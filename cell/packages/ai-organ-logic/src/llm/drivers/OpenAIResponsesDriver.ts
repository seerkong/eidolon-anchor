import type {
  ProviderDriverDefinition,
  ProviderDriverRequestParams,
  ProviderDriverStreamParams,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";
import type { NormalizedChatCompletionsStreamBinding } from "@cell/ai-organ-contract/llm/ChatCompletionsEffectBundle";
import { OpenAIResponsesNodejsFetchLlmAdapter } from "../OpenAIResponsesNodejsFetchAdapter";
import { chatCompletionsStreamCoreBinding } from "../../stream/ChatCompletionsStreamCore";
import {
  buildOpenAIResponsesInputItems,
  buildOpenAIResponsesRequestBody,
} from "../ResponsesInputItems";

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

function withoutLegacyContinuation(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = { ...options };
  delete sanitized.previous_response_id;
  return sanitized;
}

export const openAIResponsesNormalizedStreamBinding: NormalizedChatCompletionsStreamBinding =
  Object.freeze({
    id: "openai-responses-normalized",
    streamReasoningPolicy: Object.freeze({
      reasoningContent: "ignore",
      reasoningDetails: "ignore",
      thinkTags: "content",
    }),
    streamCore: chatCompletionsStreamCoreBinding,
  });

export function buildOpenAIResponsesProviderDriver(): ProviderDriverDefinition {
  return {
    name: "openai-responses",
    normalizedChatCompletionsStreamBinding:
      openAIResponsesNormalizedStreamBinding,
    adapterNames: [
      "openai-responses",
      "openai_responses",
      "responses",
      "openai-response",
      "openai_response",
      "codex",
    ],
    buildRequest(params: ProviderDriverRequestParams) {
      const input = buildOpenAIResponsesInputItems(params.messages as any[]);
      return {
        method: "POST",
        body: buildOpenAIResponsesRequestBody({
          model: params.model,
          input,
          tools: params.tools,
          requestOptions: withoutLegacyContinuation(params.requestOptions),
          extraBody: params.extraBody,
        }),
      };
    },
    async createStream(params: ProviderDriverStreamParams) {
      const transportMode = getString(
        params.connectionOptions,
        "transport_mode",
      );
      const websocketUrl = getString(params.connectionOptions, "websocket_url");
      const supportsWebsockets = params.connectionOptions.supports_websockets;
      const websocketConnectTimeoutSeconds =
        params.connectionOptions.websocket_connect_timeout_seconds;
      const webSocketFactory = params.connectionOptions.webSocketFactory;
      const adapterExtraBody = withoutLegacyContinuation({
        ...params.requestOptions,
        ...params.extraBody,
      });
      const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
        apiKey: getString(params.connectionOptions, "api_key", "apikey"),
        baseUrl: getString(params.connectionOptions, "base_url", "baseurl"),
        providerOptions: {
          apiKey: getString(params.connectionOptions, "api_key", "apikey"),
          baseURL: getString(params.connectionOptions, "base_url", "baseurl"),
          headers: params.connectionOptions.default_headers as
            Record<string, string> | undefined,
          // Responses WebSocket v2 transport selection (P1). Default (absent
          // markers) -> http_sse, identical to today.
          ...(transportMode ? { transport_mode: transportMode } : {}),
          ...(supportsWebsockets !== undefined
            ? { supports_websockets: supportsWebsockets }
            : {}),
          ...(websocketUrl ? { websocket_url: websocketUrl } : {}),
          ...(websocketConnectTimeoutSeconds !== undefined
            ? {
                websocket_connect_timeout_seconds:
                  websocketConnectTimeoutSeconds,
              }
            : {}),
          ...(typeof webSocketFactory === "function"
            ? { webSocketFactory }
            : {}),
        },
        requestObserver: params.transportRequestObserver,
      });
      return adapter.createStream({
        model: params.model,
        messages: params.messages as any[],
        tools: params.tools as any[],
        extraBody: adapterExtraBody,
        providerRequestContext: params.providerRequestContext,
        signal: params.signal,
        // Correlation only; continuation is carried by providerRequestContext.
        sessionKey:
          params.sessionKey ||
          (params.runtime?.sessionId || params.runtime?.actorId
            ? `${params.runtime?.sessionId ?? ""}/${params.runtime?.actorId ?? ""}`
            : undefined),
      });
    },
  };
}
