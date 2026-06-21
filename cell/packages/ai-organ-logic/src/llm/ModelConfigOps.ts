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
export const PRESENT_CONFIG_FILE_NAME = "agent-present.json";

type JsonSchema =
  | { type: "object"; required?: string[]; properties?: Record<string, JsonSchema>; additionalProperties?: boolean | JsonSchema }
  | { type: "array"; items: JsonSchema }
  | { type: "string" | "number" | "boolean" }
  | { enum: readonly unknown[] }
  | { anyOf: readonly JsonSchema[] }
  | { type: "any" };

export const LLM_PROVIDER_JSON_SCHEMA = {
  type: "object",
  required: ["providers"],
  properties: {
    providers: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "options", "models"],
        properties: {
          id: { type: "string" },
          adapter: { type: "string" },
          options: { type: "object", additionalProperties: true },
          models: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "limits"],
              properties: {
                id: { type: "string" },
                adapter: { type: "string" },
                limits: {
                  type: "object",
                  required: ["context", "output"],
                  properties: {
                    context: { type: "number" },
                    output: { type: "number" },
                  },
                },
                reasoning: {
                  type: "object",
                  properties: {
                    effort: { enum: ["low", "medium", "high", "xhigh"] },
                  },
                },
                options: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies JsonSchema;

export const AGENT_PRESENT_JSON_SCHEMA = {
  type: "object",
  required: ["presets"],
  properties: {
    default_preset: { type: "string" },
    defaultPreset: { type: "string" },
    "default-preset": { type: "string" },
    preset: { type: "string" },
    presets: {
      type: "object",
      additionalProperties: {
        anyOf: [
          {
            type: "object",
            required: ["primary"],
            properties: {
              primary: {
                type: "object",
                required: ["model"],
                properties: { model: { type: "string" } },
              },
            },
          },
          {
            type: "object",
            required: ["main"],
            properties: {
              main: {
                type: "object",
                required: ["model"],
                properties: { model: { type: "string" } },
              },
            },
          },
          {
            type: "object",
            required: ["default"],
            properties: {
              default: {
                type: "object",
                required: ["model"],
                properties: { model: { type: "string" } },
              },
            },
          },
        ],
      },
    },
    fallback: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        timeoutMs: { type: "number" },
        timeout_ms: { type: "number" },
        chains: {
          type: "object",
          properties: {
            primary: {
              type: "array",
              items: {
                type: "object",
                required: ["model"],
                properties: { model: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies JsonSchema;

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

function schemaTypeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateJsonSchema(value: unknown, schema: JsonSchema, pathLabel: string): string[] {
  if ("anyOf" in schema) {
    const nested = schema.anyOf.map((item) => validateJsonSchema(value, item, pathLabel));
    if (nested.some((errors) => errors.length === 0)) return [];
    return [`${pathLabel} must match one of the allowed schemas: ${nested.flat().join("; ")}`];
  }
  if ("enum" in schema) {
    return schema.enum.includes(value) ? [] : [`${pathLabel} must be one of ${schema.enum.map(String).join(", ")}`];
  }
  if (schema.type === "any") return [];
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${pathLabel} must be an array, got ${schemaTypeName(value)}`];
    return value.flatMap((item, index) => validateJsonSchema(item, schema.items, `${pathLabel}[${index}]`));
  }
  if (schema.type === "object") {
    if (!isObject(value)) return [`${pathLabel} must be an object, got ${schemaTypeName(value)}`];
    const errors: string[] = [];
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${pathLabel}.${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = schema.properties?.[key] ?? (
        typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined
      );
      if (!propertySchema) {
        if (schema.additionalProperties === false) errors.push(`${pathLabel}.${key} is not allowed`);
        continue;
      }
      errors.push(...validateJsonSchema(item, propertySchema, `${pathLabel}.${key}`));
    }
    return errors;
  }
  if (typeof value !== schema.type || (schema.type === "number" && !Number.isFinite(value))) {
    return [`${pathLabel} must be a ${schema.type}, got ${schemaTypeName(value)}`];
  }
  return [];
}

function assertJsonSchema(value: unknown, schema: JsonSchema, filePath: string, schemaName: string): void {
  const errors = validateJsonSchema(value, schema, "$");
  if (errors.length > 0) {
    throw new Error(`${filePath} does not match ${schemaName} JSON schema:\n${errors.map((item) => `- ${item}`).join("\n")}`);
  }
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

function requiredObject(value: unknown, filePath: string, context: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`'${context}' must be an object in ${filePath}`);
  return { ...value };
}

function requiredNumber(value: unknown, filePath: string, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`'${context}' must be a finite number in ${filePath}`);
  }
  return value;
}

function rejectRawProviderLegacyKeys(obj: Record<string, unknown>, filePath: string, context: string): void {
  for (const key of ["name", "baseURL", "base_url", "apiKey", "api_key"]) {
    if (key in obj) throw new Error(`'${context}.${key}' is not supported in ${filePath}; use '${context}.id/options'`);
  }
}

function rejectRawModelLegacyKeys(obj: Record<string, unknown>, filePath: string, context: string): void {
  for (const key of ["name", "context", "input", "inputContext", "input_context", "maxInputTokens", "max_input_tokens", "output", "outputContext", "output_context", "maxOutputTokens", "max_output_tokens", "limit"]) {
    if (key in obj) throw new Error(`'${context}.${key}' is not supported in ${filePath}; use '${context}.id/limits'`);
  }
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

/**
 * Resolve the provider-connection-level options (transport markers, apiKey,
 * baseURL, headers, etc.) for the provider that the local config selects for a
 * given adapter type, returning them snake-normalized.
 *
 * This is the seam that lets the Responses WebSocket v2 transport markers
 * (`transport_mode` / `supports_websockets` / `websocket_url` /
 * `websocket_connect_timeout_seconds`) configured on a provider entry in
 * `llm-provider.json` reach the codex adapter's `providerOptions` even when the
 * runtime takes the plugin `config()` path (no resolvable model-ref override).
 *
 * Provider selection mirrors the runtime: it prefers the provider named by the
 * active preset's primary model (when that provider's adapter matches
 * `adapterType`), and otherwise falls back to the first catalog provider whose
 * adapter matches. Returns `{}` when no config is present or no matching
 * provider exists, so absent markers leave behavior unchanged (http_sse).
 */
export function resolveProviderConnectionDefaults(
  adapterType: "openai" | "anthropic" | "codex" | "claude" | "deepseek",
  workdir?: string,
): Record<string, unknown> {
  let catalog: LlmProviderCatalogConfig;
  try {
    // Mirror the runtime config loader: prefer the project `.eidolon` catalog,
    // then fall back to the home `.eidolon` catalog.
    const projectCatalog = workdir
      ? path.join(workdir, LLM_CONFIG_DIR_NAME, PROVIDER_CONFIG_FILE_NAME)
      : undefined;
    const catalogPath = projectCatalog && fs.existsSync(projectCatalog) ? projectCatalog : undefined;
    catalog = loadProviderCatalog(catalogPath);
  } catch {
    return {};
  }
  const matches = (adapter: string | undefined): boolean => {
    if (!adapter) return false;
    try {
      return normalizeAdapterName(adapter) === adapterType;
    } catch {
      return false;
    }
  };

  let provider: LlmProviderConfig | undefined;
  // Prefer the provider that the active preset's primary model selects.
  try {
    const present = loadPresentConfig({ workdir });
    const presetName = String(present.defaultPreset || "").trim();
    const primaryModel = present.presets[presetName]?.primary.model || "";
    const separatorIndex = primaryModel.indexOf("/");
    if (separatorIndex > 0) {
      const providerName = primaryModel.slice(0, separatorIndex);
      const candidate = catalog.providers.find((entry) => entry.name === providerName);
      if (candidate && matches(candidate.adapter)) provider = candidate;
    }
  } catch {
    // present config is optional; fall through to first matching provider
  }
  // Fallback: first catalog provider whose adapter matches the adapter type.
  provider ??= catalog.providers.find((entry) => matches(entry.adapter));
  if (!provider) return {};

  const options = { ...(provider.options ?? {}) };
  return extractProviderConnectionOptions(options);
}

const CODEX_TRANSPORT_MARKER_KEYS = [
  "transport_mode",
  "supports_websockets",
  "websocket_url",
  "websocket_connect_timeout_seconds",
] as const;

/**
 * Gap-fill Responses WebSocket transport markers onto a (possibly recovered)
 * model config from the CURRENT provider catalog, keyed by the session's actual
 * provider NAME — NOT by adapter, because a catalog can hold several
 * `openai-responses` providers and only the session's own provider's markers are
 * correct. Only the transport markers are copied, and only when absent, so a
 * recovered session whose persisted modelConfig predates the WS config picks up
 * `transport_mode` etc. while every other persisted per-session option (apiKey,
 * store, serviceTier, …) is left untouched. Provider has no markers -> no-op
 * (http_sse unchanged). Mutates `modelConfig.options` in place.
 */
export function refreshProviderTransportMarkers(
  modelConfig: { provider?: string; adapter?: string; options?: Record<string, unknown> } | null | undefined,
  workdir?: string,
): void {
  if (!modelConfig || !modelConfig.provider || !modelConfig.options) return;
  if (tryNormalizeAdapterName(modelConfig.adapter) !== "codex") return;
  let catalog: LlmProviderCatalogConfig;
  try {
    const projectCatalog = workdir
      ? path.join(workdir, LLM_CONFIG_DIR_NAME, PROVIDER_CONFIG_FILE_NAME)
      : undefined;
    const catalogPath = projectCatalog && fs.existsSync(projectCatalog) ? projectCatalog : undefined;
    catalog = loadProviderCatalog(catalogPath);
  } catch {
    return;
  }
  const provider = catalog.providers.find((entry) => entry.name === modelConfig.provider);
  if (!provider) return;
  const connection = extractProviderConnectionOptions(provider.options ?? {});
  for (const key of CODEX_TRANSPORT_MARKER_KEYS) {
    if (connection[key] != null && modelConfig.options[key] === undefined) {
      modelConfig.options[key] = connection[key];
    }
  }
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
  assertJsonSchema(raw, LLM_PROVIDER_JSON_SCHEMA, filePath, "llm-provider.json");
  if (!Array.isArray(raw.providers)) throw new Error(`'providers' must be a list in ${filePath}`);
  const providers: LlmProviderConfig[] = raw.providers.map((item, index) => {
    const context = `providers[${index}]`;
    if (!isObject(item)) throw new Error(`'${context}' must be an object in ${filePath}`);
    rejectRawProviderLegacyKeys(item, filePath, context);
    if (!Array.isArray(item.models)) throw new Error(`'${context}.models' must be a list in ${filePath}`);
    const providerOptions = requiredObject(item.options, filePath, `${context}.options`);
    const models: LlmProviderModelConfig[] = item.models.map((modelItem, modelIndex) => {
      const modelContext = `${context}.models[${modelIndex}]`;
      if (!isObject(modelItem)) throw new Error(`'${modelContext}' must be an object in ${filePath}`);
      rejectRawModelLegacyKeys(modelItem, filePath, modelContext);
      const limits = requiredObject(modelItem.limits, filePath, `${modelContext}.limits`);
      return {
        name: requiredString(modelItem, "id", filePath, modelContext),
        adapter: optionalString(modelItem.adapter, filePath, `${modelContext}.adapter`),
        context: requiredNumber(limits.context, filePath, `${modelContext}.limits.context`),
        output: requiredNumber(limits.output, filePath, `${modelContext}.limits.output`),
        reasoning: isObject(modelItem.reasoning) ? { effort: modelItem.reasoning.effort as any } : undefined,
        options: optionalObject(modelItem.options, filePath, `${modelContext}.options`),
      };
    });
    return {
      name: requiredString(item, "id", filePath, context),
      adapter: optionalString(item.adapter, filePath, `${context}.adapter`),
      baseURL: "",
      apiKey: "",
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
  assertJsonSchema(raw, AGENT_PRESENT_JSON_SCHEMA, filePath, "agent-present.json");
  const defaultPreset = presetOverride
    || optionalString(raw.default_preset ?? raw.defaultPreset ?? raw["default-preset"] ?? raw.preset, filePath, "default_preset")
    || "default";
  const presetsRaw = optionalObject(raw.presets, filePath, "presets");
  const presets: LlmPresentConfig["presets"] = {};
  for (const [presetName, presetValue] of Object.entries(presetsRaw)) {
    if (!isObject(presetValue)) throw new Error(`'presets.${presetName}' must be an object in ${filePath}`);
    const primaryRaw = optionalObject(presetValue.primary ?? presetValue.main ?? presetValue.default, filePath, `presets.${presetName}.primary`);
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
    options,
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

function assertKnownModelRef(modelRef: string, providerConfig: LLMProviderConfig): void {
  const modelString = String(modelRef || "").trim();
  const separatorIndex = modelString.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= modelString.length - 1) {
    throw new Error(`Invalid model reference format: ${modelRef}`);
  }
  const providerName = modelString.slice(0, separatorIndex);
  const modelName = modelString.slice(separatorIndex + 1);
  const provider = providerConfig.providers.find((entry) => entry.name === providerName);
  if (!provider) {
    throw new Error(`Provider not found: ${providerName}`);
  }
  if (!provider.models.some((entry) => entry.name === modelName)) {
    throw new Error(`Model not found under provider: ${modelRef}`);
  }
}

/**
 * Boolean membership check mirroring {@link assertKnownModelRef}: returns true
 * iff `modelRef` (a `provider/model` ref) names a provider that exists in the
 * current catalog AND a model that exists under that provider.
 *
 * NOTE: this intentionally does NOT use {@link flattenModelConfig}, which
 * synthesizes a zeroed config when the provider exists but the model was removed
 * — so staleness cannot be detected by null-checking the flattened result. The
 * membership check below inspects `provider.models` directly to avoid that trap.
 */
export function isModelRefResolvable(modelRef: string, providerConfig: LLMProviderConfig): boolean {
  const modelString = String(modelRef || "").trim();
  const separatorIndex = modelString.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= modelString.length - 1) {
    return false;
  }
  const providerName = modelString.slice(0, separatorIndex);
  const modelName = modelString.slice(separatorIndex + 1);
  const provider = providerConfig.providers.find((entry) => entry.name === providerName);
  if (!provider) {
    return false;
  }
  return provider.models.some((entry) => entry.name === modelName);
}

/**
 * Recovery-time predicate (requirement `recovery-model-config-validation`):
 * returns true iff a persisted actor modelConfig still selects a resolvable
 * model in the CURRENT providers catalog — i.e. its `provider` exists AND its
 * `model` exists under that provider. Returns false when the catalog is
 * unavailable or either field is missing, so callers fall back to the default
 * preset. A still-resolvable persisted model returns true and is preserved.
 */
export function isPersistedModelStillResolvable(
  modelConfig: Pick<LlmActorModelConfig, "provider" | "model"> | null | undefined,
  providerConfig: LLMProviderConfig | null | undefined,
): boolean {
  if (!providerConfig || !modelConfig) {
    return false;
  }
  const providerName = String(modelConfig.provider || "").trim();
  const modelName = String(modelConfig.model || "").trim();
  if (!providerName || !modelName) {
    return false;
  }
  return isModelRefResolvable(`${providerName}/${modelName}`, providerConfig);
}

export function resolveActorModelConfig(params: {
  agentKey: string;
  modelRef?: string;
  presetConfig?: AgentPresetConfig | null;
  providerConfig?: LLMProviderConfig | null;
  fallback?: LlmActorModelConfig;
  fallbackModelConfig?: LlmActorModelConfig;
  fallbackOverrideKeys?: (keyof LlmActorModelConfig)[];
  strictModelRef?: boolean;
  logger?: RuntimeLogFn;
}): LlmActorModelConfig {
  const fallback = params.fallback ?? params.fallbackModelConfig ?? {};
  if (!params.providerConfig) {
    if (params.strictModelRef && params.modelRef) {
      throw new Error("LLM provider config unavailable for explicit model selection");
    }
    return fallback;
  }
  const modelRef = params.modelRef ?? (
    params.presetConfig ? resolvePresetModelRef(params.presetConfig, params.agentKey, params.logger) : null
  );
  if (!modelRef) return fallback;
  if (params.strictModelRef) {
    assertKnownModelRef(modelRef, params.providerConfig);
  }
  const flattened = flattenModelConfig(modelRef, params.providerConfig, params.logger);
  if (!flattened) {
    if (params.strictModelRef) {
      throw new Error(`Failed to resolve explicit model selection: ${modelRef}`);
    }
    return fallback;
  }
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
    options: flattened.options,
  };
  for (const key of params.fallbackOverrideKeys ?? []) {
    if (fallback[key] !== undefined) {
      (resolved as Record<string, unknown>)[key] = fallback[key];
    }
  }
  return resolved;
}
