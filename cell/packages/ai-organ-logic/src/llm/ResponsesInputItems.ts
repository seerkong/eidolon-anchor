import type { InputContentPart } from "@shared/composer";
import { projectOpenAIResponsesUserContent } from "./CanonicalImageProjection";

export type OpenAIResponsesMessageContentPart =
  | { type: "input_text" | "output_text"; text: string }
  | { type: "input_image"; image_url: string };

export type OpenAIResponsesInputItem =
  | { type: "message"; role: "user" | "assistant"; content: OpenAIResponsesMessageContentPart[] }
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
  tool_calls?: Array<{
    id?: string;
    name?: string;
    input?: unknown;
    arguments?: unknown;
    function?: { name?: string; arguments?: unknown };
  }>;
  toolCalls?: Array<{
    id?: string;
    name?: string;
    input?: unknown;
    arguments?: unknown;
    function?: { name?: string; arguments?: unknown };
  }>;
};

function normalizeText(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : (part as any)?.text ?? "")).join("");
  }
  if (content === null || content === undefined) return "";
  return String(content);
}

export function extractOpenAIResponsesSystemTexts(
  messages: readonly any[],
): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || message.role !== "system") continue;
    const text = normalizeText(message.content).trim();
    if (text) texts.push(text);
  }
  return texts;
}

export function assembleOpenAIResponsesInstructions(params: {
  transportInstructions?: unknown;
  sandboxInstructions?: unknown;
  configuredInstructions?: unknown;
  materializedMessages?: readonly any[];
}): string {
  const sections = [
    normalizeText(params.transportInstructions).trim(),
    normalizeText(params.sandboxInstructions).trim(),
    normalizeText(params.configuredInstructions).trim(),
    ...extractOpenAIResponsesSystemTexts(params.materializedMessages ?? []),
  ];
  const seen = new Set<string>();
  const uniqueSections: string[] = [];
  for (const section of sections) {
    if (!section || seen.has(section)) continue;
    seen.add(section);
    uniqueSections.push(section);
  }
  return uniqueSections.join("\n\n");
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
  const rawArgs =
    toolCall?.function?.arguments !== undefined
      ? toolCall.function.arguments
      : toolCall?.arguments !== undefined
        ? toolCall.arguments
        : toolCall?.input;
  const args = typeof rawArgs === "string" ? rawArgs : rawArgs !== undefined ? JSON.stringify(rawArgs) : "";
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

function isMoreSpecificToolCall(
  candidate: { name: string; arguments: string },
  current: { name: string; arguments: string },
  id: string,
): boolean {
  const candidatePlaceholder = candidate.name === id && candidate.arguments === "{}";
  const currentPlaceholder = current.name === id && current.arguments === "{}";
  if (currentPlaceholder && !candidatePlaceholder) return true;
  if (candidatePlaceholder && !currentPlaceholder) return false;
  return candidate.arguments.length > current.arguments.length;
}

function collectCanonicalFunctionCalls(
  messages: any[],
): Array<{ id: string; name: string; arguments: string }> {
  const ordered: string[] = [];
  const byId = new Map<string, { name: string; arguments: string }>();
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    const rawToolCalls = message.tool_calls ?? message.toolCalls ?? [];
    if (!Array.isArray(rawToolCalls)) continue;
    for (const rawToolCall of rawToolCalls) {
      const normalized = normalizeToolCall(rawToolCall);
      if (!normalized) continue;
      const current = byId.get(normalized.id);
      if (!current) ordered.push(normalized.id);
      if (!current || isMoreSpecificToolCall(normalized, current, normalized.id)) {
        byId.set(normalized.id, {
          name: normalized.name,
          arguments: normalized.arguments,
        });
      }
    }
  }
  return ordered.flatMap((id) => {
    const call = byId.get(id);
    return call ? [{ id, ...call }] : [];
  });
}

