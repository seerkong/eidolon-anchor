import type { ActorDef } from "depa-actor";
import {
  ActorRuntime,
  CompletionBindingRegistry,
  type CompletionSignalRegistry,
  createAiAgentSchedulerHooks,
  createCompletionBindingRegistry,
  createRuntimeIndexHook,
  createOrchestratorState,
  computeEffectivePriority,
  dispatchEffects,
  reduceOrchestrator,
  scheduleOne,
  selectNextFiberId,
  type FiberWaitingReason,
  type RuntimeIndexHook,
  type SuspendPolicy,
  type OrchestratorState,
} from "depa-actor";

import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import { ensureVmRuntimeContext, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import { AI_AGENT_COORDINATION_KINDS, AI_AGENT_COORDINATION_NAMES } from "@cell/ai-core-logic";
import { normalizeDelegateRunMode, type DelegateRunMode } from "@cell/ai-organ-contract/agent/DelegateRunMode";
import {
  type DetachedActorKind,
  DETACHED_ACTOR_STATUSES,
  getDetachedActorRegistry,
} from "./detached/DetachedActorRegistry";
import { aiAgentCooperativeStep } from "./exec/AiAgentExecutor";
import {
  isBackgroundAiAgentLane,
  isForegroundAiAgentLane,
  type AiAgentLane,
} from "./lane/AiAgentLane";
import { inferFiberWorkload, resolveMainFiberWorkload, type AiAgentWorkload } from "./lane/AiAgentWorkload";
import { getCoordinationEngine } from "./coordination/CoordinationEngine";
import { getMemberManager } from "./organization/MemberManager";

export const AI_AGENT_ORCHESTRATOR_TICK_SCOPES = {
  all: "all",
  foreground: "foreground",
  background: "background",
} as const

export type AiAgentOrchestratorTickScope =
  (typeof AI_AGENT_ORCHESTRATOR_TICK_SCOPES)[keyof typeof AI_AGENT_ORCHESTRATOR_TICK_SCOPES]

export const AI_AGENT_FIBER_RESULT_KINDS = {
  yield: "yield",
  suspend: "suspend",
  complete: "complete",
  fail: "fail",
  cancel: "cancel",
} as const

export type AiAgentFiberResultKind =
  (typeof AI_AGENT_FIBER_RESULT_KINDS)[keyof typeof AI_AGENT_FIBER_RESULT_KINDS]

type AiAgentOrchestrationSchema = {
  tick: { now: number; scope?: AiAgentOrchestratorTickScope };
  resume_fiber: { fiberId: string; now: number };
  agent_step: { fiberId: string };
  fiber_result: {
    fiberId: string;
    now: number;
    kind: AiAgentFiberResultKind;
    reason?: FiberWaitingReason;
    suspendPolicy?: SuspendPolicy;
    error?: string;
    cancelReason?: string;
    propagateCancelToChildren?: boolean;
  };
};

function isDelegateFiberKind(kind: unknown): boolean {
  return kind === "delegate"
}

function isDelegateActorType(actor: AiAgentActor): boolean {
  return actor.type === "delegate"
}

function isDetachedActorType(actor: AiAgentActor): boolean {
  return actor.type === "detached";
}

function isChildExecutionActor(actor: AiAgentActor): boolean {
  return isDelegateActorType(actor) || isDetachedActorType(actor);
}

function resolveActorSenderName(actor: AiAgentActor): string {
  if (actor.identity?.kind === "member") return actor.identity.name
  return actor.key
}

function finalizeShutdownIfNeeded(ctx: FiberContext): void {
  const requestId = ctx.actor.shutdownCoordination?.requestId;
  if (!requestId) return;

  const from = resolveActorSenderName(ctx.actor);
  const engine = getCoordinationEngine();
  const done = engine.makeOutbound({
    coordination: AI_AGENT_COORDINATION_NAMES.shutdown,
    kind: AI_AGENT_COORDINATION_KINDS.shutdownDone,
    request_id: requestId,
    payload: {},
  });
  const rec = engine.ingestMemberInbox(ctx.vm, { from, text: done.text, ts: Date.now() });
  if (rec.handled) {
    ctx.actor.shutdownCoordination = {
      requestId: rec.request_id,
      status: rec.status,
      kind: rec.kind as NonNullable<AiAgentActor["shutdownCoordination"]>["kind"],
      decision: rec.decision,
      updatedAt: Date.now(),
    };
    ctx.vm.effects.orchestrationHistory?.appendEvent({
      stream: "coordination_event",
      kind: "coordination_ingest",
      payload: {
        from,
        coordination: rec.coordination,
        coordination_kind: rec.kind,
        request_id: rec.request_id,
        status: rec.status,
        decision: rec.decision ?? null,
      },
    });
    ctx.vm.eventBus?.emitCoordinationEvent?.(
      { key: ctx.actor.key, id: ctx.actor.id },
      {
        from,
        coordination: rec.coordination,
        kind: rec.kind,
        requestId: rec.request_id,
        status: rec.status,
        decision: rec.decision,
      },
    );
  }

  getMemberManager().markExitedByActor({ vm: ctx.vm, actorKey: ctx.actor.key, actorId: ctx.actor.id });
}

function isTerminalDetachedActorStatus(status: unknown): boolean {
  return status === DETACHED_ACTOR_STATUSES.completed
    || status === DETACHED_ACTOR_STATUSES.failed
    || status === DETACHED_ACTOR_STATUSES.cancelled;
}

function updateDetachedActorStatus(
  runtime: AiAgentOrchestratorRuntime,
  fiberId: string,
  status: typeof DETACHED_ACTOR_STATUSES.running | typeof DETACHED_ACTOR_STATUSES.suspended,
): void {
  const done = runtime.childDoneMap.get(fiberId);
  if (!done || done.mode !== "detached" || !done.taskId || !done.taskKind) {
    return;
  }

  // Prefer the VM attached to the parent fiber, since the registry is keyed per VM.
  const parentCtx = runtime.fiberIndex.get(done.parentFiberId);
  const ctx = parentCtx ?? runtime.fiberIndex.get(fiberId);
  if (!ctx) return;

  const registry = getDetachedActorRegistry(ctx.vm);
  const existing = registry.get(done.taskId);
  if (!existing || isTerminalDetachedActorStatus(existing.status)) {
    return;
  }

  const childActor = runtime.fiberIndex.get(fiberId)?.actor;
  if (childActor?.type === "detached" && childActor.detachedTask) {
    childActor.detachedTask = {
      ...childActor.detachedTask,
      kind: done.taskKind,
      status,
      updatedAt: Date.now(),
      toolCallId: childActor.detachedTask.toolCallId ?? existing.toolCallId,
      parentFiberId: done.parentFiberId,
      childFiberId: fiberId,
    };
  }

  registry.update(done.taskId, {
    kind: done.taskKind,
    status,
    parentFiberId: done.parentFiberId,
    childFiberId: fiberId,
    childActorKey: runtime.fiberIndex.get(fiberId)?.actor?.key,
    childActorId: runtime.fiberIndex.get(fiberId)?.actor?.id,
  } as any);
}

type FiberContext = {
  fiberId: string;
  vm: AiAgentVm;
  actor: AiAgentActor;
  messages: any[];
  kind?: "control" | "delegate";
  lane?: AiAgentLane;
  workload?: AiAgentWorkload;
  execState?: any;
};

export type FiberStepOutcome =
  | { kind: typeof AI_AGENT_FIBER_RESULT_KINDS.yield }
  | { kind: typeof AI_AGENT_FIBER_RESULT_KINDS.suspend; reason: FiberWaitingReason; suspendPolicy?: SuspendPolicy }
  | { kind: typeof AI_AGENT_FIBER_RESULT_KINDS.complete }
  | { kind: typeof AI_AGENT_FIBER_RESULT_KINDS.cancel; reason: string; propagateToChildren?: boolean }
  | { kind: typeof AI_AGENT_FIBER_RESULT_KINDS.fail; error: string };

type RunStep = (ctx: FiberContext, helpers: { resume: (fiberId: string) => void }) => Promise<FiberStepOutcome>;

type WaiterStoreResultMap = {
  autonomousHolonTaskSignals: { status: string; resultText: string | null };
  leaderLedHolonRouteSignals: { resultText: string | null };
};

export type AiAgentOrchestratorDriver = {
  orchestratorId: string;
  actorRuntime: ActorRuntime<AiAgentOrchestratorRuntime, AiAgentOrchestrationSchema>;
  getState: () => OrchestratorState<AiAgentOrchestrationSchema>;
  inspectRuntime: () => {
    state: OrchestratorState<AiAgentOrchestrationSchema>;
    fibers: Record<string, FiberContext>;
    pendingResumes: string[];
    childDoneMap: Record<
      string,
      {
        parentFiberId: string;
        mode: DelegateRunMode;
        toolCallId?: string;
        taskId?: string;
        taskKind?: DetachedActorKind;
      }
    >;
  };
  tick: (now: number) => void;
  resumeFiber: (fiberId: string, now: number) => void;
  suspendFiber: (fiberId: string, now: number, reason: FiberWaitingReason, suspendPolicy?: SuspendPolicy) => void;
  tickUntilBlocked: (params: { now: number; maxTicks?: number; maxWallMs?: number }) => Promise<void>;
  tickUntilForegroundSettled: (params: { now: number; maxTicks?: number; maxWallMs?: number }) => Promise<void>;
  tickUntilBackgroundSettled: (params: { now: number; maxTicks?: number; maxWallMs?: number }) => Promise<void>;
  waitForSignal: <K extends keyof WaiterStoreResultMap>(params: {
    vm: AiAgentVm;
    waiterKey: string;
    waiterStore: K;
    resolveCurrent: () => WaiterStoreResultMap[K] | null;
    maxTicks?: number;
    maxWallMs?: number;
  }) => Promise<WaiterStoreResultMap[K] | null>;
  spawnFiber: (params: {
    fiberId: string;
    vm: AiAgentVm;
    actor: AiAgentActor;
    messages: any[];
    basePriority: number;
    parentFiberId?: string;
    kind?: "control" | "delegate";
    lane?: AiAgentLane;
    workload?: AiAgentWorkload;
    onDone?: {
      parentFiberId: string;
      mode: DelegateRunMode;
      toolCallId?: string;
      taskId?: string;
      taskKind?: DetachedActorKind;
    };
  }) => void;
};

function isHumanWaitReason(reason: unknown): boolean {
  return reason === "human_clarification" || reason === "human_approval" || reason === "human_answer";
}

function hasPauseAllHumanWaitInForeground(state: OrchestratorState<AiAgentOrchestrationSchema>): boolean {
  return Object.values(state.fibers).some((fiber: any) => {
    return (
      fiber.status === "suspended" &&
      isHumanWaitReason(fiber.waitingReason) &&
      fiber.suspendPolicy === "pause_all" &&
      isForegroundAiAgentLane(fiber.lane)
    );
  });
}

function selectNextForegroundFiberId(state: OrchestratorState<AiAgentOrchestrationSchema>): string | undefined {
  if (hasPauseAllHumanWaitInForeground(state)) {
    return undefined;
  }

  const candidates = Object.values(state.fibers).filter((fiber: any) => {
    return fiber.status === "ready" && isForegroundAiAgentLane(fiber.lane);
  }) as any[];

  if (candidates.length === 0) {
    return undefined;
  }

  const agingStep = state.options.agingStep;
  candidates.sort((a, b) => {
    const pa = computeEffectivePriority(a, agingStep);
    const pb = computeEffectivePriority(b, agingStep);
    if (pa !== pb) {
      return pa - pb;
    }
    return a.order - b.order;
  });

  return candidates[0]?.id;
}

function selectNextBackgroundFiberId(state: OrchestratorState<AiAgentOrchestrationSchema>): string | undefined {
  const candidates = Object.values(state.fibers).filter((fiber: any) => {
    return fiber.status === "ready" && isBackgroundAiAgentLane(fiber.lane);
  }) as any[];

  if (candidates.length === 0) {
    return undefined;
  }

  const agingStep = state.options.agingStep;
  candidates.sort((a, b) => {
    const pa = computeEffectivePriority(a, agingStep);
    const pb = computeEffectivePriority(b, agingStep);
    if (pa !== pb) {
      return pa - pb;
    }
    return a.order - b.order;
  });

  return candidates[0]?.id;
}

function scheduleOneForeground(
  state: OrchestratorState<AiAgentOrchestrationSchema>,
  now: number,
): {
  state: OrchestratorState<AiAgentOrchestrationSchema>;
  effects: any[];
  selectedFiberId?: string;
} {
  const selectedFiberId = selectNextForegroundFiberId(state);
  if (!selectedFiberId) {
    return { state, effects: [] };
  }

  const selected: any = (state.fibers as any)[selectedFiberId];
  if (!selected) {
    return { state, effects: [] };
  }

  const timeoutMs = selected.timeoutMs ?? state.options.defaultTimeoutMs;
  const timeoutAt = state.options.timeoutEnabled && timeoutMs > 0 ? now + timeoutMs : undefined;

  const nextFibers: any = { ...(state.fibers as any) };
  for (const [id, fiber] of Object.entries(state.fibers as Record<string, any>)) {
    if (id === selectedFiberId) {
      nextFibers[id] = {
        ...fiber,
        status: DETACHED_ACTOR_STATUSES.running,
        age: 0,
        timeoutAt,
        updatedAt: now,
      };
      continue;
    }

    if (fiber.status === "ready" && isForegroundAiAgentLane(fiber.lane)) {
      nextFibers[id] = {
        ...fiber,
        age: fiber.age + Math.max(0, state.options.agingStep),
        updatedAt: now,
      };
    }
  }

  const effects: any[] = [];
  const withStep = nextFibers[selectedFiberId];
  if (withStep?.step) {
    effects.push({
      kind: "send",
      fiberId: selectedFiberId,
      to: withStep.actorId,
      step: withStep.step,
    });
  }

  return {
    state: {
      ...state,
      fibers: nextFibers,
    } as any,
    effects,
    selectedFiberId,
  };
}

function scheduleOneBackground(
  state: OrchestratorState<AiAgentOrchestrationSchema>,
  now: number,
): {
  state: OrchestratorState<AiAgentOrchestrationSchema>;
  effects: any[];
  selectedFiberId?: string;
} {
  const selectedFiberId = selectNextBackgroundFiberId(state);
  if (!selectedFiberId) {
    return { state, effects: [] };
  }

  const selected: any = (state.fibers as any)[selectedFiberId];
  if (!selected) {
    return { state, effects: [] };
  }

  const timeoutMs = selected.timeoutMs ?? state.options.defaultTimeoutMs;
  const timeoutAt = state.options.timeoutEnabled && timeoutMs > 0 ? now + timeoutMs : undefined;

  const nextFibers: any = { ...(state.fibers as any) };
  for (const [id, fiber] of Object.entries(state.fibers as Record<string, any>)) {
    if (id === selectedFiberId) {
      nextFibers[id] = {
        ...fiber,
        status: DETACHED_ACTOR_STATUSES.running,
        age: 0,
        timeoutAt,
        updatedAt: now,
      };
      continue;
    }

    if (fiber.status === "ready" && isBackgroundAiAgentLane(fiber.lane)) {
      nextFibers[id] = {
        ...fiber,
        age: fiber.age + Math.max(0, state.options.agingStep),
        updatedAt: now,
      };
    }
  }

  const effects: any[] = [];
  const withStep = nextFibers[selectedFiberId];
  if (withStep?.step) {
    effects.push({
      kind: "send",
      fiberId: selectedFiberId,
      to: withStep.actorId,
      step: withStep.step,
    });
  }

  return {
    state: {
      ...state,
      fibers: nextFibers,
    } as any,
    effects,
    selectedFiberId,
  };
}

export type AiAgentOrchestratorRuntime = {
  orchestratorId: string;
  actorRuntime: ActorRuntime<AiAgentOrchestratorRuntime, AiAgentOrchestrationSchema>;
  state: OrchestratorState<AiAgentOrchestrationSchema>;
  fiberIndex: RuntimeIndexHook<string, FiberContext>;
  pendingResumes: Set<string>;
  childDoneMap: CompletionBindingRegistry<
    string,
    {
      parentFiberId: string;
      mode: DelegateRunMode;
      toolCallId?: string;
      taskId?: string;
      taskKind?: DetachedActorKind;
    }
  >;
  spawnFiber: AiAgentOrchestratorDriver["spawnFiber"];
  runStep: RunStep;
};

function findLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      const content = msg?.content;
      if (typeof content === "string") return content;
      if (content === undefined || content === null) return "";
      try {
        return JSON.stringify(content);
      } catch {
        return String(content);
      }
    }
  }
  return "(delegate actor returned no text)";
}

