import type { LlmModelCapabilities } from "@cell/ai-core-contract/LlmTypes";
import type { ProviderModelReasoningConfig } from "@cell/ai-organ-contract/llm/ProviderConfig";

export const LEGACY_DEEPSEEK_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const DEEPSEEK_COMPACTION_THRESHOLD_PERCENT = 80;

function deepseekContextWindowHint(modelLower: string): number | undefined {
  const matches = modelLower.matchAll(/(^|[^a-z0-9])(\d{1,4})k([^a-z0-9]|$)/g);
  for (const match of matches) {
    const kiloTokens = Number(match[2]);
    if (Number.isFinite(kiloTokens) && kiloTokens >= 8 && kiloTokens <= 1024) {
      return kiloTokens * 1000;
    }
  }
  return undefined;
}

export function isDeepSeekModelRef(providerId?: string | null, adapter?: string | null, modelId?: string | null): boolean {
  const combined = `${providerId ?? ""}/${adapter ?? ""}/${modelId ?? ""}`.toLowerCase();
  return combined.includes("deepseek") || combined.includes("deep_seek");
}

export function contextWindowForDeepSeekModel(modelId: string): number {
  const lower = String(modelId || "").toLowerCase();
  return deepseekContextWindowHint(lower)
    ?? (lower.includes("v4") ? DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS : LEGACY_DEEPSEEK_CONTEXT_WINDOW_TOKENS);
}

export function compactionThresholdForDeepSeekModel(modelId: string): number {
  return Math.floor((contextWindowForDeepSeekModel(modelId) * DEEPSEEK_COMPACTION_THRESHOLD_PERCENT) / 100);
}

export function resolveDeepSeekReasoningEffort(
  modelId: string,
  configured?: ProviderModelReasoningConfig["effort"],
): ProviderModelReasoningConfig["effort"] | undefined {
  if (configured) return configured;
  const lower = String(modelId || "").toLowerCase();
  if (lower.includes("reasoner") || lower.includes("r1")) return "high";
  return undefined;
}

export function resolveDeepSeekModelCapabilities(params: {
  providerId?: string | null;
  adapter?: string | null;
  modelId: string;
  outputLimit?: number;
  reasoningEffort?: ProviderModelReasoningConfig["effort"];
}): LlmModelCapabilities | undefined {
  if (!isDeepSeekModelRef(params.providerId, params.adapter, params.modelId)) return undefined;
  const contextWindow = contextWindowForDeepSeekModel(params.modelId);
  const compactionThresholdTokens = compactionThresholdForDeepSeekModel(params.modelId);
  return {
    family: "deepseek",
    contextWindow,
    outputLimit: params.outputLimit,
    reasoningEffort: resolveDeepSeekReasoningEffort(params.modelId, params.reasoningEffort),
    cachePolicy: {
      stablePrefix: true,
      providerManagedPrefixCache: true,
      preferLateCompaction: true,
      compactionThresholdTokens,
    },
  };
}

