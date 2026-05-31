import type { ProviderDriverDefinition, ProviderDriverRequestParams, ProviderDriverStreamParams } from "@cell/ai-organ-contract/llm/ProviderRuntime";
import { OpenAICompletionsNodejsFetchLlmAdapter } from "../OpenAICompletionsNodejsFetchAdapter";
import { resolveDeepSeekModelCapabilities } from "../DeepSeekModelCapabilities";
import { sanitizeProviderExtraBody } from "../ProviderOptions";

function getString(options: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function buildDeepSeekExtraBody(params: ProviderDriverRequestParams): Record<string, unknown> {
  const capabilities = resolveDeepSeekModelCapabilities({
    providerId: params.runtime.providerId,
    adapter: params.runtime.adapterName,
    modelId: params.model,
  });
  const extraBody: Record<string, unknown> = {
    ...params.requestOptions,
    ...sanitizeProviderExtraBody(params.extraBody),
  };
  if (capabilities) {
    extraBody.model_capabilities ??= capabilities;
    extraBody.cache_profile ??= {
      provider_family: "deepseek",
      stable_prefix: true,
      provider_managed_prefix_cache: true,
      prefer_late_compaction: true,
    };
  }
  return extraBody;
}

export function buildDeepSeekProviderDriver(): ProviderDriverDefinition {
  return {
    name: "deepseek-chat",
    adapterNames: ["deepseek", "deepseek-chat", "deepseek_chat", "deep_seek", "deep-seek"],
    buildRequest(params: ProviderDriverRequestParams) {
      return {
        method: "POST",
        body: {
          model: params.model,
          messages: params.messages,
          tools: params.tools,
          stream: true,
          ...buildDeepSeekExtraBody(params),
        },
      };
    },
    async createStream(params: ProviderDriverStreamParams) {
      const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
        apiKey: getString(params.connectionOptions, "api_key", "apikey"),
        baseUrl: getString(params.connectionOptions, "base_url", "baseurl") || "https://api.deepseek.com/v1",
        providerOptions: {
          apiKey: getString(params.connectionOptions, "api_key", "apikey"),
          baseURL: getString(params.connectionOptions, "base_url", "baseurl") || "https://api.deepseek.com/v1",
          headers: params.connectionOptions.default_headers as Record<string, string> | undefined,
        },
      });
      return adapter.createStream({
        model: params.model,
        messages: params.messages as any[],
        tools: params.tools as any[],
        extraBody: buildDeepSeekExtraBody(params),
        signal: params.signal,
      });
    },
  };
}
