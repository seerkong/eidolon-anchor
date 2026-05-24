import type { ProviderDriverDefinition, ProviderDriverRequestParams, ProviderDriverStreamParams } from "@cell/ai-organ-contract/llm/ProviderRuntime";
import { OpenAICompletionsNodejsFetchLlmAdapter } from "../OpenAICompletionsNodejsFetchAdapter";

function getString(options: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

export function buildOpenAIChatProviderDriver(): ProviderDriverDefinition {
  return {
    name: "openai-chat",
    adapterNames: ["openai-chat", "openai_chat", "openai", "openai-chat-completions", "openai_chat_completions"],
    buildRequest(params: ProviderDriverRequestParams) {
      return {
        method: "POST",
        body: {
          model: params.model,
          messages: params.messages,
          tools: params.tools,
          stream: true,
          ...params.requestOptions,
          ...params.extraBody,
        },
      };
    },
    async createStream(params: ProviderDriverStreamParams) {
      const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
        apiKey: getString(params.connectionOptions, "api_key", "apikey"),
        baseUrl: getString(params.connectionOptions, "base_url", "baseurl"),
        providerOptions: {
          apiKey: getString(params.connectionOptions, "api_key", "apikey"),
          baseURL: getString(params.connectionOptions, "base_url", "baseurl"),
          headers: params.connectionOptions.default_headers as Record<string, string> | undefined,
        },
      });
      return adapter.createStream({
        model: params.model,
        messages: params.messages as any[],
        tools: params.tools as any[],
        extraBody: { ...params.requestOptions, ...params.extraBody },
        signal: params.signal,
      });
    },
  };
}
