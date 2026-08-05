import type {
  ChatCompletionsEffectBundle,
  ChatCompletionsRequestProjectionInput,
} from "@cell/ai-organ-contract/llm/ChatCompletionsEffectBundle";
import { chatCompletionsStreamCoreBinding } from "../stream/ChatCompletionsStreamCore";
import { normalizeOpenAIChatMessages } from "./OpenAIChatHelpers";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

function resolveChatCompletionsEndpoint(
  baseUrl: string | undefined,
  defaultBaseUrl: string,
  defaultBaseIsUnversioned: boolean,
): string {
  const resolved = (baseUrl || defaultBaseUrl).replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(resolved)) return resolved;
  if (
    /\/v\d+$/i.test(resolved) ||
    (defaultBaseIsUnversioned &&
      resolved.toLowerCase() === defaultBaseUrl.toLowerCase())
  ) {
    return `${resolved}/chat/completions`;
  }
  return `${resolved}/v1/chat/completions`;
}

function projectOpenAIMessages(messages: readonly unknown[]): unknown[] {
  return normalizeOpenAIChatMessages([...messages] as any[]).map((message) => {
    if (!message || typeof message !== "object") return message;
    const projected = { ...message };
    delete projected.reasoning_details;
    delete projected.reasoningDetails;
    return projected;
  });
}

function projectDeepSeekMessages(messages: readonly unknown[]): unknown[] {
  return normalizeOpenAIChatMessages([...messages] as any[], {
    preserveReasoningContent: true,
  });
}

function projectRequest(
  input: ChatCompletionsRequestProjectionInput,
  projectMessages: (messages: readonly unknown[]) => unknown[],
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    ...input.extraBody,
    model: input.model,
    messages: projectMessages(input.messages),
    stream: true,
  };
  if (input.tools && input.tools.length > 0) {
    request.tools = [...input.tools];
  } else {
    delete request.tools;
  }
  return request;
}

export const openAIOfficialChatEffectBundle: ChatCompletionsEffectBundle =
  Object.freeze({
    id: "openai-official-chat",
    resolveEndpoint(baseUrl?: string) {
      return resolveChatCompletionsEndpoint(baseUrl, OPENAI_BASE_URL, false);
    },
    projectMessages: projectOpenAIMessages,
    projectRequest(input) {
      return projectRequest(input, projectOpenAIMessages);
    },
    streamReasoningPolicy: Object.freeze({
      reasoningContent: "ignore",
      reasoningDetails: "ignore",
      thinkTags: "content",
    }),
    streamCore: chatCompletionsStreamCoreBinding,
  });

export const deepSeekOfficialChatEffectBundle: ChatCompletionsEffectBundle =
  Object.freeze({
    id: "deepseek-official-chat",
    resolveEndpoint(baseUrl?: string) {
      return resolveChatCompletionsEndpoint(baseUrl, DEEPSEEK_BASE_URL, true);
    },
    projectMessages: projectDeepSeekMessages,
    projectRequest(input) {
      return projectRequest(input, projectDeepSeekMessages);
    },
    streamReasoningPolicy: Object.freeze({
      reasoningContent: "preserve",
      reasoningDetails: "ignore",
      thinkTags: "reasoning",
    }),
    streamCore: chatCompletionsStreamCoreBinding,
  });
