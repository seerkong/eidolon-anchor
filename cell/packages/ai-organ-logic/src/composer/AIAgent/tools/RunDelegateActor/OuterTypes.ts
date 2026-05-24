import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type RunDelegateActorOuterRuntime = AiAgentOneActorRuntime
export type RunDelegateActorOuterInput = {
  description: string
  prompt: string
  agent_type: string
  mode?: "sync_wait" | "detached"
}
export type RunDelegateActorOuterConfig = Record<string, unknown>
export type RunDelegateActorOuterDerived = null
export type RunDelegateActorOuterOutput = string
