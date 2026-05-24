import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type GetWeatherOuterRuntime = AiAgentOneActorRuntime
export type GetWeatherOuterInput = { location?: string }
export type GetWeatherOuterConfig = Record<string, unknown>
export type GetWeatherOuterDerived = null
export type GetWeatherOuterOutput = string
