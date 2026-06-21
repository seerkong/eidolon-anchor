import type {
  RuntimeAssemblyContext,
  RuntimeAssemblyState,
} from "@cell/ai-composer/ai-contract";
import {
  mergeBuiltinCodingAgents,
  resolveDefaultDelegateAgentName,
} from "./agent";
import {
  buildModAiCodingDelegateGuidanceSection,
  buildModAiCodingPromptSection,
  loadWorkspaceAgentsPromptSection,
} from "./prompt";

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
      buildModAiCodingDelegateGuidanceSection(nextAgentConfigs),
      loadWorkspaceAgentsPromptSection(context.workDir) ?? "",
    ],
    capabilityIds: Array.from(new Set([...state.capabilityIds, "mod-ai-coding"])),
    policies: {
      ...state.policies,
      defaultAppProfile: "coding",
      delegateAgentSelectionOwner: "mod-ai-coding",
      defaultDelegateAgentFallback: resolveDefaultDelegateAgentName(nextAgentConfigs),
    },
  };
}

export const applyModSysCoding = applyModAiCoding;
export const buildModSysCodingPromptSection = buildModAiCodingPromptSection;
export * from "./agent";
export * from "./hooks/actorIdleObserver";
export * from "./prompt";
