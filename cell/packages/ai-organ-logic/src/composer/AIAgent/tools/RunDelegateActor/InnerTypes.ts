import type {
  RunDelegateActorOuterInput,
  RunDelegateActorOuterOutput,
  RunDelegateActorOuterRuntime,
} from "./OuterTypes"

export type RunDelegateActorInnerRuntime = RunDelegateActorOuterRuntime
export type RunDelegateActorInnerInput = RunDelegateActorOuterInput
export type RunDelegateActorInnerConfig = Record<string, unknown>
export type RunDelegateActorInnerOutput = RunDelegateActorOuterOutput
