import { AppendOnlyEventLog, createReducerProjection, type ReducerProjection } from "depa-data-graph-core";

import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { ChatMessage, ToolCall } from "@shared/composer";

export type MessageHistoryEvent = {
  stream: string;
  payload: string;
  startAt?: number;
  endAt?: number;
  agentKey: string;
  agentActorId: string;
};

export type CommittedHistoryMessageEvent = {
  agentKey: string;
  agentActorId: string;
  message: ChatMessage;
};

export function toHistoryEvent(ev: SemanticEvent): MessageHistoryEvent | null {
  const meta = {
    agentKey: ev.actor.actor_name || ev.actor.actor_id,
    agentActorId: ev.actor.actor_id,
    startAt: ev.trace.emitted_at,
    endAt: ev.trace.emitted_at,
  };

  switch (ev.event_type) {
    case "semantic_quote":
      return {
        stream: "quote",
        payload: ev.text,
        ...meta,
      };
    case "semantic_tool_call_planned":
      return {
        stream: "tool_call",
        payload: JSON.stringify({
          type: ev.tool_call.call_kind === "xml_tag" ? "code" : "json",
          source: ev.tool_call.call_kind === "xml_tag" ? "content" : "tool",
          tool_call:
            ev.tool_call.call_kind === "xml_tag"
              ? {
                  id: ev.tool_call.tool_call_id,
                  lang: "javascript",
                  code: ev.tool_call.arguments_text,
                }
              : {
                  id: ev.tool_call.tool_call_id,
                  functionName: ev.tool_call.tool_name,
                  functionArguments: ev.tool_call.arguments_text,
                },
        }),
        ...meta,
      };
    case "semantic_error":
      return {
        stream: "tool_call_error",
        payload: JSON.stringify({
          errors: [ev.error.message || ev.error.detail_text],
          source: "tool",
        }),
        ...meta,
      };
    case "semantic_tool_call_start":
      return {
        stream: "tool_call_start",
        payload: JSON.stringify({
          toolName: ev.tool_call.tool_name,
          toolCallId: ev.tool_call.tool_call_id,
          arguments: ev.tool_call.arguments_text,
        }),
        ...meta,
      };
    case "semantic_tool_call_result":
      return {
        stream: "tool_call_result",
        payload: JSON.stringify({
          toolName: ev.tool_call.tool_name,
          toolCallId: ev.tool_call.tool_call_id,
          result: ev.output_text,
          isError: ev.is_error,
        }),
        ...meta,
      };
    case "semantic_questionnaire_request": {
      const projectedQuestions =
        ev.questionnaire_request.questions && ev.questionnaire_request.questions.length > 0
          ? ev.questionnaire_request.questions.map((question) => ({
              id: question.question_id,
              prompt: question.prompt,
              type: question.question_type,
              required: question.required,
              ...(question.options.length > 0
                ? {
                    choices: question.options.map((option) => ({
                      value: option.value_text,
                      label: option.label || option.value_text,
                      description: option.description || undefined,
                    })),
                  }
                : {}),
              helpText: question.help_text || undefined,
            }))
          : [
              {
                id: "q1",
                prompt: ev.questionnaire_request.question,
                type:
                  ev.questionnaire_request.input_kind === "approval"
                    ? "yes_no"
                    : ev.questionnaire_request.input_kind === "choice"
                      ? "single_select"
                      : "text",
                required: true,
                ...(ev.questionnaire_request.options.length > 0
                  ? {
                      choices: ev.questionnaire_request.options.map((option) => ({
                        value: option.value_text,
                        label: option.label || option.value_text,
                        description: option.description || undefined,
                      })),
                    }
                  : {}),
              },
            ];
      return {
        stream: "questionnaire_request",
        payload: JSON.stringify({
          questionnaireId: ev.questionnaire_request.questionnaire_id,
          toolCallId: ev.tool_call?.tool_call_id ?? null,
          kind: "approval",
          title: ev.questionnaire_request.title_text ?? ev.questionnaire_request.question,
          intro: (ev.questionnaire_request.intro_text ?? ev.questionnaire_request.payload_text) || null,
          suspendPolicy: "pause_all",
          questions: projectedQuestions,
        }),
        ...meta,
      };
    }
    case "semantic_questionnaire_result":
      return {
        stream: "questionnaire_result",
        payload: JSON.stringify({
          questionnaireId: ev.questionnaire_id,
          toolCallId: null,
          rawText: ev.response_text,
          status: ev.approved === false ? "invalid" : "ok",
          answers: { q1: ev.approved ?? ev.response_text },
          errors: null,
        }),
        ...meta,
      };
    case "semantic_user_input":
      return {
        stream: "user_input",
        payload: ev.text,
        ...meta,
      };
    default:
      return null;
  }
}

