const OPENAI_COMPATIBLE_SCHEMA_UNSUPPORTED_KEYS = new Set(["allOf", "anyOf", "not", "oneOf"]);

function parseToolCallArguments(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === undefined || input === null) return "{}";
  try {
    return JSON.stringify(input);
  } catch {
    return "{}";
  }
}

function normalizeOpenAIToolCalls(message: any): any[] | undefined {
  const rawToolCalls = message?.tool_calls ?? message?.toolCalls ?? message?.rawToolCalls;
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) return undefined;
  const byId = new Map<string, any>();
  for (const toolCall of rawToolCalls) {
    const fn = toolCall?.function && typeof toolCall.function === "object" ? toolCall.function : null;
    const name = String(fn?.name ?? toolCall?.name ?? "");
    const args = fn ? fn.arguments : toolCall?.arguments ?? toolCall?.input ?? {};
    const id = String(toolCall?.id ?? "");
    if (!id) continue;
    const normalized = {
      id,
      type: "function",
      function: {
        name,
        arguments: parseToolCallArguments(args),
      },
    };
    const existing = byId.get(id);
    if (!existing || isMoreSpecificOpenAIToolCall(normalized, existing)) {
      byId.set(id, normalized);
    }
  }
  return byId.size ? Array.from(byId.values()) : undefined;
}

function isMoreSpecificOpenAIToolCall(candidate: any, current: any): boolean {
  const candidateName = String(candidate?.function?.name ?? "");
  const currentName = String(current?.function?.name ?? "");
  const candidateArgs = String(candidate?.function?.arguments ?? "");
  const currentArgs = String(current?.function?.arguments ?? "");
  const candidateLooksPlaceholder = candidateName === candidate.id && candidateArgs === "{}";
  const currentLooksPlaceholder = currentName === current.id && currentArgs === "{}";
  if (currentLooksPlaceholder && !candidateLooksPlaceholder) return true;
  if (candidateLooksPlaceholder && !currentLooksPlaceholder) return false;
  return candidateArgs.length > currentArgs.length;
}

function normalizeOpenAIToolCallId(message: any): string | undefined {
  const value = message?.tool_call_id ?? message?.toolCallId ?? message?.toolCallID;
  return typeof value === "string" && value ? value : undefined;
}

function normalizeOpenAIToolMessageContent(content: unknown): string | unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function hasOpenAIMessageContent(message: any): boolean {
  if (!message || !("content" in message)) return false;
  if (typeof message.content === "string") return message.content.length > 0;
  return message.content !== null && message.content !== undefined;
}

function hasOpenAIReasoningContent(message: any): boolean {
  return typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0;
}

function isPlaceholderOpenAIToolCall(toolCall: any): boolean {
  return String(toolCall?.function?.name ?? "") === String(toolCall?.id ?? "") && String(toolCall?.function?.arguments ?? "") === "{}";
}

export function stripOpenAICompatibleUnsupportedSchemaKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripOpenAICompatibleUnsupportedSchemaKeys(item));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (OPENAI_COMPATIBLE_SCHEMA_UNSUPPORTED_KEYS.has(key)) continue;
    output[key] = stripOpenAICompatibleUnsupportedSchemaKeys(entry);
  }
  return output;
}

function updatePendingToolCallIds(
  payload: any,
  pending: Map<string, true>,
  ordered: string[],
): void {
  if (payload.role === "assistant" && Array.isArray(payload.tool_calls)) {
    for (const toolCall of payload.tool_calls) {
      const id = toolCall?.id ? String(toolCall.id) : "";
      if (!id) continue;
      if (!pending.has(id)) ordered.push(id);
      pending.set(id, true);
    }
  }
  if (payload.role === "tool") {
    const id = payload.tool_call_id ? String(payload.tool_call_id) : "";
    if (id) pending.delete(id);
  }
}

export function findOpenAIReplaySafeMessagePrefix(messages: any[]): {
  safePrefixLength: number;
  danglingToolCallIds: string[];
} {
  const pending = new Map<string, true>();
  const ordered: string[] = [];
  let safePrefixLength = 0;
  messages.forEach((message, index) => {
    updatePendingToolCallIds(message, pending, ordered);
    if (pending.size === 0) safePrefixLength = index + 1;
  });
  return { safePrefixLength, danglingToolCallIds: ordered.filter((id) => pending.has(id)) };
}

export type OpenAIChatMessageNormalizationOptions = {
  preserveReasoningContent?: boolean;
};

