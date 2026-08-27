import type {
  ProviderDriverDefinition,
  ProviderDriverRequestParams,
  ProviderDriverStreamParams,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";
import type { ProviderToolSchemaProjectionAuthority } from "@cell/ai-organ-contract/llm/ProviderToolSchemaProjection";
import { OpenAICompletionsAdmittedFetchTransport } from "../OpenAICompletionsNodejsFetchAdapter";
import {
  deepSeekCompatibleChatEffectBundle,
  deepSeekOfficialChatEffectBundle,
} from "../ChatCompletionsEffectBundles";
import {
  extractProviderTransportRequestOptions,
  sanitizeProviderExtraBody,
  sanitizeProviderRequestBodyOptions,
} from "../ProviderOptions";
import { prepareProviderToolSchemaProjection } from "../tool-schema/ProviderRequestAdmission";

function effectBundleFor(params: ProviderDriverRequestParams) {
  const selected = params.chatCompletionsEffectBundle;
  if (
    selected !== deepSeekOfficialChatEffectBundle
    && selected !== deepSeekCompatibleChatEffectBundle
  ) {
    throw new Error("invalid_deepseek_chat_completions_effect_bundle");
  }
  return selected;
}

function prepareDeepSeekRequest(params: ProviderDriverRequestParams) {
  const effectBundle = effectBundleFor(params);
  const toolSchemaProjectionAuthority = prepareProviderToolSchemaProjection(
    effectBundle.toolSchemaProjector,
    params.tools,
  );
  return {
    contract: {
      method: "POST",
      body: effectBundle.projectRequest({
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
  const extraBody: Record<string, unknown> = {
    ...sanitizeProviderRequestBodyOptions(params.requestOptions),
    ...sanitizeProviderExtraBody(params.extraBody),
  };
  if (!Object.prototype.hasOwnProperty.call(extraBody, "stream_options")) {
    extraBody.stream_options = { include_usage: true };
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
      const effectBundle = effectBundleFor(params);
      const transport = new OpenAICompletionsAdmittedFetchTransport({
        apiKey: getString(params.connectionOptions, "api_key", "apikey"),
        effectBundle,
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
