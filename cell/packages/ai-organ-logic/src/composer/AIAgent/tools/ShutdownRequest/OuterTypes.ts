import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type ShutdownRequestOuterRuntime = AiAgentOneActorRuntime
export type ShutdownRequestOuterInput = { member_id: string; reason?: string }
export type ShutdownRequestOuterConfig = Record<string, unknown>
export type ShutdownRequestOuterDerived = null
export type ShutdownRequestOuterOutput = string
