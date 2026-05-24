import type { GetWeatherOuterInput, GetWeatherOuterOutput, GetWeatherOuterRuntime } from "./OuterTypes"

export type GetWeatherInnerRuntime = GetWeatherOuterRuntime
export type GetWeatherInnerInput = GetWeatherOuterInput
export type GetWeatherInnerConfig = Record<string, unknown>
export type GetWeatherInnerOutput = GetWeatherOuterOutput
