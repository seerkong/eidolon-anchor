import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import {
  ensureVmRuntimeContext,
  isRuntimeStorageFilesEnabled,
  isRuntimeStorageLogsEnabled,
  type AiAgentVm,
} from "@cell/ai-core-logic/runtime/runtime";
import type { RuntimeHookDefinition } from "@cell/ai-core-contract";
import type { AiAgentOrchestratorDriver } from "../OrchestratorDriver";
import { getCoordinationEngine } from "../coordination/CoordinationEngine";
import type { RuntimeHookHandlerComponent } from "../hooks/RuntimeHookDispatcher";
import { runActorIdleBeforeLifecycleHook } from "../hooks/RuntimeHookProducer";
import { evaluateAiAgentRuntimeSnapshotSafepoint } from "@cell/ai-runtime-control-logic";
import { tickAiAgentRuntimeBackground } from "./tickAiAgentRuntimeBackground";
import { createSessionDiagnosticsXnlLog } from "./SessionRuntimeXnlLogs";

export type RuntimeMemberInboxPayload = {
  from: string;
  text: string;
  ts?: number;
  defer?: boolean;
};

export type AiAgentRuntimeInteractiveTurnResult =
  | { status: "settled"; safepointSafe: true }
  | { status: "timeout_unsettled"; safepointSafe: false; reason: string };

export type AiAgentRuntimeCoordinator = {
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  saveSnapshot: () => Promise<void>;
  startBackgroundPump: () => void;
  stopBackgroundPump: () => void;
  runInteractiveTurn: (params: { mainFiberId: string; timeoutMs?: number }) => Promise<AiAgentRuntimeInteractiveTurnResult>;
  deliverMemberInbox: (params: {
    actor: AiAgentActor;
    mainFiberId: string;
    payload: RuntimeMemberInboxPayload;
    foregroundMaxTicks?: number;
    foregroundMaxWallMs?: number;
  }) => Promise<void>;
  dispose: () => void;
};

function noopAsync(): Promise<void> {
  return Promise.resolve();
}

