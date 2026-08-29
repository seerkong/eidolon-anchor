import type {
  ChatCompletionsStreamCoreContract,
  ChatCompletionsStreamReasoningPolicy,
} from "@cell/ai-organ-contract/llm/ChatCompletionsEffectBundle";

export type ChatCompletionsStreamEvent = {
  event: "think" | "content";
  data: string;
};

export class ToolCallAccumulator {
  id = "";
  type = "function";
  functionName = "";
  functionArguments = "";
}

export type ChatCompletionsStreamState = {
  toolCalls: Record<number, ToolCallAccumulator>;
  protocolFailures: ChatCompletionsProtocolFailure[];
  thinkBuffer: string;
  reasoningContentBuffer: string;
  reasoningContentObserved: boolean;
  contentBuffer: string;
  reasoningDetails: any[];
  pending: string;
  inThink: boolean;
  finishReason: string | null;
  lastChunkFingerprint: string | null;
};

export type ChatCompletionsProtocolFailure = {
  code: "ambiguous_tool_call_identity" | "invalid_tool_call_index" | "conflicting_tool_call_identity" | "invalid_tool_call_payload";
  message: string;
  delta?: unknown;
};

export class ChatCompletionsProtocolError extends Error {
  readonly code: ChatCompletionsProtocolFailure["code"];
  readonly failures: readonly ChatCompletionsProtocolFailure[];

  constructor(failures: readonly ChatCompletionsProtocolFailure[]) {
    const first = failures[0] ?? { code: "invalid_tool_call_payload" as const, message: "unknown protocol failure" };
    super(`${first.code}: ${first.message}`);
    this.name = "ChatCompletionsProtocolError";
    this.code = first.code;
    this.failures = failures;
  }
}

export class ChatCompletionsOutputTruncatedError extends Error {
  readonly code = "provider_output_truncated";

  constructor() {
    super("provider_output_truncated: chat completion ended with finish_reason=length");
    this.name = "ChatCompletionsOutputTruncatedError";
  }
}

export class ChatCompletionsReasoningOnlyError extends Error {
  readonly code = "provider_reasoning_only_response";

  constructor(finishReason: string | null) {
    super(`provider_reasoning_only_response: chat completion ended without content or tool calls (finish_reason=${finishReason ?? "unknown"})`);
    this.name = "ChatCompletionsReasoningOnlyError";
  }
}

export type ChatCompletionsStreamReduction = {
  state: ChatCompletionsStreamState;
  events: ChatCompletionsStreamEvent[];
};

export const chatCompletionsStreamCoreBinding: ChatCompletionsStreamCoreContract =
  Object.freeze({
    createState: createChatCompletionsStreamState,
    reduceChunk(state, chunk, policy) {
      return reduceChatCompletionsChunk(
        state as ChatCompletionsStreamState,
        chunk,
        policy,
      );
    },
    buildAssistantMessage(state) {
      return buildChatCompletionsAssistantMessage(
        state as ChatCompletionsStreamState,
      );
    },
  });

const DEFAULT_CHAT_COMPLETIONS_REASONING_POLICY: ChatCompletionsStreamReasoningPolicy = {
  reasoningContent: "preserve",
  reasoningDetails: "preserve",
  thinkTags: "reasoning",
};

export function createChatCompletionsStreamState(): ChatCompletionsStreamState {
  return {
    toolCalls: {},
    protocolFailures: [],
    thinkBuffer: "",
    reasoningContentBuffer: "",
    reasoningContentObserved: false,
    contentBuffer: "",
    reasoningDetails: [],
    pending: "",
    inThink: false,
    finishReason: null,
    lastChunkFingerprint: null,
  };
}

