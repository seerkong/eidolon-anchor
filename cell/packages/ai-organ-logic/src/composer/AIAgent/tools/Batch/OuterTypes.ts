import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type BatchOuterRuntime = AiAgentOneActorRuntime
export type BatchOuterInput = { tool_calls: Array<{ tool: string; parameters: Record<string, unknown> }> }
export type BatchOuterConfig = Record<string, unknown>
export type BatchOuterDerived = null
export type BatchOuterOutput = string
