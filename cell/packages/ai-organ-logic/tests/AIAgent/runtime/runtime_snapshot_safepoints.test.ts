import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { createActor, createVM } from "@cell/ai-core-logic"
import type { AiAgentWakeMailbox } from "@cell/ai-core-logic/runtime/actor"
import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  createAiAgentOrchestratorDriver,
  createAiAgentOrchestratorDriverWithCooperative,
  createAiAgentRuntimeCoordinator,
} from "@cell/ai-organ-logic"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createMockProcessStream } from "../__test_support__/mockProcessStream"
import {
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
} from "@cell/ai-organ-logic/persistence/RuntimeSnapshots"
import { evaluateAiAgentRuntimeSnapshotSafepoint } from "@cell/ai-runtime-control-logic"
import {
  readXnlRecords,
  readRealSessionDurableHeads,
  writeRuntimeControlCohortCommitFile,
} from "@cell/ai-file-store-logic"
import { applyFileStoreAiRuntimeSessionUpgrade } from "@cell/ai-runtime-control-composer"
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support"
import { configureRuntimePersistenceSupport } from "@cell/ai-organ-logic/persistence/RuntimeSnapshots"

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
})

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-runtime-safepoint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function rewriteRuntimeControlCheckpointForCurrentSessionFiles(sessionDir: string): Promise<void> {
  const heads = await readRealSessionDurableHeads(sessionDir)
  await writeRuntimeControlCohortCommitFile({
    sessionDir,
    cohortId: "checkpoint",
    headSequences: Object.fromEntries(
      Object.entries(heads).map(([headId, head]) => [headId, head.committedSequence]),
    ),
  })
}

async function upgradeRuntimeControlCheckpointForCurrentSessionFiles(sessionDir: string): Promise<void> {
  const result = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
  expect(result.status === "applied" || result.status === "already_upgraded").toBe(true)
}

function createStartToolHalfStepRuntime(options: {
  runStep?: Parameters<typeof createAiAgentOrchestratorDriver>[0]["runStep"]
  sessionId?: string
  sessionDir?: string
} = {}) {
  const actor = createActor({
    key: "main",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "run bash" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_start_tool_half_step",
            name: "bash",
            input: { command: "pwd" },
          },
        ],
      },
    ] as any[],
  })
  const vm = createVM({
    controlActorKey: "main",
    actors: { main: actor },
    outerCtx: {
      metadata: {
        sessionId: options.sessionId,
        sessionDir: options.sessionDir,
      },
    },
  })
  const fiberId = `${actor.key}:${actor.id}`
  const driver = createAiAgentOrchestratorDriver({
    fibers: [{ fiberId, vm, actor, messages: actor.messages, basePriority: 1 }],
    runStep: options.runStep ?? (async () => ({ kind: "yield" as const })),
    options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
  })
  const inspected = driver.inspectRuntime()
  ;(inspected.fibers[fiberId] as any).execState = {
    phase: "start_tool",
    turn: 1,
    tools: [{ type: "function", function: { name: "bash" } }],
    toolCalls: [{ id: "call_start_tool_half_step", name: "bash", input: { command: "pwd" } }],
    toolIndex: 0,
    nextOpSeq: 803,
    pendingToolResults: [],
    pendingAiGenerated: [],
  }
  return { actor, vm, driver, fiberId }
}

