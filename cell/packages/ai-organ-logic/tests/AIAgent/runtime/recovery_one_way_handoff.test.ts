import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { createActor, createVM } from "@cell/ai-core-logic"
import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION } from "@cell/ai-organ-contract"
import type { ConversationPersistenceRepository } from "@cell/ai-organ-contract"
import {
  createAiAgentOrchestratorDriverWithCooperative,
  configureRuntimePersistenceSupport,
} from "@cell/ai-organ-logic"
import { buildProviderPromptForActorTurn } from "@cell/ai-organ-logic/exec/AiAgentExecutor"
import { recoverAiAgentRuntime, saveAiAgentRuntimeSnapshot } from "@cell/ai-organ-logic/persistence/RuntimeSnapshots"
import { materializeConversationRuntimeMessagesFromVm } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import {
  chatMessagesToCommittedHistoryRefs,
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support"
import {
  appendXnlRecord,
  readRealSessionDurableHeads,
  readRuntimeControlCohortCommitFile,
  readRuntimeControlEffectEvidenceSequence,
  readRuntimeControlSessionUpgradeFile,
  writeRuntimeControlCohortCommitFile,
  writeRuntimeControlSessionUpgradeFile,
} from "@cell/ai-file-store-logic"
import { applyFileStoreAiRuntimeSessionUpgrade } from "@cell/ai-runtime-control-composer"

/**
 * Executable coverage for spec recovery-one-way-handoff (track
 * refactor-ai-semantic-conversation-spine, task T5.1):
 *
 *  - single-recovery-source — recovery reads only the conversation files;
 *    a coexisting legacy transcript never contributes; an incomplete
 *    conversation source fails with an explicit error (no silent fallback).
 *  - no-bootstrap-backfill — there is no message-array -> domains backfill
 *    path: the runtime symbol is gone and recovery never writes conversation
 *    files from in-memory messages.
 *  - hydrate-once-then-memory-only — the conversation files hydrate the
 *    domains exactly once; after the explicit switch point the live path
 *    reads memory only (mutating the files no longer changes the provider
 *    materialization), and no live module imports the file message loaders.
 */

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
})

const aiOrganLogicSrcRoot = path.resolve(import.meta.dir, "../../../src")
const cellPackagesRoot = path.resolve(import.meta.dir, "../../../..")
const terminalPackagesRoot = path.resolve(cellPackagesRoot, "../../terminal/packages")
const runtimeSnapshotsPath = path.join(aiOrganLogicSrcRoot, "persistence", "RuntimeSnapshots.ts")

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-recovery-handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function walkTypeScriptFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      files.push(...walkTypeScriptFiles(fullPath))
      continue
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(fullPath)
    }
  }
  return files
}

function makeMockAdapter() {
  return {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield { ok: true }
      }
      return { stream: stream() }
    },
  }
}

async function upgradeRuntimeControlCheckpointForCurrentSessionFiles(sessionDir: string): Promise<void> {
  const result = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
  expect(result.status === "applied" || result.status === "already_upgraded").toBe(true)
}

async function rewriteRuntimeControlCheckpointForCurrentSessionFiles(sessionDir: string): Promise<void> {
  const heads = await readRealSessionDurableHeads(sessionDir)
  const current = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
  const checkpointHeadIds = current ? Object.keys(current.headSequences) : Object.keys(heads)
  await writeRuntimeControlCohortCommitFile({
    sessionDir,
    cohortId: "checkpoint",
    headSequences: Object.fromEntries(
      checkpointHeadIds.map((headId) => [headId, heads[headId]?.committedSequence ?? 0]),
    ),
    effectEvidenceSequence: await readRuntimeControlEffectEvidenceSequence(sessionDir),
  })
  const checkpoint = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
  const upgrade = await readRuntimeControlSessionUpgradeFile({ sessionDir })
  if (checkpoint && upgrade) {
    await writeRuntimeControlSessionUpgradeFile({
      sessionDir,
      checkpointCohortId: checkpoint.cohortId,
      checkpointMarker: checkpoint.marker,
      previousCheckpointMarker: upgrade.checkpointMarker,
      headSequences: checkpoint.headSequences,
      effectEvidenceSequence: checkpoint.effectEvidenceSequence,
    })
  }
}

/**
 * Test fixture writer: seeds the conversation files (the single recovery
 * source) directly through the persistence repository. This is a file
 * fixture, not a runtime backfill path.
 */
