import type {
  DetachedBashOuterInput,
  DetachedBashOuterOutput,
  DetachedBashOuterRuntime,
} from "./OuterTypes"

export type DetachedBashInnerRuntime = DetachedBashOuterRuntime
export type DetachedBashInnerInput = DetachedBashOuterInput
export type DetachedBashInnerConfig = Record<string, unknown>
export type DetachedBashInnerOutput = DetachedBashOuterOutput
