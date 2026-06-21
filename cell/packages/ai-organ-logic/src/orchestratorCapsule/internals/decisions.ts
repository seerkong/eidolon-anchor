import {
  createAiAgentSchedulerHooks,
  createOrchestratorState,
  reduceOrchestrator,
  type SuspendPolicy,
  type OrchestratorState,
} from "depa-actor";

import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import type { AiAgentVmSchedulerSignalData } from "@cell/ai-core-contract/runtime/AiAgentVm";
import { DETACHED_ACTOR_STATUSES } from "../../detached/DetachedActorRegistry";
import type {
  AiAgentOrchestrationSchema,
  AiAgentOrchestratorRuntime,
} from "../../OrchestratorDriver";

/**
 * Pure scheduling decision helpers for the orchestrator_driver cluster.
 * No IO and no imports from driverRuntime/coreLogic: side effects (detached
 * actor registry updates, scheduler signal publication) are injected by the
 * caller.
 */

export function isTerminalDetachedActorStatus(status: unknown): boolean {
  return status === DETACHED_ACTOR_STATUSES.completed
    || status === DETACHED_ACTOR_STATUSES.failed
    || status === DETACHED_ACTOR_STATUSES.cancelled;
}

export function resetCooperativeExecStateAfterInterrupt(execState: unknown): void {
  if (!execState || typeof execState !== "object") return;
  const state = execState as Record<string, unknown>;
  const inflight = state.inflight as { abortController?: AbortController } | undefined;
  const abortController = inflight?.abortController;
  if (abortController && typeof abortController.abort === "function") {
    abortController.abort();
  }
  state.phase = "drain";
  state.tools = [];
  state.toolCalls = [];
  state.toolIndex = 0;
  state.pendingToolResults = [];
  state.pendingAiGenerated = [];
  state.inflight = undefined;
}

export function drainControlKinds(actor: AiAgentActor, kinds: Set<string>): void {
  if (!kinds.size || !actor.hasPending("control")) return;
  const entries = actor.drainMailbox("control") as any[];
  for (const entry of entries) {
    const kind = typeof entry?.kind === "string" ? entry.kind : "";
    if (kind && kinds.has(kind)) continue;
    actor.send("control", entry as any);
  }
}

export function isTerminalFiberRecordStatus(status: unknown): boolean {
  return status === "completed" || status === "cancelled" || status === "failed" || status === "dead_letter";
}

export function projectSchedulerSignal(
  state: OrchestratorState<AiAgentOrchestrationSchema>,
  updatedAt: number | null = null,
  pendingResumeFiberIds: string[] = [],
): AiAgentVmSchedulerSignalData {
  const fibers = Object.values(state.fibers as Record<string, any>);
  const interruptedFiberIds = fibers
    .filter((fiber) => fiber.waitingReason === "interrupted" || fiber.waitingReason === "cancel_requested")
    .map((fiber) => String(fiber.id))
    .filter(Boolean);
  return {
    readyFiberIds: fibers.filter((fiber) => fiber.status === "ready").map((fiber) => String(fiber.id)).filter(Boolean),
    runningFiberIds: fibers.filter((fiber) => fiber.status === "running").map((fiber) => String(fiber.id)).filter(Boolean),
    suspendedFiberIds: fibers.filter((fiber) => fiber.status === "suspended").map((fiber) => String(fiber.id)).filter(Boolean),
    blockedFiberIds: fibers.filter((fiber) => fiber.status === "blocked").map((fiber) => String(fiber.id)).filter(Boolean),
    pendingResumeFiberIds,
    interruptedFiberIds,
    updatedAt,
  };
}

export function createInitialOrchestratorState(options?: {
  agingStep?: number;
  defaultSuspendPolicy?: SuspendPolicy;
}): OrchestratorState<AiAgentOrchestrationSchema> {
  return createOrchestratorState<AiAgentOrchestrationSchema>({
    agingStep: options?.agingStep ?? 0,
    defaultSuspendPolicy: options?.defaultSuspendPolicy ?? "continue_others",
    schedulerHooks: createAiAgentSchedulerHooks<AiAgentOrchestrationSchema>(),
  });
}

export function applyResumeFiber(
  runtime: AiAgentOrchestratorRuntime,
  fiberId: string,
  now: number,
  effects: {
    updateDetachedActorStatus: (fiberId: string, status: "running" | "suspended") => void;
    publishSchedulerSignal: (vm: AiAgentVm, updatedAt: number) => void;
  },
): void {
  if (!fiberId) return;

  effects.updateDetachedActorStatus(fiberId, "running");

  const current = runtime.state.fibers[fiberId];
  if (!current) return;
  if (current.status === "failed") {
    runtime.pendingResumes.delete(fiberId);
    runtime.state = {
      ...runtime.state,
      fibers: {
        ...runtime.state.fibers,
        [fiberId]: {
          ...current,
          status: "ready",
          waitingReason: undefined,
          suspendPolicy: undefined,
          retryAt: undefined,
          timeoutAt: undefined,
          lastError: undefined,
          step: { tag: "agent_step", payload: { fiberId } } as any,
          updatedAt: now,
        },
      },
    };
    const ctx = runtime.fiberIndex.get(fiberId);
    if (ctx) effects.publishSchedulerSignal(ctx.vm, now);
    return;
  }
  if (current.status === "ready") {
    runtime.pendingResumes.delete(fiberId);
    runtime.state = {
      ...runtime.state,
      fibers: {
        ...runtime.state.fibers,
        [fiberId]: {
          ...current,
          waitingReason: undefined,
          suspendPolicy: undefined,
          retryAt: undefined,
          timeoutAt: undefined,
          lastError: undefined,
          step: { tag: "agent_step", payload: { fiberId } } as any,
          updatedAt: now,
        },
      },
    };
    const ctx = runtime.fiberIndex.get(fiberId);
    if (ctx) effects.publishSchedulerSignal(ctx.vm, now);
    return;
  }
  if (current.status !== "suspended") {
    runtime.pendingResumes.add(fiberId);
    const ctx = runtime.fiberIndex.get(fiberId);
    if (ctx) effects.publishSchedulerSignal(ctx.vm, now);
    return;
  }

  const next = reduceOrchestrator(runtime.state, {
    type: "resume",
    fiberId,
    now,
    nextStep: { tag: "agent_step", payload: { fiberId } },
  });
  runtime.state = next.state;
  const ctx = runtime.fiberIndex.get(fiberId);
  if (ctx) effects.publishSchedulerSignal(ctx.vm, now);
}
