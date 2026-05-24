import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type ReadOuterRuntime = AiAgentOneActorRuntime
export type ReadOuterInput = { filePath: string; offset?: number; limit?: number }
export type ReadOuterConfig = Record<string, unknown>
export type ReadOuterDerived = null
export type ReadOuterOutput = string
