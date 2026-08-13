import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { FileToolScopeIntent } from "@cell/ai-organ-logic/permissions/FileToolScope"
export type EditOuterRuntime = AiAgentOneActorRuntime
export type EditOuterInput = { filePath: string; oldString: string; newString: string; replaceAll?: boolean; scopeIntent?: FileToolScopeIntent }
export type EditOuterConfig = Record<string, unknown>
export type EditOuterDerived = null
export type EditOuterOutput = string
