import type { LlmModelCapabilities } from "@cell/ai-core-contract/LlmTypes";
import type { ProviderModelReasoningConfig } from "@cell/ai-organ-contract/llm/ProviderConfig";

export function isDeepSeekModelRef(providerId?: string | null, adapter?: string | null, modelId?: string | null): boolean {
  const combined = `${providerId ?? ""}/${adapter ?? ""}/${modelId ?? ""}`.toLowerCase();
  return combined.includes("deepseek") || combined.includes("deep_seek");
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
  contextWindow?: number;
  outputLimit?: number;
  reasoningEffort?: ProviderModelReasoningConfig["effort"];
}): LlmModelCapabilities | undefined {
  if (!isDeepSeekModelRef(params.providerId, params.adapter, params.modelId)) return undefined;
  const reasoningEffort = resolveDeepSeekReasoningEffort(
    params.modelId,
    params.reasoningEffort,
  );
  return {
    family: "deepseek",
    ...(params.contextWindow !== undefined
      ? { contextWindow: params.contextWindow }
      : {}),
    ...(params.outputLimit !== undefined
      ? { outputLimit: params.outputLimit }
      : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    cachePolicy: {
      stablePrefix: true,
      providerManagedPrefixCache: true,
      preferLateCompaction: true,
    },
  };
}
