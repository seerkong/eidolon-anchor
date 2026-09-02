import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { createActor, createVM } from "@cell/ai-core-logic"
import {
  configureRuntimePersistenceSupport,
  createAiAgentOrchestratorDriverWithCooperative,
} from "@cell/ai-organ-logic"
import {
  getConversationActorRawStateFromVm,
  materializeConversationRuntimeMessagesFromVm,
} from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import { ensureVmToolCallDomain } from "@cell/ai-organ-logic/runtime/ToolCallDomainRuntime"
import {
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
} from "@cell/ai-organ-logic/persistence/RuntimeSnapshots"
import { createRecoveryReadPort } from "@cell/ai-organ-logic/persistence/RecoveryReadPort"
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support"
import {
  readRealSessionDurableHeads,
  readRuntimeControlCohortCommitFile,
  readRuntimeControlEffectEvidenceSequence,
  readRuntimeControlSessionUpgradeFile,
  writeRuntimeControlCohortCommitFile,
  writeRuntimeControlSessionUpgradeFile,
} from "@cell/ai-file-store-logic"
import { applyFileStoreAiRuntimeSessionUpgrade } from "@cell/ai-runtime-control-composer"
import { createMockProcessStream } from "../__test_support__/mockProcessStream"

/**
 * Recovery regression for the live single-writer conversation path.
 *
 * A recovered VM owns a fresh event bus. The resident MessageHistoryGraph must
 * already be attached when recovery returns, before any cooperative tick, so
 * live ingress cannot disappear between process reconstruction and the first
 * scheduler action. Each tool-call/result sequence must therefore commit the
 * assistant/tool pair through the same graph as a fresh runtime.
 */

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
})

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-repeat-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
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

async function rewriteCheckpoint(sessionDir: string): Promise<void> {
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

async function upgradeCheckpoint(sessionDir: string): Promise<void> {
  const result = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
  expect(result.status === "applied" || result.status === "already_upgraded").toBe(true)
}

/**
 * Persist a settled session with a base conversation (1 user msg + 1 assistant
 * reply, committed via the live single-writer path) at a real safepoint. This
 * mirrors the real scenario: recovery starts from a session that already has a
 * committed base conversation.
 */
async function persistSettledBaseSession(sessionDir: string, sessionId: string) {
  const root = createActor({
    key: "main",
    id: "actor-main",
    llmClient: makeMockAdapter(),
    modelConfig: { model: "mock" },
    messages: [
      { role: "system", content: "system" } as any,
      { role: "user", content: "hello" } as any,
    ],
    callbacks: {
      buildToolset: () => [],
      processStream: createMockProcessStream(async () => ({ role: "assistant", content: "hi there" })),
    },
  })
  const vm = createVM({
    controlActorKey: root.key,
    actors: { [root.key]: root },
    registries: { toolRegistry: composeToolRegistry({ includeInternalOnly: true }) } as any,
    outerCtx: { metadata: { sessionId, sessionDir } },
    callbacks: {
      buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
    },
  })
  const fiberId = `${root.key}:${root.id}`
  const driver = createAiAgentOrchestratorDriverWithCooperative({
    fibers: [{ fiberId, vm, actor: root, messages: root.messages, basePriority: 1 }],
    options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
  })
  await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 20, maxWallMs: 2000 })
  await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })
  await rewriteCheckpoint(sessionDir)
  await upgradeCheckpoint(sessionDir)
}

async function recoverSession(sessionDir: string, sessionId: string) {
  return await recoverAiAgentRuntime({
    sessionDir,
    sessionId,
    llmClient: makeMockAdapter() as any,
    registries: { toolRegistry: composeToolRegistry({ includeInternalOnly: true }) } as any,
    recoveryReadPort: createRecoveryReadPort(),
    callbacks: {
      buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
    },
    actorCallbacks: {
      buildToolset: () => [],
      processStream: createMockProcessStream(async () => ({ role: "assistant", content: "noop" })),
    },
  })
}

/**
 * Drive ONE assistant-content + tool-call + tool-result semantic sequence onto
 * the vm event bus the way production's `processRuntimeIngressStream` does
 * (ShellRuntimeSupport.ts:206-239 -> `eventBus.emit(event)` per semantic event),
 * WITHOUT `replayedFromEffectEvidence`. The `emit*` helpers on AgentEventGraph
 * are the same ones the semantic stream pipeline uses; the result event is the
 * commit boundary (MessageHistoryGraph.ts:611-628). This is the LIVE path under
 * test — NOT the createMockProcessStream harness shortcut (which would attach
 * the graph via the cooperative step and hide the bug).
 */
function driveLiveToolOpOnBus(vm: any, actor: { key: string; id: string }, idx: number) {
  const bus = vm.eventBus
  const actorRef = { key: actor.key, id: actor.id }
  bus.emitContentStart(actorRef)
  bus.emitContentDelta(actorRef, `step ${idx}`)
  bus.emitContentEnd(actorRef)
  bus.emitToolCall(
    actorRef,
    {
      id: `call_repeat_read_${idx}`,
      functionName: "read_file",
      functionArguments: JSON.stringify({ path: `src/file_${idx}.ts` }),
    } as any,
    "tool",
    "json",
  )
  bus.emitToolCallResult(actorRef, "read_file", `call_repeat_read_${idx}`, `FILE-OUTPUT-${idx}`, false)
}

