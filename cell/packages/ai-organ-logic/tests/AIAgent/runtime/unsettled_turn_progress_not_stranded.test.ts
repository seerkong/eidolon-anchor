/**
 * Track fix-frozen-session-history, requirement
 * `unsettled-turn-progress-not-stranded`, case
 * `buffered-progress-flushed-on-turn-end`.
 *
 * REAL SESSION EVIDENCE (20260916195258__01M2NJ5J13HCNR63X950KTPJXS):
 *   runtime_conversation_flush          n=32, last at 20:28:44
 *   runtime_conversation_history_buffered n=573, 159 of them AFTER that flush
 *                                          (last at 20:44:57)
 *   runtime self-reported messageCount  4362
 *   persisted history.xnl               4203   <- 159 messages only in memory
 *   runtime_checkpoint_save_skipped     20:28:52 status=skipped_non_safepoint
 *   fiber                                status=suspended waitingReason=idle_external
 *   orchestration head                   pendingMailboxes=["humanInput"]
 *
 * The turn never reached a safepoint, so the ONLY conversation-flush exit
 * (`sealCompletedProgress`, called from the `timeout_unsettled` branch) never
 * ran. The user's "continue" was accepted into the mailbox, but neither the
 * durable history nor the TUI live stream ever showed it.
 *
 * These tests pin the missing exit: a turn that ends WITHOUT settling — the
 * user cancelled it, i.e. the pump was interrupted rather than timed out —
 * must still flush the progress the conversation domain already completed,
 * while leaving genuinely in-flight work out of that flushed progress.
 *
 * NOTE on the VM snapshot: cancelling clears the fiber's in-flight state
 * (`settleInterruptedFiber` → phase `drain`, inflight null), so the safepoint
 * becomes SAFE and the ordinary snapshot path legitimately runs. That is why
 * these tests assert on what reaches the conversation history rather than on
 * the absence of `runtime_state/manifest.json` (the timeout-shaped sibling test
 * `timed_out_turn_progress.test.ts` covers the non-safepoint/no-snapshot case).
 */
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
import { readXnlRecords } from "@cell/ai-file-store-logic"
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support"

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
})

function makeTempSessionDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `eidolon-unsettled-progress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * A runtime whose fiber is parked on an in-flight tool (non-safepoint, no
 * deadline expiry of its own). This is the cancel shape: the pump is
 * interrupted by the user, NOT by the turn deadline running out.
 *
 * The conversation domain already holds the COMPLETED progress of this turn
 * (user message + assistant tool-call + its paired tool result).
 */
function createInterruptedTurnRuntime(options: { sessionId: string; sessionDir: string }) {
  const actor = createActor({
    key: "main",
    id: "actor-main",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "do the long job" },
    ] as any[],
  })
  const vm = createVM({
    controlActorKey: "main",
    actors: { main: actor },
    outerCtx: { metadata: { sessionId: options.sessionId, sessionDir: options.sessionDir } },
  })

  appendLiveHistoryMessageToConversationDomainRuntime({
    vm,
    actorKey: actor.key,
    actorId: actor.id,
    message: { role: "user", content: "do the long job" } as any,
    occurredAt: "2026-09-16T17:28:59.000Z",
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
    occurredAt: "2026-09-16T17:28:59.500Z",
  })
  appendLiveHistoryMessageToConversationDomainRuntime({
    vm,
    actorKey: actor.key,
    actorId: actor.id,
    message: {
      role: "tool",
      tool_call_id: "call_completed_pair",
      content: "COMPLETED-PROGRESS: the user's continued instruction was accepted",
    } as any,
    occurredAt: "2026-09-16T17:29:00.000Z",
  })

  const fiberId = `${actor.key}:${actor.id}`
  const driver = createAiAgentOrchestratorDriver({
    fibers: [{ fiberId, vm, actor, messages: actor.messages, basePriority: 1 }],
    runStep: async () => ({ kind: "suspend" as const, reason: "wait_tool_result" as any }),
    options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
  })
  // Park at the in-flight tool shape: no safepoint, and no turn deadline.
  const inspected = driver.inspectRuntime()
  ;(inspected.fibers[fiberId] as any).execState = {
    phase: "wait_tool",
    turn: 2,
    tools: [{ type: "function", function: { name: "bash" } }],
    toolCalls: [{ id: "call_in_flight", name: "bash", input: { command: "sleep 999" } }],
    toolIndex: 0,
    nextOpSeq: 8,
    pendingToolResults: [],
    pendingAiGenerated: [],
    inflight: {
      kind: "tool",
      opId: `tool:${fiberId}:8`,
      funcName: "bash",
      toolCallId: "call_in_flight",
      args: { command: "sleep 999" },
    },
  }
  return { actor, vm, driver, fiberId }
}

describe("unsettled turn progress is not stranded", () => {
  it("flushes completed progress when the user interrupts a turn (no safepoint, no deadline)", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-unsettled-progress-interrupt"
    const { vm, driver, fiberId } = createInterruptedTurnRuntime({ sessionId, sessionDir })

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
      // The user cancels: the production abort path signals the fiber and
      // settles it out of `running` WITHOUT giving the turn a deadline. The
      // pump must then notice the interruption and return, not spin until some
      // external deadline that never comes.
      const cancelInFlight = setTimeout(() => {
        driver.emitFiberSignal({
          fiberId,
          signalKind: "interrupt_requested",
          mailbox: { kind: "control", payload: { kind: "cancel_requested" } as any },
          idempotencyKey: `${fiberId}:cancel:test`,
          createdAt: Date.now(),
        } as any)
        driver.settleInterruptedFiber({
          fiberId,
          now: Date.now(),
          reason: "idle_external" as any,
          controlKinds: ["cancel_requested"],
        })
      }, 5)

      let result: any
      try {
        result = await coordinator.runInteractiveTurn({
          mainFiberId: fiberId,
          timeoutMs: undefined,
        })
      } finally {
        clearTimeout(cancelInFlight)
      }

      // The turn reports itself settled — that IS the observed shape: the cancel
      // settles the fiber out of `running`, the pump then sees a safe safepoint
      // with nothing running and closes normally. Reporting "settled" is not the
      // bug; the bug was that a settled turn never flushed its progress.
      expect(result.status).toBe("settled")

      // Completed conversation progress is durable even though the turn never
      // settled: memory and persisted counts must not diverge.
      const historyPath = path.join(sessionDir, "conversation", "history.xnl")
      expect(fs.existsSync(historyPath)).toBe(true)
      const records = await readXnlRecords({ filePath: historyPath, tag: "HistoryMessage" })
      const serialized = JSON.stringify(records)
      expect(serialized).toContain("COMPLETED-PROGRESS: the user's continued instruction was accepted")
      expect(serialized).toContain("call_completed_pair")

      // The in-flight tool stays un-flushed: its command must never reach the
      // conversation history, and the seal must not smuggle it in.
      expect(serialized).not.toContain("sleep 999")
    } finally {
      coordinator.dispose()
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("lets a recovered session see the accepted user input after an interrupted turn", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-unsettled-progress-resume"
    const { vm, driver, fiberId } = createInterruptedTurnRuntime({ sessionId, sessionDir })

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
      const cancelInFlight = setTimeout(() => {
        driver.emitFiberSignal({
          fiberId,
          signalKind: "interrupt_requested",
          mailbox: { kind: "control", payload: { kind: "cancel_requested" } as any },
          idempotencyKey: `${fiberId}:cancel:test`,
          createdAt: Date.now(),
        } as any)
        driver.settleInterruptedFiber({
          fiberId,
          now: Date.now(),
          reason: "idle_external" as any,
          controlKinds: ["cancel_requested"],
        })
      }, 5)

      try {
        try {
          await coordinator.runInteractiveTurn({
            mainFiberId: fiberId,
            timeoutMs: undefined,
          })
        } finally {
          clearTimeout(cancelInFlight)
        }
      } catch {
        // The turn is expected to end without throwing once the interruption is
        // observed; a throw here means the turn-end path broke.
        throw new Error("interrupted turn did not end cleanly")
      }

      const recovered = await recoverAiAgentRuntime({ sessionDir, sessionId })
      expect(recovered.controlActor.messages.some((message: any) =>
        message?.role === "tool"
        && message?.content === "COMPLETED-PROGRESS: the user's continued instruction was accepted",
      )).toBe(true)
    } finally {
      coordinator.dispose()
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})