type HistoryProjectionInput =
  | { kind: "semantic"; event: SemanticEvent }
  | { kind: "complete" };

type PendingAssistantState = {
  agentKey: string;
  agentActorId: string;
  content: string[];
  reasoning: string[];
  toolCalls: ToolCall[];
  startAt?: number;
  endAt?: number;
};

type HistoryProjectionState = {
  completed: boolean;
  lastBatch: MessageHistoryEvent[];
  lastCommittedBatch: CommittedHistoryMessageEvent[];
  thinkOpen: boolean;
  thinkBuffer: string;
  thinkAgentKey: string;
  thinkAgentActorId: string;
  thinkStartAt?: number;
  thinkEndAt?: number;
  contentOpen: boolean;
  contentBuffer: string;
  contentAgentKey: string;
  contentAgentActorId: string;
  contentStartAt?: number;
  contentEndAt?: number;
  pendingAssistant: PendingAssistantState | null;
};

const INITIAL_HISTORY_PROJECTION_STATE: HistoryProjectionState = {
  completed: false,
  lastBatch: [],
  lastCommittedBatch: [],
  thinkOpen: false,
  thinkBuffer: "",
  thinkAgentKey: "",
  thinkAgentActorId: "",
  thinkStartAt: undefined,
  thinkEndAt: undefined,
  contentOpen: false,
  contentBuffer: "",
  contentAgentKey: "",
  contentAgentActorId: "",
  contentStartAt: undefined,
  contentEndAt: undefined,
  pendingAssistant: null,
};

