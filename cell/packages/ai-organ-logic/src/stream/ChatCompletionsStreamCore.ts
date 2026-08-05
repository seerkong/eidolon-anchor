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
  thinkBuffer: string;
  reasoningContentBuffer: string;
  reasoningContentObserved: boolean;
  contentBuffer: string;
  reasoningDetails: any[];
  pending: string;
  inThink: boolean;
  lastChunkFingerprint: string | null;
};

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
    thinkBuffer: "",
    reasoningContentBuffer: "",
    reasoningContentObserved: false,
    contentBuffer: "",
    reasoningDetails: [],
    pending: "",
    inThink: false,
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
    for (const toolCall of delta.tool_calls) {
      reduceToolCallDelta(state, toolCall);
    }
  }
  return { state, events };
}

export function buildChatCompletionsAssistantMessage(
  state: ChatCompletionsStreamState,
): any {
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
  return Object.values(state.toolCalls).map((toolCall) => ({
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
  delta: any,
  chunk: any,
): string | null {
  const normalized = {
    reasoning_details:
      firstNonEmptyArray(
        chunk?.reasoning_details,
        choice?.reasoning_details,
        delta?.reasoning_details,
      ) ?? undefined,
    reasoning_content:
      delta?.reasoning_content ??
      choice?.reasoning_content ??
      chunk?.reasoning_content ??
      undefined,
    content: delta?.content ?? undefined,
    tool_calls:
      Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0
        ? delta.tool_calls
        : undefined,
    finish_reason: choice?.finish_reason ?? undefined,
  };
  if (Object.values(normalized).every((value) => value === undefined)) {
    return null;
  }
  try {
    return JSON.stringify(normalized);
  } catch {
    return null;
  }
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
): void {
  const index = Number(delta?.index ?? 0);
  const current = state.toolCalls[index] ?? new ToolCallAccumulator();
  const next = { ...current };
  if (delta?.id) next.id = String(delta.id);
  if (delta?.type) next.type = String(delta.type);
  if (delta?.function) {
    if (delta.function.name) next.functionName += String(delta.function.name);
    if (delta.function.arguments) {
      next.functionArguments += String(delta.function.arguments);
    }
  }
  state.toolCalls[index] = next;
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
