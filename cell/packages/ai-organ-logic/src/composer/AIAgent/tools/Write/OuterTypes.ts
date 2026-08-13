import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { FileToolScopeIntent } from "@cell/ai-organ-logic/permissions/FileToolScope"
export type WriteOuterRuntime = AiAgentOneActorRuntime
export type WriteOuterInput = { filePath: string; content: string; scopeIntent?: FileToolScopeIntent }
export type WriteOuterConfig = Record<string, unknown>
export type WriteOuterDerived = null
export type WriteOuterOutput = string
