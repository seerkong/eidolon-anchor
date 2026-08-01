import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { createActor, createVM } from "@cell/ai-core-logic"
import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  createAiAgentOrchestratorDriver,
  createAiAgentRuntimeCoordinator,
} from "@cell/ai-organ-logic"
import {
  configureRuntimePersistenceSupport,
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
  sealCompletedConversationProgress,
} from "@cell/ai-organ-logic/persistence/RuntimeSnapshots"
import { evaluateAiAgentRuntimeSnapshotSafepoint } from "@cell/ai-runtime-control-logic"
import { readXnlRecords } from "@cell/ai-file-store-logic"
import { applyFileStoreAiRuntimeSessionUpgrade } from "@cell/ai-runtime-control-composer"
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support"

/**
 * P3 (track harden-runtime-session-robustness), behavior-delta requirement
 * `timed-out-turn-progress-persisted`, cases:
 *   - completed-progress-sealed-on-timeout
 *   - continuation-resumes-not-restarts
 *
 * SCENARIO (the (b) fix): a turn completes N tool pairs (already committed into
 * the in-memory conversation domain) and then times out in
 * mandatory_continuation (returns timeout_unsettled). The runtime SHALL seal the
 * completed conversation progress into persisted history WITHOUT snapshotting the
 * unsafe in-flight tool execution (no VM/ToolCallDomain in-flight snapshot). A
 * subsequent continuation that recovers the session SHALL see the completed
 * progress (relay, not bare restart), and recovery SHALL tolerate conversation
 * history being AHEAD of the last VM snapshot.
 */

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
})

function makeTempSessionDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `eidolon-timed-out-progress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Build a runtime whose fiber is parked at a `start_tool` mandatory-continuation
 * non-safepoint (the historical 20260604 timeout shape). The cooperative
 * runStep never reaches a safepoint, so runInteractiveTurn with a tiny deadline
 * returns timeout_unsettled. The conversation domain is pre-loaded with the
 * COMPLETED progress of the current turn (a user message + the assistant
 * tool-call message + the paired tool result) — i.e. the "N completed tool
 * pairs already committed into the conversation domain" precondition.
 */
function createTimedOutTurnRuntime(options: { sessionId: string; sessionDir: string }) {
  const actor = createActor({
    key: "main",
    id: "actor-main",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "do the long job" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_completed_pair", name: "bash", input: { command: "echo done" } },
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

  // COMPLETED progress already committed into the in-memory conversation domain.
  appendLiveHistoryMessageToConversationDomainRuntime({
    vm,
    actorKey: actor.key,
    actorId: actor.id,
    message: { role: "user", content: "do the long job" } as any,
    occurredAt: "2026-06-05T03:30:00.000Z",
  })
  appendLiveHistoryMessageToConversationDomainRuntime({
    vm,
    actorKey: actor.key,
    actorId: actor.id,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_completed_pair",
          type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command: "echo done" }) },
        },
      ],
    } as any,
    occurredAt: "2026-06-05T03:30:01.000Z",
  })
  appendLiveHistoryMessageToConversationDomainRuntime({
    vm,
    actorKey: actor.key,
    actorId: actor.id,
    message: {
      role: "tool",
      tool_call_id: "call_completed_pair",
      content: "COMPLETED-PROGRESS: echo done output",
    } as any,
    occurredAt: "2026-06-05T03:30:02.000Z",
  })

  const fiberId = `${actor.key}:${actor.id}`
  const driver = createAiAgentOrchestratorDriver({
    fibers: [{ fiberId, vm, actor, messages: actor.messages, basePriority: 1 }],
    // The next half-step would start a NEW (in-flight, unsafe) tool — it is never
    // allowed to reach a safepoint within the deadline.
    runStep: async (ctx: any) => {
      ctx.execState = {
        phase: "wait_tool",
        turn: 2,
        tools: [{ type: "function", function: { name: "bash" } }],
        toolCalls: [{ id: "call_in_flight", name: "bash", input: { command: "sleep 999" } }],
        toolIndex: 0,
        nextOpSeq: 9,
        pendingToolResults: [],
        pendingAiGenerated: [],
        inflight: {
          kind: "tool",
          opId: `tool:${ctx.fiberId}:8`,
          funcName: "bash",
          toolCallId: "call_in_flight",
          args: { command: "sleep 999" },
        },
      }
      return { kind: "suspend" as const, reason: "wait_tool_result" as any }
    },
    options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
  })
  // Park at the mandatory-continuation non-safepoint shape.
  const inspected = driver.inspectRuntime()
  ;(inspected.fibers[fiberId] as any).execState = {
    phase: "start_tool",
    turn: 2,
    tools: [{ type: "function", function: { name: "bash" } }],
    toolCalls: [{ id: "call_in_flight", name: "bash", input: { command: "sleep 999" } }],
    toolIndex: 0,
    nextOpSeq: 8,
    pendingToolResults: [],
    pendingAiGenerated: [],
  }
  return { actor, vm, driver, fiberId }
}

describe("timed-out turn persists completed progress", () => {
  // MECHANISM (case 1): the seal callback is injected DIRECTLY into the
  // coordinator. This proves `sealCompletedConversationProgress` flushes
  // completed pairs WITHOUT snapshotting in-flight tool execution.
  it("MECHANISM (direct injection): seals completed conversation progress on timeout without snapshotting in-flight tool execution", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-timed-out-progress-seal"
    const { vm, driver, fiberId } = createTimedOutTurnRuntime({ sessionId, sessionDir })

    const saveSnapshot = async () =>
      await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })
    // Inject the seal DIRECTLY (unit-level) — NOT via the production bootstrap,
    // which leaves the coordinator's `sealCompletedProgress` at its default no-op.
    const sealCompletedProgress = async () =>
      await sealCompletedConversationProgress({ sessionDir, sessionId, vm })
    const coordinator = createAiAgentRuntimeCoordinator({ vm, driver, saveSnapshot, sealCompletedProgress })

    try {
      const result = await coordinator.runInteractiveTurn({ mainFiberId: fiberId, timeoutMs: 1 })

      expect(result).toEqual({
        status: "timeout_unsettled",
        safepointSafe: false,
        reason: "mandatory_continuation",
      })

      // (1) Completed conversation progress IS sealed into persisted history.
      const historyPath = path.join(sessionDir, "conversation", "history.xnl")
      expect(fs.existsSync(historyPath)).toBe(true)
      const records = await readXnlRecords({ filePath: historyPath, tag: "HistoryMessage" })
      const serialized = JSON.stringify(records)
      expect(serialized).toContain("COMPLETED-PROGRESS: echo done output")
      expect(serialized).toContain("call_completed_pair")

      // (2) The in-flight (unsafe) tool execution is NOT snapshotted — no VM
      // snapshot manifest, no checkpoint commit (the safepoint invariant holds).
      expect(fs.existsSync(path.join(sessionDir, "runtime_state", "manifest.json"))).toBe(false)
      expect(
        fs.existsSync(path.join(sessionDir, "runtime-control", "cohorts", "checkpoint.commit.json")),
      ).toBe(false)
      // The in-flight tool's command must never reach disk.
      expect(serialized).not.toContain("sleep 999")
    } finally {
      coordinator.dispose()
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("recovers from injected sealed progress when conversation advances past the checkpoint", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-timed-out-progress-relay"

    // --- Turn 1: a clean settled safepoint establishes a real VM snapshot +
    // checkpoint marker (the "last VM snapshot" baseline). ---
    {
      const actor = createActor({
        key: "main",
        id: "actor-main",
        messages: [{ role: "user", content: "first settled turn" }] as any[],
      })
      const vm = createVM({
        controlActorKey: "main",
        actors: { main: actor },
        outerCtx: { metadata: { sessionId, sessionDir } },
      })
      appendLiveHistoryMessageToConversationDomainRuntime({
        vm,
        actorKey: actor.key,
        actorId: actor.id,
        message: { role: "user", content: "first settled turn" } as any,
        occurredAt: "2026-06-05T03:29:00.000Z",
      })
      const fiberId = `${actor.key}:${actor.id}`
      const driver = createAiAgentOrchestratorDriver({
        fibers: [{ fiberId, vm, actor, messages: actor.messages, basePriority: 1 }],
        runStep: async () => ({ kind: "yield" as const }),
        options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
      })
      const saved = await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })
      expect(saved.status).toBe("saved")
      const upgrade = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      expect(upgrade.status === "applied" || upgrade.status === "already_upgraded").toBe(true)
    }

    // --- Turn 2: completes more progress, then times out in
    // mandatory_continuation. The flush seals it; the VM snapshot stays at the
    // turn-1 version, so conversation history is now AHEAD of the snapshot. ---
    const { vm, driver, fiberId } = createTimedOutTurnRuntime({ sessionId, sessionDir })
    const saveSnapshot = async () =>
      await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })
    const sealCompletedProgress = async () =>
      await sealCompletedConversationProgress({ sessionDir, sessionId, vm })
    const coordinator = createAiAgentRuntimeCoordinator({
      vm,
      driver,
      saveSnapshot,
      sealCompletedProgress,
    })

    try {
      const result = await coordinator.runInteractiveTurn({ mainFiberId: fiberId, timeoutMs: 1 })
      expect(result.status).toBe("timeout_unsettled")

      // The completed progress is durably sealed on disk on timeout, past the
      // turn-1 checkpoint — no data loss and no VM snapshot of unsafe in-flight
      // execution.
      const historyPath = path.join(sessionDir, "conversation", "history.xnl")
      const records = await readXnlRecords({ filePath: historyPath, tag: "HistoryMessage" })
      expect(JSON.stringify(records)).toContain("COMPLETED-PROGRESS: echo done output")

      const recovered = await recoverAiAgentRuntime({ sessionDir, sessionId })
      expect(recovered.controlActor.messages.some((message: any) =>
        message?.role === "tool" && message?.content === "COMPLETED-PROGRESS: echo done output",
      )).toBe(true)
    } finally {
      coordinator.dispose()
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("production seal callback makes a settled-then-timed-out session recover with sealed progress", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-timed-out-progress-no-seal"

    // --- Turn 1: clean settled safepoint → real VM snapshot + checkpoint marker. ---
    {
      const actor = createActor({
        key: "main",
        id: "actor-main",
        messages: [{ role: "user", content: "first settled turn" }] as any[],
      })
      const vm = createVM({
        controlActorKey: "main",
        actors: { main: actor },
        outerCtx: { metadata: { sessionId, sessionDir } },
      })
      appendLiveHistoryMessageToConversationDomainRuntime({
        vm,
        actorKey: actor.key,
        actorId: actor.id,
        message: { role: "user", content: "first settled turn" } as any,
        occurredAt: "2026-06-05T03:29:00.000Z",
      })
      const fiberId = `${actor.key}:${actor.id}`
      const driver = createAiAgentOrchestratorDriver({
        fibers: [{ fiberId, vm, actor, messages: actor.messages, basePriority: 1 }],
        runStep: async () => ({ kind: "yield" as const }),
        options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
      })
      const saved = await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })
      expect(saved.status).toBe("saved")
      const upgrade = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      expect(upgrade.status === "applied" || upgrade.status === "already_upgraded").toBe(true)
    }

    const historyPath = path.join(sessionDir, "conversation", "history.xnl")

    // --- Turn 2: completes more progress, then times out in mandatory_continuation
    // under the production coordinator configuration. The completed progress is
    // sealed; the conversation head can advance beyond the turn-1 checkpoint
    // without making recovery dirty. ---
    const { vm, driver, fiberId } = createTimedOutTurnRuntime({ sessionId, sessionDir })
    const saveSnapshot = async () =>
      await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })
    const sealCompletedProgress = async () =>
      await sealCompletedConversationProgress({ sessionDir, sessionId, vm })
    const coordinator = createAiAgentRuntimeCoordinator({ vm, driver, saveSnapshot, sealCompletedProgress })

    try {
      const result = await coordinator.runInteractiveTurn({ mainFiberId: fiberId, timeoutMs: 1 })
      expect(result.status).toBe("timeout_unsettled")

      const sealedHistoryAfter = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, "utf8") : ""
      expect(sealedHistoryAfter).toContain("COMPLETED-PROGRESS: echo done output")

      const recovered = await recoverAiAgentRuntime({ sessionDir, sessionId })
      expect(recovered.controlActor.messages.some((message: any) =>
        message?.role === "user" && message?.content === "first settled turn",
      )).toBe(true)
      expect(recovered.controlActor.messages.some((message: any) =>
        message?.role === "tool" && message?.content === "COMPLETED-PROGRESS: echo done output",
      )).toBe(true)
    } finally {
      coordinator.dispose()
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})
