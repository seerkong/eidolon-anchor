import type {
  ProviderDriverDefinition,
  ProviderDriverRequestParams,
  ProviderDriverStreamParams,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";
import type { ProviderToolSchemaProjectionAuthority } from "@cell/ai-organ-contract/llm/ProviderToolSchemaProjection";
import { OpenAICompletionsAdmittedFetchTransport } from "../OpenAICompletionsNodejsFetchAdapter";
import { deepSeekOfficialChatEffectBundle } from "../ChatCompletionsEffectBundles";
import { resolveDeepSeekModelCapabilities } from "../DeepSeekModelCapabilities";
import {
  extractProviderTransportRequestOptions,
  sanitizeProviderExtraBody,
  sanitizeProviderRequestBodyOptions,
} from "../ProviderOptions";
import { prepareProviderToolSchemaProjection } from "../tool-schema/ProviderRequestAdmission";

function prepareDeepSeekRequest(params: ProviderDriverRequestParams) {
  const toolSchemaProjectionAuthority = prepareProviderToolSchemaProjection(
    deepSeekOfficialChatEffectBundle.toolSchemaProjector,
    params.tools,
  );
  return {
    contract: {
      method: "POST",
      body: deepSeekOfficialChatEffectBundle.projectRequest({
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        extraBody: buildDeepSeekExtraBody(params),
        toolSchemaProjectionAuthority,
      }),
    },
    toolSchemaProjectionAuthority,
  } as const;
}

function getString(
  options: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function buildDeepSeekExtraBody(
  params: ProviderDriverRequestParams,
): Record<string, unknown> {
  const capabilities = resolveDeepSeekModelCapabilities({
    providerId: params.runtime.providerId,
    adapter: params.runtime.adapterName,
    modelId: params.model,
  });
  const extraBody: Record<string, unknown> = {
    ...sanitizeProviderRequestBodyOptions(params.requestOptions),
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
    chatCompletionsEffectBundle: deepSeekOfficialChatEffectBundle,
    adapterNames: [
      "deepseek",
      "deepseek-chat",
      "deepseek_chat",
      "deep_seek",
      "deep-seek",
    ],
    buildRequest(params: ProviderDriverRequestParams) {
      return prepareDeepSeekRequest(params).contract;
    },
    prepareRequest: prepareDeepSeekRequest,
    async createStream(params: ProviderDriverStreamParams) {
      const transport = new OpenAICompletionsAdmittedFetchTransport({
        apiKey: getString(params.connectionOptions, "api_key", "apikey"),
        effectBundle: deepSeekOfficialChatEffectBundle,
        baseUrl:
          getString(params.connectionOptions, "base_url", "baseurl") ||
          "https://api.deepseek.com",
        providerOptions: {
          apiKey: getString(params.connectionOptions, "api_key", "apikey"),
          baseURL:
            getString(params.connectionOptions, "base_url", "baseurl") ||
            "https://api.deepseek.com",
          headers: params.connectionOptions.default_headers as
            Record<string, string> | undefined,
        },
        requestObserver: params.transportRequestObserver,
      });
      return transport.createStream({
        model: params.model,
        messages: params.messages as any[],
        extraBody: {
          ...buildDeepSeekExtraBody(params),
          ...extractProviderTransportRequestOptions(params.requestOptions),
        },
        signal: params.signal,
      }, params.toolSchemaProjectionAuthority as ProviderToolSchemaProjectionAuthority);
    },
  };
}
