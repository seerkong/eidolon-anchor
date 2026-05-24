import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type DetachedToolCallOuterRuntime = AiAgentOneActorRuntime

export type DetachedToolCallOuterInput = {
  tool_name: string
  arguments: any
  agent_type: string
}

export type DetachedToolCallOuterConfig = Record<string, unknown>
export type DetachedToolCallOuterDerived = null
export type DetachedToolCallOuterOutput = string
