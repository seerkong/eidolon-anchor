import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type RunDetachedBashOuterRuntime = AiAgentOneActorRuntime

export type RunDetachedBashOuterInput = {
  command: string
  agent_type: string
}

export type RunDetachedBashOuterConfig = Record<string, unknown>
export type RunDetachedBashOuterDerived = null
export type RunDetachedBashOuterOutput = string
