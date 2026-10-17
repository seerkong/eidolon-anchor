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
import { isForegroundAiAgentLane } from "../lane/AiAgentLane";
import { decodeExecutionOrigin, type ExecutionOrigin } from "@cell/ai-core-contract/runtime/ExecutionOrigin";

export type RuntimeMemberInboxPayload = {
  from: string;
  text: string;
  ts?: number;
  defer?: boolean;
};

export type AiAgentRuntimeInteractiveTurnResult =
  | { status: "settled"; safepointSafe: boolean }
  | { status: "cancelled"; safepointSafe: boolean }
  | { status: "failed"; safepointSafe: boolean; error: string }
  | {
      status: "blocked_on_human";
      safepointSafe: boolean;
      fiberId: string;
      reason: "human_clarification" | "human_approval" | "human_answer";
    }
  | { status: "timeout_unsettled"; safepointSafe: false; reason: string };

export type RuntimeInteractiveTurnState = "queued" | "running" | "waiting_input" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type RuntimeInteractiveTurn = Readonly<{
  turnId: string;
  actorId: string;
  mainFiberId: string;
  state: RuntimeInteractiveTurnState;
  cancelRequested: boolean;
  error?: string;
  waitingFiberId?: string;
  waitingReason?: HumanWaitBoundary["reason"];
}>;
export type RuntimeInteractiveTurnAdmission = {
  executionOrigin?: ExecutionOrigin;
  turnId: string;
  actorId: string;
  mainFiberId: string;
  timeoutMs?: number;
  deliver?: (signal: AbortSignal) => void | Promise<void>;
};
export type RuntimeInteractiveTurnHandle = {
  turnId: string;
  settled: Promise<AiAgentRuntimeInteractiveTurnResult>;
};
export type RuntimeInteractiveTurnCancelResult = {
  status: "cancel_requested" | "cancelled_before_delivery" | "already_terminal" | "not_found";
};

