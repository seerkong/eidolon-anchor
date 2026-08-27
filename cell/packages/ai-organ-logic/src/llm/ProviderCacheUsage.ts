import type { AiAgentVm } from "@cell/ai-core-contract/runtime/AiAgentVm";
import { ensureVmRxData } from "@cell/ai-core-logic/runtime/rxData";
import type { ProviderCacheUsageTokens } from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation";

function ownDataValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Normalize final provider-native usage without inventing missing hit/miss counters. */
export function normalizeProviderCacheUsageTokens(providerOutput: unknown): ProviderCacheUsageTokens | null {
  if (!providerOutput || typeof providerOutput !== "object" || Array.isArray(providerOutput)) return null;
  const outputPrototype = Object.getPrototypeOf(providerOutput);
  if (outputPrototype !== Object.prototype && outputPrototype !== null) return null;
  const usage = ownDataValue(providerOutput, "usage");
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const usagePrototype = Object.getPrototypeOf(usage);
  if (usagePrototype !== Object.prototype && usagePrototype !== null) return null;
  const promptTokens = ownDataValue(usage, "prompt_tokens");
  const completionTokens = ownDataValue(usage, "completion_tokens");
  const cacheHitTokens = ownDataValue(usage, "prompt_cache_hit_tokens");
  const cacheMissTokens = ownDataValue(usage, "prompt_cache_miss_tokens");
  for (const value of [promptTokens, completionTokens, cacheHitTokens, cacheMissTokens]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  }
  return Object.freeze({
    promptTokens: promptTokens as number,
    completionTokens: completionTokens as number,
    cacheHitTokens: cacheHitTokens as number,
    cacheMissTokens: cacheMissTokens as number,
  });
}

/** Project provider-native prefix-cache counters into the existing VM usage authority. */
export function recordProviderCacheUsage(vm: AiAgentVm, providerOutput: unknown): void {
  const usage = normalizeProviderCacheUsageTokens(providerOutput);
  if (!usage) return;
  const { privateRxData } = ensureVmRxData(vm);
  privateRxData.usage.set((previous) => ({
    ...previous,
    cache_read_tokens: previous.cache_read_tokens + usage.cacheHitTokens,
    // Compatibility field: provider-reported prefix misses/cache-fill input.
    cache_creation_tokens: previous.cache_creation_tokens + usage.cacheMissTokens,
  }));
}