function parseJsonSafe(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const parsed = parseJsonSafe(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  const trimmed = String(raw ?? "").trim();
  return trimmed ? { raw: trimmed } : {};
}

function toCommittedToolCall(event: SemanticEvent): ToolCall | null {
  if (event.event_type !== "semantic_tool_call_planned" && event.event_type !== "semantic_tool_call_start") {
    return null;
  }
  const toolCallId = String(event.tool_call.tool_call_id ?? "").trim();
  const toolName = String(event.tool_call.tool_name ?? "").trim();
  if (!toolCallId && !toolName) return null;
  return {
    id: toolCallId || toolName,
    name: toolName || toolCallId,
    input: parseToolArguments(String(event.tool_call.arguments_text ?? "")),
  };
}

function createCommittedAssistantMessage(pending: PendingAssistantState): ChatMessage | null {
  const content = pending.content.join("");
  const reasoning = pending.reasoning.join("");
  const hasToolCalls = pending.toolCalls.length > 0;
  if (!content && !reasoning && !hasToolCalls) return null;

  const next: ChatMessage = {
    role: "assistant",
    content,
    ...(typeof pending.startAt === "number" ? { startAt: pending.startAt } : {}),
    ...(typeof pending.endAt === "number" ? { endAt: pending.endAt } : {}),
  };
  if (reasoning) {
    next.reasoning_content = reasoning;
  }
  if (hasToolCalls) {
    next.toolCalls = pending.toolCalls.map((toolCall) => ({ ...toolCall, input: { ...toolCall.input } }));
    next.rawToolCalls = pending.toolCalls.map((toolCall) => ({ ...toolCall, input: { ...toolCall.input } }));
    next.rawToolCallsStr = JSON.stringify(next.rawToolCalls);
  }
  return next;
}

export class MessageHistoryGraph {
  private readonly listeners = new Set<(event: MessageHistoryEvent) => void>();
  private readonly committedListeners = new Set<(event: CommittedHistoryMessageEvent) => void>();
  private readonly inputLog = new AppendOnlyEventLog<HistoryProjectionInput>();
  private readonly projection: ReducerProjection<HistoryProjectionInput, HistoryProjectionState>;
  private readonly projectionSubscription: { unsubscribe: () => void };
  private disposed = false;

  constructor() {
    this.projection = createReducerProjection(this.inputLog, {
      initial: INITIAL_HISTORY_PROJECTION_STATE,
      reducer: (state, entry) => reduceHistoryProjection(state, entry.value),
    });

    this.projectionSubscription = this.projection.stream({ emitCurrent: false }).subscribe({
      next: (state) => {
        for (const event of state.lastBatch) {
          this.emit(event);
        }
        for (const event of state.lastCommittedBatch) {
          this.emitCommitted(event);
        }
      },
      error: () => {},
      complete: () => {},
    });
  }

  consumeSemanticEvent(event: SemanticEvent): void {
    if (this.disposed || this.projection.getState().completed) return;
    this.inputLog.append({ kind: "semantic", event });
  }

  onHistoryEvent(handler: (event: MessageHistoryEvent) => void): { unsubscribe: () => void } {
    if (this.disposed || this.projection.getState().completed) {
      return {
        unsubscribe: () => {},
      };
    }
    this.listeners.add(handler);
    return {
      unsubscribe: () => {
        this.listeners.delete(handler);
      },
    };
  }

  onCommittedMessage(handler: (event: CommittedHistoryMessageEvent) => void): { unsubscribe: () => void } {
    if (this.disposed || this.projection.getState().completed) {
      return {
        unsubscribe: () => {},
      };
    }
    this.committedListeners.add(handler);
    return {
      unsubscribe: () => {
        this.committedListeners.delete(handler);
      },
    };
  }

  complete(): void {
    if (this.disposed || this.projection.getState().completed) return;
    this.inputLog.append({ kind: "complete" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.projectionSubscription.unsubscribe();
    this.projection.dispose();
    this.inputLog.dispose();
    this.listeners.clear();
    this.committedListeners.clear();
  }

  private emit(event: MessageHistoryEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  private emitCommitted(event: CommittedHistoryMessageEvent): void {
    for (const listener of [...this.committedListeners]) {
      listener(event);
    }
  }
}

function reduceHistoryProjection(
  state: HistoryProjectionState,
  input: HistoryProjectionInput,
): HistoryProjectionState {
  if (state.completed) {
    return state;
  }

  const next: HistoryProjectionState = {
    ...state,
    lastBatch: [],
    lastCommittedBatch: [],
  };

  const emit = (event: MessageHistoryEvent) => {
    next.lastBatch = [...next.lastBatch, event];
  };

  const emitCommitted = (event: CommittedHistoryMessageEvent) => {
    next.lastCommittedBatch = [...next.lastCommittedBatch, event];
  };

  const flushCommittedAssistant = () => {
    if (!next.pendingAssistant) return;
    const message = createCommittedAssistantMessage(next.pendingAssistant);
    if (message) {
      emitCommitted({
        agentKey: next.pendingAssistant.agentKey,
        agentActorId: next.pendingAssistant.agentActorId,
        message,
      });
    }
    next.pendingAssistant = null;
  };

  const ensurePendingAssistant = (agentKey: string, agentActorId: string, timestamp: number) => {
    const current = next.pendingAssistant;
    if (current && (current.agentKey !== agentKey || current.agentActorId !== agentActorId)) {
      flushCommittedAssistant();
    }
    if (!next.pendingAssistant) {
      next.pendingAssistant = {
        agentKey,
        agentActorId,
        content: [],
        reasoning: [],
        toolCalls: [],
        startAt: timestamp,
        endAt: timestamp,
      };
    }
    next.pendingAssistant.startAt =
      typeof next.pendingAssistant.startAt === "number"
        ? Math.min(next.pendingAssistant.startAt, timestamp)
        : timestamp;
    next.pendingAssistant.endAt =
      typeof next.pendingAssistant.endAt === "number"
        ? Math.max(next.pendingAssistant.endAt, timestamp)
        : timestamp;
    return next.pendingAssistant;
  };

  const flushThink = () => {
    if (next.thinkBuffer) {
      emit({
        stream: "think",
        payload: next.thinkBuffer,
        startAt: next.thinkStartAt,
        endAt: next.thinkEndAt ?? next.thinkStartAt,
        agentKey: next.thinkAgentKey,
        agentActorId: next.thinkAgentActorId,
      });
    }
    next.thinkOpen = false;
    next.thinkBuffer = "";
    next.thinkStartAt = undefined;
    next.thinkEndAt = undefined;
  };

  const flushContent = () => {
    if (next.contentBuffer) {
      emit({
        stream: "content",
        payload: next.contentBuffer,
        startAt: next.contentStartAt,
        endAt: next.contentEndAt ?? next.contentStartAt,
        agentKey: next.contentAgentKey,
        agentActorId: next.contentAgentActorId,
      });
    }
    next.contentOpen = false;
    next.contentBuffer = "";
    next.contentStartAt = undefined;
    next.contentEndAt = undefined;
  };

  const flushTranscriptBuffers = () => {
    flushThink();
    flushContent();
  };

  const flushAll = () => {
    flushTranscriptBuffers();
    flushCommittedAssistant();
  };

  if (input.kind === "complete") {
    flushAll();
    next.completed = true;
    return next;
  }

  const ev = input.event;
  const agentKey = ev.actor.actor_name || ev.actor.actor_id;
  const agentActorId = ev.actor.actor_id;
  const emittedAt = ev.trace.emitted_at;

  switch (ev.event_type) {
    case "semantic_think_start":
      flushTranscriptBuffers();
      ensurePendingAssistant(agentKey, agentActorId, emittedAt);
      next.thinkOpen = true;
      next.thinkAgentKey = agentKey;
      next.thinkAgentActorId = agentActorId;
      next.thinkStartAt = emittedAt;
      next.thinkEndAt = emittedAt;
      return next;
    case "semantic_think_delta": {
      flushContent();
      if (next.thinkOpen && (next.thinkAgentKey !== agentKey || next.thinkAgentActorId !== agentActorId)) {
        flushThink();
      }
      if (!next.thinkOpen) {
        next.thinkOpen = true;
      }
      next.thinkAgentKey = agentKey;
      next.thinkAgentActorId = agentActorId;
      next.thinkStartAt ??= emittedAt;
      next.thinkEndAt = emittedAt;
      next.thinkBuffer += ev.text;
      ensurePendingAssistant(agentKey, agentActorId, emittedAt).reasoning.push(ev.text);
      return next;
    }
    case "semantic_think_end":
      if (next.thinkOpen) {
        next.thinkEndAt = emittedAt;
      }
      flushThink();
      ensurePendingAssistant(agentKey, agentActorId, emittedAt);
      return next;
    case "semantic_content_start":
      flushTranscriptBuffers();
      ensurePendingAssistant(agentKey, agentActorId, emittedAt);
      next.contentOpen = true;
      next.contentAgentKey = agentKey;
      next.contentAgentActorId = agentActorId;
      next.contentStartAt = emittedAt;
      next.contentEndAt = emittedAt;
      return next;
    case "semantic_content_delta": {
      flushThink();
      if (next.contentOpen && (next.contentAgentKey !== agentKey || next.contentAgentActorId !== agentActorId)) {
        flushContent();
      }
      if (!next.contentOpen) {
        next.contentOpen = true;
      }
      next.contentAgentKey = agentKey;
      next.contentAgentActorId = agentActorId;
      next.contentStartAt ??= emittedAt;
      next.contentEndAt = emittedAt;
      next.contentBuffer += ev.text;
      ensurePendingAssistant(agentKey, agentActorId, emittedAt).content.push(ev.text);
      return next;
    }
    case "semantic_content_end":
      if (next.contentOpen) {
        next.contentEndAt = emittedAt;
      }
      flushContent();
      ensurePendingAssistant(agentKey, agentActorId, emittedAt);
      return next;
    case "semantic_tool_call_planned":
    case "semantic_tool_call_start": {
      flushTranscriptBuffers();
      const pending = ensurePendingAssistant(agentKey, agentActorId, emittedAt);
      const toolCall = toCommittedToolCall(ev);
      if (toolCall) {
        pending.toolCalls = [...pending.toolCalls, toolCall];
      }
      const mapped = toHistoryEvent(ev);
      if (mapped) {
        emit(mapped);
      }
      return next;
    }
    case "semantic_tool_call_result": {
      flushTranscriptBuffers();
      flushCommittedAssistant();
      const mapped = toHistoryEvent(ev);
      if (mapped) {
        emit(mapped);
      }
      emitCommitted({
        agentKey,
        agentActorId,
        message: {
          role: "tool",
          content: ev.output_text,
          toolCallId: ev.tool_call.tool_call_id,
          startAt: emittedAt,
          endAt: emittedAt,
        } as ChatMessage,
      });
      return next;
    }
    case "semantic_questionnaire_result": {
      flushTranscriptBuffers();
      flushCommittedAssistant();
      const mapped = toHistoryEvent(ev);
      if (mapped) {
        emit(mapped);
      }
      emitCommitted({
        agentKey,
        agentActorId,
        message: {
          role: "tool",
          content: ev.response_text,
          startAt: emittedAt,
          endAt: emittedAt,
        } as ChatMessage,
      });
      return next;
    }
    case "semantic_user_input":
      flushTranscriptBuffers();
      flushCommittedAssistant();
      emit({
        stream: "user_input",
        payload: ev.text,
        startAt: emittedAt,
        endAt: emittedAt,
        agentKey,
        agentActorId,
      });
      emitCommitted({
        agentKey,
        agentActorId,
        message: {
          role: "user",
          content: ev.text,
          startAt: emittedAt,
          endAt: emittedAt,
        },
      });
      return next;
    case "semantic_turn_start":
    case "semantic_turn_end":
      flushAll();
      return next;
    default: {
      flushTranscriptBuffers();
      const mapped = toHistoryEvent(ev);
      if (mapped) {
        emit(mapped);
      }
      return next;
    }
  }
}