export function buildOpenAIResponsesInputItems(messages: any[]): OpenAIResponsesInputBuildResult {
  const canonicalFunctionCalls = collectCanonicalFunctionCalls(messages);
  const toolCallMap = new Map(canonicalFunctionCalls.map((call) => [call.id, call]));
  const toolItems: OpenAIResponsesInputItem[] = [];
  const toolOutputItems: OpenAIResponsesInputItem[] = [];

  const messageItems: OpenAIResponsesInputItem[] = [];
  const emittedFunctionCallIds = new Set<string>();
  const orderedInput: OpenAIResponsesInputItem[] = [];
  for (const message of messages) {
    if (!message) continue;
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const callId = getToolCallId(message);
      const outputItem: OpenAIResponsesInputItem = {
        type: "function_call_output",
        call_id: callId,
        output: normalizeToolOutput(message.content),
      };
      toolOutputItems.push(outputItem);
      orderedInput.push(outputItem);
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      if (message.role === "user" && Array.isArray(message.content)) {
        const content = projectOpenAIResponsesUserContent(message.content as InputContentPart[]);
        if (!content.some((part) => part.type === "input_image" || part.text.trim())) continue;
        const item: OpenAIResponsesInputItem = { type: "message", role: "user", content };
        messageItems.push(item);
        orderedInput.push(item);
        continue;
      }
      const content = normalizeText(message.content ?? "");
      if (content.trim()) {
        const item: OpenAIResponsesInputItem = {
          type: "message",
          role: message.role,
          content: [{ type: message.role === "user" ? "input_text" : "output_text", text: content }],
        };
        messageItems.push(item);
        orderedInput.push(item);
      }
      if (message.role === "assistant") {
        const rawToolCalls = message.tool_calls ?? message.toolCalls ?? [];
        if (!Array.isArray(rawToolCalls)) continue;
        for (const rawToolCall of rawToolCalls) {
          const normalized = normalizeToolCall(rawToolCall);
          if (!normalized || emittedFunctionCallIds.has(normalized.id)) continue;
          const callInfo = toolCallMap.get(normalized.id) ?? normalized;
          const item: OpenAIResponsesInputItem = {
            type: "function_call",
            call_id: normalized.id,
            name: callInfo.name,
            arguments: callInfo.arguments || "",
          };
          toolItems.push(item);
          orderedInput.push(item);
          emittedFunctionCallIds.add(normalized.id);
        }
      }
    }
  }

  return { input: orderedInput, messageItems, toolItems, toolOutputItems };
}

export function buildOpenAIResponsesToolFollowUpInputItems(
  input: OpenAIResponsesInputBuildResult,
): OpenAIResponsesInputItem[] {
  return input.toolItems.length ? [...input.toolItems, ...input.toolOutputItems] : [...input.toolOutputItems];
}

/** Complete canonical Responses input, including a trailing tool-call pair. */
export function buildOpenAIResponsesFullInputItems(
  messages: any[],
): OpenAIResponsesInputItem[] {
  return [...buildOpenAIResponsesInputItems(messages).input];
}

/**
 * Items added after a checkpoint's canonical message frontier. Provider
 * output already owns the corresponding function_call, so a tool follow-up
 * contributes only function_call_output items.
 */
export function buildOpenAIResponsesIncrementalInputItems(
  messagesAfterFrontier: any[],
): OpenAIResponsesInputItem[] {
  const built = buildOpenAIResponsesInputItems(messagesAfterFrontier);
  return [...built.messageItems, ...built.toolOutputItems];
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

const INTERNAL_EXTRA_BODY_KEYS = new Set([
  "reasoning_split",
  "work_context",
  "prompt_plan",
  "previous_response_id",
]);

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
  const requestOptions = { ...params.requestOptions };
  delete requestOptions.previous_response_id;
  const extraBody = sanitizeOpenAIResponsesExtraBody(params.extraBody);
  const body: Record<string, unknown> = {
    model: params.model,
    input: params.input.input,
    stream: true,
    tools: toolSpecs,
    tool_choice: "auto",
    parallel_tool_calls: false,
    ...requestOptions,
    ...extraBody,
  };
  if (params.instructions) body.instructions = params.instructions;
  return body;
}
