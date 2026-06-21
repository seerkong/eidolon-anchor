/**
 * Compatibility facade for the engine capsule. The implementation lives in
 * ./engineCapsule (coreLogic + adapterRegistry); public names are unchanged.
 */

export {
  createAiRuntimeControlState,
  enqueueAiRuntimeControlCommand,
  selectNextAiRuntimeControlCommand,
  runOneAiRuntimeControlStep,
  runAiRuntimeControlUntilIdle,
  classifyAiRuntimeControlRecovery,
  engineCommandDerivation,
  runEngineCapsule,
} from "./engineCapsule/coreLogic"

export type {
  AiRuntimeControlCommandGroupState,
  AiRuntimeConcreteControlState,
  AiRuntimeControlStepResult,
} from "@cell/ai-runtime-control-contract"
