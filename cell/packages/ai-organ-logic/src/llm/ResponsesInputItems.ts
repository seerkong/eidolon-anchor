export type OpenAIResponsesInputItem =
  | { type: "message"; role: "user" | "assistant"; content: Array<{ type: "input_text" | "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export type OpenAIResponsesInputBuildResult = {
  input: OpenAIResponsesInputItem[];
  messageItems: OpenAIResponsesInputItem[];
  toolItems: OpenAIResponsesInputItem[];
  toolOutputItems: OpenAIResponsesInputItem[];
};

export type OpenAIResponsesAssistantReplayPayload = {
  content?: unknown;
  tool_calls?: Array<{ id?: string; name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }>;
  toolCalls?: Array<{ id?: string; name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }>;
};

function normalizeText(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : (part as any)?.text ?? "")).join("");
  }
  if (content === null || content === undefined) return "";
  return String(content);
}

function normalizeToolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function getToolCallId(message: any): string {
  const raw = message?.tool_call_id ?? message?.toolCallId ?? message?.toolCallID ?? "";
  return typeof raw === "string" ? raw : String(raw || "");
}

function collectTrailingToolMessages(messages: any[]): any[] {
  const trailing: any[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "tool") break;
    trailing.push(message);
  }
  trailing.reverse();
  return trailing;
}

function normalizeToolCall(toolCall: any): { id: string; name: string; arguments: string } | null {
  const id = toolCall?.id ? String(toolCall.id) : "";
  const name = toolCall?.function?.name ? String(toolCall.function.name) : toolCall?.name ? String(toolCall.name) : "";
  const rawArgs = toolCall?.function?.arguments ?? toolCall?.arguments;
  const args = typeof rawArgs === "string" ? rawArgs : rawArgs ? JSON.stringify(rawArgs) : "";
  if (!id) return null;
  return { id, name, arguments: args };
}

function findLatestAssistantToolCalls(messages: any[]): Map<string, { name: string; arguments: string }> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const toolCalls = message.tool_calls ?? message.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    const map = new Map<string, { name: string; arguments: string }>();
    for (const toolCall of toolCalls) {
      const normalized = normalizeToolCall(toolCall);
      if (normalized) map.set(normalized.id, { name: normalized.name, arguments: normalized.arguments });
    }
    return map;
  }
  return new Map();
}

export function buildOpenAIResponsesInputItems(messages: any[]): OpenAIResponsesInputBuildResult {
  const trailingToolMessages = collectTrailingToolMessages(messages);
  const toolCallMap = findLatestAssistantToolCalls(messages);
  const toolItems: OpenAIResponsesInputItem[] = [];
  const toolOutputItems: OpenAIResponsesInputItem[] = [];

  for (const message of trailingToolMessages) {
    const callId = getToolCallId(message);
    if (!callId) continue;
    const callInfo = toolCallMap.get(callId);
    if (callInfo?.name) {
      toolItems.push({ type: "function_call", call_id: callId, name: callInfo.name, arguments: callInfo.arguments || "" });
    }
    toolOutputItems.push({ type: "function_call_output", call_id: callId, output: normalizeToolOutput(message.content) });
  }

  const messageItems: OpenAIResponsesInputItem[] = [];
  const skipToolMessages = toolOutputItems.length > 0;
  for (const message of messages) {
    if (!message) continue;
    if (message.role === "system") continue;
    if (message.role === "tool") {
      if (skipToolMessages) continue;
      const content = normalizeToolOutput(message.content ?? "");
      if (!content.trim()) continue;
      messageItems.push({ type: "message", role: "user", content: [{ type: "input_text", text: content }] });
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      const content = normalizeText(message.content ?? "");
      if (!content.trim()) continue;
      messageItems.push({
        type: "message",
        role: message.role,
        content: [{ type: message.role === "user" ? "input_text" : "output_text", text: content }],
      });
    }
  }

  return { input: messageItems, messageItems, toolItems, toolOutputItems };
}

export function buildOpenAIResponsesToolFollowUpInputItems(
  input: OpenAIResponsesInputBuildResult,
): OpenAIResponsesInputItem[] {
  return input.toolItems.length ? [...input.toolItems, ...input.toolOutputItems] : [...input.toolOutputItems];
}

export function assistantReplayToOpenAIResponsesInputItems(
  payload: OpenAIResponsesAssistantReplayPayload,
): OpenAIResponsesInputItem[] {
  const items: OpenAIResponsesInputItem[] = [];
  const content = normalizeText(payload.content ?? "");
  if (content.trim()) {
    items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] });
  }
  const toolCalls = payload.tool_calls ?? payload.toolCalls ?? [];
  for (const toolCall of toolCalls) {
    const normalized = normalizeToolCall(toolCall);
    if (!normalized || !normalized.name) continue;
    items.push({ type: "function_call", call_id: normalized.id, name: normalized.name, arguments: normalized.arguments });
  }
  return items;
}

export function buildOpenAIResponsesInputItemsWithAssistantReplay(
  messages: any[],
  assistantReplay: OpenAIResponsesAssistantReplayPayload,
): OpenAIResponsesInputBuildResult & { assistantReplayItems: OpenAIResponsesInputItem[] } {
  const base = buildOpenAIResponsesInputItems(messages);
  const assistantReplayItems = assistantReplayToOpenAIResponsesInputItems(assistantReplay);
  return {
    ...base,
    input: [...base.input, ...assistantReplayItems],
    messageItems: [...base.messageItems, ...assistantReplayItems],
    assistantReplayItems,
  };
}

function toOpenAIResponsesTools(tools: any[]): Array<Record<string, unknown>> {
  return Array.isArray(tools)
    ? tools.map((tool) => ({
        type: "function",
        name: tool?.function?.name ?? tool?.name ?? "",
        description: tool?.function?.description ?? tool?.description,
        strict: false,
        parameters: tool?.function?.parameters ?? tool?.parameters ?? {},
      }))
    : [];
}

const INTERNAL_EXTRA_BODY_KEYS = new Set(["reasoning_split", "work_context", "prompt_plan"]);

function sanitizeOpenAIResponsesExtraBody(extraBody?: Record<string, unknown>): Record<string, unknown> {
  if (!extraBody || typeof extraBody !== "object") return {};
  return Object.fromEntries(
    Object.entries(extraBody).filter(([key, value]) => value !== undefined && !INTERNAL_EXTRA_BODY_KEYS.has(key)),
  );
}

export function buildOpenAIResponsesRequestBody(params: {
  model: string;
  input: OpenAIResponsesInputBuildResult;
  tools?: any[];
  requestOptions?: Record<string, unknown>;
  extraBody?: Record<string, unknown>;
  instructions?: string;
}): Record<string, unknown> {
  const toolSpecs = toOpenAIResponsesTools(params.tools ?? []);
  const extraBody = sanitizeOpenAIResponsesExtraBody(params.extraBody);
  const previousResponseId =
    typeof params.requestOptions?.previous_response_id === "string" ? params.requestOptions.previous_response_id : undefined;
  const hasToolOutputs = params.input.toolOutputItems.length > 0;
  const body: Record<string, unknown> = {
    model: params.model,
    input: params.input.input,
    stream: true,
    tools: toolSpecs,
    tool_choice: "auto",
    parallel_tool_calls: false,
    ...params.requestOptions,
    ...extraBody,
  };
  if (params.instructions) body.instructions = params.instructions;
  if (previousResponseId && hasToolOutputs) {
    body.previous_response_id = previousResponseId;
    body.input = buildOpenAIResponsesToolFollowUpInputItems(params.input);
  }
  return body;
}