export function reduceChatCompletionsChunk(
  current: ChatCompletionsStreamState,
  chunk: any,
  reasoningPolicy: ChatCompletionsStreamReasoningPolicy =
    DEFAULT_CHAT_COMPLETIONS_REASONING_POLICY,
): ChatCompletionsStreamReduction {
  const state = cloneChatCompletionsStreamState(current);
  const events: ChatCompletionsStreamEvent[] = [];
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta || {};
  const fingerprint = fingerprintChatCompletionsChunk(choice, delta, chunk);
  if (fingerprint && fingerprint === state.lastChunkFingerprint) {
    return { state, events };
  }
  state.lastChunkFingerprint = fingerprint;
  const finishReason = normalizeChatCompletionsFinishReason(choice, chunk);
  if (finishReason) state.finishReason = finishReason;

  const content = normalizeChatCompletionsContent(delta.content);
  reduceReasoning(
    state,
    events,
    chunk,
    choice,
    delta,
    content,
    reasoningPolicy,
  );
  if (content) reduceContent(state, events, content, reasoningPolicy);
  if (Array.isArray(delta.tool_calls)) {
    for (const [ordinal, toolCall] of delta.tool_calls.entries()) {
      reduceToolCallDelta(state, toolCall, ordinal, delta.tool_calls.length);
    }
  }
  return { state, events };
}

export function normalizeChatCompletionsFinishReason(
  choice: unknown,
  chunk?: unknown,
): string | null {
  const choiceRecord = choice && typeof choice === "object"
    ? choice as Record<string, unknown>
    : {};
  const chunkRecord = chunk && typeof chunk === "object"
    ? chunk as Record<string, unknown>
    : {};
  const candidate = choiceRecord.finish_reason
    ?? choiceRecord.finishReason
    ?? choiceRecord.stop_reason
    ?? choiceRecord.stopReason
    ?? chunkRecord.finish_reason
    ?? chunkRecord.finishReason
    ?? chunkRecord.stop_reason
    ?? chunkRecord.stopReason;
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const normalized = candidate.trim().toLowerCase();
  if (normalized === "max_tokens" || normalized === "max_output_tokens") return "length";
  return normalized;
}

export function buildChatCompletionsAssistantMessage(
  state: ChatCompletionsStreamState,
): any {
  if (state.finishReason === "length") {
    throw new ChatCompletionsOutputTruncatedError();
  }
  if (!state.contentBuffer.trim()
    && Object.keys(state.toolCalls).length === 0
    && state.reasoningContentBuffer.trim()) {
    throw new ChatCompletionsReasoningOnlyError(state.finishReason);
  }
  const message: any = {
    role: "assistant",
    content: state.contentBuffer || null,
  };
  const toolCalls = buildChatCompletionsToolCalls(state);
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (state.reasoningContentObserved) {
    message.reasoning_content = state.reasoningContentBuffer;
  } else if (state.thinkBuffer) {
    message.reasoning_content = state.thinkBuffer;
  }
  if (state.reasoningDetails.length > 0) {
    message.reasoning_details = [...state.reasoningDetails];
  }
  return message;
}

export function buildChatCompletionsToolCalls(
  state: ChatCompletionsStreamState,
): any[] {
  const failures = [...(state.protocolFailures ?? [])];
  for (const [index, toolCall] of orderedToolCallEntries(state)) {
    if (!toolCall.id || !toolCall.functionName) {
      failures.push({
        code: "invalid_tool_call_payload",
        message: `tool call ${index} is missing id or function name`,
      });
    }
    if (toolCall.functionArguments) {
      try {
        JSON.parse(toolCall.functionArguments);
      } catch {
        failures.push({
          code: "invalid_tool_call_payload",
          message: `tool call ${toolCall.id || index} has invalid JSON arguments`,
        });
      }
    }
  }
  if (failures.length) throw new ChatCompletionsProtocolError(failures);
  return orderedToolCallEntries(state).map(([, toolCall]) => ({
    id: toolCall.id,
    type: toolCall.type,
    function: {
      name: toolCall.functionName,
      arguments: toolCall.functionArguments,
    },
  }));
}

export function normalizeChatCompletionsContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : String(part?.text ?? ""),
      )
      .join("");
  }
  if (content === null || content === undefined) return "";
  return String(content);
}