async function writeConversationHistoryFixture(params: {
  sessionId: string
  actorKey: string
  actorId: string
  messages: any[]
  repository: ConversationPersistenceRepository
  generationId?: string
}): Promise<string> {
  const generationId = params.generationId ?? `${params.actorKey}__active`
  const nowIso = new Date().toISOString()
  const committedMessages = chatMessagesToCommittedHistoryRefs({
    messages: params.messages,
    actorKey: params.actorKey,
    actorId: params.actorId,
    recordIdPrefix: generationId,
  })

  await params.repository.writeHistoryGeneration({
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    generationId,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    parentGenerationId: null,
    predecessorGenerationIds: [],
    createdReason: "bootstrap",
    sealed: false,
    messageCount: committedMessages.length,
    messages: committedMessages,
    createdAt: nowIso,
    updatedAt: nowIso,
  })
  await writeConversationHeadFixture({ ...params, generationId })
  return generationId
}

/** Writes only the index/head files (no generation payload). */
async function writeConversationHeadFixture(params: {
  sessionId: string
  actorKey: string
  actorId: string
  repository: ConversationPersistenceRepository
  generationId: string
}): Promise<void> {
  const nowIso = new Date().toISOString()
  const historyIndex = await params.repository.loadHistoryIndex()
  const sessionIndex = await params.repository.loadSessionIndex()

  historyIndex.heads[params.actorKey] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    activeGenerationId: params.generationId,
    visibleGenerationIds: [params.generationId],
    updatedAt: nowIso,
  }
  historyIndex.generations[params.generationId] = {
    generationId: params.generationId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    sealed: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  }
  historyIndex.updatedAt = nowIso
  await params.repository.writeHistoryIndex(historyIndex)

  sessionIndex.session.activeActorKey = params.actorKey
  sessionIndex.session.actorBindings[params.actorKey] = {
    actorKey: params.actorKey,
    actorId: params.actorId,
    boundAt: nowIso,
    historyHeadGenerationId: params.generationId,
    promptHeadGenerationId: null,
  }
  sessionIndex.session.activeSelection = {
    sessionId: params.sessionId,
    activeActorKey: params.actorKey,
    historyHeadGenerationId: params.generationId,
    promptHeadGenerationId: null,
    selectedAt: nowIso,
  }
  sessionIndex.session.updatedAt = nowIso
  sessionIndex.updatedAt = nowIso
  await params.repository.writeSessionIndex(sessionIndex)
}

type SavedSessionFixture = {
  sessionDir: string
  actorId: string
}

async function saveSnapshotSessionFixture(params: {
  sessionId: string
  seedMessages?: any[]
}): Promise<SavedSessionFixture> {
  const sessionDir = makeTempSessionDir()
  const adapter = makeMockAdapter()
  const actor = createActor({
    key: "main",
    llmClient: adapter,
    modelConfig: { model: "mock" },
    messages: params.seedMessages ?? [{ role: "user", content: "hello" } as any],
    callbacks: {
      buildToolset: () => [],
      processStream: async () => ({ role: "assistant", content: "ok" }),
    },
  })
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    callbacks: {
      buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
    },
  })
  const driver = createAiAgentOrchestratorDriverWithCooperative({
    fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: actor.messages, basePriority: 1 }],
    options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
  })
  await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId: params.sessionId, vm, driver })
  return { sessionDir, actorId: actor.id }
}

async function recoverSession(params: { sessionDir: string; sessionId: string }) {
  return await recoverAiAgentRuntime({
    sessionDir: params.sessionDir,
    sessionId: params.sessionId,
    llmClient: makeMockAdapter() as any,
    callbacks: {
      buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
    },
    actorCallbacks: {
      buildToolset: () => [],
      processStream: async () => ({ role: "assistant", content: "ok" }),
    },
  })
}