export type AiAgentRuntimeCoordinator = {
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Same exclusive owner lane, without progress ticks or automatic snapshot side effects. */
  enqueueWithoutSnapshot: <T>(fn: () => Promise<T>) => Promise<T>;
  saveSnapshot: () => Promise<void>;
  startBackgroundPump: () => void;
  stopBackgroundPump: () => void;
  runInteractiveTurn: (params: { mainFiberId: string; timeoutMs?: number }) => Promise<AiAgentRuntimeInteractiveTurnResult>;
  admitInteractiveTurn: (params: RuntimeInteractiveTurnAdmission) => RuntimeInteractiveTurnHandle;
  cancelInteractiveTurn: (params: { actorId: string; turnId: string }) => RuntimeInteractiveTurnCancelResult;
  resumeInteractiveTurn: (params: { actorId: string; turnId: string }) => boolean;
  readInteractiveTurns: () => readonly RuntimeInteractiveTurn[];
  forgetInteractiveTurn: (params: { actorId: string; turnId: string }) => boolean;
  subscribeInteractiveTurns: (listener: (turn: RuntimeInteractiveTurn) => void) => { unsubscribe: () => void };
  deliverMemberInbox: (params: {
    actor: AiAgentActor;
    mainFiberId: string;
    payload: RuntimeMemberInboxPayload;
    foregroundMaxTicks?: number;
    foregroundMaxWallMs?: number;
  }) => Promise<void>;
  dispose: () => void;
  shutdown: () => Promise<void>;
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
  interactiveCapacity?: { maxOutstandingTurns?: number; maxQueuedTurnsPerActor?: number; terminalRetention?: number };
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

  type TurnEntry = {
    admission: RuntimeInteractiveTurnAdmission;
    view: RuntimeInteractiveTurn;
    controller: AbortController;
    delivered: boolean;
    preparing: boolean;
    deadline: number;
    compatibility: boolean;
    timedOut: boolean;
    resolve: (result: AiAgentRuntimeInteractiveTurnResult) => void;
    reject: (error: unknown) => void;
    settled: Promise<AiAgentRuntimeInteractiveTurnResult>;
  };
  const turns = new Map<string, TurnEntry>();
  const capacity = {
    maxOutstandingTurns: Math.max(1, params.interactiveCapacity?.maxOutstandingTurns ?? 128),
    maxQueuedTurnsPerActor: Math.max(1, params.interactiveCapacity?.maxQueuedTurnsPerActor ?? 32),
    terminalRetention: Math.max(0, params.interactiveCapacity?.terminalRetention ?? 256),
  };
  const activeByActor = new Map<string, TurnEntry>();
  const queuedByActor = new Map<string, TurnEntry[]>();
  const turnListeners = new Set<(turn: RuntimeInteractiveTurn) => void>();
  let pumpScheduled = false;
  let disposed = false;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;
  let compatibilitySequence = 0;
  const isTerminal = (state: RuntimeInteractiveTurnState) =>
    state === "succeeded" || state === "failed" || state === "cancelled" || state === "interrupted";

  const publishTurn = (entry: TurnEntry, patch: Partial<RuntimeInteractiveTurn>) => {
    entry.view = Object.freeze({ ...entry.view, ...patch });
    for (const listener of turnListeners) {
      try { listener(entry.view); } catch { /* An observer cannot change execution. */ }
    }
  };

  const readScope = (entry: TurnEntry, inspected = params.driver.inspectRuntime()) => {
    const ids = new Set([entry.admission.mainFiberId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, record] of Object.entries(inspected.state.fibers)) {
        const parentId = record.parentId ?? inspected.childDoneMap?.[id]?.parentFiberId;
        if (!ids.has(id) && parentId && ids.has(parentId) && isForegroundAiAgentLane(record.lane)) {
          ids.add(id);
          changed = true;
        }
      }
    }
    const scoped = {
      ...inspected,
      state: { ...inspected.state, fibers: Object.fromEntries(Object.entries(inspected.state.fibers).filter(([id]) => ids.has(id))) },
      fibers: Object.fromEntries(Object.entries(inspected.fibers).filter(([id]) => ids.has(id))),
      pendingResumes: (inspected.pendingResumes ?? []).filter((id) => ids.has(id)),
      pendingForegroundTasks: (inspected.pendingForegroundTasks ?? []).filter((id) => ids.has(id)),
    };
    const safepoint = evaluateAiAgentRuntimeSnapshotSafepoint({ vm: params.vm, inspected: scoped });
    const records = Object.values(scoped.state.fibers);
    const outstanding = records.some((record) => record.status === "ready" || record.status === "running")
      || scoped.pendingResumes.length > 0 || scoped.pendingForegroundTasks.length > 0;
    const waiting = Object.entries(scoped.state.fibers).find(([, record]) =>
      record.status === "suspended" && readHumanWaitReason(record.waitingReason));
    const human = entry.compatibility
      ? findInteractiveHumanWaitBoundary(inspected, entry.admission.mainFiberId)
      : waiting ? { fiberId: waiting[0], reason: readHumanWaitReason(waiting[1].waitingReason)! } : undefined;
    return { ids, scoped, safepoint, outstanding, human };
  };

  const syncInteractiveActive = () => {
    ensureVmRuntimeContext(params.vm).interactiveTurnActive = activeByActor.size > 0;
  };

  const completed: Array<{ entry: TurnEntry; result: AiAgentRuntimeInteractiveTurnResult }> = [];
  const finishTurn = (entry: TurnEntry, state: RuntimeInteractiveTurnState, result: AiAgentRuntimeInteractiveTurnResult) => {
    if (isTerminal(entry.view.state)) return;
    const actor = params.driver.inspectRuntime().fibers[entry.admission.mainFiberId]?.actor;
    if (actor?.execution && (entry.compatibility || actor.execution.origin?.turnId === entry.view.turnId)) {
      // The legacy turn deadline pauses the caller, not the live provider/tool.
      // Marking it interrupted would drop its eventual durable resume signal.
      const awaitingContinuation = entry.compatibility
        && (result.status === "timeout_unsettled" || result.status === "blocked_on_human");
      actor.execution.status = awaitingContinuation ? "active" : state === "interrupted" ? "interrupted" : "settled";
    }
    if (activeByActor.get(entry.view.actorId) === entry) activeByActor.delete(entry.view.actorId);
    const queue = queuedByActor.get(entry.view.actorId);
    if (queue) {
      const remaining = queue.filter((item) => item !== entry);
      if (remaining.length) queuedByActor.set(entry.view.actorId, remaining);
      else queuedByActor.delete(entry.view.actorId);
    }
    publishTurn(entry, { state, waitingFiberId: undefined, waitingReason: undefined,
      ...(result.status === "failed" ? { error: result.error } : {}) });
    completed.push({ entry, result });
    syncInteractiveActive();
  };

  const interruptTurn = (entry: TurnEntry) => {
    entry.controller.abort();
    if (!entry.delivered) return;
    for (const fiberId of readScope(entry).ids) {
      const record = params.driver.inspectRuntime().state.fibers[fiberId];
      if (!record || record.status === "completed" || record.status === "failed" || record.status === "cancelled") continue;
      params.driver.emitFiberSignal({
        fiberId,
        signalKind: "interrupt_requested",
        mailbox: { kind: "control", payload: { kind: "cancel_requested" } },
        idempotencyKey: `interactive-turn:${entry.view.turnId}:cancel:${fiberId}`,
        createdAt: Date.now(),
      });
    }
  };

  const settleCompleted = async () => {
    if (!completed.length) return;
    const batch = completed.splice(0);
    try {
      await flushPersistenceWriteBehind();
      await sealCompletedProgress();
      // Snapshot persistence is a whole-VM boundary, never a per-turn verdict.
      // Do not drive another actor's work as a side effect of completing this turn.
      const safe = evaluateAiAgentRuntimeSnapshotSafepoint({ vm: params.vm, inspected: params.driver.inspectRuntime() });
      if (safe.safe && activeByActor.size === 0) await saveSnapshotAfterProgress();
      if (activeByActor.size === 0) {
        flushDeferredMemberResumes();
        if (!closing && !batch.some(({ result }) => result.status === "blocked_on_human") && hasIdleLifecycleHooks()) {
          await runIdleLifecycleHooks();
        }
      }
      for (const { entry, result } of batch) entry.resolve(result);
    } catch (error) {
      for (const { entry } of batch) entry.reject(error);
    }
    // Retain bounded terminal diagnostics; host command retention is a separate port.
    const terminal = [...turns.values()].filter((entry) => isTerminal(entry.view.state));
    for (const entry of terminal.slice(0, Math.max(0, terminal.length - capacity.terminalRetention))) turns.delete(entry.view.turnId);
  };

  const startQueued = () => {
    for (const [actorId, queue] of queuedByActor) {
      if (activeByActor.has(actorId)) continue;
      const entry = queue.shift();
      if (!queue.length) queuedByActor.delete(actorId);
      if (!entry) continue;
      activeByActor.set(actorId, entry);
      const actor = params.driver.inspectRuntime().fibers[entry.admission.mainFiberId]!.actor;
      const origin = entry.admission.executionOrigin;
      const continuingLocalTurn = entry.compatibility && actor.execution?.status === "active"
        && actor.execution.origin?.source !== "web";
      actor.execution = continuingLocalTurn ? actor.execution : {
        originSchemaVersion: 1,
        origin: origin ?? { source: "tui", sessionId: String((params.vm.outerCtx?.metadata as any)?.sessionId ?? "local"), actorId, turnId: entry.view.turnId },
        status: "active", webOwned: actor.execution?.webOwned || origin?.source === "web",
      };
      entry.preparing = true;
      entry.deadline = entry.admission.timeoutMs && entry.admission.timeoutMs > 0
        ? Date.now() + entry.admission.timeoutMs : Infinity;
      publishTurn(entry, { state: "running" });
      syncInteractiveActive();
      const deliveryFinished = () => {
        entry.preparing = false;
        if (entry.controller.signal.aborted) {
          // A delivery callback must obey its AbortSignal and not enqueue after abort.
          finishTurn(entry, entry.timedOut ? "interrupted" : "cancelled", entry.timedOut
            ? { status: "timeout_unsettled", safepointSafe: false, reason: "delivery_timeout" }
            : { status: "cancelled", safepointSafe: false });
        } else {
          entry.delivered = true;
          const record = params.driver.inspectRuntime().state.fibers[entry.admission.mainFiberId];
          if (record?.status === "failed" || record?.status === "cancelled" || record?.status === "completed") {
            params.driver.reviveFiber(entry.admission.mainFiberId, Date.now());
          } else {
            params.driver.resumeFiber(entry.admission.mainFiberId, Date.now());
          }
        }
        schedulePump();
      };
      try {
        const delivery = entry.admission.deliver?.(entry.controller.signal);
        if (delivery && typeof delivery.then === "function") {
          void delivery.then(deliveryFinished, (error: unknown) => {
            entry.preparing = false;
            finishTurn(entry, entry.controller.signal.aborted ? "cancelled" : "failed", entry.controller.signal.aborted
              ? { status: "cancelled", safepointSafe: false }
              : { status: "failed", safepointSafe: false, error: error instanceof Error ? error.message : String(error) });
            schedulePump();
          });
        } else deliveryFinished();
      } catch (error) {
        entry.preparing = false;
        finishTurn(entry, "failed", { status: "failed", safepointSafe: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  const pumpSlice = async () => {
    if (disposed) return;
    startQueued();
    if ([...activeByActor.values()].some((entry) => entry.delivered && entry.view.state === "running")) {
      await params.driver.tickUntilForegroundSettled({ now: Date.now(), maxWallMs: 50 });
    }
    const inspected = params.driver.inspectRuntime();
    const globalSafe = evaluateAiAgentRuntimeSnapshotSafepoint({ vm: params.vm, inspected }).safe;
    for (const entry of [...activeByActor.values()]) {
      if (entry.preparing) {
        if (Date.now() >= entry.deadline) {
          entry.timedOut = true;
          entry.controller.abort();
        }
        continue;
      }
      if (!entry.delivered) continue;
      const scope = readScope(entry, inspected);
      const root = inspected.state.fibers[entry.admission.mainFiberId];
      const scopedSettled = !scope.outstanding && scope.safepoint.safe;
      if ((root?.status === "failed" || root?.status === "cancelled") && !scopedSettled) {
        // A root terminal record cannot release its actor queue while a child
        // still owns foreground work or asynchronous cleanup.
        interruptTurn(entry);
      } else if (root?.status === "failed" && scopedSettled) {
        finishTurn(entry, entry.view.cancelRequested ? "cancelled" : "failed", entry.view.cancelRequested
          ? { status: "cancelled", safepointSafe: globalSafe }
          : { status: "failed", safepointSafe: globalSafe, error: root.lastError ?? "runtime_actor_fiber_failed" });
      } else if (scopedSettled && (root?.status === "cancelled" || entry.view.cancelRequested)) {
        finishTurn(entry, entry.timedOut ? "interrupted" : "cancelled", entry.timedOut
          ? { status: "timeout_unsettled", safepointSafe: false, reason: "turn_deadline" }
          : { status: "cancelled", safepointSafe: globalSafe });
      } else if (scope.human && !entry.view.cancelRequested) {
        if (entry.compatibility) {
          finishTurn(entry, "succeeded", { status: "blocked_on_human", safepointSafe: globalSafe,
            fiberId: scope.human.fiberId, reason: scope.human.reason });
        } else if (entry.view.state !== "waiting_input") {
          publishTurn(entry, { state: "waiting_input", waitingFiberId: scope.human.fiberId, waitingReason: scope.human.reason });
          await flushPersistenceWriteBehind();
          await sealCompletedProgress();
        }
      } else if (!scope.outstanding && scope.safepoint.safe) {
        finishTurn(entry, "succeeded", { status: "settled", safepointSafe: globalSafe });
      } else if (Date.now() >= entry.deadline && !entry.timedOut) {
        const reason = scope.safepoint.safe ? "foreground_still_running" : scope.safepoint.blockers.map((blocker) => blocker.reason).join(",");
        if (entry.compatibility) {
          finishTurn(entry, "interrupted", { status: "timeout_unsettled", safepointSafe: false, reason });
        } else {
          entry.timedOut = true;
          publishTurn(entry, { cancelRequested: true, state: "running" });
          interruptTurn(entry);
        }
      }
    }
    await settleCompleted();
  };

  function schedulePump(): void {
    if (pumpScheduled || disposed) return;
    pumpScheduled = true;
    setTimeout(() => {
      void enqueueWithoutSnapshot(pumpSlice).catch((error) => {
        for (const entry of activeByActor.values()) {
          finishTurn(entry, "failed", { status: "failed", safepointSafe: false, error: error instanceof Error ? error.message : String(error) });
        }
        for (const { entry } of completed.splice(0)) entry.reject(error);
      }).finally(() => {
        pumpScheduled = false;
        const runnable = [...activeByActor.values()].some((entry) => entry.view.state === "running");
        const queued = [...queuedByActor.keys()].some((actorId) => !activeByActor.has(actorId));
        if (runnable || queued || completed.length) schedulePump();
      });
    }, 0);
  }

  const admit = (admission: RuntimeInteractiveTurnAdmission, compatibility = false): RuntimeInteractiveTurnHandle => {
    if (disposed || closing) throw new Error("runtime_coordinator_disposed");
    if (!admission.turnId || turns.has(admission.turnId)) throw new Error("runtime_turn_id_conflict");
    const fiber = params.driver.inspectRuntime().fibers[admission.mainFiberId];
    if (!fiber || fiber.actor.id !== admission.actorId) throw new Error("runtime_actor_not_found");
    if (admission.executionOrigin) {
      const origin = decodeExecutionOrigin(admission.executionOrigin);
      if (!origin || origin.actorId !== admission.actorId || origin.turnId !== admission.turnId
        || (origin.source === "web" && origin.sessionId !== String((params.vm.outerCtx?.metadata as any)?.sessionId ?? ""))) {
        throw new Error("runtime_execution_origin_invalid");
      }
      admission = { ...admission, executionOrigin: origin };
    }
    if ([...turns.values()].filter((entry) => !isTerminal(entry.view.state)).length >= capacity.maxOutstandingTurns) {
      throw new Error("runtime_session_turn_capacity");
    }
    if ((queuedByActor.get(admission.actorId)?.length ?? 0) >= capacity.maxQueuedTurnsPerActor) {
      throw new Error("runtime_actor_turn_capacity");
    }
    let resolve!: TurnEntry["resolve"];
    let reject!: TurnEntry["reject"];
    const settled = new Promise<AiAgentRuntimeInteractiveTurnResult>((ok, fail) => { resolve = ok; reject = fail; });
    const entry: TurnEntry = {
      admission, compatibility, settled, resolve, reject, controller: new AbortController(),
      delivered: false, preparing: false, deadline: Infinity, timedOut: false,
      view: Object.freeze({ turnId: admission.turnId, actorId: admission.actorId, mainFiberId: admission.mainFiberId,
        state: "queued", cancelRequested: false }),
    };
    turns.set(admission.turnId, entry);
    const queue = queuedByActor.get(admission.actorId) ?? [];
    queue.push(entry);
    queuedByActor.set(admission.actorId, queue);
    publishTurn(entry, {});
    schedulePump();
    return { turnId: admission.turnId, settled };
  };

  const cancelInteractiveTurn = (input: { actorId: string; turnId: string }): RuntimeInteractiveTurnCancelResult => {
    const entry = turns.get(input.turnId);
    if (!entry || entry.view.actorId !== input.actorId) return { status: "not_found" };
    if (isTerminal(entry.view.state)) return { status: "already_terminal" };
    if (entry.delivered && !entry.preparing && entry.view.state === "running" && !entry.view.cancelRequested) {
      const scope = readScope(entry);
      if (!scope.outstanding && scope.safepoint.safe && !scope.human) {
        const globalSafe = evaluateAiAgentRuntimeSnapshotSafepoint({ vm: params.vm, inspected: params.driver.inspectRuntime() }).safe;
        finishTurn(entry, "succeeded", { status: "settled", safepointSafe: globalSafe });
        schedulePump();
        return { status: "already_terminal" };
      }
    }
    if (entry.view.state === "queued") {
      finishTurn(entry, "cancelled", { status: "cancelled", safepointSafe: false });
      schedulePump();
      return { status: "cancelled_before_delivery" };
    }
    if (!entry.view.cancelRequested) {
      publishTurn(entry, { cancelRequested: true, state: "running" });
      interruptTurn(entry);
    }
    schedulePump();
    return { status: "cancel_requested" };
  };

  const resumeInteractiveTurn = (input: { actorId: string; turnId: string }): boolean => {
    const entry = turns.get(input.turnId);
    if (!entry || entry.view.actorId !== input.actorId || entry.view.state !== "waiting_input") return false;
    publishTurn(entry, { state: "running", waitingFiberId: undefined, waitingReason: undefined });
    params.driver.resumeFiber(entry.admission.mainFiberId, Date.now());
    schedulePump();
    return true;
  };

  const runInteractiveTurn = (input: { mainFiberId: string; timeoutMs?: number }) => {
    const actor = params.driver.inspectRuntime().fibers[input.mainFiberId]?.actor;
    if (!actor) return Promise.reject(new Error("runtime_actor_not_found"));
    return admit({ ...input, actorId: actor.id, turnId: `local-turn:${++compatibilitySequence}` }, true).settled;
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
    enqueueWithoutSnapshot,
    // Existing command owners call this from inside enqueue. The safepoint
    // check belongs to saveSnapshotAfterProgress; recursively enqueueing here
    // would deadlock that owner.
    saveSnapshot: saveSnapshotAfterProgress,
    startBackgroundPump,
    stopBackgroundPump,
    runInteractiveTurn,
    admitInteractiveTurn: (input) => admit(input),
    forgetInteractiveTurn: ({ actorId, turnId }) => {
      const entry = turns.get(turnId);
      if (!entry || entry.view.actorId !== actorId || !isTerminal(entry.view.state)) return false;
      return turns.delete(turnId);
    },
    cancelInteractiveTurn,
    resumeInteractiveTurn,
    readInteractiveTurns: () => [...turns.values()].map((entry) => entry.view),
    subscribeInteractiveTurns: (listener) => {
      turnListeners.add(listener);
      return { unsubscribe: () => { turnListeners.delete(listener); } };
    },
    deliverMemberInbox,
    shutdown() {
      return shutdownPromise ??= (async () => {
        closing = true;
        stopBackgroundPump();
        const pending = [...turns.values()].filter((entry) => !isTerminal(entry.view.state));
        for (const entry of pending) cancelInteractiveTurn(entry.view);
        await Promise.allSettled(pending.map((entry) => entry.settled));
        await enqueueWithoutSnapshot(async () => {
          for (const fiberId of Object.keys(params.driver.inspectRuntime().fibers)) {
            params.driver.settleInterruptedFiber({ fiberId, now: Date.now(), reason: "idle_external" as any });
          }
          // Cancellation requests are not completion. Detached effects and
          // provider transports retain the session writer until their actual
          // tasks have returned, even when a fiber record is already terminal.
          await params.driver.awaitOwnedTasks();
          await flushPersistenceWriteBehind();
          await checkpointDiagnostics.flush();
        });
      })();
    },
    dispose() {
      disposed = true;
      stopBackgroundPump();
      for (const entry of turns.values()) {
        if (isTerminal(entry.view.state)) continue;
        entry.controller.abort();
        entry.resolve({ status: "timeout_unsettled", safepointSafe: false, reason: "runtime_coordinator_disposed" });
      }
      activeByActor.clear();
      queuedByActor.clear();
      turnListeners.clear();
      syncInteractiveActive();
      void flushPersistenceWriteBehind();
      void checkpointDiagnostics.flush().catch(() => {});
    },
  };
}
