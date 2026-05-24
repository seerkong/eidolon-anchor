import type { Component } from "solid-js"
import { GenericTool, TOOL_CARD_REGISTRY } from "./tool-cards"
import type { ToolCardProps } from "./tool-chrome"

export const CODING_TOOL_CARD_ALLOWLIST = [
  "bash",
  "edit",
  "multiedit",
  "write",
  "read",
  "grep",
  "glob",
  "list",
  "patch",
  "apply_patch",
] as const

export const RESEARCH_TOOL_CARD_ALLOWLIST = ["webfetch", "codesearch", "websearch"] as const
export const ORCHESTRATION_TOOL_CARD_ALLOWLIST = ["task", "question", "tasktreewrite", "tasktreeread"] as const

const CODING_TOOL_CARD_ALLOWLIST_SET = new Set<string>(CODING_TOOL_CARD_ALLOWLIST)
const RESEARCH_TOOL_CARD_ALLOWLIST_SET = new Set<string>(RESEARCH_TOOL_CARD_ALLOWLIST)
const ORCHESTRATION_TOOL_CARD_ALLOWLIST_SET = new Set<string>(ORCHESTRATION_TOOL_CARD_ALLOWLIST)

export function resolveTuiA1ToolCard(tool: string): Component<ToolCardProps<any>> {
  if (
    !CODING_TOOL_CARD_ALLOWLIST_SET.has(tool) &&
    !RESEARCH_TOOL_CARD_ALLOWLIST_SET.has(tool) &&
    !ORCHESTRATION_TOOL_CARD_ALLOWLIST_SET.has(tool)
  ) {
    return GenericTool
  }
  return TOOL_CARD_REGISTRY[tool] ?? GenericTool
}

export { GenericTool, TOOL_CARD_REGISTRY }