const snapshotBlockingMailboxCases: Array<{
  mailboxKind: AiAgentWakeMailbox
  payload: any
  expectedBlocking: boolean
  execState?: Record<string, unknown>
}> = [
  { mailboxKind: "control", payload: { kind: "cancel_requested" }, expectedBlocking: true },
  { mailboxKind: "toolResult", payload: { toolCallId: "call_pending", content: "approved" }, expectedBlocking: true },
  {
    mailboxKind: "asyncCompletion",
    payload: { kind: "llm_done", opId: "llm:main:actor-mailbox:1", msg: { role: "assistant", content: "done" } },
    expectedBlocking: true,
    execState: {
      phase: "wait_llm",
      inflight: { kind: "llm", opId: "llm:main:actor-mailbox:1", turn: 1, tools: [] },
    },
  },
  {
    mailboxKind: "childDone",
    payload: {
      childFiberId: "child",
      childActorKey: "child",
      childActorId: "actor-child",
      mode: "sync_wait",
      outputText: "done",
    },
    expectedBlocking: true,
  },
  { mailboxKind: "memberCoordination", payload: { from: "member", text: "<coordination/>", ts: 1 }, expectedBlocking: true },
  { mailboxKind: "humanInput", payload: "continue", expectedBlocking: true },
  { mailboxKind: "memberChatInbox", payload: { from: "member", text: "done", ts: 1 }, expectedBlocking: true },
  {
    mailboxKind: "heartbeat",
    payload: {
      scheduleId: "hb-1",
      name: "heartbeat",
      kind: "interval",
      description: "wake",
      message: "wake",
      fireCount: 1,
      firedAt: 1,
    },
    expectedBlocking: true,
  },
]

function createReadyMailboxRuntime(params: {
  mailboxKind: AiAgentWakeMailbox
  payload: any
  execState?: Record<string, unknown>
  runStep?: Parameters<typeof createAiAgentOrchestratorDriver>[0]["runStep"]
}) {
  const actor = createActor({
    key: "main",
    id: "actor-mailbox",
    messages: [{ role: "system", content: "system" }] as any[],
  })
  actor.send(params.mailboxKind as any, params.payload)
  const vm = createVM({ controlActorKey: "main", actors: { main: actor } })
  const fiberId = `${actor.key}:${actor.id}`
  const driver = createAiAgentOrchestratorDriver({
    fibers: [{ fiberId, vm, actor, messages: actor.messages, basePriority: 1 }],
    runStep: params.runStep ?? (async () => ({ kind: "yield" as const })),
    options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
  })
  const inspected = driver.inspectRuntime()
  ;(inspected.fibers[fiberId] as any).execState = {
    phase: "drain",
    turn: 1,
    tools: [],
    toolCalls: [],
    toolIndex: 0,
    nextOpSeq: 2,
    pendingToolResults: [],
    pendingAiGenerated: [],
    ...(params.execState ?? {}),
  }
  return { actor, vm, driver, fiberId }
}

function createSuspendedInflightRuntime(params: {
  phase: "wait_llm" | "wait_tool" | "wait_questionnaire_parse" | "compress"
  waitingReason: "wait_llm_result" | "wait_tool_result" | "wait_questionnaire_parse" | "wait_compress_result"
  inflight: Record<string, unknown>
  runStep?: Parameters<typeof createAiAgentOrchestratorDriver>[0]["runStep"]
}) {
  const actor = createActor({
    key: "main",
    id: "actor-inflight",
    messages: [{ role: "system", content: "system" }] as any[],
  })
  const vm = createVM({ controlActorKey: "main", actors: { main: actor } })
  const fiberId = `${actor.key}:${actor.id}`
  const execState = {
    phase: params.phase,
    turn: 68,
    tools: [],
    toolCalls: [],
    toolIndex: 0,
    nextOpSeq: 132,
    pendingToolResults: [],
    pendingAiGenerated: [],
    inflight: params.inflight,
  }
  const driver = createAiAgentOrchestratorDriver({
    fibers: [{ fiberId, vm, actor, messages: actor.messages, basePriority: 1, execState }],
    runStep: params.runStep ?? (async () => ({ kind: "suspend" as const, reason: params.waitingReason as any })),
    options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
  })
  driver.suspendFiber(fiberId, Date.now(), params.waitingReason as any)
  return { vm, driver, fiberId }
}