function readSnapshotSaveStatus(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const status = (result as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

function readSnapshotPendingEffectReason(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const pendingEffectIds = (result as Record<string, unknown>).pendingEffectIds;
  if (!Array.isArray(pendingEffectIds) || pendingEffectIds.length === 0) return undefined;
  return pendingEffectIds.map((effectId) => String(effectId)).join(",");
}

export function createAiAgentRuntimeCoordinator(params: {
  vm: AiAgentVm;
  driver: AiAgentOrchestratorDriver;
  saveSnapshot?: () => Promise<unknown>;
  /**
   * P3 (track harden-runtime-session-robustness, requirement
   * `timed-out-turn-progress-persisted`): seal ONLY the completed conversation
   * progress already in the conversation domain when a turn times out in
   * mandatory_continuation. Unlike `saveSnapshot`, this does NOT snapshot the
   * unsafe in-flight VM/ToolCallDomain state. No-op when not injected.
   */
  sealCompletedProgress?: () => Promise<unknown>;
  backgroundIntervalMs?: number;
  backgroundMaxTicks?: number;
  backgroundMaxWallMs?: number;
  hookDefinitions?: readonly RuntimeHookDefinition[];
  hookHandlers?: Readonly<Record<string, RuntimeHookHandlerComponent | undefined>>;
}): AiAgentRuntimeCoordinator {
  const saveSnapshot = params.saveSnapshot ?? noopAsync;
  const sealCompletedProgress = params.sealCompletedProgress ?? noopAsync;
  const backgroundIntervalMs =
    typeof params.backgroundIntervalMs === "number" && params.backgroundIntervalMs > 0
      ? params.backgroundIntervalMs
      : 50;
  const backgroundMaxTicks =
    typeof params.backgroundMaxTicks === "number" && params.backgroundMaxTicks > 0
      ? params.backgroundMaxTicks
      : 20;
  const backgroundMaxWallMs =
    typeof params.backgroundMaxWallMs === "number" && params.backgroundMaxWallMs > 0
      ? params.backgroundMaxWallMs
      : 50;

  let tickQueue: Promise<void> = Promise.resolve();
  let queuedTicks = 0;
  let backgroundPumpInterval: ReturnType<typeof setInterval> | null = null;
  let backgroundPumpQueuedOrRunning = false;
  const hookDefinitions = params.hookDefinitions ?? [];
  const hookHandlers = params.hookHandlers ?? {};
  const sessionMetadata = params.vm.outerCtx?.metadata as Record<string, unknown> | undefined;
  const sessionDir = typeof sessionMetadata?.sessionDir === "string" ? sessionMetadata.sessionDir : undefined;
  const sessionId = typeof sessionMetadata?.sessionId === "string" ? sessionMetadata.sessionId : undefined;
  const checkpointDiagnostics = createSessionDiagnosticsXnlLog({
    sessionDir: isRuntimeStorageLogsEnabled(params.vm) ? sessionDir : undefined,
  });

  /**
   * Deterministic flush of the injected write-behind persistence port (P3,
   * refactor-persistent-session-backplane). Effect-evidence WAL appends are
   * enqueued non-blocking on the executor hot path; we drain them at the turn /
   * safepoint / shutdown boundaries the code already owns so recovery/snapshot
   * timing stays deterministic. No-op when no flushable port is injected
   * (memory-only profile).
   */
  const flushPersistenceWriteBehind = async (): Promise<void> => {
    const port = params.vm.outerCtx?.persistenceWritePort as
      | { flush?: () => Promise<void> }
      | undefined;
    if (port && typeof port.flush === "function") {
      await port.flush().catch(() => {});
    }
  };

  const flushDeferredMemberResumes = () => {
    const runtimeContext = ensureVmRuntimeContext(params.vm);
    const queued = [...runtimeContext.deferredMemberResumes];
    runtimeContext.deferredMemberResumes = [];
    for (const entry of queued) {
      const fiberId = String(entry?.fiberId ?? "");
      if (!fiberId) continue;
      params.driver.resumeFiber(fiberId, Date.now());
    }
  };

  const runIdleLifecycleHooks = async (mainFiberId?: string) => {
    if (!hookDefinitions.length) return;
    await runActorIdleBeforeLifecycleHook({
      vm: params.vm,
      driver: params.driver,
      definitions: hookDefinitions,
      handlers: hookHandlers,
      now: Date.now(),
      mainFiberId,
    });
  };

  const progressBeforeSnapshot = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const safepoint = evaluateAiAgentRuntimeSnapshotSafepoint({
        vm: params.vm,
        inspected: params.driver.inspectRuntime(),
      });
      if (safepoint.safe) return;
      await params.driver.tickUntilForegroundSettled({
        now: Date.now(),
        maxTicks: 20,
        maxWallMs: 250,
      }).catch(() => {});
    }
  };

  const saveSnapshotAfterProgress = async () => {
    if (!isRuntimeStorageFilesEnabled(params.vm)) {
      return;
    }
    await progressBeforeSnapshot();
    // Drain write-behind evidence WAL appends accumulated during the turn before
    // the snapshot save so a subsequent recovery read sees a durable journal.
    await flushPersistenceWriteBehind();
    const safepoint = evaluateAiAgentRuntimeSnapshotSafepoint({
      vm: params.vm,
      inspected: params.driver.inspectRuntime(),
    });
    checkpointDiagnostics.appendRuntimeCheckpointEvent({
      eventType: "runtime_checkpoint_save_start",
      sessionId,
      status: "start",
      safepointSafe: safepoint.safe,
      reason: safepoint.safe ? undefined : safepoint.blockers.map((blocker) => blocker.reason).join(","),
    });
    if (!safepoint.safe) {
      checkpointDiagnostics.appendRuntimeCheckpointEvent({
        eventType: "runtime_checkpoint_save_skipped",
        sessionId,
        status: "skipped_non_safepoint",
        safepointSafe: false,
        reason: safepoint.blockers.map((blocker) => blocker.reason).join(","),
      });
      await checkpointDiagnostics.flush().catch(() => {});
      return;
    }
    try {
      const result = await saveSnapshot();
      const snapshotStatus = readSnapshotSaveStatus(result);
      if (snapshotStatus === "skipped_non_safepoint" || snapshotStatus === "skipped_pending_effects") {
        checkpointDiagnostics.appendRuntimeCheckpointEvent({
          eventType: "runtime_checkpoint_save_skipped",
          sessionId,
          status: snapshotStatus,
          safepointSafe: snapshotStatus !== "skipped_non_safepoint",
          reason: readSnapshotPendingEffectReason(result),
        });
        return;
      }
      checkpointDiagnostics.appendRuntimeCheckpointEvent({
        eventType: "runtime_checkpoint_save_finished",
        sessionId,
        status: "saved",
        safepointSafe: true,
      });
    } catch (error) {
      checkpointDiagnostics.appendRuntimeCheckpointEvent({
        eventType: "runtime_checkpoint_save_error",
        sessionId,
        status: "error",
        safepointSafe: safepoint.safe,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await checkpointDiagnostics.flush().catch(() => {});
    }
  };

  const enqueue = <T>(fn: () => Promise<T>) => {
    queuedTicks += 1;
    const run = tickQueue.then(
      async () => {
        const result = await fn();
        await saveSnapshotAfterProgress().catch(() => {});
        return result;
      },
      async () => {
        const result = await fn();
        await saveSnapshotAfterProgress().catch(() => {});
        return result;
      },
    );
    tickQueue = run.then(
      () => undefined,
      () => undefined,
    );
    run.then(
      () => {
        queuedTicks -= 1;
      },
      () => {
        queuedTicks -= 1;
      },
    );
    return run;
  };

  const startBackgroundPump = () => {
    if (backgroundPumpInterval) return;
    backgroundPumpInterval = setInterval(() => {
      if (backgroundPumpQueuedOrRunning) return;
      if (queuedTicks > 0) return;
      backgroundPumpQueuedOrRunning = true;
      void enqueue(async () => {
        await tickAiAgentRuntimeBackground({
          vm: params.vm,
          driver: params.driver,
          hookDefinitions,
          hookHandlers,
          now: Date.now(),
          maxTicks: backgroundMaxTicks,
          maxWallMs: backgroundMaxWallMs,
        });
      })
        .catch(() => {})
        .finally(() => {
          backgroundPumpQueuedOrRunning = false;
        });
    }, backgroundIntervalMs);
    (backgroundPumpInterval as any).unref?.();
  };

  const stopBackgroundPump = () => {
    if (!backgroundPumpInterval) return;
    clearInterval(backgroundPumpInterval);
    backgroundPumpInterval = null;
    backgroundPumpQueuedOrRunning = false;
  };

  const runInteractiveTurn = async (turnParams: { mainFiberId: string; timeoutMs?: number }) => {
    ensureVmRuntimeContext(params.vm).interactiveTurnActive = true;
    let result: AiAgentRuntimeInteractiveTurnResult = { status: "settled", safepointSafe: true };
    try {
      await enqueue(async () => {
        const startedAt = Date.now();
        const deadlineMs = typeof turnParams.timeoutMs === "number" && turnParams.timeoutMs > 0
          ? startedAt + turnParams.timeoutMs
          : Number.POSITIVE_INFINITY;
        let resumedMain = false;
        let safepoint = evaluateAiAgentRuntimeSnapshotSafepoint({
          vm: params.vm,
          inspected: params.driver.inspectRuntime(),
        });
        while (true) {
          const now = Date.now();
          const remainingMs = deadlineMs - now;
          if (Number.isFinite(deadlineMs) && remainingMs <= 0) {
            break;
          }
          if (!resumedMain) {
            params.driver.resumeFiber(turnParams.mainFiberId, now);
            resumedMain = true;
          }
          await params.driver.tickUntilForegroundSettled({
            now,
            maxWallMs: Number.isFinite(deadlineMs)
              ? Math.max(1, Math.min(remainingMs, 1000))
              : undefined,
          });
          safepoint = evaluateAiAgentRuntimeSnapshotSafepoint({
            vm: params.vm,
            inspected: params.driver.inspectRuntime(),
          });
          if (safepoint.safe) break;
        }
        if (!safepoint.safe) {
          const reason = safepoint.blockers.map((blocker) => blocker.reason).join(",");
          result = {
            status: "timeout_unsettled",
            safepointSafe: false,
            reason,
          };
          // P3 (requirement `timed-out-turn-progress-persisted`): a turn that
          // timed out in mandatory_continuation may have completed tool pairs
          // already committed into the conversation domain. Seal ONLY that
          // completed progress so a later continuation relays from it instead of
          // restarting bare. This deliberately does NOT take a VM snapshot — the
          // in-flight (unsafe) tool execution stays un-snapshotted, preserving
          // the "don't snapshot unsafe tool-execution" invariant. Best-effort:
          // a flush failure must never turn a timeout into a hard error.
          await flushPersistenceWriteBehind().catch(() => {});
          await sealCompletedProgress().catch(() => {});
          checkpointDiagnostics.appendRuntimeCheckpointEvent({
            eventType: "runtime_interactive_turn_unsettled",
            sessionId,
            status: "timeout_unsettled",
            safepointSafe: false,
            reason,
          });
          await checkpointDiagnostics.flush().catch(() => {});
        }
      });
    } finally {
      ensureVmRuntimeContext(params.vm).interactiveTurnActive = false;
      flushDeferredMemberResumes();
      await enqueue(async () => {
        await runIdleLifecycleHooks(turnParams.mainFiberId);
      }).catch(() => {});
    }
    return result;
  };

  const deliverMemberInbox = async (deliverParams: {
    actor: AiAgentActor;
    mainFiberId: string;
    payload: RuntimeMemberInboxPayload;
    foregroundMaxTicks?: number;
    foregroundMaxWallMs?: number;
  }) => {
    const dispatch = async () => {
      const mailboxTag = getCoordinationEngine().parseEnvelopeText(deliverParams.payload.text) ? "memberCoordination" : "memberChatInbox";
      const payload = {
        from: deliverParams.payload.from,
        text: deliverParams.payload.text,
        ts: typeof deliverParams.payload.ts === "number" ? deliverParams.payload.ts : Date.now(),
      };
      const now = Date.now();
      params.driver.emitFiberSignal({
        fiberId: deliverParams.mainFiberId,
        signalKind: "mailbox_enqueue",
        signalClass: deliverParams.payload.defer ? "ordinary" : "wake",
        mailbox: { kind: mailboxTag as any, payload: payload as any },
        idempotencyKey: `${deliverParams.mainFiberId}:${mailboxTag}:${payload.ts}:${payload.from}`,
        createdAt: now,
      });
      if (deliverParams.payload.defer) {
        return;
      }
      await params.driver.tickUntilBlocked({
        now,
        maxTicks: deliverParams.foregroundMaxTicks ?? 20,
        maxWallMs: deliverParams.foregroundMaxWallMs ?? 200,
      });
    };

    if (deliverParams.payload.defer) {
      await dispatch();
      return;
    }

    await enqueue(dispatch);
  };

  return {
    enqueue,
    saveSnapshot: saveSnapshotAfterProgress,
    startBackgroundPump,
    stopBackgroundPump,
    runInteractiveTurn,
    deliverMemberInbox,
    dispose() {
      stopBackgroundPump();
      void flushPersistenceWriteBehind();
      void checkpointDiagnostics.flush().catch(() => {});
    },
  };
}
