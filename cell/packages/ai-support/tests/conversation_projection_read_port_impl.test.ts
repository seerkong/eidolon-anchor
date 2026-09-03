import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION } from "@cell/ai-organ-contract"
import type { ActorHistoryGenerationData, ActorPromptGenerationData, ConversationPersistenceRepository } from "@cell/ai-organ-contract"
import { isConversationProjectionReadPort } from "@cell/ai-core-contract"
import {
  chatMessagesToCommittedHistoryRefs,
  createLocalFileConversationProjectionReadPort,
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "../src"

/**
 * P1 (track isolate-runtime-projection-surfaces) — impl slice.
 *
 * Covers behavior-delta requirement `conversation-projection-read-port` from the
 * implementation side:
 *  - the impl conforms to the read-only ConversationProjectionReadPort shape;
 *  - it reads from the SINGLE source (the conversation files / the
 *    runtime_state questionnaires file) via the SAME loaders the backplane uses,
 *    not a re-implemented raw file read;
 *  - a declared-but-unloadable / absent source surfaces the established
 *    empty/null semantics (no mixing).
 */

const implSourcePath = path.resolve(
  import.meta.dir,
  "../src/conversation/LocalFileConversationProjectionReadPort.ts",
)

function makeTempSessionDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `eidolon-projection-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function writeConversationHistoryFixture(params: {
  sessionId: string
  actorKey: string
  actorId: string
  messages: any[]
  committedMessages?: ActorHistoryGenerationData["messages"]
  repository: ConversationPersistenceRepository
}): Promise<void> {
  const generationId = `${params.actorKey}__active`
  const nowIso = new Date().toISOString()
  const committedMessages = params.committedMessages ?? chatMessagesToCommittedHistoryRefs({
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

  const historyIndex = await params.repository.loadHistoryIndex()
  historyIndex.heads[params.actorKey] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    activeGenerationId: generationId,
    visibleGenerationIds: [generationId],
    updatedAt: nowIso,
  }
  historyIndex.generations[generationId] = {
    generationId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    sealed: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  }
  historyIndex.updatedAt = nowIso
  await params.repository.writeHistoryIndex(historyIndex)

  const sessionIndex = await params.repository.loadSessionIndex()
  sessionIndex.session.activeActorKey = params.actorKey
  sessionIndex.session.actorBindings[params.actorKey] = {
    actorKey: params.actorKey,
    actorId: params.actorId,
    boundAt: nowIso,
    historyHeadGenerationId: generationId,
    promptHeadGenerationId: null,
  }
  sessionIndex.session.updatedAt = nowIso
  sessionIndex.updatedAt = nowIso
  await params.repository.writeSessionIndex(sessionIndex)
}

describe("LocalFileConversationProjectionReadPort: conforms to the read-only contract", () => {
  it("is a ConversationProjectionReadPort (read-only method surface)", () => {
    const port = createLocalFileConversationProjectionReadPort()
    expect(isConversationProjectionReadPort(port)).toBe(true)
  })
})

describe("LocalFileConversationProjectionReadPort: single-source reads", () => {
  it("extracts visible first/latest previews from bounded XNL edge windows", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = path.basename(sessionDir)
    const nowIso = new Date().toISOString()
    try {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: "actor-1",
        messages: [
          { role: "user", content: "first visible prompt" },
          { role: "assistant", content: "x".repeat(2_000_000) },
          { role: "assistant", content: "latest visible response" },
        ],
        repository,
      })
      await repository.writeHistoryGeneration({
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        generationId: "hidden-after-rewind",
        sessionId,
        actorKey: "main",
        actorId: "actor-1",
        parentGenerationId: null,
        predecessorGenerationIds: [],
        createdReason: "rewind",
        sealed: true,
        messageCount: 1,
        messages: chatMessagesToCommittedHistoryRefs({
          messages: [{ role: "assistant", content: "hidden abandoned tail" }],
          actorKey: "main",
          actorId: "actor-1",
          recordIdPrefix: "hidden-after-rewind",
        }),
        createdAt: nowIso,
        updatedAt: nowIso,
      })

      const port = createLocalFileConversationProjectionReadPort()
      const summary = await port.loadHistorySummaryProjection({ sessionDir, actorKey: "main" })

      expect(summary).toMatchObject({
        source: "conversation",
        initialUserMessage: "first visible prompt",
        latestMessage: "latest visible response",
      })
      expect(summary.sourceBytes).toBeGreaterThan(2_000_000)
      expect(summary.observedBytes).toBeLessThan(summary.sourceBytes)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("uses the root fork session head for the initial preview and the child visible tail for latest", async () => {
    const sessionsDir = makeTempSessionDir()
    const parentSessionId = "parent-session"
    const childSessionId = "child-session"
    const parentDir = path.join(sessionsDir, parentSessionId)
    const childDir = path.join(sessionsDir, childSessionId)
    fs.mkdirSync(parentDir, { recursive: true })
    fs.mkdirSync(childDir, { recursive: true })
    try {
      const parentRepository = LocalFileConversationPersistenceRepositoryFactory.createRepository(parentDir)
      await writeConversationHistoryFixture({
        sessionId: parentSessionId,
        actorKey: "main",
        actorId: "actor-parent",
        messages: [
          { role: "user", content: "root session question" },
          { role: "assistant", content: "root session answer" },
        ],
        repository: parentRepository,
      })
      const childRepository = LocalFileConversationPersistenceRepositoryFactory.createRepository(childDir)
      await writeConversationHistoryFixture({
        sessionId: childSessionId,
        actorKey: "main",
        actorId: "actor-child",
        messages: [
          { role: "user", content: "child continuation" },
          { role: "assistant", content: "child latest answer" },
        ],
        repository: childRepository,
      })
      const childIndex = await childRepository.loadSessionIndex()
      childIndex.lineage = {
        version: 1,
        sessionId: childSessionId,
        parentSessionId,
        forkedFromGenerationId: "main__active",
        rolledBackFromSessionId: null,
        predecessorSessionIds: [parentSessionId],
        forkSessionIds: [],
        updatedAt: new Date().toISOString(),
      }
      await childRepository.writeSessionIndex(childIndex)

      const summary = await createLocalFileConversationProjectionReadPort()
        .loadHistorySummaryProjection({ sessionDir: childDir, actorKey: "main" })

      expect(summary.initialUserMessage).toBe("root session question")
      expect(summary.latestMessage).toBe("child latest answer")
    } finally {
      fs.rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it("loads the visible history projection from the conversation files (single source)", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = path.basename(sessionDir)
    try {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: "actor-1",
        messages: [
          { role: "user", content: "conversation source input" },
          { role: "assistant", content: "conversation source output" },
        ],
        repository,
      })

      const port = createLocalFileConversationProjectionReadPort()
      const history = await port.loadHistoryProjection({ sessionDir, actorKey: "main" })
      expect(history.source).toBe("conversation")
      const contents = history.messages.map((message: any) => String(message?.content ?? ""))
      expect(contents.some((content) => content.includes("conversation source input"))).toBe(true)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("reads latest and previous visible history pages without materializing the whole XNL", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = path.basename(sessionDir)
    try {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      const messages = Array.from({ length: 120 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${String(index).padStart(3, "0")}:${"x".repeat(2_000)}`,
      }))
      await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: "actor-1",
        messages,
        repository,
      })

      const port = createLocalFileConversationProjectionReadPort()
      const latest = await port.loadHistoryPageProjection(
        { sessionDir, actorKey: "main" },
        { limit: 10 },
      )
      expect(latest.status).toBe("ok")
      expect(latest.messages.map((message) => String(message.content).slice(0, 11))).toEqual(
        messages.slice(-10).map((message) => message.content.slice(0, 11)),
      )
      expect(latest.pageInfo.hasPreviousPage).toBe(true)
      expect(latest.pageInfo.startCursor).toBeTruthy()
      expect(latest.observedBytes).toBeLessThan(latest.sourceBytes)

      const previous = await port.loadHistoryPageProjection(
        { sessionDir, actorKey: "main" },
        { limit: 10, before: latest.pageInfo.startCursor },
      )
      expect(previous.status).toBe("ok")
      expect(previous.messages.map((message) => String(message.content).slice(0, 11))).toEqual(
        messages.slice(-20, -10).map((message) => message.content.slice(0, 11)),
      )
      expect(new Set([...previous.messages, ...latest.messages].map((message) => message.messageId)).size).toBe(20)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("bounds filtered scanning when a large invisible actor tail follows the visible history", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = path.basename(sessionDir)
    try {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: "actor-main",
        messages: Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `visible-${index}` })),
        repository,
      })
      await repository.writeHistoryGeneration({
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        generationId: "other__hidden",
        sessionId,
        actorKey: "other",
        actorId: "actor-other",
        parentGenerationId: null,
        predecessorGenerationIds: [],
        createdReason: "bootstrap",
        sealed: false,
        messageCount: 200,
        messages: chatMessagesToCommittedHistoryRefs({
          messages: Array.from({ length: 200 }, (_, index) => ({
            role: "assistant",
            content: `hidden-${index}:${"z".repeat(50_000)}`,
          })),
          actorKey: "other",
          actorId: "actor-other",
          recordIdPrefix: "other__hidden",
        }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      const page = await createLocalFileConversationProjectionReadPort().loadHistoryPageProjection(
        { sessionDir, actorKey: "main" },
        { limit: 4 },
      )
      expect(page.messages).toEqual([])
      expect(page.pageInfo.hasPreviousPage).toBe(true)
      expect(page.pageInfo.startCursor).toBeTruthy()
      expect(page.observedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
      expect(page.sourceBytes).toBeGreaterThan(page.observedBytes)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  }, 30_000)

  it("matches the mature prompt-target head decision during provider handoff", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = path.basename(sessionDir)
    const nowIso = new Date().toISOString()
    const targetGenerationId = "main__prompt_target"
    const declaredGenerationId = "main__declared_tail"
    try {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      const generation = (generationId: string, content: string): ActorHistoryGenerationData => ({
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        generationId,
        sessionId,
        actorKey: "main",
        actorId: "actor-main",
        parentGenerationId: null,
        predecessorGenerationIds: [],
        createdReason: "append",
        sealed: false,
        messageCount: 1,
        messages: chatMessagesToCommittedHistoryRefs({
          messages: [{ role: "assistant", content }],
          actorKey: "main",
          actorId: "actor-main",
          recordIdPrefix: generationId,
        }),
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      await repository.writeHistoryGeneration(generation(targetGenerationId, "prompt-target-visible"))
      await repository.writeHistoryGeneration(generation(declaredGenerationId, "declared-tail-hidden"))

      const historyIndex = await repository.loadHistoryIndex()
      historyIndex.heads.main = {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId,
        actorKey: "main",
        actorId: "actor-main",
        activeGenerationId: declaredGenerationId,
        visibleGenerationIds: [targetGenerationId, declaredGenerationId],
        updatedAt: nowIso,
      }
      for (const generationId of [targetGenerationId, declaredGenerationId]) {
        historyIndex.generations[generationId] = {
          generationId,
          actorKey: "main",
          actorId: "actor-main",
          sealed: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        historyIndex.lineages[generationId] = {
          version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
          sessionId,
          actorKey: "main",
          actorId: "actor-main",
          generationId,
          parentGenerationId: null,
          rolledBackFromGenerationId: null,
          predecessorGenerationIds: [],
          createdAt: nowIso,
        }
      }
      historyIndex.updatedAt = nowIso
      await repository.writeHistoryIndex(historyIndex)

      const promptGeneration: ActorPromptGenerationData = {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        promptGenerationId: "prompt-handoff",
        sessionId,
        actorKey: "main",
        actorId: "actor-main",
        basedOnPromptGenerationId: null,
        basis: {
          version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
          basisHistoryGenerationIds: [targetGenerationId],
          basisMessageRecordIds: [],
        },
        transforms: [],
        createdReason: "request_build",
        materializedContext: null,
        sealed: false,
        createdAt: nowIso,
        updatedAt: nowIso,
        metadata: { targetHistoryGenerationId: targetGenerationId },
      }
      await repository.writePromptGeneration(promptGeneration)
      const promptIndex = await repository.loadPromptIndex()
      promptIndex.heads.main = {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId,
        actorKey: "main",
        actorId: "actor-main",
        activePromptGenerationId: promptGeneration.promptGenerationId,
        updatedAt: nowIso,
      }
      promptIndex.generations[promptGeneration.promptGenerationId] = {
        promptGenerationId: promptGeneration.promptGenerationId,
        actorKey: "main",
        actorId: "actor-main",
        sealed: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      promptIndex.updatedAt = nowIso
      await repository.writePromptIndex(promptIndex)

      const sessionIndex = await repository.loadSessionIndex()
      sessionIndex.session.activeActorKey = "main"
      sessionIndex.session.actorBindings.main = {
        actorKey: "main",
        actorId: "actor-main",
        boundAt: nowIso,
        historyHeadGenerationId: declaredGenerationId,
        promptHeadGenerationId: promptGeneration.promptGenerationId,
      }
      sessionIndex.session.updatedAt = nowIso
      sessionIndex.updatedAt = nowIso
      await repository.writeSessionIndex(sessionIndex)

      const port = createLocalFileConversationProjectionReadPort()
      const full = await port.loadHistoryProjection({ sessionDir, actorKey: "main" })
      const page = await port.loadHistoryPageProjection({ sessionDir, actorKey: "main" }, { limit: 10 })
      expect(page.historyGenerationId).toBe(targetGenerationId)
      expect(page.messages.map((message) => [message.role, message.content])).toEqual(
        full.messages.map((message) => [message.role, message.content]),
      )
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("rejects a page cursor after the visible history snapshot changes", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = path.basename(sessionDir)
    try {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: "actor-1",
        messages: Array.from({ length: 12 }, (_, index) => ({ role: "user", content: `m-${index}` })),
        repository,
      })
      const port = createLocalFileConversationProjectionReadPort()
      const page = await port.loadHistoryPageProjection({ sessionDir, actorKey: "main" }, { limit: 4 })
      expect(page.pageInfo.startCursor).toBeTruthy()

      const historyIndex = await repository.loadHistoryIndex()
      historyIndex.heads.main!.visibleGenerationIds = ["main__active", "rewound-successor"]
      historyIndex.heads.main!.activeGenerationId = "rewound-successor"
      await repository.writeHistoryIndex(historyIndex)

      const stale = await port.loadHistoryPageProjection(
        { sessionDir, actorKey: "main" },
        { limit: 4, before: page.pageInfo.startCursor },
      )
      expect(stale.status).toBe("stale_cursor")
      expect(stale.messages).toEqual([])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("rejects a cursor issued by another session even when generation ids match", async () => {
    const firstSessionDir = makeTempSessionDir()
    const secondSessionDir = makeTempSessionDir()
    try {
      for (const sessionDir of [firstSessionDir, secondSessionDir]) {
        const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
        await writeConversationHistoryFixture({
          sessionId: path.basename(sessionDir),
          actorKey: "main",
          actorId: "actor-1",
          messages: Array.from({ length: 12 }, (_, index) => ({ role: "user", content: `m-${index}` })),
          repository,
        })
      }
      const port = createLocalFileConversationProjectionReadPort()
      const firstPage = await port.loadHistoryPageProjection(
        { sessionDir: firstSessionDir, actorKey: "main" },
        { limit: 4 },
      )
      expect(firstPage.pageInfo.startCursor).toBeTruthy()

      const crossSession = await port.loadHistoryPageProjection(
        { sessionDir: secondSessionDir, actorKey: "main" },
        { limit: 4, before: firstPage.pageInfo.startCursor },
      )
      expect(crossSession.status).toBe("stale_cursor")
      expect(crossSession.messages).toEqual([])
    } finally {
      fs.rmSync(firstSessionDir, { recursive: true, force: true })
      fs.rmSync(secondSessionDir, { recursive: true, force: true })
    }
  })

  it("preserves generation sequence when compacted timestamps precede ordinal live progress", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = path.basename(sessionDir)
    const generationId = "main__active"
    try {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: "actor-1",
        messages: [],
        committedMessages: [
          {
            recordId: `${generationId}::30`,
            actorKey: "main",
            actorId: "actor-1",
            committedAt: 1785610313793,
            message: { role: "user", content: "last compacted user input" },
          },
          {
            recordId: `${generationId}::31`,
            actorKey: "main",
            actorId: "actor-1",
            committedAt: 31,
            message: { role: "assistant", content: "persisted assistant progress" },
          },
          {
            recordId: `${generationId}::32`,
            actorKey: "main",
            actorId: "actor-1",
            committedAt: 32,
            message: {
              role: "tool",
              content: "persisted tool progress",
              toolCallId: "call-sequence-regression",
              resultMetadata: {
                contextResource: {
                  status: "loaded",
                  resourceId: "file:///workspace/README.md",
                },
              },
            },
          },
        ],
        repository,
      })

      const port = createLocalFileConversationProjectionReadPort()
      const history = await port.loadHistoryProjection({ sessionDir, actorKey: "main" })

      expect(history.source).toBe("conversation")
      expect(history.messages.map((message) => [message.role, String(message.content ?? "")])).toEqual([
        ["user", "last compacted user input"],
        ["assistant", "persisted assistant progress"],
        ["tool", "persisted tool progress"],
      ])
      expect(history.messages[2]?.resultMetadata).toEqual({
        contextResource: {
          status: "loaded",
          resourceId: "file:///workspace/README.md",
        },
      })
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("loads the session + actor projection from the same single source", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = path.basename(sessionDir)
    try {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
      await writeConversationHistoryFixture({
        sessionId,
        actorKey: "main",
        actorId: "actor-1",
        messages: [{ role: "user", content: "hi" }],
        repository,
      })

      const port = createLocalFileConversationProjectionReadPort()
      const session = await port.loadSessionProjection({ sessionDir })
      expect(session.activeActorKey).toBe("main")
      expect(Object.keys(session.actorBindings)).toContain("main")

      const actor = await port.loadActorProjection({ sessionDir, actorKey: "main" })
      expect(actor).toBeTruthy()
      expect(actor!.actorKey).toBe("main")
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("surfaces empty on an absent source (no mixing, no silent second source)", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      const port = createLocalFileConversationProjectionReadPort()
      // Absent conversation source: the single-source history loader reports an
      // empty view (no head, no messages) — it never degrades to a second source.
      const history = await port.loadHistoryProjection({ sessionDir, actorKey: "main" })
      expect(history.source).toBe("empty")
      expect(history.messages).toEqual([])

      // An explicitly-requested actor with no persisted state yields an empty
      // raw-state view (no declared history head), matching the loader's
      // single-source semantics.
      const actor = await port.loadActorProjection({ sessionDir, actorKey: "main" })
      expect(actor).toBeTruthy()
      expect(actor!.historyHeadGenerationId ?? null).toBeNull()
      expect(actor!.visibleHistoryGenerations).toEqual([])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})

describe("LocalFileConversationProjectionReadPort: pending-questions single source", () => {
  it("reads only the pending questionnaires through the snapshot repository (not a raw file read)", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      const snapshotRepository =
        LocalFileRuntimeSnapshotRepositoryFactory.createRuntimeSnapshotRepository(sessionDir)
      await snapshotRepository.writeQuestionnaires([
        {
          questionnaireId: "q-pending",
          toolCallId: "tc-1",
          status: "pending",
          suspendPolicy: "pause_all",
          request: {
            questionnaireId: "q-pending",
            toolCallId: "tc-1",
            kind: "clarification",
            suspendPolicy: "pause_all",
            questions: [{ id: "x", prompt: "?", type: "text" }],
          },
          result: { questionnaireId: "q-pending", toolCallId: "tc-1", rawText: "", status: "ok", answers: {} },
        },
        {
          questionnaireId: "q-answered",
          toolCallId: "tc-2",
          status: "answered",
          suspendPolicy: "pause_all",
          request: {
            questionnaireId: "q-answered",
            toolCallId: "tc-2",
            kind: "clarification",
            suspendPolicy: "pause_all",
            questions: [{ id: "y", prompt: "?", type: "text" }],
          },
          result: { questionnaireId: "q-answered", toolCallId: "tc-2", rawText: "", status: "ok", answers: {} },
        },
      ] as any)

      const port = createLocalFileConversationProjectionReadPort()
      const pending = await port.loadPendingQuestionsProjection({ sessionDir })
      expect(pending.rows.map((row) => row.questionnaireId)).toEqual(["q-pending"])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("returns an empty projection when the questionnaires file is absent", async () => {
    const sessionDir = makeTempSessionDir()
    try {
      const port = createLocalFileConversationProjectionReadPort()
      const pending = await port.loadPendingQuestionsProjection({ sessionDir })
      expect(pending.rows).toEqual([])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})

describe("LocalFileConversationProjectionReadPort: no loader duplication (source-level)", () => {
  it("delegates to the shared single-source loaders, not a re-implemented raw read", () => {
    const source = fs.readFileSync(implSourcePath, "utf8")
    // References the shared loaders (the same ones the backplane reads through).
    expect(source.includes("loadConversationHistoryMessages")).toBe(true)
    expect(source.includes("loadConversationSessionRawState")).toBe(true)
    expect(source.includes("loadConversationActorRawState")).toBe(true)
    // Pending-questions goes through the snapshot repository's single source,
    // not a hand-rolled raw read / parse of the questionnaires file.
    expect(source.includes("readQuestionnaires")).toBe(true)
    // No raw byte read / parse re-implementation in the impl itself.
    expect(source.includes("readFile(")).toBe(false)
    expect(source.includes("parseQuestionnaireRowsXnl")).toBe(false)
  })
})
