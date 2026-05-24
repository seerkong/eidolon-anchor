import type { AgentPresetConfig, LLMProviderConfig } from "@cell/ai-organ-contract/llm/ProviderConfig";
import type { RuntimeLogFn } from "./Logging";

export type CoreRuntimeConfigLoader = {
  loadLLMProviderConfig: (workDir: string, logger?: RuntimeLogFn) => LLMProviderConfig | null;
  loadAgentPresetConfig: (workDir: string, logger?: RuntimeLogFn) => AgentPresetConfig | null;
};
