import { reduceOrchestrator, type FiberAction, type OrchestratorState, type SuspendPolicy } from "depa-actor";

import { assertSchedulerDerivation } from "@cell/ai-core-contract";
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import type { AiAgentOrchestrationSchema, AiAgentOrchestratorDriver } from "../OrchestratorDriver";
import { createInitialOrchestratorState, projectSchedulerSignal } from "./internals/decisions";
import { createAiAgentOrchestratorDriverWithCooperative } from "./internals/driverRuntime";

/**
 * Stable core logic surface of the orchestrator capsule. Pure scheduling
 * decisions live in ./internals/decisions; the actor/effect wiring lives in
 * ./internals/driverRuntime. Everything consumers may use is re-exported
 * here so nothing outside the capsule reaches into internals.
 */

export {
  applyResumeFiber,
  isTerminalFiberRecordStatus,
  isTerminalDetachedActorStatus,
  resetCooperativeExecStateAfterInterrupt,
  drainControlKinds,
  projectSchedulerSignal,
  createInitialOrchestratorState,
} from "./internals/decisions";
export { AI_AGENT_ORCHESTRATOR_TICK_SCOPES, AI_AGENT_FIBER_RESULT_KINDS } from "./internals/constants";
export {
  createAiAgentOrchestratorDriver,
  createAiAgentOrchestratorDriverWithCooperative,
} from "./internals/driverRuntime";

/**
 * Scheduler derivation: explicit-state processing definition for the
 * orchestrator cluster, asserted against the contract from
 * @cell/ai-core-contract.
 */
export const schedulerDerivation = assertSchedulerDerivation({
  initializeSchedulerState: (): OrchestratorState<AiAgentOrchestrationSchema> =>
    createInitialOrchestratorState(),
  reduceFiberEvent: (
    state: OrchestratorState<AiAgentOrchestrationSchema>,
    action: FiberAction<AiAgentOrchestrationSchema>,
  ) => reduceOrchestrator(state, action),
  projectSchedulerSignal: (state: OrchestratorState<AiAgentOrchestrationSchema>) =>
    projectSchedulerSignal(state),
});

type OrchestratorCapsuleFiberInit = {
  fiberId: string;
  vm: AiAgentVm;
  actor: AiAgentActor;
  messages: readonly any[];
  basePriority: number;
};

/**
 * Stable capsule entry. `runtime` is a placeholder for injected adapter
 * dependencies (currently none); `input` carries the fibers to schedule and
 * `config` the scheduling options.
 */
export function createOrchestratorCapsule(
  runtime: Record<string, unknown>,
  input: { fibers: OrchestratorCapsuleFiberInit[] },
  config: { agingStep?: number; defaultSuspendPolicy?: SuspendPolicy },
): { driver: AiAgentOrchestratorDriver } {
  void runtime;
  return {
    driver: createAiAgentOrchestratorDriverWithCooperative({
      fibers: input.fibers,
      options: {
        agingStep: config.agingStep,
        defaultSuspendPolicy: config.defaultSuspendPolicy,
      },
    }),
  };
}
