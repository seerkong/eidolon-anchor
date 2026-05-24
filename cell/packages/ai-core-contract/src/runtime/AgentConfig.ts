export type AgentConfig = {
  name: string
  description: string
  tools: string[] | "*"
  prompt: string[]
}
