import type { RuntimeAssemblyContext } from "../types";
import kernelRulesMd from "./KernelRules.md" with { type: "text" };
import kernelWorkLoopMd from "./KernelWorkLoop.md" with { type: "text" };

function formatDelegateAgentDescriptions(descriptions: string): string {
  const trimmed = descriptions.trim();
  return trimmed || "- workspace 配置中没有额外 delegate；coding profile 可能会添加内置 delegate，RunDelegateActor 的 agent_type schema 是最终可用列表。";
}

function renderTemplate(text: string, context: RuntimeAssemblyContext): string {
  return text
    .replace("{skillsDescription}", context.skillsDescription)
    .replace("{delegateAgentDescriptions}", formatDelegateAgentDescriptions(context.delegateAgentDescriptions))
    .trim();
}

export function buildModAiKernelPromptSection(context: RuntimeAssemblyContext): string {
  return [
    renderTemplate(kernelWorkLoopMd, context),
    kernelRulesMd.trim(),
  ].filter(Boolean).join("\n\n");
}