export function fingerprintChatCompletionsChunk(
  choice: any,
  _delta: any,
  chunk: any,
): string | null {
  // Equal adjacent deltas are not duplicates: token streams may legitimately
  // emit the same fragment twice (for example the two closing braces of a
  // nested JSON tool argument). Deduplicate only when the provider supplies an
  // explicit per-event identity; the standard completion `id` is shared by all
  // chunks and therefore cannot serve as an event identity.
  const eventId = chunk?.event_id ?? choice?.event_id;
  if ((typeof eventId !== "string" && typeof eventId !== "number") || String(eventId).length === 0) {
    return null;
  }
  const completionId = typeof chunk?.id === "string" ? chunk.id : "";
  return `${completionId}:${String(eventId)}`;
}

function cloneChatCompletionsStreamState(
  state: ChatCompletionsStreamState,
): ChatCompletionsStreamState {
  return {
    ...state,
    toolCalls: Object.fromEntries(
      Object.entries(state.toolCalls).map(([index, toolCall]) => [
        index,
        { ...toolCall },
      ]),
    ),
    protocolFailures: [...(state.protocolFailures ?? [])],
    reasoningDetails: [...state.reasoningDetails],
  };
}

function reduceReasoning(
  state: ChatCompletionsStreamState,
  events: ChatCompletionsStreamEvent[],
  chunk: any,
  choice: any,
  delta: any,
  contentText: string,
  policy: ChatCompletionsStreamReasoningPolicy,
): void {
  if (policy.reasoningDetails === "preserve") {
    const reasoningDetails = [
      ...(Array.isArray(chunk?.reasoning_details) ? chunk.reasoning_details : []),
      ...(Array.isArray(choice?.reasoning_details) ? choice.reasoning_details : []),
      ...(Array.isArray(delta?.reasoning_details) ? delta.reasoning_details : []),
    ];
    for (const detail of reasoningDetails) {
      if (!detail || typeof detail !== "object" || !("text" in detail)) continue;
      const text = String(detail.text ?? "");
      if (!text) continue;
      state.reasoningDetails.push(detail);
      state.thinkBuffer += text;
      events.push({ event: "think", data: text });
    }
  }

  if (policy.reasoningContent === "ignore") return;
  const sources = [delta, choice, chunk];
  const observed = sources.some(
    (source) =>
      source && typeof source === "object" && "reasoning_content" in source,
  );
  const reasoning = normalizeChatCompletionsContent(
    delta?.reasoning_content ??
      choice?.reasoning_content ??
      chunk?.reasoning_content,
  );
  if (observed) {
    state.reasoningContentObserved = true;
    state.reasoningContentBuffer += reasoning;
  }
  if (reasoning && reasoning !== contentText) {
    state.thinkBuffer += reasoning;
    events.push({ event: "think", data: reasoning });
  }
}

function reduceContent(
  state: ChatCompletionsStreamState,
  events: ChatCompletionsStreamEvent[],
  content: string,
  policy: ChatCompletionsStreamReasoningPolicy,
): void {
  if (policy.thinkTags === "content") {
    state.contentBuffer += content;
    events.push({ event: "content", data: content });
    return;
  }
  const reduced = splitThinkSegments(state.pending, state.inThink, content);
  state.pending = reduced.pending;
  state.inThink = reduced.inThink;
  for (const segment of reduced.segments) {
    if (!segment.text) continue;
    if (segment.isThink) {
      state.thinkBuffer += segment.text;
      events.push({ event: "think", data: segment.text });
    } else {
      state.contentBuffer += segment.text;
      events.push({ event: "content", data: segment.text });
    }
  }
}

function reduceToolCallDelta(
  state: ChatCompletionsStreamState,
  delta: any,
  ordinal: number,
  batchSize: number,
): void {
  const index = resolveToolCallIndex(state, delta, ordinal, batchSize);
  if (index === null) return;
  const current = state.toolCalls[index] ?? new ToolCallAccumulator();
  const next = { ...current };
  if (delta?.id) {
    const id = String(delta.id);
    if (next.id && next.id !== id) {
      state.protocolFailures.push({
        code: "conflicting_tool_call_identity",
        message: `tool call index ${index} changed id from ${next.id} to ${id}`,
        delta,
      });
      return;
    }
    next.id = id;
  }
  if (delta?.type) next.type = String(delta.type);
  if (delta?.function) {
    if (delta.function.name) {
      const name = String(delta.function.name);
      if (!next.functionName) next.functionName = name;
      else if (next.functionName !== name) next.functionName += name;
    }
    if (delta.function.arguments) {
      next.functionArguments += String(delta.function.arguments);
    }
  }
  state.toolCalls[index] = next;
}

