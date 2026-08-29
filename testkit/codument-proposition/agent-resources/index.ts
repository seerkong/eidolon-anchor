import kernelWorkLoop from "./copied-profile/KernelWorkLoop.md" with { type: "text" }
import kernelRules from "./copied-profile/KernelRules.md" with { type: "text" }
import primaryAgent from "./copied-profile/PrimaryAgent.md" with { type: "text" }
import primaryIdentity from "./copied-profile/PrimaryIdentity.md" with { type: "text" }
import primaryRouting from "./copied-profile/PrimaryRouting.md" with { type: "text" }
import primaryCodingRules from "./copied-profile/PrimaryCodingRules.md" with { type: "text" }
import delegationGuidance from "./copied-profile/DelegationGuidance.md" with { type: "text" }

function frontmatterBody(source: string): string {
  const match = source.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/)
  return (match?.[1] ?? source).trim()
}

export function copiedMatureCodeAgentPrefix(workDir: string): Readonly<{
  kernel: string
  coding: string
}> {
  const kernel = [
    kernelWorkLoop.replace(
      "{delegateAgentDescriptions}",
      "- Workflow CodeAgent uses the exact ToolRefs frozen with this AIAgentDefinition.",
    ).trim(),
    kernelRules.trim(),
  ].join("\n\n")
  const coding = [
    `# Agent\n\n${frontmatterBody(primaryAgent).replaceAll("{workdir}", workDir)}`,
    `# Identity\n\n${primaryIdentity.trim()}`,
    `# Routing\n\n${primaryRouting.trim()}`,
    primaryCodingRules.trim(),
    delegationGuidance.replace(
      "{agent_list}",
      "- code: general coding delegate\n- explorer: repository discovery\n- oracle: architecture and root-cause analysis",
    ).trim(),
  ].join("\n\n")
  return Object.freeze({ kernel, coding })
}

export const WORKSPACE_AGENTS_MESSAGE_SOURCE = JSON.stringify(Object.freeze({
  implementation: "eidolon.workspace-agents/v1",
}))

export const STANDARD_CONTEXT_PIPELINE_SOURCE = JSON.stringify(Object.freeze({
  implementation: "eidolon.standard-context-pipeline/v1",
  stages: Object.freeze([
    "prompt-plan",
    "conversation-prelude",
    "provider-context-facts-at-history-anchors",
    "stable-message-prefix",
    "conversation-boundary-overlays",
    "provider-conversion",
  ]),
}))
