import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type MemberCreateOuterRuntime = AiAgentOneActorRuntime
export type MemberCreateOuterInput = {
  name: string
  agent_type: string
  prompt: string
}
export type MemberCreateOuterConfig = Record<string, unknown>
export type MemberCreateOuterDerived = null
export type MemberCreateOuterOutput = string
