import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type GrepOuterRuntime = AiAgentOneActorRuntime
export type GrepOuterInput = { pattern: string; path?: string; include?: string }
export type GrepOuterConfig = Record<string, unknown>
export type GrepOuterDerived = null
export type GrepOuterOutput = string
