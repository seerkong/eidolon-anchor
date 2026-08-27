import type {
  ChatCompletionsEffectBundle,
  ChatCompletionsRequestProjectionInput,
} from "@cell/ai-organ-contract/llm/ChatCompletionsEffectBundle";
import { chatCompletionsStreamCoreBinding } from "../stream/ChatCompletionsStreamCore";
import { normalizeOpenAIChatMessages } from "./OpenAIChatHelpers";
import {
  deepSeekChatToolSchemaProjector,
  openAIChatToolSchemaProjector,
} from "./tool-schema/ChatToolSchemaProjectors";
import {
  assertProviderToolSchemaProtocol,
  prepareProviderToolSchemaProjection,
  readProviderToolSchemaProjection,
} from "./tool-schema/ProviderRequestAdmission";
import type { ProviderToolSchemaProjector } from "@cell/ai-organ-contract/llm/ProviderToolSchemaProjection";

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
  toolSchemaProjector: ProviderToolSchemaProjector,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    ...input.extraBody,
    model: input.model,
    messages: projectMessages(input.messages),
    stream: true,
  };
  const authority = input.toolSchemaProjectionAuthority
    ?? prepareProviderToolSchemaProjection(toolSchemaProjector, input.tools ?? []);
  const projection = readProviderToolSchemaProjection(authority);
  assertProviderToolSchemaProtocol(projection.protocol, toolSchemaProjector.protocol);
  const projectedTools = projection.tools;
  if (projectedTools.length > 0) {
    request.tools = projectedTools;
  } else {
    delete request.tools;
  }
  return request;
}

export const openAIOfficialChatEffectBundle: ChatCompletionsEffectBundle =
  Object.freeze({
    id: "openai-official-chat",
    toolSchemaProjector: openAIChatToolSchemaProjector,
    resolveEndpoint(baseUrl?: string) {
      return resolveChatCompletionsEndpoint(baseUrl, OPENAI_BASE_URL, false);
    },
    projectMessages: projectOpenAIMessages,
    projectRequest(input) {
      return projectRequest(input, projectOpenAIMessages, openAIChatToolSchemaProjector);
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
    toolSchemaProjector: deepSeekChatToolSchemaProjector,
    resolveEndpoint(baseUrl?: string) {
      return resolveChatCompletionsEndpoint(baseUrl, DEEPSEEK_BASE_URL, true);
    },
    projectMessages: projectDeepSeekMessages,
    projectRequest(input) {
      return projectRequest(input, projectDeepSeekMessages, deepSeekChatToolSchemaProjector);
    },
    streamReasoningPolicy: Object.freeze({
      reasoningContent: "preserve",
      reasoningDetails: "ignore",
      thinkTags: "reasoning",
    }),
    streamCore: chatCompletionsStreamCoreBinding,
  });

export const deepSeekCompatibleChatEffectBundle: ChatCompletionsEffectBundle =
  Object.freeze({
    ...deepSeekOfficialChatEffectBundle,
    id: "deepseek-compatible-chat",
  });
