import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig";
import type { RuntimeAssemblyContext, RuntimeAssemblyState } from "@cell/ai-composer/ai-contract";
import fs from "fs";
import path from "path";
import {
  BUILTIN_CODING_AGENT_CONFIGS,
  DEFAULT_CODE_AGENT_CONFIG,
  buildBundledDelegateGuidanceSection,
  buildBundledPrimaryPromptSection,
} from "./AgentDefinitionLoader";

export { BUILTIN_CODING_AGENT_CONFIGS, DEFAULT_CODE_AGENT_CONFIG };

function mergeBuiltinCodingAgents(
  loadedAgents: Readonly<Record<string, AgentConfig>>,
): Readonly<Record<string, AgentConfig>> {
  return {
    ...BUILTIN_CODING_AGENT_CONFIGS,
    ...loadedAgents,
  };
}

export function buildModAiCodingPromptSection(context: Pick<RuntimeAssemblyContext, "workDir">): string {
  return buildBundledPrimaryPromptSection({ workDir: context.workDir });
}

function loadWorkspaceAgentsPromptSection(workDir: string): string | null {
  try {
    const agentsPath = path.join(workDir, "AGENTS.md");
    if (!fs.existsSync(agentsPath) || !fs.statSync(agentsPath).isFile()) return null;
    const content = fs.readFileSync(agentsPath, "utf-8").trim();
    if (!content) return null;
    return `AGENTS.md (workspace):\n${content}`;
  } catch {
    return null;
  }
}

export function applyModAiCoding(
  state: RuntimeAssemblyState,
  context: RuntimeAssemblyContext,
): RuntimeAssemblyState {
  const nextAgentConfigs = mergeBuiltinCodingAgents(state.agentConfigs);

  return {
    ...state,
    agentConfigs: nextAgentConfigs,
    systemPromptSections: [
      ...state.systemPromptSections,
      buildModAiCodingPromptSection(context),
      buildBundledDelegateGuidanceSection(nextAgentConfigs),
      loadWorkspaceAgentsPromptSection(context.workDir) ?? "",
    ],
    capabilityIds: Array.from(new Set([...state.capabilityIds, "mod-ai-coding"])),
    policies: {
      ...state.policies,
      defaultAppProfile: "coding",
      delegateAgentSelectionOwner: "mod-ai-coding",
      defaultDelegateAgentFallback: Object.keys(nextAgentConfigs).includes(DEFAULT_CODE_AGENT_CONFIG.name)
        ? DEFAULT_CODE_AGENT_CONFIG.name
        : Object.keys(nextAgentConfigs)[0] ?? "",
    },
  };
}

export const applyModSysCoding = applyModAiCoding;
export const buildModSysCodingPromptSection = buildModAiCodingPromptSection;
