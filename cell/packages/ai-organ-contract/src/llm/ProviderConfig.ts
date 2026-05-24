import type { LlmModelCapabilities } from "@cell/ai-core-contract/LlmTypes";

export type LlmProviderAdapterType = "openai" | "anthropic" | "codex" | "claude" | "deepseek";

export type ProviderModelReasoningConfig = {
  effort?: "low" | "medium" | "high" | "xhigh";
};

export type LlmProviderModelConfig = {
  name: string;
  adapter?: string;
  context?: number;
  output?: number;
  reasoning?: ProviderModelReasoningConfig;
  options?: Record<string, unknown>;
};

export type LlmProviderConfig = {
  name: string;
  adapter?: string;
  baseURL?: string;
  apiKey?: string;
  options?: Record<string, unknown>;
  models: LlmProviderModelConfig[];
};

export type LlmProviderCatalogConfig = {
  providers: LlmProviderConfig[];
};

export type LlmPresentPrimaryConfig = {
  model: string;
};

export type LlmPresentPresetConfig = {
  primary: LlmPresentPrimaryConfig;
};

export type LlmPresentFallbackEntry = {
  model: string;
};

export type LlmPresentFallbackChains = {
  primary: LlmPresentFallbackEntry[];
};

export type LlmPresentFallbackConfig = {
  enabled: boolean;
  timeoutMs: number;
  chains: LlmPresentFallbackChains;
};

export type LlmPresentConfig = {
  defaultPreset: string;
  presets: Record<string, LlmPresentPresetConfig>;
  fallback: LlmPresentFallbackConfig;
};

export type LlmResolvedModelConfig = {
  selectedModel: string;
  providerId: string;
  modelId: string;
  adapter: LlmProviderAdapterType;
  baseURL: string;
  apiKey: string;
  inputLimit: number;
  outputLimit: number;
  reasoningEffort?: ProviderModelReasoningConfig["effort"];
  capabilities?: LlmModelCapabilities;
  options: Record<string, unknown>;
};

export type AgentModelPreset = {
  model: string;
};

export type AgentPresetConfig = {
  preset: string;
  presets: Record<string, Record<string, AgentModelPreset>>;
};

export type LLMProviderConfig = LlmProviderCatalogConfig;
export type ProviderConfig = LlmProviderConfig & {
  adapter?: LlmProviderAdapterType;
  baseURL?: string;
  apiKey?: string;
};
export type ProviderModelConfig = LlmProviderModelConfig & {
  context: number;
  output: number;
};
export type FlattenedModelConfig = {
  provider: string;
  adapter?: LlmProviderAdapterType;
  model: string;
  baseURL: string;
  apiKey: string;
  inputLimit: number;
  outputLimit: number;
  reasoningEffort?: ProviderModelReasoningConfig["effort"];
  capabilities?: LlmModelCapabilities;
};

export function isLlmAdapterType(value: unknown): value is LlmProviderAdapterType {
  return value === "openai" || value === "anthropic" || value === "codex" || value === "claude" || value === "deepseek";
}

export function isReasoningEffort(value: unknown): value is ProviderModelReasoningConfig["effort"] {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return value === undefined || isObject(value);
}

export function isProviderModelConfig(value: unknown): value is ProviderModelConfig {
  if (!isObject(value)) return false;
  return (
    typeof value.name === "string" &&
    (value.adapter === undefined || typeof value.adapter === "string") &&
    typeof value.context === "number" &&
    Number.isFinite(value.context) &&
    typeof value.output === "number" &&
    Number.isFinite(value.output) &&
    isStringRecord(value.options) &&
    (value.reasoning === undefined ||
      (isObject(value.reasoning) &&
        (value.reasoning.effort === undefined || isReasoningEffort(value.reasoning.effort))))
  );
}

export function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!isObject(value)) return false;
  return (
    typeof value.name === "string" &&
    (value.adapter === undefined || isLlmAdapterType(value.adapter)) &&
    typeof value.baseURL === "string" &&
    typeof value.apiKey === "string" &&
    isStringRecord(value.options) &&
    Array.isArray(value.models) &&
    value.models.every((model) => isProviderModelConfig(model))
  );
}

export function isLLMProviderConfig(value: unknown): value is LLMProviderConfig {
  if (!isObject(value) || !Array.isArray(value.providers)) return false;
  return value.providers.every((provider) => isProviderConfig(provider));
}

export function isAgentModelPreset(value: unknown): value is AgentModelPreset {
  return isObject(value) && typeof value.model === "string";
}

export function isAgentPresetConfig(value: unknown): value is AgentPresetConfig {
  if (!isObject(value) || typeof value.preset !== "string" || !isObject(value.presets)) return false;
  return Object.values(value.presets).every(
    (preset) => isObject(preset) && Object.values(preset).every((entry) => isAgentModelPreset(entry)),
  );
}