function orderedToolCallEntries(state: ChatCompletionsStreamState): Array<[number, ToolCallAccumulator]> {
  return Object.entries(state.toolCalls)
    .map(([index, value]) => [Number(index), value] as [number, ToolCallAccumulator])
    .sort(([left], [right]) => left - right);
}

function nextToolCallIndex(state: ChatCompletionsStreamState): number {
  const indices = orderedToolCallEntries(state).map(([index]) => index);
  return indices.length ? Math.max(...indices) + 1 : 0;
}

function resolveToolCallIndex(
  state: ChatCompletionsStreamState,
  delta: any,
  ordinal: number,
  batchSize: number,
): number | null {
  if (delta?.index !== undefined && delta?.index !== null) {
    const explicit = Number(delta.index);
    if (Number.isInteger(explicit) && explicit >= 0) return explicit;
    state.protocolFailures.push({
      code: "invalid_tool_call_index",
      message: `tool call index must be a non-negative integer, received ${String(delta.index)}`,
      delta,
    });
    return null;
  }

  const id = typeof delta?.id === "string" && delta.id ? delta.id : undefined;
  if (id) {
    const existing = orderedToolCallEntries(state).find(([, toolCall]) => toolCall.id === id);
    return existing?.[0] ?? nextToolCallIndex(state);
  }

  const ordered = orderedToolCallEntries(state);
  if (batchSize > 1 && ordinal < ordered.length) return ordered[ordinal]![0];
  if (ordered.length === 1) return ordered[0]![0];

  state.protocolFailures.push({
    code: "ambiguous_tool_call_identity",
    message: ordered.length === 0
      ? "tool call delta omitted both index and id before any call identity was established"
      : `tool call delta omitted both index and id while ${ordered.length} calls were active`,
    delta,
  });
  return null;
}

function splitThinkSegments(
  pending: string,
  initialInThink: boolean,
  chunk: string,
): {
  pending: string;
  inThink: boolean;
  segments: Array<{ text: string; isThink: boolean }>;
} {
  let buffer = pending + chunk;
  let inThink = initialInThink;
  let nextPending = "";
  const segments: Array<{ text: string; isThink: boolean }> = [];
  while (buffer.length > 0) {
    if (inThink) {
      const endIndex = buffer.indexOf("</think>");
      if (endIndex === -1) {
        const tail = splitTagTail(buffer);
        if (tail.emit) segments.push({ text: tail.emit, isThink: true });
        nextPending = tail.keep;
        break;
      }
      const text = buffer.slice(0, endIndex);
      if (text) segments.push({ text, isThink: true });
      buffer = buffer.slice(endIndex + "</think>".length);
      inThink = false;
      continue;
    }
    const startIndex = buffer.indexOf("<think>");
    if (startIndex === -1) {
      const tail = splitTagTail(buffer);
      if (tail.emit) segments.push({ text: tail.emit, isThink: false });
      nextPending = tail.keep;
      break;
    }
    const text = buffer.slice(0, startIndex);
    if (text) segments.push({ text, isThink: false });
    buffer = buffer.slice(startIndex + "<think>".length);
    inThink = true;
  }
  return { pending: nextPending, inThink, segments };
}

function splitTagTail(text: string): { emit: string; keep: string } {
  const tokens = ["<think>", "</think>"];
  let keep = "";
  for (let length = 1; length < Math.min(text.length + 1, 8); length += 1) {
    const tail = text.slice(-length);
    if (tokens.some((token) => token.startsWith(tail))) keep = tail;
  }
  if (!keep) return { emit: text, keep: "" };
  return { emit: text.slice(0, -keep.length), keep };
}

function firstNonEmptyArray(...values: unknown[]): unknown[] | undefined {
  return values.find(
    (value): value is unknown[] => Array.isArray(value) && value.length > 0,
  );
}
