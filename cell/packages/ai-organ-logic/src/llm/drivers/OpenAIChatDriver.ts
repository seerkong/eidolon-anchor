import type {
  ProviderDriverDefinition,
  ProviderDriverRequestParams,
  ProviderDriverStreamParams,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";
import type { ProviderToolSchemaProjectionAuthority } from "@cell/ai-organ-contract/llm/ProviderToolSchemaProjection";
import { OpenAICompletionsAdmittedFetchTransport } from "../OpenAICompletionsNodejsFetchAdapter";
import { openAIOfficialChatEffectBundle } from "../ChatCompletionsEffectBundles";
import {
  extractProviderTransportRequestOptions,
  sanitizeProviderExtraBody,
  sanitizeProviderRequestBodyOptions,
} from "../ProviderOptions";
import { prepareProviderToolSchemaProjection } from "../tool-schema/ProviderRequestAdmission";

function prepareOpenAIChatRequest(params: ProviderDriverRequestParams) {
  const requestBodyOptions = sanitizeProviderRequestBodyOptions(params.requestOptions);
  const toolSchemaProjectionAuthority = prepareProviderToolSchemaProjection(
    openAIOfficialChatEffectBundle.toolSchemaProjector,
    params.tools,
  );
  return {
    contract: {
      method: "POST",
      body: openAIOfficialChatEffectBundle.projectRequest({
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        extraBody: {
          ...requestBodyOptions,
          ...sanitizeProviderExtraBody(params.extraBody),
        },
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

export function buildOpenAIChatProviderDriver(): ProviderDriverDefinition {
  return {
    name: "openai-chat",
    chatCompletionsEffectBundle: openAIOfficialChatEffectBundle,
    adapterNames: [
      "openai-chat",
      "openai_chat",
      "openai",
      "openai-chat-completions",
      "openai_chat_completions",
    ],
    buildRequest(params: ProviderDriverRequestParams) {
      return prepareOpenAIChatRequest(params).contract;
    },
    prepareRequest: prepareOpenAIChatRequest,
    async createStream(params: ProviderDriverStreamParams) {
      const transport = new OpenAICompletionsAdmittedFetchTransport({
        apiKey: getString(params.connectionOptions, "api_key", "apikey"),
        baseUrl: getString(params.connectionOptions, "base_url", "baseurl"),
        effectBundle: openAIOfficialChatEffectBundle,
        providerOptions: {
          apiKey: getString(params.connectionOptions, "api_key", "apikey"),
          baseURL: getString(params.connectionOptions, "base_url", "baseurl"),
          headers: params.connectionOptions.default_headers as
            Record<string, string> | undefined,
        },
        requestObserver: params.transportRequestObserver,
      });
      return transport.createStream({
        model: params.model,
        messages: params.messages as any[],
        extraBody: {
          ...sanitizeProviderRequestBodyOptions(params.requestOptions),
          ...extractProviderTransportRequestOptions(params.requestOptions),
          ...sanitizeProviderExtraBody(params.extraBody),
        },
        signal: params.signal,
      }, params.toolSchemaProjectionAuthority as ProviderToolSchemaProjectionAuthority);
    },
  };
}
