import type { BatchOuterInput, BatchOuterOutput, BatchOuterRuntime } from "./OuterTypes"
export type BatchInnerRuntime = BatchOuterRuntime
export type BatchInnerInput = BatchOuterInput
export type BatchInnerConfig = Record<string, unknown>
export type BatchInnerOutput = BatchOuterOutput
