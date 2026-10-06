import { hasPendingAiAgentWakeMailbox, type AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
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
import { getConversationActorRawStateFromVm } from "../conversation/ConversationDomainRuntime";

export type RuntimeMemberInboxPayload = {
  from: string;
  text: string;
  ts?: number;
  defer?: boolean;
};

export type AiAgentRuntimeInteractiveTurnResult =
  | { status: "settled"; safepointSafe: true }
  | {
      status: "blocked_on_human";
      safepointSafe: boolean;
      fiberId: string;
      reason: "human_clarification" | "human_approval" | "human_answer";
    }
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

type HumanWaitBoundary = {
  fiberId: string;
  reason: "human_clarification" | "human_approval" | "human_answer";
};

function readHumanWaitReason(value: unknown): HumanWaitBoundary["reason"] | undefined {
  if (
    value === "human_clarification"
    || value === "human_approval"
    || value === "human_answer"
  ) {
    return value;
  }
  return undefined;
}

function findInteractiveHumanWaitBoundary(
  inspected: ReturnType<AiAgentOrchestratorDriver["inspectRuntime"]>,
  mainFiberId: string,
): HumanWaitBoundary | undefined {
  const fibers = inspected.state.fibers as Record<string, any>;
  const mainFiber = fibers[mainFiberId];
  const mainReason = mainFiber?.status === "suspended"
    ? readHumanWaitReason(mainFiber.waitingReason)
    : undefined;
  if (mainReason) {
    return { fiberId: mainFiberId, reason: mainReason };
  }

  for (const [fiberId, fiber] of Object.entries(fibers)) {
    const reason = fiber?.status === "suspended"
      ? readHumanWaitReason(fiber.waitingReason)
      : undefined;
    if (reason && fiber.suspendPolicy === "pause_all") {
      return { fiberId, reason };
    }
  }
  return undefined;
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

  /**
   * Non-fatal observability for the stranding shape: the turn ended, the
   * snapshot was refused because the lane was not at a safepoint, and the
   * completed conversation progress could not be flushed. Before this warning
   * existed the only symptom was silence — the user's accepted input and the
   * assistant's finished replies stayed in memory while both the durable
   * history and the TUI (which reads that history for its durable pages) showed
   * nothing new, with no diagnostic naming the cause.
   *
   * Best-effort by construction: a diagnostics failure must never turn an
   * already-degraded turn end into a hard error, and this must never become a
   * second writer — it only reports the in-memory vs persisted counts.
   */
  const reportStrandedConversationProgress = async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const actorRawStates = Object.values(params.vm.actors)
        .map((actor) => getConversationActorRawStateFromVm({
          vm: params.vm,
          actorKey: actor.key,
          sessionId,
        }))
        .filter((rawState): rawState is NonNullable<typeof rawState> => !!rawState);
      const bufferedMessageCount = actorRawStates.reduce(
        (total, actorRawState) =>
          total + actorRawState.visibleHistoryGenerations.reduce(
            (actorTotal, generation) => actorTotal + generation.messages.length,
            0,
          ),
        0,
      );
      checkpointDiagnostics.appendRuntimePersistenceEvent({
        eventType: "runtime_conversation_progress_stranded",
        sessionId,
        status: "skipped",
        reason: "snapshot_refused_non_safepoint",
        messageCount: bufferedMessageCount,
        historyGenerationCount: actorRawStates.reduce(
          (total, actorRawState) => total + actorRawState.visibleHistoryGenerations.length,
          0,
        ),
      });
      await checkpointDiagnostics.flush().catch(() => {});
    } catch {
      // Never let the warning itself break the turn-end path.
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

  const hasPendingBackgroundWork = (): boolean => {
    const inspected = params.driver.inspectRuntime();
    const fibers = inspected.state.fibers as Record<string, any>;
    const isBackground = (fiberId: string) => {
      const lane = fibers[fiberId]?.lane;
      return lane === "detached" || lane === "organization";
    };

    if (inspected.pendingResumes.some(isBackground)) return true;

    for (const [fiberId, fiber] of Object.entries(fibers)) {
      if (!isBackground(fiberId)) continue;
      if (fiber.status === "ready" || fiber.status === "running") return true;
      const ctx = inspected.fibers[fiberId];
      if (ctx?.actor && hasPendingAiAgentWakeMailbox(ctx.actor)) return true;
    }

    const backgroundTasks = (params.driver.actorRuntime as any)?.runtime?.backgroundTasks;
    return backgroundTasks instanceof Set && backgroundTasks.size > 0;
  };

  const hasIdleLifecycleHooks = (): boolean => hookDefinitions.some((definition) => (
    definition.enabled !== false && definition.point === "actor.idle.before"
  ));

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
      // Best-effort: this is a pre-snapshot nudge, not the turn's decision
      // loop. A slice that ends with work still running simply means this
      // attempt made no progress; the next attempt re-evaluates, and a snapshot
      // that stays unsafe is still reported as unsafe by the caller.
      await params.driver.tickUntilForegroundSettled({
        now: Date.now(),
        maxTicks: 20,
        maxWallMs: 250,
      });
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
      // A non-safepoint turn still completes conversation work (user inputs the
      // runtime accepted, assistant replies that closed, paired tool results).
      // Skipping the VM snapshot is correct — in-flight tool execution must not
      // be snapshotted — but leaving the completed progress un-flushed strands
      // it: the fiber is no longer running, so no later turn will ever commit
      // it. Seal only that completed progress.
      await sealCompletedProgress().catch(() => {});
      await reportStrandedConversationProgress();
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
        // Same reasoning as the pre-check above: the snapshot was refused, so
        // the completed conversation progress must still reach disk.
        await sealCompletedProgress().catch(() => {});
        await reportStrandedConversationProgress();
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
        await saveSnapshotAfterProgress();
        return result;
      },
      async () => {
        const result = await fn();
        await saveSnapshotAfterProgress();
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

  const enqueueWithoutSnapshot = <T>(fn: () => Promise<T>) => {
    queuedTicks += 1;
    const run = tickQueue.then(fn, fn);
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
      const hasBackgroundWork = hasPendingBackgroundWork();
      if (!hasBackgroundWork && !hasIdleLifecycleHooks()) return;
      backgroundPumpQueuedOrRunning = true;
      const run = hasBackgroundWork ? enqueue : enqueueWithoutSnapshot;
      void run(async () => {
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
        let inspected = params.driver.inspectRuntime();
        let safepoint = evaluateAiAgentRuntimeSnapshotSafepoint({
          vm: params.vm,
          inspected,
        });
        let humanWait: HumanWaitBoundary | undefined;
        // Whether the last pump slice ended with foreground work still running.
        // A safepoint verdict alone cannot answer this: it classifies cooperative
        // exec state, and a fiber actor mid-step can look settled there.
        let stillRunning = false;
        // Set when the unsettled branch below already flushed this turn's
        // completed progress, so the single turn-end seal does not repeat it.
        let sealedOnUnsettled = false;
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
          // The slice budget exists so this loop can re-evaluate the control
          // plane (human waits, safepoint, remaining deadline) while provider and
          // tool work is in flight. Exhausting a slice is therefore a normal
          // outcome of pumping, NOT a turn failure: the turn's own deadline below
          // is the only thing that can fail it. A long tool that outlives a slice
          // must keep the turn alive.
          const drain = await params.driver.tickUntilForegroundSettled({
            now,
            maxWallMs: Number.isFinite(deadlineMs)
              ? Math.max(1, Math.min(remainingMs, 1000))
              : undefined,
          });
          stillRunning = drain.status === "budget_exhausted" && drain.stillRunning;
          inspected = params.driver.inspectRuntime();
          safepoint = evaluateAiAgentRuntimeSnapshotSafepoint({
            vm: params.vm,
            inspected,
          });
          humanWait = findInteractiveHumanWaitBoundary(inspected, turnParams.mainFiberId);
          if (humanWait) break;
          // The turn is only over once the foreground lane has actually stopped
          // running; a spent slice that still reports running work keeps pumping
          // (the deadline above bounds the loop).
          if (safepoint.safe && !stillRunning) break;
        }
        if (humanWait) {
          result = {
            status: "blocked_on_human",
            safepointSafe: safepoint.safe,
            fiberId: humanWait.fiberId,
            reason: humanWait.reason,
          };
        } else if (stillRunning || !safepoint.safe) {
          // P3 (requirement `timed-out-turn-progress-persisted`): a turn that
          // ended unsettled may have completed tool pairs already committed into
          // the conversation domain. Seal ONLY that completed progress so a later
          // continuation relays from it instead of restarting bare. This
          // deliberately does NOT take a VM snapshot — the in-flight (unsafe) tool
          // execution stays un-snapshotted, preserving the "don't snapshot unsafe
          // tool-execution" invariant. Best-effort: a flush failure must never
          // turn a timeout into a hard error.
          //
          // Two shapes reach here: the turn deadline ran out with foreground work
          // still running, or the lane stopped running but sits in a
          // non-safepoint (mandatory_continuation) state.
          const reason = stillRunning && safepoint.safe
            ? "foreground_still_running"
            : safepoint.blockers.map((blocker) => blocker.reason).join(",");
          result = { status: "timeout_unsettled", safepointSafe: false, reason };
          sealedOnUnsettled = true;
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
        } else {
          // A turn that reaches here ended without settling-timeout: it either
          // settled normally or stopped for the user. Its conversation progress
          // is just as real as an unsettled turn's — the user's accepted input
          // and the assistant's closed replies are already committed into the
          // domain — so it must reach disk too. Without this the progress stays
          // in memory: the fiber is no longer running, so no later turn will
          // ever commit it, and the durable history (which the TUI reads for its
          // durable pages) simply never shows it.
          result = { status: "settled", safepointSafe: true };
        }
        // One seal exit for every turn-end shape, still inside the enqueue body
        // so it also covers the `blocked_on_human` early break. In-flight work is
        // untouched: the seal flushes only what the conversation domain already
        // completed, never a VM snapshot of unsafe tool execution.
        if (!sealedOnUnsettled) {
          await flushPersistenceWriteBehind().catch(() => {});
          await sealCompletedProgress().catch(() => {});
        }
      });
    } finally {
      ensureVmRuntimeContext(params.vm).interactiveTurnActive = false;
      flushDeferredMemberResumes();
      if (result.status !== "blocked_on_human" && hasIdleLifecycleHooks()) {
        await enqueue(async () => {
          await runIdleLifecycleHooks(turnParams.mainFiberId);
        }).catch(() => {});
      }
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
