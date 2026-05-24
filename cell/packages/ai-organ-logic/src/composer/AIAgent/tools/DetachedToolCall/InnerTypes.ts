import type {
  DetachedToolCallOuterInput,
  DetachedToolCallOuterOutput,
  DetachedToolCallOuterRuntime,
} from "./OuterTypes"

export type DetachedToolCallInnerRuntime = DetachedToolCallOuterRuntime
export type DetachedToolCallInnerInput = DetachedToolCallOuterInput
export type DetachedToolCallInnerConfig = Record<string, unknown>
export type DetachedToolCallInnerOutput = DetachedToolCallOuterOutput