function actorMessageCount(vm: any, actorKey: string): number {
  const raw = getConversationActorRawStateFromVm({ vm, actorKey })
  return (raw?.visibleHistoryGenerations ?? []).reduce(
    (total: number, generation: any) => total + (generation.messages?.length ?? 0),
    0,
  )
}

const LIVE_OPS = 2

describe("repeat-read live single-writer recovery", () => {
  it("eagerly attaches the resident graph and commits live semantic operations after recovery", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "repeat-read-recovered-frozen"
    try {
      await persistSettledBaseSession(sessionDir, sessionId)

      const recovered = await recoverSession(sessionDir, sessionId)
      expect(recovered).toBeTruthy()
      const vm = recovered!.vm
      const actor = recovered!.controlActor

      // Real scenario: the ToolCallDomain is present and holds tool results.
      ensureVmToolCallDomain(vm)

      // Recovery really happened from a snapshot.
      expect(vm.recovery?.restoredFromSnapshot).toBe(true)

      const baseCount = actorMessageCount(vm, "main")
      const baseMaterialized = materializeConversationRuntimeMessagesFromVm({ vm, actorKey: "main" }).length
      // Base conversation present (user + assistant reply committed pre-snapshot).
      expect(baseCount).toBeGreaterThanOrEqual(1)
      expect(baseMaterialized).toBeGreaterThanOrEqual(baseCount)

      // ----- THE PINNED TRIGGER, probed directly at the moment live events arrive -----
      // The eventBus is LIVE (not completed): the bug is NOT a done bus.
      expect((vm.eventBus as any).done).toBe(false)
      expect((vm.eventBus as any).consumers.size).toBeGreaterThan(0)

      // ----- Drive N live tool ops on the recovered bus (production emit path) -----
      for (let i = 1; i <= LIVE_OPS; i += 1) {
        driveLiveToolOpOnBus(vm, { key: actor.key, id: actor.id }, i)
      }

      const afterCount = actorMessageCount(vm, "main")
      const afterMaterialized = materializeConversationRuntimeMessagesFromVm({ vm, actorKey: "main" }).length

      expect(afterCount).toBe(baseCount + 2 * LIVE_OPS)
      expect(afterMaterialized).toBe(baseMaterialized + 2 * LIVE_OPS)
      expect((vm.eventBus as any).done).toBe(false)
      expect((vm.eventBus as any).consumers.size).toBeGreaterThan(0)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("keeps the eager resident attachment idempotent across the first cooperative tick", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "repeat-read-counterfactual"
    try {
      await persistSettledBaseSession(sessionDir, sessionId)
      const recovered = await recoverSession(sessionDir, sessionId)
      expect(recovered).toBeTruthy()
      const vm = recovered!.vm
      const actor = recovered!.controlActor
      ensureVmToolCallDomain(vm)

      const consumersBeforeTick = (vm.eventBus as any).consumers.size
      const residentDetach = (vm.runtimeContext as any).persistentMessageHistoryGraphDetach
      expect(consumersBeforeTick).toBeGreaterThan(0)
      expect(residentDetach).toBeFunction()
      const baseCount = actorMessageCount(vm, "main")

      // Run one cooperative tick: eager attachment must remain idempotent.
      recovered!.driver.resumeFiber?.(`${actor.key}:${actor.id}`, Date.now())
      await recovered!.driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 5, maxWallMs: 1000 })

      expect((vm.eventBus as any).consumers.size).toBeGreaterThanOrEqual(consumersBeforeTick)
      expect((vm.runtimeContext as any).persistentMessageHistoryGraphDetach).toBe(residentDetach)

      // The SAME live bus op now commits (assistant + tool message = +2).
      driveLiveToolOpOnBus(vm, { key: actor.key, id: actor.id }, 1)
      const afterCount = actorMessageCount(vm, "main")
      expect(afterCount).toBe(baseCount + 2)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("CONTRAST: on a FRESH (non-recovered) runtime that already ran a turn, the same live ops DO grow messageCount (bug is recovery-specific)", () => {
    const root = createActor({
      key: "main",
      id: "actor-main",
      llmClient: makeMockAdapter(),
      modelConfig: { model: "mock" },
      messages: [
        { role: "system", content: "system" } as any,
        { role: "user", content: "hello" } as any,
      ],
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async () => ({ role: "assistant", content: "hi" })),
      },
    })
    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      registries: { toolRegistry: composeToolRegistry({ includeInternalOnly: true }) } as any,
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
    })
    const fiberId = `${root.key}:${root.id}`
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId, vm, actor: root, messages: root.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    return (async () => {
      await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 20, maxWallMs: 2000 })

      // The live turn already ran -> resident graph attached.
      expect((vm.eventBus as any).consumers.size).toBeGreaterThan(0)
      const baseCount = actorMessageCount(vm, "main")

      for (let i = 1; i <= LIVE_OPS; i += 1) {
        driveLiveToolOpOnBus(vm, { key: root.key, id: root.id }, i)
      }
      // Fresh runtime: live ops COMMIT (+2 per op). This is the behavior the fix
      // track must also achieve on the recovered runtime.
      expect(actorMessageCount(vm, "main")).toBe(baseCount + 2 * LIVE_OPS)
    })()
  })
})
