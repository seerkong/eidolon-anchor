import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type DetachedActorStatusOuterRuntime = AiAgentOneActorRuntime

export type DetachedActorStatusOuterInput = {
  task_id: string
}

export type DetachedActorStatusOuterConfig = Record<string, unknown>
export type DetachedActorStatusOuterDerived = null
export type DetachedActorStatusOuterOutput = string
