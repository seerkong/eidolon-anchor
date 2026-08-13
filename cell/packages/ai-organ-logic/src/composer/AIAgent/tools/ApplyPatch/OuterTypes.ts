import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { FileToolScopeIntent } from "@cell/ai-organ-logic/permissions/FileToolScope"
export type ApplyPatchOuterRuntime = AiAgentOneActorRuntime
export type ApplyPatchOuterInput = { patchText?: string; patch?: string; scopeIntent?: FileToolScopeIntent }
export type ApplyPatchOuterConfig = Record<string, unknown>
export type ApplyPatchOuterDerived = null
export type ApplyPatchOuterOutput = string
