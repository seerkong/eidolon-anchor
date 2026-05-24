import type { Agent } from "@terminal/core/AIAgent"

const genericAgentDescriptions = new Map<string, string>([
  ["Default agent", "Implement code changes and complete the task end to end"],
  ["Planning agent", "Reason about scope, constraints, and the execution plan before editing"],
  ["Research agent", "Inspect the codebase and gather facts before making changes"],
  ["General assistant", "Handle mixed runtime tasks when no specialized agent role fits"],
  ["Default code agent", "Primary coding agent used by the runtime profile"],
])

function fallbackDescription(name: string): string {
  switch (name) {
    case "build":
      return "Implement code changes and complete the task end to end"
    case "plan":
      return "Reason about scope, constraints, and the execution plan before editing"
    case "explore":
      return "Inspect the codebase and gather facts before making changes"
    case "general":
      return "Handle mixed runtime tasks when no specialized agent role fits"
    case "code":
      return "Primary coding agent used by the runtime profile"
    default:
      return "Runtime agent"
  }
}

export function formatAgentOptionDescription(agent: Agent): string {
  const raw = agent.description?.trim()
  const refined = raw ? genericAgentDescriptions.get(raw) ?? raw : fallbackDescription(agent.name)
  const model = agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : ""
  return model ? `${refined} · ${model}` : refined
}

export function sortAgentsByCurrent(agents: Agent[], currentName?: string): Agent[] {
  if (!currentName) return [...agents]
  const current = agents.find((agent) => agent.name === currentName)
  if (!current) return [...agents]
  return [current, ...agents.filter((agent) => agent.name !== currentName)]
}
