import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type TaskTreeReadMode = "tree" | "flat"

export type TaskTreeReadOuterRuntime = AiAgentOneActorRuntime
export type TaskTreeReadOuterInput = Record<string, never>
export type TaskTreeReadOuterConfig = {
  mode?: TaskTreeReadMode
}
export type TaskTreeReadOuterDerived = null
export type TaskTreeReadOuterOutput = string
