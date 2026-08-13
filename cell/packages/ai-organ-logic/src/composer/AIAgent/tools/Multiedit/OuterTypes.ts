import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { FileToolScopeIntent } from "@cell/ai-organ-logic/permissions/FileToolScope"
export type MultieditOuterRuntime = AiAgentOneActorRuntime
export type MultieditOuterInput = { filePath: string; edits: Array<{ filePath?: string; oldString: string; newString: string; replaceAll?: boolean }>; scopeIntent?: FileToolScopeIntent }
export type MultieditOuterConfig = Record<string, unknown>
export type MultieditOuterDerived = null
export type MultieditOuterOutput = string
