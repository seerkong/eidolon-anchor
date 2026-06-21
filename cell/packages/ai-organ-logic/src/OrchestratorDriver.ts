import type {
  ActorRuntime,
  CompletionBindingRegistry,
  FiberWaitingReason,
  RuntimeIndexHook,
  SuspendPolicy,
  OrchestratorState,
} from "depa-actor";

import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import type { AiAgentMailboxSchema } from "@cell/ai-core-contract/runtime/AiAgentActor";
import type { DurableControlSignalData, DurableControlSignalInput } from "@cell/ai-core-contract/runtime/DurableControlSignal";
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import type { DelegateRunMode } from "@cell/ai-organ-contract/agent/DelegateRunMode";
import type { DetachedActorKind } from "./detached/DetachedActorRegistry";
import type { AiAgentLane } from "./lane/AiAgentLane";
import type { AiAgentWorkload } from "./lane/AiAgentWorkload";
import { AI_AGENT_ORCHESTRATOR_TICK_SCOPES, AI_AGENT_FIBER_RESULT_KINDS } from "./orchestratorCapsule/coreLogic";

/**
 * Compatibility facade for the orchestrator capsule. The implementation lives
 * in ./orchestratorCapsule (coreLogic + internals); this module owns the
 * exported types and re-exports the public value surface from coreLogic.
 */

export { AI_AGENT_ORCHESTRATOR_TICK_SCOPES, AI_AGENT_FIBER_RESULT_KINDS };
export {
  createAiAgentOrchestratorDriver,
  createAiAgentOrchestratorDriverWithCooperative,
} from "./orchestratorCapsule/coreLogic";

export type AiAgentOrchestratorTickScope =
  (typeof AI_AGENT_ORCHESTRATOR_TICK_SCOPES)[keyof typeof AI_AGENT_ORCHESTRATOR_TICK_SCOPES]

export type AiAgentFiberResultKind =
  (typeof AI_AGENT_FIBER_RESULT_KINDS)[keyof typeof AI_AGENT_FIBER_RESULT_KINDS]

export type AiAgentOrchestrationSchema = {
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

export type FiberContext = {
  fiberId: string;
  vm: AiAgentVm;
  actor: AiAgentActor;
  messages: readonly any[];
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

export type EmitFiberSignalParams<K extends keyof AiAgentMailboxSchema = keyof AiAgentMailboxSchema> =
  Omit<DurableControlSignalInput, "actorKey" | "actorId" | "fiberId" | "mailboxKind" | "payload"> & {
    fiberId: string;
    mailbox?: {
      kind: K;
      payload: AiAgentMailboxSchema[K];
    };
  };

export type RunStep = (ctx: FiberContext, helpers: {
  resume: (fiberId: string) => void;
  emitFiberSignal: (params: EmitFiberSignalParams) => DurableControlSignalData | null;
}) => Promise<FiberStepOutcome>;

export type WaiterStoreResultMap = {
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
  emitFiberSignal: (params: EmitFiberSignalParams) => DurableControlSignalData | null;
  reviveFiber: (fiberId: string, now: number) => void;
  suspendFiber: (fiberId: string, now: number, reason: FiberWaitingReason, suspendPolicy?: SuspendPolicy) => void;
  settleInterruptedFiber: (params: {
    fiberId: string;
    now: number;
    reason?: FiberWaitingReason;
    controlKinds?: string[];
  }) => void;
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
    messages: readonly any[];
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

export type AiAgentOrchestratorRuntime = {
  orchestratorId: string;
  actorRuntime: ActorRuntime<AiAgentOrchestratorRuntime, AiAgentOrchestrationSchema>;
  state: OrchestratorState<AiAgentOrchestrationSchema>;
  fiberIndex: RuntimeIndexHook<string, FiberContext>;
  pendingResumes: Set<string>;
  backgroundTasks: Set<Promise<unknown>>;
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
  emitFiberSignal: AiAgentOrchestratorDriver["emitFiberSignal"];
  runStep: RunStep;
};
