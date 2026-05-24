import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type MemberAssignOuterRuntime = AiAgentOneActorRuntime
export type MemberAssignOuterInput = { target: string; mode: "final" | "none" | "stream"; content: string }
export type MemberAssignOuterConfig = Record<string, unknown>
export type MemberAssignOuterDerived = null
export type MemberAssignOuterOutput = string
