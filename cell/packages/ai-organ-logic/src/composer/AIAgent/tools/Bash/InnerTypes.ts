import type { BashOuterInput, BashOuterOutput, BashOuterRuntime } from "./OuterTypes"
export type BashInnerRuntime = BashOuterRuntime
export type BashInnerInput = BashOuterInput
export type BashInnerConfig = Record<string, unknown>
export type BashInnerOutput = BashOuterOutput
