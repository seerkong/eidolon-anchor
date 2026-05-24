import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type DetachedBashOuterRuntime = AiAgentOneActorRuntime

export type DetachedBashOuterInput = {
  command: string
  agent_type: string
}

export type DetachedBashOuterConfig = Record<string, unknown>
export type DetachedBashOuterDerived = null
export type DetachedBashOuterOutput = string
