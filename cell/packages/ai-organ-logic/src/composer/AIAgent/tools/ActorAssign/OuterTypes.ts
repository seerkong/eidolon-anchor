import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type ActorAssignOuterRuntime = AiAgentOneActorRuntime
export type ActorAssignOuterInput = { target: string; mode: "final" | "none" | "stream"; content: string }
export type ActorAssignOuterConfig = Record<string, unknown>
export type ActorAssignOuterDerived = null
export type ActorAssignOuterOutput = string
