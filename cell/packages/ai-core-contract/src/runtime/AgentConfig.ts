import type { ActorContextPolicy } from "./AiAgentActor"

export type AgentConfig = {
  name: string
  description: string
  tools: string[] | "*"
  prompt: string[]
  contextPolicy?: Partial<ActorContextPolicy>
}