const ORCH_MAILBOX_PRIORITY = {
  fiber_result: 0,
  resume_fiber: 10,
  tick: 20,
  agent_step: 30,
} as const;

async function flushMicrotasks(): Promise<void> {
  // ActorSystem drains via queueMicrotask; yielding to macrotasks gives it time.
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

function hasRunningFibers(state: OrchestratorState<AiAgentOrchestrationSchema>): boolean {
  return Object.values(state.fibers).some((f) => f.status === "running");
}

function hasRunningFibersWhere(
  state: OrchestratorState<AiAgentOrchestrationSchema>,
  predicate: (fiberId: string) => boolean,
): boolean {
  return Object.entries(state.fibers).some(([id, f]) => f.status === "running" && predicate(id));
}

function hasInflightAsync(runtime: AiAgentOrchestratorRuntime): boolean {
  for (const [fiberId, ctx] of Object.entries(runtime.fiberIndex.snapshot())) {
    const rec = runtime.state.fibers[fiberId];
    if (!rec) continue;
    if (rec.status !== "suspended") continue;
    const reason = rec.waitingReason;
    if (reason !== "external" && reason !== "tool_result") continue;
    const inflight = (ctx.execState as any)?.inflight;
    if (inflight) return true;
  }
  return false;
}

function hasInflightAsyncWhere(runtime: AiAgentOrchestratorRuntime, predicate: (fiberId: string) => boolean): boolean {
  for (const [fiberId, ctx] of Object.entries(runtime.fiberIndex.snapshot())) {
    if (!predicate(fiberId)) continue;
    const rec: any = runtime.state.fibers[fiberId];
    if (!rec) continue;
    if (rec.status !== "suspended") continue;
    const reason = rec.waitingReason;
    if (reason !== "external" && reason !== "tool_result") continue;
    const inflight = (ctx.execState as any)?.inflight;
    if (inflight) return true;
  }
  return false;
}

function hasPendingResumesWhere(runtime: AiAgentOrchestratorRuntime, predicate: (fiberId: string) => boolean): boolean {
  for (const id of runtime.pendingResumes) {
    if (predicate(id)) return true;
  }
  return false;
}

async function waitForNoRunningFibers(params: {
  getState: () => OrchestratorState<AiAgentOrchestrationSchema>;
  deadlineMs: number;
}): Promise<void> {
  // Wait until the scheduled fiber step completes and reports back.
  while (hasRunningFibers(params.getState())) {
    if (Date.now() > params.deadlineMs) {
      return;
    }
    await flushMicrotasks();
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

async function waitForNoRunningFibersWhere(params: {
  getState: () => OrchestratorState<AiAgentOrchestrationSchema>;
  deadlineMs: number;
  predicate: (fiberId: string) => boolean;
}): Promise<void> {
  while (hasRunningFibersWhere(params.getState(), params.predicate)) {
    if (Date.now() > params.deadlineMs) {
      return;
    }
    await flushMicrotasks();
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

// Questionnaire wait mapping is handled in the cooperative stepper.

function createOrchestratorActor(): ActorDef<AiAgentOrchestratorRuntime, AiAgentOrchestrationSchema, void> {
  return {
    initialState: undefined,
    priority: ORCH_MAILBOX_PRIORITY,
    handler: (self, envelope) => {
      const runtime = self.runtime;
      if (envelope.tag === "tick") {
        const now = (envelope.payload as any)?.now;
        const scope = (envelope.payload as any)?.scope ?? AI_AGENT_ORCHESTRATOR_TICK_SCOPES.all;
        const t = typeof now === "number" ? now : Date.now();

        const ticked = reduceOrchestrator(runtime.state, { type: "tick", now: t });
        runtime.state = ticked.state;

        if (scope === AI_AGENT_ORCHESTRATOR_TICK_SCOPES.foreground) {
          const scheduled = scheduleOneForeground(runtime.state, t);
          runtime.state = scheduled.state;
          dispatchEffects(runtime.actorRuntime, scheduled.effects as any, runtime.state.options.senderId);
        } else if (scope === AI_AGENT_ORCHESTRATOR_TICK_SCOPES.background) {
          const scheduled = scheduleOneBackground(runtime.state, t);
          runtime.state = scheduled.state;
          dispatchEffects(runtime.actorRuntime, scheduled.effects as any, runtime.state.options.senderId);
        } else {
          const scheduled = scheduleOne(runtime.state, t);
          runtime.state = scheduled.state;
          dispatchEffects(runtime.actorRuntime, scheduled.effects, runtime.state.options.senderId);
        }
        return;
      }

      if (envelope.tag === "resume_fiber") {
        const payload = envelope.payload as any;
        const fiberId = String(payload?.fiberId ?? "");
        const now = typeof payload?.now === "number" ? payload.now : Date.now();
        if (!fiberId) return;

        updateDetachedActorStatus(runtime, fiberId, "running");

        const current = runtime.state.fibers[fiberId];
        if (!current) return;
        if (current.status !== "suspended") {
          runtime.pendingResumes.add(fiberId);
          return;
        }

        const next = reduceOrchestrator(runtime.state, {
          type: "resume",
          fiberId,
          now,
          nextStep: { tag: "agent_step", payload: { fiberId } },
        });
        runtime.state = next.state;
        return;
      }

      if (envelope.tag === "fiber_result") {
        const payload = envelope.payload as any;
        const fiberId = String(payload?.fiberId ?? "");
        const now = typeof payload?.now === "number" ? payload.now : Date.now();
        if (!fiberId) return;

        if (payload.kind === "yield") {
          updateDetachedActorStatus(runtime, fiberId, "running");
          runtime.state = reduceOrchestrator(runtime.state, {
            type: "yield",
            fiberId,
            now,
            nextStep: { tag: "agent_step", payload: { fiberId } },
          }).state;
          return;
        }

        if (payload.kind === "complete") {
          runtime.state = reduceOrchestrator(runtime.state, { type: "complete", fiberId, now }).state;
          return;
        }

        if (payload.kind === "cancel") {
          const reason = typeof payload?.cancelReason === "string" && payload.cancelReason ? payload.cancelReason : "cancel";
          const propagate = payload?.propagateCancelToChildren !== false;
          runtime.state = reduceOrchestrator(runtime.state, {
            type: "cancel",
            fiberId,
            now,
            reason,
            propagateToChildren: propagate,
          }).state;
          return;
        }

        if (payload.kind === "fail") {
          const error = typeof payload?.error === "string" ? payload.error : "unknown";
          runtime.state = reduceOrchestrator(runtime.state, { type: "fail", fiberId, now, error }).state;
          return;
        }

        const reason = (payload.reason as FiberWaitingReason) ?? "external";
        updateDetachedActorStatus(runtime, fiberId, "suspended");
        runtime.state = reduceOrchestrator(runtime.state, {
          type: "suspend",
          fiberId,
          now,
          reason,
          suspendPolicy: payload.suspendPolicy as SuspendPolicy | undefined,
        }).state;

        if (runtime.pendingResumes.has(fiberId)) {
          runtime.pendingResumes.delete(fiberId);
          runtime.state = reduceOrchestrator(runtime.state, {
            type: "resume",
            fiberId,
            now,
            nextStep: { tag: "agent_step", payload: { fiberId } },
          }).state;
        }
        return;
      }
    },
  };
}

function createFiberActor(fiberId: string): ActorDef<AiAgentOrchestratorRuntime, AiAgentOrchestrationSchema, void> {
  return {
    initialState: undefined,
    priority: ORCH_MAILBOX_PRIORITY,
    handler: async (self, envelope) => {
      if (envelope.tag !== "agent_step") {
        return;
      }

      const runtime = self.runtime;
      const ctx = runtime.fiberIndex.get(fiberId);
      if (!ctx) {
        self.send(runtime.orchestratorId, "fiber_result", {
          fiberId,
          now: Date.now(),
          kind: AI_AGENT_FIBER_RESULT_KINDS.fail,
          error: "missing fiber context",
        });
        return;
      }

      const runtimeContext = ensureVmRuntimeContext(ctx.vm);
      const prevOrch = runtimeContext.currentOrchestrator;
      runtimeContext.currentOrchestrator = {
        parentFiberId: fiberId,
        spawnFiber: runtime.spawnFiber,
      };

      try {
        const result = await runtime.runStep(ctx, {
          resume: (id) => {
            self.send(runtime.orchestratorId, "resume_fiber", { fiberId: id, now: Date.now() });
          },
        });

        const isChildExecution = isDelegateFiberKind(ctx.kind) || isChildExecutionActor(ctx.actor);
        const isTransientDelegateExecution = isDelegateFiberKind(ctx.kind) || isDelegateActorType(ctx.actor);

        if (result.kind === AI_AGENT_FIBER_RESULT_KINDS.yield) {
          self.send(runtime.orchestratorId, "fiber_result", {
            fiberId,
            now: Date.now(),
            kind: AI_AGENT_FIBER_RESULT_KINDS.yield,
          });
          return;
        }

        if (result.kind === AI_AGENT_FIBER_RESULT_KINDS.suspend) {
          self.send(runtime.orchestratorId, "fiber_result", {
            fiberId,
            now: Date.now(),
            kind: AI_AGENT_FIBER_RESULT_KINDS.suspend,
            reason: result.reason,
            suspendPolicy: result.suspendPolicy,
          });
          return;
        }

        if (result.kind === AI_AGENT_FIBER_RESULT_KINDS.cancel) {
          finalizeShutdownIfNeeded(ctx);
          getMemberManager().markExitedByActor({ vm: ctx.vm, actorKey: ctx.actor.key, actorId: ctx.actor.id });
          const done = runtime.childDoneMap.get(fiberId);
          if (done) {
            const parentCtx = runtime.fiberIndex.get(done.parentFiberId);
            const outputText = isChildExecution ? findLastAssistantText(ctx.messages) : "";
            if (parentCtx) {
              parentCtx.actor.send("childDone", {
                childFiberId: fiberId,
                childActorKey: ctx.actor.key,
                childActorId: ctx.actor.id,
                mode: done.mode,
                toolCallId: done.toolCallId,
                outputText: outputText || `Delegate actor ${ctx.actor.key} cancelled`,
              });

              if (done.mode === "sync_wait") {
                self.send(runtime.orchestratorId, "resume_fiber", {
                  fiberId: done.parentFiberId,
                  now: Date.now(),
                });
              }

              if (done.mode === "detached" && done.taskId && done.taskKind) {
                const registry = getDetachedActorRegistry(parentCtx.vm);
                registry.update(done.taskId, {
                  kind: done.taskKind,
                  status: DETACHED_ACTOR_STATUSES.cancelled,
                  toolCallId: done.toolCallId,
                  parentFiberId: done.parentFiberId,
                  childFiberId: fiberId,
                  childActorKey: ctx.actor.key,
                  childActorId: ctx.actor.id,
                  outputText: outputText || `Delegate actor ${ctx.actor.key} cancelled`,
                });

                parentCtx.vm.eventBus?.emitDetachedActorDone(
                  { key: parentCtx.actor.key, id: parentCtx.actor.id },
                  {
                    taskId: done.taskId,
                    kind: done.taskKind,
                    status: DETACHED_ACTOR_STATUSES.cancelled,
                    toolCallId: done.toolCallId,
                    childFiberId: fiberId,
                    childActorKey: ctx.actor.key,
                    childActorId: ctx.actor.id,
                    outputText: outputText || `Delegate actor ${ctx.actor.key} cancelled`,
                  },
                );

                parentCtx.vm.effects.orchestrationHistory?.appendEvent({
                  stream: "detached_actor",
                  kind: "detached_actor_done",
                  payload: {
                    task_id: done.taskId,
                    task_kind: done.taskKind,
                    status: DETACHED_ACTOR_STATUSES.cancelled,
                    tool_call_id: done.toolCallId ?? null,
                    child_fiber_id: fiberId,
                    child_actor_key: ctx.actor.key,
                    child_actor_id: ctx.actor.id,
                  },
                });
              }
            }

            if (ctx.actor.type === "detached" && done.taskId && done.taskKind) {
              ctx.actor.detachedTask = {
                taskId: done.taskId,
                kind: done.taskKind,
                status: DETACHED_ACTOR_STATUSES.cancelled,
                createdAt: ctx.actor.detachedTask?.createdAt ?? Date.now(),
                updatedAt: Date.now(),
                toolCallId: done.toolCallId,
                parentFiberId: done.parentFiberId,
                childFiberId: fiberId,
                outputText: outputText || `Delegate actor ${ctx.actor.key} cancelled`,
              };
            } else if (isTransientDelegateExecution) {
              delete ctx.vm.actors[ctx.actor.key];
              if (ctx.vm.actorRuntime.has(ctx.actor.key)) {
                ctx.vm.actorRuntime.unregister(ctx.actor.key);
              }
            }
          }

          self.send(runtime.orchestratorId, "fiber_result", {
            fiberId,
            now: Date.now(),
            kind: AI_AGENT_FIBER_RESULT_KINDS.cancel,
            cancelReason: result.reason,
            propagateCancelToChildren: result.propagateToChildren,
          });
          return;
        }

        if (result.kind === AI_AGENT_FIBER_RESULT_KINDS.fail) {
          const error = typeof (result as any).error === "string" ? (result as any).error : "unknown";
          const done = runtime.childDoneMap.get(fiberId);
          if (isChildExecution && done) {
            const parentCtx = runtime.fiberIndex.get(done.parentFiberId);
            if (parentCtx) {
              parentCtx.actor.send("childDone", {
                childFiberId: fiberId,
                childActorKey: ctx.actor.key,
                childActorId: ctx.actor.id,
                mode: done.mode,
                toolCallId: done.toolCallId,
                outputText: `Delegate actor ${ctx.actor.key} failed: ${error}`,
              });

              if (done.mode === "sync_wait") {
                self.send(runtime.orchestratorId, "resume_fiber", {
                  fiberId: done.parentFiberId,
                  now: Date.now(),
                });
              }

              if (done.mode === "detached" && done.taskId && done.taskKind) {
                const registry = getDetachedActorRegistry(parentCtx.vm);
                registry.update(done.taskId, {
                  kind: done.taskKind,
                  status: DETACHED_ACTOR_STATUSES.failed,
                  toolCallId: done.toolCallId,
                  parentFiberId: done.parentFiberId,
                  childFiberId: fiberId,
                  childActorKey: ctx.actor.key,
                  childActorId: ctx.actor.id,
                  outputText: `Delegate actor ${ctx.actor.key} failed: ${error}`,
                  error,
                });

                parentCtx.vm.eventBus?.emitDetachedActorDone(
                  { key: parentCtx.actor.key, id: parentCtx.actor.id },
                  {
                    taskId: done.taskId,
                    kind: done.taskKind,
                    status: DETACHED_ACTOR_STATUSES.failed,
                    toolCallId: done.toolCallId,
                    childFiberId: fiberId,
                    childActorKey: ctx.actor.key,
                    childActorId: ctx.actor.id,
                    outputText: `Delegate actor ${ctx.actor.key} failed: ${error}`,
                    error,
                  },
                );

                parentCtx.vm.effects.orchestrationHistory?.appendEvent({
                  stream: "detached_actor",
                  kind: "detached_actor_done",
                  payload: {
                    task_id: done.taskId,
                    task_kind: done.taskKind,
                    status: DETACHED_ACTOR_STATUSES.failed,
                    tool_call_id: done.toolCallId ?? null,
                    child_fiber_id: fiberId,
                    child_actor_key: ctx.actor.key,
                    child_actor_id: ctx.actor.id,
                    error,
                  },
                });
              }
            }

            if (ctx.actor.type === "detached" && done.taskId && done.taskKind) {
              ctx.actor.detachedTask = {
                taskId: done.taskId,
                kind: done.taskKind,
                status: DETACHED_ACTOR_STATUSES.failed,
                createdAt: ctx.actor.detachedTask?.createdAt ?? Date.now(),
                updatedAt: Date.now(),
                toolCallId: done.toolCallId,
                parentFiberId: done.parentFiberId,
                childFiberId: fiberId,
                outputText: `Delegate actor ${ctx.actor.key} failed: ${error}`,
                error,
              };
            } else {
              delete ctx.vm.actors[ctx.actor.key];
              if (ctx.vm.actorRuntime.has(ctx.actor.key)) {
                ctx.vm.actorRuntime.unregister(ctx.actor.key);
              }
            }
          }

          self.send(runtime.orchestratorId, "fiber_result", {
            fiberId,
            now: Date.now(),
            kind: AI_AGENT_FIBER_RESULT_KINDS.fail,
            error,
          });
          return;
        }

        if (result.kind === AI_AGENT_FIBER_RESULT_KINDS.complete) {
          const done = runtime.childDoneMap.get(fiberId);
          if (done) {
            const parentCtx = runtime.fiberIndex.get(done.parentFiberId);
            const outputText = isChildExecution ? findLastAssistantText(ctx.messages) : "";
            if (parentCtx) {
              parentCtx.actor.send("childDone", {
                childFiberId: fiberId,
                childActorKey: ctx.actor.key,
                childActorId: ctx.actor.id,
                mode: done.mode,
                toolCallId: done.toolCallId,
                outputText,
              });

              if (done.mode === "sync_wait") {
                self.send(runtime.orchestratorId, "resume_fiber", {
                  fiberId: done.parentFiberId,
                  now: Date.now(),
                });
              }

              if (done.mode === "detached" && done.taskId && done.taskKind) {
                const registry = getDetachedActorRegistry(parentCtx.vm);
                registry.update(done.taskId, {
                  kind: done.taskKind,
                  status: DETACHED_ACTOR_STATUSES.completed,
                  toolCallId: done.toolCallId,
                  parentFiberId: done.parentFiberId,
                  childFiberId: fiberId,
                  childActorKey: ctx.actor.key,
                  childActorId: ctx.actor.id,
                  outputText,
                });

                parentCtx.vm.eventBus?.emitDetachedActorDone(
                  { key: parentCtx.actor.key, id: parentCtx.actor.id },
                  {
                    taskId: done.taskId,
                    kind: done.taskKind,
                    status: DETACHED_ACTOR_STATUSES.completed,
                    toolCallId: done.toolCallId,
                    childFiberId: fiberId,
                    childActorKey: ctx.actor.key,
                    childActorId: ctx.actor.id,
                    outputText,
                  },
                );

                parentCtx.vm.effects.orchestrationHistory?.appendEvent({
                  stream: "detached_actor",
                  kind: "detached_actor_done",
                  payload: {
                    task_id: done.taskId,
                    task_kind: done.taskKind,
                    status: DETACHED_ACTOR_STATUSES.completed,
                    tool_call_id: done.toolCallId ?? null,
                    child_fiber_id: fiberId,
                    child_actor_key: ctx.actor.key,
                    child_actor_id: ctx.actor.id,
                  },
                });
              }
            }

            if (ctx.actor.type === "detached" && done.taskId && done.taskKind) {
              ctx.actor.detachedTask = {
                taskId: done.taskId,
                kind: done.taskKind,
                status: DETACHED_ACTOR_STATUSES.completed,
                createdAt: ctx.actor.detachedTask?.createdAt ?? Date.now(),
                updatedAt: Date.now(),
                toolCallId: done.toolCallId,
                parentFiberId: done.parentFiberId,
                childFiberId: fiberId,
                outputText,
              };
            } else if (isTransientDelegateExecution) {
              delete ctx.vm.actors[ctx.actor.key];
              if (ctx.vm.actorRuntime.has(ctx.actor.key)) {
                ctx.vm.actorRuntime.unregister(ctx.actor.key);
              }
            }
          }

          self.send(runtime.orchestratorId, "fiber_result", {
            fiberId,
            now: Date.now(),
            kind: AI_AGENT_FIBER_RESULT_KINDS.complete,
          });
          return;
        }

        // Unexpected step result: treat as an exception so we go through the
        // same failure path (including delegate detached completion wiring).
        throw new Error("invalid step outcome");
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);

        const isChildExecution = isDelegateFiberKind(ctx.kind) || isChildExecutionActor(ctx.actor);
        const isTransientDelegateExecution = isDelegateFiberKind(ctx.kind) || isDelegateActorType(ctx.actor);
        const done = runtime.childDoneMap.get(fiberId);
        if (isChildExecution && done) {
          const parentCtx = runtime.fiberIndex.get(done.parentFiberId);
          if (parentCtx) {
            parentCtx.actor.send("childDone", {
              childFiberId: fiberId,
              childActorKey: ctx.actor.key,
              childActorId: ctx.actor.id,
              mode: done.mode,
              toolCallId: done.toolCallId,
              outputText: `Delegate actor ${ctx.actor.key} failed: ${error}`,
            });

            if (done.mode === "sync_wait") {
              self.send(runtime.orchestratorId, "resume_fiber", {
                fiberId: done.parentFiberId,
                now: Date.now(),
              });
            }

            if (done.mode === "detached" && done.taskId && done.taskKind) {
              const registry = getDetachedActorRegistry(parentCtx.vm);
              registry.update(done.taskId, {
                kind: done.taskKind,
                status: DETACHED_ACTOR_STATUSES.failed,
                toolCallId: done.toolCallId,
                parentFiberId: done.parentFiberId,
                childFiberId: fiberId,
                childActorKey: ctx.actor.key,
                childActorId: ctx.actor.id,
                outputText: `Delegate actor ${ctx.actor.key} failed: ${error}`,
                error,
              });
              parentCtx.vm.eventBus?.emitDetachedActorDone(
                { key: parentCtx.actor.key, id: parentCtx.actor.id },
                {
                  taskId: done.taskId,
                  kind: done.taskKind,
                  status: DETACHED_ACTOR_STATUSES.failed,
                  toolCallId: done.toolCallId,
                  childFiberId: fiberId,
                  childActorKey: ctx.actor.key,
                  childActorId: ctx.actor.id,
                  outputText: `Delegate actor ${ctx.actor.key} failed: ${error}`,
                  error,
                },
              );

              parentCtx.vm.effects.orchestrationHistory?.appendEvent({
                stream: "detached_actor",
                kind: "detached_actor_done",
                payload: {
                  task_id: done.taskId,
                  task_kind: done.taskKind,
                  status: DETACHED_ACTOR_STATUSES.failed,
                  tool_call_id: done.toolCallId ?? null,
                  child_fiber_id: fiberId,
                  child_actor_key: ctx.actor.key,
                  child_actor_id: ctx.actor.id,
                  error,
                },
              });
            }
            if (ctx.actor.type === "detached" && done.taskId && done.taskKind) {
              ctx.actor.detachedTask = {
                taskId: done.taskId,
                kind: done.taskKind,
                status: DETACHED_ACTOR_STATUSES.failed,
                createdAt: ctx.actor.detachedTask?.createdAt ?? Date.now(),
                updatedAt: Date.now(),
                toolCallId: done.toolCallId,
                parentFiberId: done.parentFiberId,
                childFiberId: fiberId,
                outputText: `Delegate actor ${ctx.actor.key} failed: ${error}`,
                error,
              };
            } else if (isTransientDelegateExecution) {
              delete ctx.vm.actors[ctx.actor.key];
              if (ctx.vm.actorRuntime.has(ctx.actor.key)) {
                ctx.vm.actorRuntime.unregister(ctx.actor.key);
              }
            }
          }
        }

        self.send(runtime.orchestratorId, "fiber_result", {
          fiberId,
          now: Date.now(),
          kind: AI_AGENT_FIBER_RESULT_KINDS.fail,
          error,
        });
      } finally {
        ensureVmRuntimeContext(ctx.vm).currentOrchestrator = prevOrch ?? null;
      }
    },
  };
}

export function createAiAgentOrchestratorDriver(params: {
  fibers: Array<{
    fiberId: string;
    vm: AiAgentVm;
    actor: AiAgentActor;
    messages: any[];
    basePriority: number;
    lane?: AiAgentLane;
    workload?: AiAgentWorkload;
  }>;
  runStep: RunStep;
  options?: {
    orchestratorId?: string;
    agingStep?: number;
    defaultSuspendPolicy?: SuspendPolicy;
  };
  restore?: {
    state: OrchestratorState<AiAgentOrchestrationSchema>;
    pendingResumes?: string[];
    childDoneMap?: Record<
      string,
      {
        parentFiberId: string;
        mode: DelegateRunMode;
        toolCallId?: string;
        taskId?: string;
        taskKind?: DetachedActorKind;
      }
    >;
  };
}): AiAgentOrchestratorDriver {
  const orchestratorId = params.options?.orchestratorId ?? "__ai_orchestrator__";

  let runtime!: AiAgentOrchestratorRuntime;
  const actorRuntime = new ActorRuntime<AiAgentOrchestratorRuntime, AiAgentOrchestrationSchema>(() => runtime);

  const fibers: Record<string, FiberContext> = {};
  for (const f of params.fibers) {
    fibers[f.fiberId] = {
      fiberId: f.fiberId,
      vm: f.vm,
      actor: f.actor,
      messages: f.messages,
      lane: f.lane,
      workload: f.workload ?? resolveMainFiberWorkload(f.lane),
    };
  }

  const spawnFiber = (input: {
    fiberId: string;
    vm: AiAgentVm;
    actor: AiAgentActor;
    messages: any[];
    basePriority: number;
    parentFiberId?: string;
    kind?: "control" | "delegate";
    lane?: AiAgentLane;
    workload?: AiAgentWorkload;
    onDone?: {
      parentFiberId: string;
      mode: DelegateRunMode;
      toolCallId?: string;
      taskId?: string;
      taskKind?: DetachedActorKind;
    };
  }) => {
    if (runtime.fiberIndex.has(input.fiberId)) {
      return;
    }
    runtime.fiberIndex.set(input.fiberId, {
      fiberId: input.fiberId,
      vm: input.vm,
      actor: input.actor,
      messages: input.messages,
      kind: input.kind,
      lane: input.lane,
      workload: input.workload ?? inferFiberWorkload({
        actor: input.actor,
        lane: input.lane,
        kind: input.kind,
        detachedActorKind: input.onDone?.taskKind,
      }),
    });

    if (input.onDone) {
      runtime.childDoneMap.set(input.fiberId, {
        parentFiberId: input.onDone.parentFiberId,
        mode: normalizeDelegateRunMode(input.onDone.mode),
        toolCallId: input.onDone.toolCallId,
        taskId: input.onDone.taskId,
        taskKind: input.onDone.taskKind,
      });
    }

    runtime.actorRuntime.register(input.fiberId, createFiberActor(input.fiberId));
    runtime.state = reduceOrchestrator(runtime.state, {
      type: "spawn",
      fiber: {
        id: input.fiberId,
        actorId: input.fiberId,
        parentId: input.parentFiberId,
        basePriority: input.basePriority,
        lane: input.lane,
        step: { tag: "agent_step", payload: { fiberId: input.fiberId } },
      },
      now: Date.now(),
    }).state;
  };

  runtime = {
    orchestratorId,
    actorRuntime,
    state:
      params.restore?.state ??
      createOrchestratorState<AiAgentOrchestrationSchema>({
        agingStep: params.options?.agingStep ?? 0,
        defaultSuspendPolicy: params.options?.defaultSuspendPolicy ?? "continue_others",
        schedulerHooks: createAiAgentSchedulerHooks<AiAgentOrchestrationSchema>(),
      }),
    fiberIndex: actorRuntime.ensureFacet("cell.orchestrator.fiberIndex", () => createRuntimeIndexHook(fibers)),
    pendingResumes: new Set(params.restore?.pendingResumes ?? []),
    childDoneMap: createCompletionBindingRegistry(params.restore?.childDoneMap ?? {}),
    spawnFiber,
    runStep: params.runStep,
  };

  // Register orchestrator + fibers.
  actorRuntime.register(orchestratorId, createOrchestratorActor());
  for (const f of params.fibers) {
    actorRuntime.register(f.fiberId, createFiberActor(f.fiberId));
    if (!params.restore?.state) {
      runtime.state = reduceOrchestrator(runtime.state, {
        type: "spawn",
        fiber: {
          id: f.fiberId,
          actorId: f.fiberId,
          basePriority: f.basePriority,
          lane: f.lane,
          step: { tag: "agent_step", payload: { fiberId: f.fiberId } },
        },
        now: Date.now(),
      }).state;
    }
  }

  return {
    orchestratorId,
    actorRuntime,
    getState: () => runtime.state,
    inspectRuntime: () => ({
      state: runtime.state,
      fibers: runtime.fiberIndex.snapshot(),
      pendingResumes: Array.from(runtime.pendingResumes),
      childDoneMap: runtime.childDoneMap.snapshot(),
    }),
    tick: (now) => {
      actorRuntime.sendFrom("client", orchestratorId, "tick", { now, scope: "all" });
    },
    resumeFiber: (fiberId, now) => {
      actorRuntime.sendFrom("client", orchestratorId, "resume_fiber", { fiberId, now });
    },
    suspendFiber: (fiberId, now, reason, suspendPolicy) => {
      runtime.state = reduceOrchestrator(runtime.state, {
        type: "suspend",
        fiberId,
        now,
        reason,
        suspendPolicy,
      } as any).state;
    },
    tickUntilBlocked: async ({ now, maxTicks, maxWallMs }) => {
      const start = Date.now();
      const max = typeof maxTicks === "number" && maxTicks > 0 ? Math.floor(maxTicks) : 500;
      const wall = typeof maxWallMs === "number" && maxWallMs > 0 ? maxWallMs : Number.POSITIVE_INFINITY;

      // `maxTicks` limits how many scheduler ticks we dispatch, not how many idle/wait cycles
      // we perform while waiting on async IO (LLM/tool/parse). This prevents premature returns
      // when the agent is suspended on `external` but still has inflight async work.
      let tickCount = 0;

      // Apply any queued resume_fiber / fiber_result before checking readiness.
      await flushMicrotasks();

      while (tickCount < max) {
        if (Date.now() - start > wall) {
          break;
        }

        const next = selectNextFiberId(runtime.state);
        if (!next) {
          // Drain any late-arriving messages that could make fibers ready.
          await flushMicrotasks();

          const nextAfterDrain = selectNextFiberId(runtime.state);
          if (nextAfterDrain) {
            continue;
          }

          // If a cooperative fiber is waiting on async IO (LLM/tool/parse), wait for it
          // to enqueue aiGenerated + resume_fiber before returning.
          if (hasInflightAsync(runtime) || runtime.pendingResumes.size > 0 || hasRunningFibers(runtime.state)) {
            await waitForNoRunningFibers({
              getState: () => runtime.state,
              deadlineMs: start + wall,
            });
            await flushMicrotasks();
            await new Promise<void>((r) => setTimeout(r, 5));
            continue;
          }

          break;
        }

        actorRuntime.sendFrom("client", orchestratorId, "tick", { now, scope: "all" });

        tickCount += 1;

        const deadlineMs = start + wall;
        await waitForNoRunningFibers({
          getState: () => runtime.state,
          deadlineMs,
        });

        if (Number.isFinite(deadlineMs) && Date.now() > deadlineMs && hasRunningFibers(runtime.state)) {
          throw new Error(`Timeout after ${Math.floor(wall)}ms`);
        }

        // Ensure any resulting fiber_result messages are applied.
        await flushMicrotasks();
      }
    },

    tickUntilForegroundSettled: async ({ now, maxTicks, maxWallMs }) => {
      const start = Date.now();
      const max = typeof maxTicks === "number" && maxTicks > 0 ? Math.floor(maxTicks) : 500;
      const wall = typeof maxWallMs === "number" && maxWallMs > 0 ? maxWallMs : Number.POSITIVE_INFINITY;

      let tickCount = 0;
      await flushMicrotasks();

      const isFg = (fiberId: string) => isForegroundAiAgentLane((runtime.state.fibers as any)?.[fiberId]?.lane);

      while (tickCount < max) {
        if (Date.now() - start > wall) {
          break;
        }

        const nextFg = selectNextForegroundFiberId(runtime.state);
        if (!nextFg) {
          await flushMicrotasks();

          const nextAfterDrain = selectNextForegroundFiberId(runtime.state);
          if (nextAfterDrain) {
            continue;
          }

          // Only wait on foreground inflight/running/pending resumes.
          if (hasInflightAsyncWhere(runtime, isFg) || hasPendingResumesWhere(runtime, isFg) || hasRunningFibersWhere(runtime.state, isFg)) {
            await waitForNoRunningFibersWhere({
              getState: () => runtime.state,
              deadlineMs: start + wall,
              predicate: isFg,
            });
            await flushMicrotasks();
            await new Promise<void>((r) => setTimeout(r, 5));
            continue;
          }

          break;
        }

        actorRuntime.sendFrom("client", orchestratorId, "tick", { now, scope: "foreground" });
        tickCount += 1;

        const deadlineMs = start + wall;
        await waitForNoRunningFibersWhere({
          getState: () => runtime.state,
          deadlineMs,
          predicate: isFg,
        });

        if (Number.isFinite(deadlineMs) && Date.now() > deadlineMs && hasRunningFibersWhere(runtime.state, isFg)) {
          throw new Error(`Timeout after ${Math.floor(wall)}ms`);
        }

        await flushMicrotasks();
      }
    },

    tickUntilBackgroundSettled: async ({ now, maxTicks, maxWallMs }) => {
      const start = Date.now();
      const max = typeof maxTicks === "number" && maxTicks > 0 ? Math.floor(maxTicks) : 500;
      const wall = typeof maxWallMs === "number" && maxWallMs > 0 ? maxWallMs : Number.POSITIVE_INFINITY;

      let tickCount = 0;
      await flushMicrotasks();

      const isBackground = (fiberId: string) =>
        isBackgroundAiAgentLane((runtime.state.fibers as any)?.[fiberId]?.lane);

      while (tickCount < max) {
        if (Date.now() - start > wall) {
          break;
        }

        const nextBackground = selectNextBackgroundFiberId(runtime.state);
        if (!nextBackground) {
          await flushMicrotasks();

          const nextAfterDrain = selectNextBackgroundFiberId(runtime.state);
          if (nextAfterDrain) {
            continue;
          }

          if (
            hasInflightAsyncWhere(runtime, isBackground) ||
            hasPendingResumesWhere(runtime, isBackground) ||
            hasRunningFibersWhere(runtime.state, isBackground)
          ) {
            await waitForNoRunningFibersWhere({
              getState: () => runtime.state,
              deadlineMs: start + wall,
              predicate: isBackground,
            });
            await flushMicrotasks();
            await new Promise<void>((r) => setTimeout(r, 5));
            continue;
          }

          break;
        }

        actorRuntime.sendFrom("client", orchestratorId, "tick", {
          now,
          scope: AI_AGENT_ORCHESTRATOR_TICK_SCOPES.background,
        });
        tickCount += 1;

        const deadlineMs = start + wall;
        await waitForNoRunningFibersWhere({
          getState: () => runtime.state,
          deadlineMs,
          predicate: isBackground,
        });

        if (
          Number.isFinite(deadlineMs) &&
          Date.now() > deadlineMs &&
          hasRunningFibersWhere(runtime.state, isBackground)
        ) {
          throw new Error(`Timeout after ${Math.floor(wall)}ms`);
        }

        await flushMicrotasks();
      }
    },
    waitForSignal: async <K extends keyof WaiterStoreResultMap>({
      vm,
      waiterKey,
      waiterStore,
      resolveCurrent,
      maxTicks,
      maxWallMs,
    }: {
      vm: AiAgentVm;
      waiterKey: string;
      waiterStore: K;
      resolveCurrent: () => WaiterStoreResultMap[K] | null;
      maxTicks?: number;
      maxWallMs?: number;
    }): Promise<WaiterStoreResultMap[K] | null> => {
      const runtimeContext = ensureVmRuntimeContext(vm);
      const existing = resolveCurrent();
      if (existing) {
        return existing;
      }

      let settled: WaiterStoreResultMap[K] | null = null;
      const waiter = (result: WaiterStoreResultMap[K]) => {
        settled = result;
      };
      const registry = runtimeContext[waiterStore] as CompletionSignalRegistry<string, WaiterStoreResultMap[K]>;
      const unsubscribe = registry.subscribe(waiterKey, waiter);

      try {
        const start = Date.now();
        const max = typeof maxTicks === "number" && maxTicks > 0 ? Math.floor(maxTicks) : 240;
        const wall = typeof maxWallMs === "number" && maxWallMs > 0 ? maxWallMs : 2000;
        let tickCount = 0;

        await flushMicrotasks();

        while (tickCount < max && !settled) {
          if (Date.now() - start > wall) {
            break;
          }

          const next = selectNextFiberId(runtime.state);
          if (!next) {
            await flushMicrotasks();
            const nextAfterDrain = selectNextFiberId(runtime.state);
            if (nextAfterDrain) {
              continue;
            }
            if (hasInflightAsync(runtime) || runtime.pendingResumes.size > 0 || hasRunningFibers(runtime.state)) {
              await waitForNoRunningFibers({
                getState: () => runtime.state,
                deadlineMs: start + wall,
              });
              await flushMicrotasks();
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
              continue;
            }
            break;
          }

          actorRuntime.sendFrom("client", orchestratorId, "tick", { now: Date.now(), scope: "all" });
          tickCount += 1;
          const deadlineMs = start + wall;
          await waitForNoRunningFibers({
            getState: () => runtime.state,
            deadlineMs,
          });
          await flushMicrotasks();
        }
        if (!settled) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          settled = resolveCurrent();
        }
      } finally {
        unsubscribe();
      }

      return settled ?? resolveCurrent();
    },
    spawnFiber,
  };
}

export function createAiAgentOrchestratorDriverWithCooperative(params: {
  fibers: Array<{
    fiberId: string;
    vm: AiAgentVm;
    actor: AiAgentActor;
    messages: any[];
    basePriority: number;
  }>;
  options?: {
    orchestratorId?: string;
    agingStep?: number;
    defaultSuspendPolicy?: SuspendPolicy;
  };
}): AiAgentOrchestratorDriver {
  return createAiAgentOrchestratorDriver({
    fibers: params.fibers,
    runStep: async (ctx, helpers) => {
      return await aiAgentCooperativeStep({
        fiberId: ctx.fiberId,
        vm: ctx.vm,
        actor: ctx.actor,
        messages: ctx.messages,
        state: ctx.execState,
        setState: (next) => {
          ctx.execState = next;
        },
        resumeFiber: helpers.resume,
      });
    },
    options: params.options,
  });
}
