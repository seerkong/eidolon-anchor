import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { FileToolScopeIntent } from "@cell/ai-organ-logic/permissions/FileToolScope"
export type LsOuterRuntime = AiAgentOneActorRuntime
export type LsOuterInput = { path?: string; ignore?: string[]; scopeIntent?: FileToolScopeIntent }
export type LsOuterConfig = Record<string, unknown>
export type LsOuterDerived = null
export type LsOuterOutput = string