describe("recovery-one-way-handoff: single-recovery-source", () => {
  it("reads only the conversation files even when a legacy transcript coexists", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "handoff-single-source"
    try {
      const fixture = await saveSnapshotSessionFixture({ sessionId })
      fs.rmSync(sessionDir, { recursive: true, force: true })
      fs.renameSync(fixture.sessionDir, sessionDir)

      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: fixture.actorId,
        messages: [
          { role: "user", content: "conversation truth input" },
          { role: "assistant", content: "conversation truth output" },
        ],
        repository,
      })

      // A coexisting legacy transcript with different content (the format is
      // removed; runtime code no longer knows this path — recreate it
      // literally for the regression).
      const transcriptXnlPath = path.join(sessionDir, "actors", `primary__${fixture.actorId}`, "transcript.xnl")
      await appendXnlRecord({
        filePath: transcriptXnlPath,
        tag: "actor-transcript-record",
        metadata: { stream: "user_input" },
        body: [{
          kind: "text",
          tag: "record",
          metadata: { stream: "user_input" },
          text: "stale transcript input must never load",
        }],
      })

      await rewriteRuntimeControlCheckpointForCurrentSessionFiles(sessionDir)
      await upgradeRuntimeControlCheckpointForCurrentSessionFiles(sessionDir)

      const recovered = await recoverSession({ sessionDir, sessionId })
      expect(recovered).toBeTruthy()
      const contents = recovered!.controlActor.messages.map((message: any) => String(message?.content ?? ""))
      expect(contents.some((content) => content.includes("conversation truth input"))).toBe(true)
      expect(contents.some((content) => content.includes("stale transcript input"))).toBe(false)
      expect((recovered!.vm.recovery?.report as any)?.actorTranscriptSources).toBeUndefined()
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("fails with an explicit error when the conversation source is incomplete (no silent fallback)", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "handoff-incomplete-source"
    try {
      const fixture = await saveSnapshotSessionFixture({ sessionId })
      fs.rmSync(sessionDir, { recursive: true, force: true })
      fs.renameSync(fixture.sessionDir, sessionDir)

      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      // Declare a history head whose generation payload is missing.
      await writeConversationHeadFixture({
        sessionId,
        actorKey: "main",
        actorId: fixture.actorId,
        repository,
        generationId: "main__missing__generation",
      })
      await rewriteRuntimeControlCheckpointForCurrentSessionFiles(sessionDir)
      await upgradeRuntimeControlCheckpointForCurrentSessionFiles(sessionDir)

      await expect(recoverSession({ sessionDir, sessionId })).rejects.toThrow(
        "conversation_recovery_source_incomplete",
      )
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("the recovery source has no fallback branch (source-level)", () => {
    const source = fs.readFileSync(runtimeSnapshotsPath, "utf8")
    expect(source.includes("actorTranscriptStore.loadMessages")).toBe(false)
    expect(source.includes('source !== "conversation"')).toBe(false)
    expect(source.includes("loadConversationRuntimeMessages")).toBe(false)
  })
})

describe("recovery-one-way-handoff: no-bootstrap-backfill", () => {
  it("the message-array -> domains backfill symbol is gone from every package source tree", () => {
    const offenders: string[] = []
    for (const root of [cellPackagesRoot, terminalPackagesRoot]) {
      for (const packageDir of fs.readdirSync(root)) {
        const srcDir = path.join(root, packageDir, "src")
        if (!fs.existsSync(srcDir)) continue
        for (const file of walkTypeScriptFiles(srcDir)) {
          if (fs.readFileSync(file, "utf8").includes("bootstrapConversationHistoryFromMessages")) {
            offenders.push(file)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("recovery of a session without conversation files never backfills them from memory", async () => {
    const sessionId = "handoff-no-backfill"
    const fixture = await saveSnapshotSessionFixture({
      sessionId,
      seedMessages: [
        { role: "system", content: "system" },
        { role: "user", content: "persist me" },
        { role: "assistant", content: "done" },
      ],
    })
    const sessionDir = fixture.sessionDir
    try {
      await upgradeRuntimeControlCheckpointForCurrentSessionFiles(sessionDir)
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history.index.json"))).toBe(false)

      const recovered = await recoverSession({ sessionDir, sessionId })
      expect(recovered).toBeTruthy()

      // No conversation files were written by recovery: hydration is one-way
      // (files -> domains) and an absent source stays absent.
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history.index.json"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "conversation", "session.index.json"))).toBe(false)
      expect((recovered!.vm.recovery?.report as any)?.actorTranscriptSources).toBeUndefined()
      expect(recovered!.controlActor.messages).toEqual([])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})

describe("recovery-one-way-handoff: hydrate-once-then-memory-only", () => {
  it("hydrates once, marks the switch point, and live reads stay on memory when the files change", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "handoff-memory-only"
    try {
      const fixture = await saveSnapshotSessionFixture({ sessionId })
      fs.rmSync(sessionDir, { recursive: true, force: true })
      fs.renameSync(fixture.sessionDir, sessionDir)

      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      const generationId = await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: fixture.actorId,
        messages: [
          { role: "user", content: "hydrated from the conversation files" },
          { role: "assistant", content: "hydrated assistant reply" },
        ],
        repository,
      })
      await rewriteRuntimeControlCheckpointForCurrentSessionFiles(sessionDir)
      await upgradeRuntimeControlCheckpointForCurrentSessionFiles(sessionDir)

      const recovered = await recoverSession({ sessionDir, sessionId })
      expect(recovered).toBeTruthy()

      // Explicit switch point marker: the one-time hydration completed.
      expect(recovered!.vm.recovery?.conversationHydration).toEqual({
        completed: true,
        source: "conversation_files",
        hydratedAt: expect.any(Number),
      })

      const beforeMutation = materializeConversationRuntimeMessagesFromVm({
        vm: recovered!.vm,
        actorKey: "main",
      })
      expect(
        beforeMutation.some((message: any) => String(message?.content ?? "").includes("hydrated from the conversation files")),
      ).toBe(true)

      const promptBefore = buildProviderPromptForActorTurn({
        vm: recovered!.vm,
        actor: recovered!.controlActor,
        tools: [],
        llmAdapter: makeMockAdapter() as any,
        model: "mock",
        recordPromptPlan: false,
      })
      expect(promptBefore.promptSource).toBe("domain_materialization")

      // Mutate the conversation files after the handoff: rewrite the hydrated
      // generation with different content, then also delete the whole
      // conversation directory. The live path must not notice either.
      await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: fixture.actorId,
        messages: [{ role: "user", content: "mutated on disk after the handoff" }],
        repository,
        generationId,
      })
      fs.rmSync(path.join(sessionDir, "conversation"), { recursive: true, force: true })

      const afterMutation = materializeConversationRuntimeMessagesFromVm({
        vm: recovered!.vm,
        actorKey: "main",
      })
      expect(afterMutation).toEqual(beforeMutation)
      expect(
        afterMutation.some((message: any) => String(message?.content ?? "").includes("mutated on disk")),
      ).toBe(false)

      const promptAfter = buildProviderPromptForActorTurn({
        vm: recovered!.vm,
        actor: recovered!.controlActor,
        tools: [],
        llmAdapter: makeMockAdapter() as any,
        model: "mock",
        recordPromptPlan: false,
      })
      expect(promptAfter.promptSource).toBe("domain_materialization")
      expect(promptAfter.providerMessages).toEqual(promptBefore.providerMessages)
      expect(
        promptAfter.providerMessages.some((message: any) => String(message?.content ?? "").includes("mutated on disk")),
      ).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("no live module imports the conversation file message loaders (source-level)", () => {
    // The conversation-file message loaders feed exactly one consumer set:
    // none. Recovery hydrates raw domain states (loadConversationActorRawState/
    // loadConversationSessionRawState) and projects the actor mirror from the
    // in-memory materialization; the message-level file loaders are out of the
    // ai-organ-logic live tree entirely.
    const messageLoaderOffenders: string[] = []
    for (const file of walkTypeScriptFiles(aiOrganLogicSrcRoot)) {
      const source = fs.readFileSync(file, "utf8")
      if (source.includes("loadConversationRuntimeMessages") || source.includes("loadConversationHistoryMessages")) {
        messageLoaderOffenders.push(path.relative(aiOrganLogicSrcRoot, file))
      }
    }
    expect(messageLoaderOffenders).toEqual([])

    // Raw-state loaders are confined to the recovery hydration and the
    // capsule's persistence-sync helpers (write-back refresh), never the
    // provider build path. The recovery→read port (T4.2,
    // refactor-persistent-session-backplane) is the single-source policy surface
    // recovery reads through, so it is part of the recovery hydration tree.
    const rawStateAllowlist = new Set([
      path.join("persistence", "RuntimeSnapshots.ts"),
      path.join("persistence", "RecoveryReadPort.ts"),
      path.join("conversationCapsule", "internals", "domainRuntime.ts"),
    ])
    const rawStateOffenders: string[] = []
    for (const file of walkTypeScriptFiles(aiOrganLogicSrcRoot)) {
      const relative = path.relative(aiOrganLogicSrcRoot, file)
      if (rawStateAllowlist.has(relative)) continue
      const source = fs.readFileSync(file, "utf8")
      if (source.includes("loadConversationActorRawState") || source.includes("loadConversationSessionRawState")) {
        rawStateOffenders.push(relative)
      }
    }
    expect(rawStateOffenders).toEqual([])
  })
})
