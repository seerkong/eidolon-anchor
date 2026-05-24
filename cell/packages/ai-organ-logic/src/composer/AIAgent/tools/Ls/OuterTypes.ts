import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type LsOuterRuntime = AiAgentOneActorRuntime
export type LsOuterInput = { path?: string; ignore?: string[] }
export type LsOuterConfig = Record<string, unknown>
export type LsOuterDerived = null
export type LsOuterOutput = string