describe("runtime snapshot safepoints", () => {
  it("disables the orchestration log effect only when log storage is off", () => {
    const actor = createActor({ key: "main" })
    const orchestrationHistory = {
      appendEvent: () => {},
    }

    // The message-history write effect port has been removed (it was a no-op
    // shim); disabling file storage no longer toggles any history effect, but
    // the orchestration log effect must remain intact.
    const filesDisabledVm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      options: { storage: { files: false } },
      effects: { orchestrationHistory },
    })
    expect(filesDisabledVm.effects.orchestrationHistory).toBe(orchestrationHistory)

    const logsDisabledVm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      options: { storage: { logs: false } },
      effects: { orchestrationHistory },
    })
    expect(logsDisabledVm.effects.orchestrationHistory).toBeUndefined()
  })

  it("classifies ready start_tool without durable tool operation as a non-safepoint", () => {
    const { vm, driver, fiberId } = createStartToolHalfStepRuntime()

    const result = evaluateAiAgentRuntimeSnapshotSafepoint({ vm, inspected: driver.inspectRuntime() })

    expect(result.safe).toBe(false)
    expect(result.blockers).toContainEqual(expect.objectContaining({
      fiberId,
      phase: "start_tool",
      reason: "mandatory_continuation",
    }))
    expect(JSON.stringify(result)).not.toContain("pwd")
  })

  it("classifies start_tool after the last tool result as a mandatory continuation", () => {
    // Historical session 20260604001602__01KT74AEF400CGVZ5X318GJM8Y:
    // after a tool result was consumed, the cooperative state stayed at
    // start_tool with toolIndex === toolCalls.length. Headless exec treated
    // that as settled and returned with no final assistant message.
    const { vm, driver, fiberId } = createStartToolHalfStepRuntime()
    const inspected = driver.inspectRuntime()
    const execState = (inspected.fibers[fiberId] as any).execState
    execState.toolIndex = execState.toolCalls.length

    const result = evaluateAiAgentRuntimeSnapshotSafepoint({ vm, inspected })

    expect(result.safe).toBe(false)
    expect(result.blockers).toContainEqual(expect.objectContaining({
      fiberId,
      phase: "start_tool",
      reason: "mandatory_continuation",
    }))
  })

  it("classifies ready start_llm after a tool result as a mandatory continuation", () => {
    // Historical session 20260604001602__01KT74AEF400CGVZ5X318GJM8Y:
    // after "请继续", the restored turn consumed tool output, reached
    // start_llm, and was incorrectly considered safepoint-safe. Headless exec
    // then returned runtime_turn_completed_without_final_output instead of
    // asking the model for the next assistant message.
    const { vm, driver, fiberId } = createStartToolHalfStepRuntime()
    const inspected = driver.inspectRuntime()
    const execState = (inspected.fibers[fiberId] as any).execState
    execState.phase = "start_llm"
    execState.toolIndex = execState.toolCalls.length

    const result = evaluateAiAgentRuntimeSnapshotSafepoint({ vm, inspected })

    expect(result.safe).toBe(false)
    expect(result.blockers).toContainEqual(expect.objectContaining({
      fiberId,
      phase: "start_llm",
      reason: "mandatory_continuation",
    }))
  })

  it("classifies suspended wait_llm with live inflight as a non-safepoint", () => {
    // Historical session 20260604001602__01KT74AEF400CGVZ5X318GJM8Y:
    // checkpoint saves were allowed after provider_completion request/waiting
    // evidence for op 131, but before result/failed evidence existed. That
    // persisted an unfinishable wait_llm state and the recovered session stopped
    // after a few more turns.
    const { vm, driver, fiberId } = createSuspendedInflightRuntime({
      phase: "wait_llm",
      waitingReason: "wait_llm_result",
      inflight: {
        kind: "llm",
        opId: "llm:main:actor-inflight:131",
        turn: 68,
        tools: [],
      },
    })

    const result = evaluateAiAgentRuntimeSnapshotSafepoint({ vm, inspected: driver.inspectRuntime() })

    expect(result.safe).toBe(false)
    expect(result.blockers).toContainEqual(expect.objectContaining({
      fiberId,
      phase: "wait_llm",
      reason: "mandatory_continuation",
    }))
  })

  it("classifies suspended wait_tool with live inflight as a non-safepoint", () => {
    const { vm, driver, fiberId } = createSuspendedInflightRuntime({
      phase: "wait_tool",
      waitingReason: "wait_tool_result",
      inflight: {
        kind: "tool",
        opId: "tool:main:actor-inflight:130",
        funcName: "bash",
        toolCallId: "call_inflight_tool",
        args: { command: "sleep 5" },
      },
    })

    const result = evaluateAiAgentRuntimeSnapshotSafepoint({ vm, inspected: driver.inspectRuntime() })

    expect(result.safe).toBe(false)
    expect(result.blockers).toContainEqual(expect.objectContaining({
      fiberId,
      phase: "wait_tool",
      reason: "mandatory_continuation",
    }))
  })

  for (const { mailboxKind, payload, expectedBlocking, execState } of snapshotBlockingMailboxCases) {
    it(`classifies ready actor with pending ${mailboxKind} mailbox work`, () => {
      const { vm, driver, fiberId } = createReadyMailboxRuntime({ mailboxKind, payload, execState })

      const result = evaluateAiAgentRuntimeSnapshotSafepoint({ vm, inspected: driver.inspectRuntime() })

      expect(result.safe).toBe(!expectedBlocking)
      if (expectedBlocking) {
        expect(result.blockers).toContainEqual(expect.objectContaining({
          fiberId,
          reason: "pending_mailbox_work",
          mailboxKinds: [mailboxKind],
        }))
      } else {
        expect(result.blockers).toEqual([])
      }
      expect(JSON.stringify(result)).not.toContain(JSON.stringify(payload))
    })
  }

  it("does not treat questionnaire_pending control marker as mailbox work by itself", () => {
    const { vm, driver } = createReadyMailboxRuntime({
      mailboxKind: "control",
      payload: {
        kind: "questionnaire_pending",
        toolCallId: "call_questionnaire",
        questionnaireId: "q-call_questionnaire",
        suspendPolicy: "pause_all",
      },
    })

    const result = evaluateAiAgentRuntimeSnapshotSafepoint({ vm, inspected: driver.inspectRuntime() })

    expect(result.safe).toBe(true)
    expect(result.blockers).toEqual([])
  })

  it("does not write latest snapshot when start_tool is not snapshot-safe", async () => {
    const sessionDir = makeTempSessionDir()
    const { actor, vm, driver } = createStartToolHalfStepRuntime({
      sessionId: "session-start-tool-half-step",
      sessionDir,
    })
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "buffer until safepoint" } as any,
      occurredAt: "2026-06-05T03:30:00.000Z",
    })

    try {
      const result = await saveAiAgentRuntimeSnapshot({
        sessionDir,
        sessionId: "session-start-tool-half-step",
        vm,
        driver,
      })

      expect(result.status).toBe("skipped_non_safepoint")
      expect(fs.existsSync(path.join(sessionDir, "runtime_state", "manifest.json"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "cohorts", "checkpoint.commit.json"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history.index.json"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history-generations", "main__active.json"))).toBe(false)
      expect(result.safepoint.blockers).toEqual([
        expect.objectContaining({
          phase: "start_tool",
          reason: "mandatory_continuation",
        }),
      ])
      expect(JSON.stringify(result.safepoint.blockers)).not.toContain("pwd")
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("does not write non-log session files when runtime storage files are disabled", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-storage-files-disabled"
    const actor = createActor({
      key: "main",
      id: "actor-main",
      messages: [{ role: "user", content: "run without persistence" }] as any[],
    })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      options: { storage: { files: false } },
      outerCtx: {
        metadata: { sessionId, sessionDir },
      },
    })
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: actor.messages, basePriority: 1 }],
      runStep: async () => ({ kind: "complete" as const }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    try {
      const result = await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

      expect(result.status).toBe("skipped_storage_disabled")
      expect(fs.existsSync(path.join(sessionDir, "runtime_state"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "runtime-control"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "conversation"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "actors"))).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("does not schedule checkpoint writes or diagnostics when runtime storage files are disabled", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-coordinator-storage-files-disabled"
    const actor = createActor({
      key: "main",
      id: "actor-main",
      messages: [{ role: "user", content: "settle without checkpoint" }] as any[],
    })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      options: { storage: { files: false, logs: true } },
      outerCtx: {
        metadata: { sessionId, sessionDir },
      },
    })
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: actor.messages, basePriority: 1 }],
      runStep: async () => ({ kind: "complete" as const }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    let saveCalls = 0
    const coordinator = createAiAgentRuntimeCoordinator({
      vm,
      driver,
      saveSnapshot: async () => {
        saveCalls += 1
      },
    })

    try {
      await coordinator.saveSnapshot()

      expect(saveCalls).toBe(0)
      expect(fs.existsSync(path.join(sessionDir, "logs", "diagnostics.xnl"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "runtime_state"))).toBe(false)
    } finally {
      coordinator.dispose()
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("does not write diagnostics when only runtime log storage is disabled", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-log-storage-disabled"
    const actor = createActor({
      key: "main",
      id: "actor-main",
      messages: [{ role: "user", content: "persist without logs" }] as any[],
    })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      options: { storage: { files: true, logs: false } },
      outerCtx: {
        metadata: { sessionId, sessionDir },
      },
    })
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "persist without logs" } as any,
      occurredAt: "2026-06-05T03:31:00.000Z",
    })
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: actor.messages, basePriority: 1 }],
      runStep: async () => ({ kind: "complete" as const }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    try {
      const result = await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

      expect(result.status).toBe("saved")
      expect(fs.existsSync(path.join(sessionDir, "conversation", "history.xnl"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "logs", "diagnostics.xnl"))).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("can complete an ordinary LLM turn with both runtime storage switches disabled", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-storage-disabled-ordinary-turn"
    const actor = createActor({
      key: "main",
      id: "actor-main",
      llmClient: {
        type: "mock",
        createStream: async () => ({ stream: {} }),
      } as any,
      modelConfig: { model: "mock-model" } as any,
      messages: [{ role: "user", content: "hello?" }] as any[],
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async () => ({ role: "assistant", content: "hello from mock" })),
      } as any,
    })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      registries: { toolRegistry: new ToolFuncRegistry() as any },
      options: { storage: { files: false, logs: false } },
      outerCtx: {
        metadata: { sessionId, sessionDir },
      },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${actor.key}:${actor.id}`, vm, actor, messages: actor.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const coordinator = createAiAgentRuntimeCoordinator({ vm, driver })

    try {
      const result = await coordinator.runInteractiveTurn({
        mainFiberId: `${actor.key}:${actor.id}`,
        timeoutMs: 3000,
      })

      expect(result).toEqual({ status: "settled", safepointSafe: true })
      expect(actor.messages.at(-1)).toMatchObject({ role: "assistant", content: "hello from mock" })
      expect(fs.readdirSync(sessionDir)).toEqual([])
    } finally {
      coordinator.dispose()
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("flushes buffered conversation state only after the runtime reaches a safepoint", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-conversation-safepoint"
    const actor = createActor({
      key: "main",
      id: "actor-main",
      messages: [{ role: "user", content: "persist at safepoint" }] as any[],
    })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      outerCtx: {
        metadata: { sessionId, sessionDir },
      },
    })
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "persist at safepoint" } as any,
      occurredAt: "2026-06-05T03:31:00.000Z",
    })
    const fiberId = `${actor.key}:${actor.id}`
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages: actor.messages, basePriority: 1 }],
      runStep: async () => ({ kind: "yield" as const }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    try {
      const result = await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

      expect(result.status).toBe("saved")
      const records = await readXnlRecords({
        filePath: path.join(sessionDir, "conversation", "history.xnl"),
        tag: "HistoryMessage",
      })
      expect(records).toHaveLength(1)
      expect(records[0].metadata.generationId).toBeTruthy()
      expect(records[0].metadata.blockCount).toBe(1)
      expect(records[0].body[0]).toEqual(expect.objectContaining({
        kind: "text",
        tag: "Content",
        text: "persist at safepoint",
      }))
      expect(fs.existsSync(path.join(sessionDir, "runtime_state", "manifest.json"))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "cohorts", "checkpoint.commit.json"))).toBe(true)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("does not duplicate conversation history when the same safepoint is checkpointed repeatedly", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-conversation-repeat-safepoint"
    const actor = createActor({
      key: "main",
      id: "actor-main",
      messages: [{ role: "user", content: "persist once" }] as any[],
    })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      outerCtx: {
        metadata: { sessionId, sessionDir },
      },
    })
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "persist once" } as any,
      occurredAt: "2026-06-05T03:31:00.000Z",
    })
    const fiberId = `${actor.key}:${actor.id}`
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages: actor.messages, basePriority: 1 }],
      runStep: async () => ({ kind: "yield" as const }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    try {
      const first = await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })
      const second = await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

      expect(first.status).toBe("saved")
      expect(second.status).toBe("saved")
      const records = await readXnlRecords({
        filePath: path.join(sessionDir, "conversation", "history.xnl"),
        tag: "HistoryMessage",
      })
      expect(records).toHaveLength(1)
      expect(records[0].metadata.id).toBe("main__active::0")
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("direct snapshot writer skips start_tool half-step without scheduling runtime progress", async () => {
    const sessionDir = makeTempSessionDir()
    let advanced = false
    const runtime = createStartToolHalfStepRuntime({
      runStep: async () => {
        advanced = true
        return { kind: "yield" as const }
      },
    })

    try {
      const result = await saveAiAgentRuntimeSnapshot({
        sessionDir,
        sessionId: "session-start-tool-direct-save",
        vm: runtime.vm,
        driver: runtime.driver,
      })

      expect(result.status).toBe("skipped_non_safepoint")
      expect(advanced).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "runtime_state", "manifest.json"))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "runtime-control", "cohorts", "checkpoint.commit.json"))).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("coordinator skips physical snapshot while async effect is only durably requested", async () => {
    const sessionDir = makeTempSessionDir()
    let advanced = false
    let saveResult: Awaited<ReturnType<typeof saveAiAgentRuntimeSnapshot>> | null = null
    const runtime = createReadyMailboxRuntime({
      mailboxKind: "asyncCompletion",
      payload: {
        kind: "llm_done",
        opId: "llm:main:actor-mailbox:7",
        msg: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_after_llm_done",
              type: "function",
              function: { name: "bash", arguments: "{\"command\":\"pwd\"}" },
            },
          ],
        },
      },
      execState: {
        phase: "wait_llm",
        inflight: { kind: "llm", opId: "llm:main:actor-mailbox:7", turn: 1, tools: [] },
      },
      runStep: async (ctx: any) => {
        advanced = true
        ctx.actor.drainMailbox("asyncCompletion")
        ctx.execState = {
          phase: "wait_tool",
          turn: 1,
          tools: [{ type: "function", function: { name: "bash" } }],
          toolCalls: [{ id: "call_after_llm_done", name: "bash", input: { command: "pwd" } }],
          toolIndex: 0,
          nextOpSeq: 8,
          pendingToolResults: [],
          pendingAiGenerated: [],
          inflight: {
            kind: "tool",
            opId: `tool:${ctx.fiberId}:7`,
            funcName: "bash",
            toolCallId: "call_after_llm_done",
            args: { command: "pwd" },
          },
        }
        runtime.vm.sessionState.controlSignals.events = [
          {
            eventId: "ctrl_wait_tool_after_llm",
            sequence: 1,
            actorKey: "main",
            fiberId: ctx.fiberId,
            signalKind: "async_completed",
            signalClass: "wake",
            priority: 10,
            opId: `tool:${ctx.fiberId}:7`,
            toolCallId: "call_after_llm_done",
            idempotencyKey: "wait-tool-after-llm-proof",
            createdAt: 1,
          },
        ] as any
        runtime.vm.sessionState.controlSignals.idempotencyIndex = {
          "wait-tool-after-llm-proof": "ctrl_wait_tool_after_llm",
        }
        return { kind: "suspend" as const, reason: "wait_tool_result" as any }
      },
    })

    try {
      const coordinator = createAiAgentRuntimeCoordinator({
        vm: runtime.vm,
        driver: runtime.driver,
        saveSnapshot: async () => {
          saveResult = await saveAiAgentRuntimeSnapshot({
            sessionDir,
            sessionId: "session-async-completion-progress",
            vm: runtime.vm,
            driver: runtime.driver,
          })
        },
      })
      await coordinator.enqueue(async () => {})

      expect(advanced).toBe(true)
      expect(saveResult).toBeNull()
      expect(runtime.actor.peekMailbox("asyncCompletion")).toEqual([])
      expect(fs.existsSync(path.join(sessionDir, "runtime_state", "manifest.json"))).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("coordinator advances mandatory start_tool but skips snapshot until tool completion is available", async () => {
    const sessionDir = makeTempSessionDir()
    let advanced = false
    let saveResult: Awaited<ReturnType<typeof saveAiAgentRuntimeSnapshot>> | null = null
    const runtime = createStartToolHalfStepRuntime({
      runStep: async (ctx: any) => {
        advanced = true
        ctx.execState = {
          phase: "wait_tool",
          turn: 1,
          tools: [{ type: "function", function: { name: "bash" } }],
          toolCalls: [{ id: "call_start_tool_half_step", name: "bash", input: { command: "pwd" } }],
          toolIndex: 0,
          nextOpSeq: 804,
          pendingToolResults: [],
          pendingAiGenerated: [],
          inflight: {
            kind: "tool",
            opId: `tool:${ctx.fiberId}:803`,
            funcName: "bash",
            toolCallId: "call_start_tool_half_step",
            args: { command: "pwd" },
          },
        }
        runtime.vm.sessionState.controlSignals.events = [
          {
            eventId: "ctrl_wait_tool",
            sequence: 1,
            actorKey: "main",
            fiberId: ctx.fiberId,
            signalKind: "async_completed",
            signalClass: "wake",
            priority: 10,
            opId: `tool:${ctx.fiberId}:803`,
            toolCallId: "call_start_tool_half_step",
            idempotencyKey: "wait-tool-proof",
            createdAt: 1,
          },
        ] as any
        runtime.vm.sessionState.controlSignals.idempotencyIndex = {
          "wait-tool-proof": "ctrl_wait_tool",
        }
        return { kind: "suspend" as const, reason: "wait_tool_result" as any }
      },
    })

    try {
      const coordinator = createAiAgentRuntimeCoordinator({
        vm: runtime.vm,
        driver: runtime.driver,
        saveSnapshot: async () => {
          saveResult = await saveAiAgentRuntimeSnapshot({
            sessionDir,
            sessionId: "session-start-tool-progress",
            vm: runtime.vm,
            driver: runtime.driver,
          })
        },
      })
      await coordinator.enqueue(async () => {})

      expect(advanced).toBe(true)
      expect(saveResult).toBeNull()
      expect(fs.existsSync(path.join(sessionDir, "runtime_state", "manifest.json"))).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("coordinator does not fail the interactive turn when persistence is not checkpoint-safe by deadline", async () => {
    const sessionDir = makeTempSessionDir()
    let saveCalled = false
    const runtime = createStartToolHalfStepRuntime({
      runStep: async (ctx: any) => {
        ctx.execState = {
          phase: "wait_tool",
          turn: 1,
          tools: [{ type: "function", function: { name: "bash" } }],
          toolCalls: [{ id: "call_start_tool_half_step", name: "bash", input: { command: "pwd" } }],
          toolIndex: 0,
          nextOpSeq: 804,
          pendingToolResults: [],
          pendingAiGenerated: [],
          inflight: {
            kind: "tool",
            opId: `tool:${ctx.fiberId}:803`,
            funcName: "bash",
            toolCallId: "call_start_tool_half_step",
            args: { command: "pwd" },
          },
        }
        return { kind: "suspend" as const, reason: "wait_tool_result" as any }
      },
    })

    try {
      const coordinator = createAiAgentRuntimeCoordinator({
        vm: runtime.vm,
        driver: runtime.driver,
        saveSnapshot: async () => {
          saveCalled = true
          await saveAiAgentRuntimeSnapshot({
            sessionDir,
            sessionId: "session-interactive-turn-deadline",
            vm: runtime.vm,
            driver: runtime.driver,
          })
        },
      })

      await expect(coordinator.runInteractiveTurn({
        mainFiberId: runtime.fiberId,
        timeoutMs: 1,
      })).resolves.toEqual({
        status: "timeout_unsettled",
        safepointSafe: false,
        reason: "mandatory_continuation",
      })

      expect(saveCalled).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, "runtime_state", "manifest.json"))).toBe(false)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("coordinator keeps driving mandatory continuations until a safepoint is reached", async () => {
    let tickCount = 0
    let saveCalled = false
    const actor = createActor({ key: "main", messages: [] })
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } })
    const fiberId = `${actor.key}:${actor.id}`
    let execState: any = {
      phase: "wait_tool",
      inflight: {
        kind: "tool",
        opId: `tool:${fiberId}:1`,
        funcName: "bash",
      },
    }
    const driver = {
      resumeFiber: () => {},
      async tickUntilForegroundSettled() {
        tickCount += 1
        if (tickCount >= 2) {
          execState = { phase: "idle" }
        }
      },
      inspectRuntime() {
        return {
          fibers: {
            [fiberId]: { fiberId, actor, execState },
          },
          state: {
            fibers: {
              [fiberId]: { status: "suspended" },
            },
          },
        }
      },
    } as any
    const coordinator = createAiAgentRuntimeCoordinator({
      vm,
      driver,
      saveSnapshot: async () => {
        saveCalled = true
      },
    })

    const result = await coordinator.runInteractiveTurn({
      mainFiberId: fiberId,
      timeoutMs: 2000,
    })

    expect(result).toEqual({ status: "settled", safepointSafe: true })
    expect(tickCount).toBe(2)
    expect(saveCalled).toBe(true)
    expect(evaluateAiAgentRuntimeSnapshotSafepoint({
      vm,
      inspected: driver.inspectRuntime(),
    }).safe).toBe(true)
  })

  it("allows start_tool when a durable tool operation proof exists", () => {
    const { vm, driver, fiberId } = createStartToolHalfStepRuntime()
    vm.sessionState.controlSignals.consumedTombstones = {
      ctrl_tool_started: {
        eventId: "ctrl_tool_started",
        sequence: 1,
        actorKey: "main",
        fiberId,
        signalKind: "async_completed",
        signalClass: "wake",
        priority: 10,
        toolCallId: "call_start_tool_half_step",
        idempotencyKey: "tool-started-proof",
        createdAt: 1,
        consumedAt: 2,
      },
    } as any

    const result = evaluateAiAgentRuntimeSnapshotSafepoint({ vm, inspected: driver.inspectRuntime() })

    expect(result.safe).toBe(true)
    expect(result.blockers).toEqual([])
  })

  it("diagnoses a recovered historical start_tool half-step snapshot", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-recovered-start-tool-half-step"
    const { vm, driver, fiberId } = createStartToolHalfStepRuntime()

    try {
      vm.sessionState.controlSignals.consumedTombstones = {
        ctrl_tool_started: {
          eventId: "ctrl_tool_started",
          sequence: 1,
          actorKey: "main",
          fiberId,
          signalKind: "async_completed",
          signalClass: "wake",
          priority: 10,
          toolCallId: "call_start_tool_half_step",
          idempotencyKey: "tool-started-proof",
          createdAt: 1,
          consumedAt: 2,
        },
      } as any
      await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

      const vmPath = path.join(sessionDir, "runtime_state", "vm.json")
      const persistedVm = JSON.parse(fs.readFileSync(vmPath, "utf-8"))
      persistedVm.sessionState.controlSignals.consumedTombstones = {}
      persistedVm.sessionState.controlSignals.consumedEventIds = {}
      persistedVm.sessionState.controlSignals.idempotencyIndex = {}
      persistedVm.sessionState.controlSignals.consumedCheckpoint = { sequence: 0 }
      fs.writeFileSync(vmPath, `${JSON.stringify(persistedVm, null, 2)}\n`)
      await rewriteRuntimeControlCheckpointForCurrentSessionFiles(sessionDir)
      await upgradeRuntimeControlCheckpointForCurrentSessionFiles(sessionDir)

      const recovered = await recoverAiAgentRuntime({ sessionDir, sessionId })

      expect(recovered).toBeTruthy()
      const safepoint = evaluateAiAgentRuntimeSnapshotSafepoint({
        vm: recovered!.vm,
        inspected: recovered!.driver.inspectRuntime(),
      })
      expect(safepoint.blockers).toEqual([
        expect.objectContaining({
          fiberId,
          phase: "start_tool",
          reason: "mandatory_continuation",
        }),
      ])
      expect(JSON.stringify(safepoint.blockers)).not.toContain("pwd")
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})
