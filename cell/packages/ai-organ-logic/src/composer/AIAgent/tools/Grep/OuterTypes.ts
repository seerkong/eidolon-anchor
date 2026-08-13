import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { FileToolScopeIntent } from "@cell/ai-organ-logic/permissions/FileToolScope"
export type GrepOuterRuntime = AiAgentOneActorRuntime
export type GrepOuterInput = { pattern: string; path?: string; include?: string; scopeIntent?: FileToolScopeIntent }
export type GrepOuterConfig = Record<string, unknown>
export type GrepOuterDerived = null
export type GrepOuterOutput = string
