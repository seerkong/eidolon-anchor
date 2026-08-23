import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type SkillOuterRuntime = AiAgentOneActorRuntime
export type SkillOuterInput = {
  skill: string
  resource?: string
  resources?: string[]
  offset?: number
  limit?: number
}
export type SkillOuterConfig = Record<string, unknown>
export type SkillOuterDerived = null
export type SkillOuterOutput = string
