import fs from "fs";
import os from "os";
import path from "path";
import type { RuntimeLogFn } from "@cell/ai-core-contract/runtime/Logging";
import type {
  AgentPresetConfig,
  FlattenedModelConfig,
  LlmPresentConfig,
  LlmProviderCatalogConfig,
  LlmProviderConfig,
  LlmProviderModelConfig,
  LLMProviderConfig,
} from "@cell/ai-organ-contract/llm/ProviderConfig";
import { extractProviderConnectionOptions } from "./ProviderOptions";
import { resolveDeepSeekModelCapabilities } from "./DeepSeekModelCapabilities";

export type LlmActorModelConfig = {
  provider?: string;
  adapter?: "openai" | "anthropic" | "codex" | "claude" | "deepseek";
  apiKind?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  inputLimit?: number;
  outputLimit?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  capabilities?: import("@cell/ai-core-contract/LlmTypes").LlmModelCapabilities;
};

export const LLM_CONFIG_DIR_NAME = ".eidolon";
export const PROVIDER_CONFIG_FILE_NAME = "llm-provider.json";
export const PRESENT_CONFIG_FILE_NAME = "agent-preset.json";

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeConfigPath(configPath: string | undefined): string | undefined {
  if (!configPath) return undefined;
  const expanded = configPath.startsWith("~/") ? path.join(resolveHomeDir(), configPath.slice(2)) : configPath;
  return path.resolve(expanded);
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`LLM config file not found: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) {
    throw new Error(`LLM config must be a JSON object: ${filePath}`);
  }
  return parsed;
}

function readJsonObjectIfExists(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  return readJsonObject(filePath);
}

function optionalString(value: unknown, filePath: string, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`'${context}' must be a string in ${filePath}`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredString(obj: Record<string, unknown>, key: string, filePath: string, context: string): string {
  const value = optionalString(obj[key], filePath, `${context}.${key}`);
  if (!value) throw new Error(`'${context}.${key}' must be a non-empty string in ${filePath}`);
  return value;
}

function optionalObject(value: unknown, filePath: string, context: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error(`'${context}' must be an object in ${filePath}`);
  return { ...value };
}

function optionalNumber(value: unknown, filePath: string, context: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`'${context}' must be a finite number in ${filePath}`);
  }
  return value;
}

function optionalNestedNumber(
  obj: Record<string, unknown>,
  keys: readonly string[],
  filePath: string,
  context: string,
): number | undefined {
  for (const key of keys) {
    const value = optionalNumber(obj[key], filePath, `${context}.${key}`);
    if (value !== undefined) return value;
  }
  return undefined;
}

function resolveModelLimit(
  modelItem: Record<string, unknown>,
  filePath: string,
  modelContext: string,
  key: "context" | "output",
): number {
  const topLevelKeys = key === "context"
    ? ["context", "input", "inputContext", "input_context", "maxInputTokens", "max_input_tokens"]
    : ["output", "outputContext", "output_context", "maxOutputTokens", "max_output_tokens"];
  const topLevel = optionalNestedNumber(modelItem, topLevelKeys, filePath, modelContext);
  if (topLevel !== undefined) return topLevel;

  for (const nestedKey of ["limits", "limit"]) {
    const limits = optionalObject(modelItem[nestedKey], filePath, `${modelContext}.${nestedKey}`);
    const nested = optionalNestedNumber(limits, topLevelKeys, filePath, `${modelContext}.${nestedKey}`);
    if (nested !== undefined) return nested;
  }

  return 0;
}

export function normalizeModelOptions(options: Record<string, unknown> = {}): Record<string, unknown> {
  const aliases: Record<string, string> = {
    max_output_tokens: "max_tokens",
    max_completion_tokens: "max_tokens",
    max_new_tokens: "max_tokens",
    reasoningeffort: "reasoning_effort",
    defaultheaders: "default_headers",
    defaultquery: "default_query",
  };
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    const snakeKey = toSnakeCase(String(key));
    normalized[aliases[snakeKey] ?? snakeKey] = value;
  }
  return normalized;
}

export function extractConnectionOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  return extractProviderConnectionOptions(options);
}

export function normalizeAdapterName(value: string): "openai" | "anthropic" | "codex" | "claude" | "deepseek" {
  const normalized = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  if (["openai_responses", "responses", "openai_response", "codex"].includes(normalized)) return "codex";
  if (["openai", "openai_chat", "openai_chat_completions"].includes(normalized)) return "openai";
  if (["anthropic", "anthropic_chat"].includes(normalized)) return "anthropic";
  if (["claude", "claude_code"].includes(normalized)) return "claude";
  if (["deepseek", "deep_seek"].includes(normalized)) return "deepseek";
  throw new Error(`Unsupported provider adapter: ${value}`);
}

function tryNormalizeAdapterName(value: string | undefined): "openai" | "anthropic" | "codex" | "claude" | "deepseek" | undefined {
  if (!value) return undefined;
  return normalizeAdapterName(value);
}

export function defaultProviderConfigPath(): string {
  return path.join(resolveHomeDir(), LLM_CONFIG_DIR_NAME, PROVIDER_CONFIG_FILE_NAME);
}

export function defaultPresentConfigPath(workdir?: string): string {
  if (workdir) {
    const workspaceCandidate = path.join(workdir, LLM_CONFIG_DIR_NAME, PRESENT_CONFIG_FILE_NAME);
    if (fs.existsSync(workspaceCandidate)) return workspaceCandidate;
  }
  return path.join(resolveHomeDir(), LLM_CONFIG_DIR_NAME, PRESENT_CONFIG_FILE_NAME);
}

export function parseProviderCatalogRaw(raw: Record<string, unknown>, filePath = "<memory>"): LlmProviderCatalogConfig {
  if (!Array.isArray(raw.providers)) throw new Error(`'providers' must be a list in ${filePath}`);
  const providers: LlmProviderConfig[] = raw.providers.map((item, index) => {
    const context = `providers[${index}]`;
    if (!isObject(item)) throw new Error(`'${context}' must be an object in ${filePath}`);
    if (!Array.isArray(item.models)) throw new Error(`'${context}.models' must be a list in ${filePath}`);
    const providerOptions = optionalObject(item.options, filePath, `${context}.options`);
    const providerBaseURL = optionalString(item.baseURL ?? item.base_url, filePath, `${context}.baseURL`) ?? "";
    const providerApiKey = optionalString(item.apiKey ?? item.api_key, filePath, `${context}.apiKey`) ?? "";
    if (providerBaseURL) providerOptions.baseURL ??= providerBaseURL;
    if (providerApiKey) providerOptions.apiKey ??= providerApiKey;
    const models: LlmProviderModelConfig[] = item.models.map((modelItem, modelIndex) => {
      const modelContext = `${context}.models[${modelIndex}]`;
      if (!isObject(modelItem)) throw new Error(`'${modelContext}' must be an object in ${filePath}`);
      const name = optionalString(modelItem.id, filePath, `${modelContext}.id`) ?? requiredString(modelItem, "name", filePath, modelContext);
      return {
        name,
        adapter: optionalString(modelItem.adapter, filePath, `${modelContext}.adapter`),
        context: resolveModelLimit(modelItem, filePath, modelContext, "context"),
        output: resolveModelLimit(modelItem, filePath, modelContext, "output"),
        reasoning: isObject(modelItem.reasoning) ? { effort: modelItem.reasoning.effort as any } : undefined,
        options: optionalObject(modelItem.options, filePath, `${modelContext}.options`),
      };
    });
    return {
      name: optionalString(item.id, filePath, `${context}.id`) ?? requiredString(item, "name", filePath, context),
      adapter: optionalString(item.adapter, filePath, `${context}.adapter`),
      baseURL: providerBaseURL,
      apiKey: providerApiKey,
      options: providerOptions,
      models,
    };
  });
  return { providers };
}

export function loadProviderCatalog(configPath?: string): LlmProviderCatalogConfig {
  const filePath = normalizeConfigPath(configPath) ?? defaultProviderConfigPath();
  const raw = readJsonObjectIfExists(filePath);
  if (raw) return parseProviderCatalogRaw(raw, filePath);
  if (configPath) throw new Error(`LLM config file not found: ${filePath}`);
  throw new Error(`LLM config file not found: ${filePath}`);
}

export function parsePresentConfigRaw(raw: Record<string, unknown>, filePath = "<memory>", presetOverride?: string): LlmPresentConfig {
  const defaultPreset = presetOverride || optionalString(raw.default_preset ?? raw.defaultPreset, filePath, "default_preset") || "default";
  const presetsRaw = optionalObject(raw.presets, filePath, "presets");
  const presets: LlmPresentConfig["presets"] = {};
  for (const [presetName, presetValue] of Object.entries(presetsRaw)) {
    if (!isObject(presetValue)) throw new Error(`'presets.${presetName}' must be an object in ${filePath}`);
    const primaryRaw = optionalObject(presetValue.primary, filePath, `presets.${presetName}.primary`);
    presets[presetName] = { primary: { model: optionalString(primaryRaw.model, filePath, `presets.${presetName}.primary.model`) || "" } };
  }
  const fallbackRaw = optionalObject(raw.fallback, filePath, "fallback");
  const chainsRaw = optionalObject(fallbackRaw.chains, filePath, "fallback.chains");
  const primaryChain = Array.isArray(chainsRaw.primary) ? chainsRaw.primary : [];
  return {
    defaultPreset,
    presets,
    fallback: {
      enabled: fallbackRaw.enabled === true,
      timeoutMs: typeof fallbackRaw.timeout_ms === "number" ? fallbackRaw.timeout_ms : typeof fallbackRaw.timeoutMs === "number" ? fallbackRaw.timeoutMs : 15000,
      chains: {
        primary: primaryChain.map((entry) => ({ model: isObject(entry) && typeof entry.model === "string" ? entry.model : "" })),
      },
    },
  };
}

export function loadPresentConfig(params: { configPath?: string; workdir?: string; presetOverride?: string } = {}): LlmPresentConfig {
  const filePath = normalizeConfigPath(params.configPath) ?? defaultPresentConfigPath(params.workdir);
  return parsePresentConfigRaw(readJsonObject(filePath), filePath, params.presetOverride);
}

export function flattenModelConfig(
  modelRef: string,
  providerConfig: LLMProviderConfig,
  logger?: RuntimeLogFn,
): FlattenedModelConfig | null {
  const modelString = String(modelRef || "").trim();
  const separatorIndex = modelString.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= modelString.length - 1) {
    logger?.("error", `Invalid model reference format: ${modelRef}`);
    return null;
  }
  const providerName = modelString.slice(0, separatorIndex);
  const modelName = modelString.slice(separatorIndex + 1);
  const provider = providerConfig.providers.find((entry) => entry.name === providerName);
  if (!provider) {
    logger?.("error", `Provider not found: ${providerName}`);
    return null;
  }
  const model = provider.models.find((entry) => entry.name === modelName);
  if (!model) {
    logger?.("warn", `Model not found under provider: ${modelRef}`);
  }

  const options = { ...(provider.options ?? {}), ...(model?.options ?? {}) };
  const baseURL = String(options.baseURL ?? options.base_url ?? provider.baseURL ?? "");
  const apiKey = String(options.apiKey ?? options.api_key ?? provider.apiKey ?? "");
  const adapter = tryNormalizeAdapterName(model?.adapter || provider.adapter);
  const capabilities = resolveDeepSeekModelCapabilities({
    providerId: provider.name,
    adapter,
    modelId: model?.name ?? modelName,
    outputLimit: model?.output ?? 0,
    reasoningEffort: model?.reasoning?.effort,
  });
  const inputLimit = model?.context ?? 0;
  // Derive compaction threshold from the user-configured context window
  // for models that support prefix caching.
  if (capabilities && inputLimit > 0) {
    capabilities.cachePolicy ??= {
      stablePrefix: true,
      providerManagedPrefixCache: true,
      preferLateCompaction: true,
    };
    capabilities.cachePolicy.compactionThresholdTokens = Math.floor(
      (inputLimit * 80) / 100,
    );
  }
  return {
    provider: provider.name,
    adapter,
    model: model?.name ?? modelName,
    baseURL,
    apiKey,
    inputLimit,
    outputLimit: model?.output ?? 0,
    reasoningEffort: capabilities?.reasoningEffort ?? model?.reasoning?.effort,
    capabilities,
  };
}

export function resolvePrimaryCandidates(catalog: LlmProviderCatalogConfig, presentConfig: LlmPresentConfig): string[] {
  const presetName = String(presentConfig.defaultPreset || "").trim();
  const preset = presentConfig.presets[presetName];
  if (!preset) throw new Error(`Preset '${presetName}' not found in present config`);
  if (!preset.primary.model) throw new Error(`Preset '${presetName}' has no primary model`);
  const candidates = [preset.primary.model];
  if (presentConfig.fallback.enabled) {
    candidates.push(...presentConfig.fallback.chains.primary.map((entry) => entry.model).filter(Boolean));
  }
  const deduped: string[] = [];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || deduped.includes(normalized)) continue;
    const resolved = flattenModelConfig(normalized, catalog);
    if (!resolved) throw new Error(`Invalid model candidate: ${normalized}`);
    deduped.push(normalized);
  }
  return deduped;
}

export function resolvePresetModelRef(presetConfig: AgentPresetConfig, agentKey: string, logger?: RuntimeLogFn): string | null {
  const activePresetName = presetConfig.preset;
  const activePreset = presetConfig.presets[activePresetName];
  if (!activePreset) {
    logger?.("error", `Active preset not found: ${activePresetName}`);
    return null;
  }
  const agentPreset = activePreset[agentKey] ?? activePreset.default;
  if (!agentPreset) {
    logger?.("error", `No model preset found for agent: ${agentKey}`);
    return null;
  }
  return agentPreset.model;
}

export function resolveActorModelConfig(params: {
  agentKey: string;
  presetConfig?: AgentPresetConfig | null;
  providerConfig?: LLMProviderConfig | null;
  fallback?: LlmActorModelConfig;
  fallbackModelConfig?: LlmActorModelConfig;
  fallbackOverrideKeys?: (keyof LlmActorModelConfig)[];
  logger?: RuntimeLogFn;
}): LlmActorModelConfig {
  const fallback = params.fallback ?? params.fallbackModelConfig ?? {};
  if (!params.presetConfig || !params.providerConfig) return fallback;
  const modelRef = resolvePresetModelRef(params.presetConfig, params.agentKey, params.logger);
  if (!modelRef) return fallback;
  const flattened = flattenModelConfig(modelRef, params.providerConfig, params.logger);
  if (!flattened) return fallback;
  const resolved: LlmActorModelConfig = {
    ...fallback,
    provider: flattened.provider,
    adapter: flattened.adapter ?? fallback.adapter,
    model: flattened.model,
    baseUrl: flattened.baseURL,
    apiKey: flattened.apiKey,
    inputLimit: flattened.inputLimit,
    outputLimit: flattened.outputLimit,
    maxInputTokens: flattened.inputLimit,
    maxOutputTokens: flattened.outputLimit,
    reasoningEffort: flattened.reasoningEffort,
    capabilities: flattened.capabilities,
  };
  for (const key of params.fallbackOverrideKeys ?? []) {
    if (fallback[key] !== undefined) {
      (resolved as Record<string, unknown>)[key] = fallback[key];
    }
  }
  return resolved;
}
