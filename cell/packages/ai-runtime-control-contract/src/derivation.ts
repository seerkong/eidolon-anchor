import {
  assertDerivationContract,
  createDerivationContract,
  type DerivationContract,
} from "@cell/platform-contract"

import type { AiRuntimeControlCommand } from "./index"

/**
 * Engine command derivation: the pure data-graph processing definition of the
 * runtime-control engine. State advances only through these methods; flow
 * wiring (queues, ports, evidence) stays on vendor primitives.
 */
export type EngineCommandDerivation<TState = unknown, TCommand = AiRuntimeControlCommand> = {
  initializeControlState: (input?: unknown) => TState
  enqueueCommand: (state: TState, command: TCommand) => TState
  selectNextCommand: (state: TState) => TCommand | undefined
  classifyRecovery: (state: TState) => TState
}

export const ENGINE_COMMAND_DERIVATION_CONTRACT: DerivationContract = createDerivationContract({
  contractId: "engine_command_derivation",
  requiredMethods: [
    "initializeControlState",
    "enqueueCommand",
    "selectNextCommand",
    "classifyRecovery",
  ],
})

export function assertEngineCommandDerivation<TState, TCommand>(
  implementation: EngineCommandDerivation<TState, TCommand>,
): EngineCommandDerivation<TState, TCommand> {
  return assertDerivationContract(ENGINE_COMMAND_DERIVATION_CONTRACT, implementation)
}
