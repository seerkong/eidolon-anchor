import fs from "fs";
import os from "os";
import path from "path";
import type {
  LlmProviderCatalogConfig,
  LlmProviderConfig,
  LlmPresentConfig,
} from "@cell/ai-organ-contract/llm/ProviderConfig";
import {
  LLM_CONFIG_DIR_NAME,
  PROVIDER_CONFIG_FILE_NAME,
  PRESENT_CONFIG_FILE_NAME,
  isObject,
  normalizeAdapterName,
  tryNormalizeAdapterName,
  parseProviderCatalogRaw,
  parsePresentConfigRaw,
} from "@cell/ai-core-logic/llm/ModelConfigRules";
import { extractProviderConnectionOptions } from "@cell/ai-core-logic/llm/ProviderOptions";

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
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

export function loadProviderCatalog(configPath?: string): LlmProviderCatalogConfig {
  const filePath = normalizeConfigPath(configPath) ?? defaultProviderConfigPath();
  const raw = readJsonObjectIfExists(filePath);
  if (raw) return parseProviderCatalogRaw(raw, filePath);
  if (configPath) throw new Error(`LLM config file not found: ${filePath}`);
  throw new Error(`LLM config file not found: ${filePath}`);
}

export function loadPresentConfig(params: { configPath?: string; workdir?: string; presetOverride?: string } = {}): LlmPresentConfig {
  const filePath = normalizeConfigPath(params.configPath) ?? defaultPresentConfigPath(params.workdir);
  return parsePresentConfigRaw(readJsonObject(filePath), filePath, params.presetOverride);
}
