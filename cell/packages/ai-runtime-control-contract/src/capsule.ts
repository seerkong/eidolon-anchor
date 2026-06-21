import type { CommandDequeGroupState } from "depa-actor"

import type {
  AiRuntimeControlCommand,
  AiRuntimeControlPorts,
  AiRuntimeControlState,
} from "./index"

/**
 * Concrete engine state and capsule types. The engine capsule's processing
 * definition is the EngineCommandDerivation (see ./derivation); these types
 * pin the concrete state shape and the capsule's (runtime, input, config)
 * surface so the logic package defines no types of its own.
 */

export type AiRuntimeControlCommandGroupState = CommandDequeGroupState<AiRuntimeControlCommand>

export type AiRuntimeConcreteControlState = AiRuntimeControlState<AiRuntimeControlCommandGroupState>

export type AiRuntimeControlStepResult = {
  state: AiRuntimeConcreteControlState
  command?: AiRuntimeControlCommand
}

export const AI_RUNTIME_ENGINE_PORT_ADAPTER_IDS = ["in_memory", "file_store"] as const

export type AiRuntimeEnginePortAdapterId = (typeof AI_RUNTIME_ENGINE_PORT_ADAPTER_IDS)[number]

/** Explicit dependencies a port adapter may need; adapters receive it verbatim. */
export type EngineCapsuleRuntime = {
  portDependencies?: unknown
}

export type EnginePortAdapter = (runtime: EngineCapsuleRuntime) => AiRuntimeControlPorts

export type EngineCapsuleConfig = {
  portAdapter: AiRuntimeEnginePortAdapterId
  maxSteps?: number
}

export type EngineCapsuleInput = {
  state: AiRuntimeConcreteControlState
}

export type EngineCapsuleOutput = {
  state: AiRuntimeConcreteControlState
}
