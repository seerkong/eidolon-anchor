import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type WriteOuterRuntime = AiAgentOneActorRuntime
export type WriteOuterInput = { filePath: string; content: string }
export type WriteOuterConfig = Record<string, unknown>
export type WriteOuterDerived = null
export type WriteOuterOutput = string
