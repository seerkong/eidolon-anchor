import type { ActorContextPolicy } from "./AiAgentActor"

export type AgentSeedMessageRole = "system" | "developer" | "user" | "assistant"

export type AgentSeedMessage = {
  readonly role: AgentSeedMessageRole
  readonly content: string
}

export type AgentConfig = {
  name: string
  description: string
  tools: string[] | "*"
  prompt: string[]
  seedMessages?: readonly AgentSeedMessage[]
  requireExactTools?: boolean
  contextPolicy?: Partial<ActorContextPolicy>
}
