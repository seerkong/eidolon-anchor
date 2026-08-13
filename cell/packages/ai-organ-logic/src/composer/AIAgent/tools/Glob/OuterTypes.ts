import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { FileToolScopeIntent } from "@cell/ai-organ-logic/permissions/FileToolScope"
export type GlobOuterRuntime = AiAgentOneActorRuntime
export type GlobOuterInput = { pattern: string; path?: string; scopeIntent?: FileToolScopeIntent }
export type GlobOuterConfig = Record<string, unknown>
export type GlobOuterDerived = null
export type GlobOuterOutput = string