export function normalizeOpenAIChatMessages(
  messages: any[],
  options: OpenAIChatMessageNormalizationOptions = {},
): any[] {
  const laterConcreteToolCallIds = new Set<string>();
  const normalized = messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    if (message.role === "tool") {
      const toolCallId = normalizeOpenAIToolCallId(message);
      const normalized: Record<string, unknown> = {
        role: "tool",
        content: normalizeOpenAIToolMessageContent(message.content),
      };
      if (toolCallId) normalized.tool_call_id = toolCallId;
      if (typeof message.name === "string" && message.name) normalized.name = message.name;
      return normalized;
    }
    if (message.role === "assistant") {
      const toolCalls = normalizeOpenAIToolCalls(message);
      const normalized: Record<string, unknown> = {
        ...message,
      };
      if (options.preserveReasoningContent) {
        const reasoningContent =
          typeof message.reasoning_content === "string"
            ? message.reasoning_content
            : typeof message.reasoningContent === "string"
              ? message.reasoningContent
              : undefined;
        if (reasoningContent) normalized.reasoning_content = reasoningContent;
      } else {
        delete normalized.reasoning_content;
      }
      if (normalized.reasoning_content && !("content" in normalized) && !toolCalls) {
        normalized.content = "";
      }
      delete normalized.reasoningContent;
      delete normalized.content_parts;
      delete normalized.toolCalls;
      delete normalized.rawToolCalls;
      delete normalized.rawToolCallsStr;
      delete normalized.toolCallId;
      delete normalized.tool_call_id;
      if (toolCalls) normalized.tool_calls = toolCalls;
      if (toolCalls) {
        for (const toolCall of toolCalls) {
          if (!isPlaceholderOpenAIToolCall(toolCall)) laterConcreteToolCallIds.add(String(toolCall.id));
        }
      }
      return normalized;
    }
    return { ...message };
  });
  const deduped = normalized.map((message) => {
    if (!message || message.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;
    const toolCalls = message.tool_calls.filter((toolCall: any) => {
      return !(isPlaceholderOpenAIToolCall(toolCall) && laterConcreteToolCallIds.has(String(toolCall.id)));
    });
    if (toolCalls.length === message.tool_calls.length) return message;
    const next = { ...message };
    if (toolCalls.length) {
      next.tool_calls = toolCalls;
    } else {
      delete next.tool_calls;
    }
    return next;
  });
  return repairOpenAIChatToolCallAdjacency(deduped);
}

function isOpenAIReplayableAssistantMessage(message: any): boolean {
  if (!message || message.role !== "assistant") return true;
  return hasOpenAIMessageContent(message) || hasOpenAIReasoningContent(message) || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
}

export function repairOpenAIChatToolCallAdjacency(messages: any[]): any[] {
  const repaired: any[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      index += 1;
      continue;
    }

    if (message.role === "tool") {
      index += 1;
      continue;
    }

    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      if (isOpenAIReplayableAssistantMessage(message)) repaired.push(message);
      index += 1;
      continue;
    }

    const toolMessages: any[] = [];
    let nextIndex = index + 1;
    while (nextIndex < messages.length && messages[nextIndex]?.role === "tool") {
      toolMessages.push(messages[nextIndex]);
      nextIndex += 1;
    }
    while (
      nextIndex + 1 < messages.length &&
      messages[nextIndex]?.role === "assistant" &&
      Array.isArray(messages[nextIndex]?.tool_calls) &&
      messages[nextIndex].tool_calls.length > 0 &&
      !hasOpenAIMessageContent(messages[nextIndex]) &&
      !hasOpenAIReasoningContent(messages[nextIndex]) &&
      messages[nextIndex + 1]?.role === "tool"
    ) {
      const duplicateToolCalls = messages[nextIndex].tool_calls;
      const duplicateToolCallIds = new Set(duplicateToolCalls.map((toolCall: any) => String(toolCall?.id ?? "")).filter(Boolean));
      const allDuplicateCallsWereDeclared = duplicateToolCallIds.size > 0
        && Array.from(duplicateToolCallIds).every((id) => message.tool_calls.some((toolCall: any) => String(toolCall?.id ?? "") === id));
      if (!allDuplicateCallsWereDeclared) break;
      while (nextIndex + 1 < messages.length && messages[nextIndex + 1]?.role === "tool") {
        toolMessages.push(messages[nextIndex + 1]);
        nextIndex += 1;
      }
      nextIndex += 1;
    }

    const toolMessagesById = new Map<string, any>();
    for (const toolMessage of toolMessages) {
      const toolCallId = normalizeOpenAIToolCallId(toolMessage);
      if (toolCallId && !toolMessagesById.has(toolCallId)) {
        toolMessagesById.set(toolCallId, toolMessage);
      }
    }

    const pairedToolCalls = message.tool_calls.filter((toolCall: any) => {
      const id = toolCall?.id ? String(toolCall.id) : "";
      return id && toolMessagesById.has(id);
    });

    if (pairedToolCalls.length > 0) {
      const nextMessage = { ...message, tool_calls: pairedToolCalls };
      repaired.push(nextMessage);
      for (const toolCall of pairedToolCalls) {
        const toolMessage = toolMessagesById.get(String(toolCall.id));
        if (toolMessage) repaired.push(toolMessage);
      }
    } else {
      const nextMessage = { ...message };
      delete nextMessage.tool_calls;
      if (String(nextMessage.content ?? "").trim()) {
        repaired.push(nextMessage);
      }
    }

    index = nextIndex;
  }
  return repaired;
}
