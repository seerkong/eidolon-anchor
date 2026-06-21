import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig";
import {
  BUILTIN_CODING_AGENT_CONFIGS,
  DEFAULT_CODE_AGENT_CONFIG,
} from "./AgentDefinitionLoader";

export {
  BUILTIN_CODING_AGENT_CONFIGS,
  DEFAULT_CODE_AGENT_CONFIG,
  buildBundledDelegateGuidanceSection,
  buildBundledPrimaryPromptSection,
} from "./AgentDefinitionLoader";

export function mergeBuiltinCodingAgents(
  loadedAgents: Readonly<Record<string, AgentConfig>>,
): Readonly<Record<string, AgentConfig>> {
  return {
    ...BUILTIN_CODING_AGENT_CONFIGS,
    ...loadedAgents,
  };
}

export function resolveDefaultDelegateAgentName(agentConfigs: Readonly<Record<string, AgentConfig>>): string {
  return Object.keys(agentConfigs).includes(DEFAULT_CODE_AGENT_CONFIG.name)
    ? DEFAULT_CODE_AGENT_CONFIG.name
    : Object.keys(agentConfigs)[0] ?? "";
}
