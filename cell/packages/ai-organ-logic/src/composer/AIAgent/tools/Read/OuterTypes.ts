import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { FileToolScopeIntent } from "@cell/ai-organ-logic/permissions/FileToolScope"
export type ReadOuterRuntime = AiAgentOneActorRuntime
export type ReadOuterInput = { filePath: string; offset?: number; limit?: number; scopeIntent?: FileToolScopeIntent }
export type ReadOuterConfig = Record<string, unknown>
export type ReadOuterDerived = null
export type ReadOuterOutput = string
