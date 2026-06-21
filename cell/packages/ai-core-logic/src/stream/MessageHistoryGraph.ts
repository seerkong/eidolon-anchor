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

/**
 * Structured, non-fatal anomaly surfaced by the single-writer history reducer
 * at one of its invariant boundaries. The reducer PRODUCES these (pure); the
 * host RECORDS them (e.g. `console.warn`). This is observability only: emitting
 * an anomaly never changes the committed-message set, never throws, and never
 * adds a second writer.
 *
 * - `orphaned_tool_result`: a `semantic_tool_call_result(tool_call_id=X)` was
 *   consumed but no assistant tool-call for X was ever seen this generation
 *   (no `semantic_tool_call_start`/`_planned` for X, and X is in no pending
 *   assistant's toolCalls). This is the codex-adapter bug's exact signature.
 * - `hollow_assistant_commit`: reserved for P2 (flush of an all-empty pending
 *   assistant).
 */
export type AnomalyReason = "orphaned_tool_result" | "hollow_assistant_commit";

export type AnomalyEvent = {
  kind: "anomaly";
  reason: AnomalyReason;
  toolCallId?: string;
  agentKey: string;
  agentActorId: string;
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

export type HistoryProjectionInput =
  | { kind: "semantic"; event: SemanticEvent }
  | { kind: "complete" };

export type PendingAssistantState = {
  agentKey: string;
  agentActorId: string;
  content: string[];
  reasoning: string[];
  toolCalls: ToolCall[];
  startAt?: number;
  endAt?: number;
};

export type HistoryProjectionState = {
  completed: boolean;
  lastBatch: MessageHistoryEvent[];
  lastCommittedBatch: CommittedHistoryMessageEvent[];
  lastAnomalyBatch: AnomalyEvent[];
  /**
   * tool_call_ids of every assistant tool-call seen this generation (from
   * `semantic_tool_call_start`/`_planned` and any pending assistant toolCalls).
   * A `semantic_tool_call_result` whose tool_call_id is absent here is orphaned.
   */
  seenToolCallIds: string[];
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

export const INITIAL_HISTORY_PROJECTION_STATE: HistoryProjectionState = {
  completed: false,
  lastBatch: [],
  lastCommittedBatch: [],
  lastAnomalyBatch: [],
  seenToolCallIds: [],
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

/** Fresh initial state for the pure semantic->committed merge core. */
export function createInitialHistoryProjectionState(): HistoryProjectionState {
  return { ...INITIAL_HISTORY_PROJECTION_STATE };
}

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

function isPlaceholderToolCall(toolCall: ToolCall): boolean {
  return toolCall.name === toolCall.id && Object.keys(toolCall.input ?? {}).length === 0;
}

function upsertPendingToolCall(pending: PendingAssistantState, toolCall: ToolCall): void {
  const index = pending.toolCalls.findIndex((entry) => entry.id === toolCall.id);
  if (index < 0) {
    pending.toolCalls = [...pending.toolCalls, toolCall];
    return;
  }

  const current = pending.toolCalls[index];
  if (isPlaceholderToolCall(current) && !isPlaceholderToolCall(toolCall)) {
    pending.toolCalls = [
      ...pending.toolCalls.slice(0, index),
      toolCall,
      ...pending.toolCalls.slice(index + 1),
    ];
    return;
  }

  if (
    !isPlaceholderToolCall(toolCall) &&
    JSON.stringify(toolCall.input ?? {}) !== JSON.stringify(current.input ?? {})
  ) {
    pending.toolCalls = [
      ...pending.toolCalls.slice(0, index),
      toolCall,
      ...pending.toolCalls.slice(index + 1),
    ];
  }
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
  private readonly anomalyListeners = new Set<(event: AnomalyEvent) => void>();
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
        for (const event of state.lastAnomalyBatch) {
          this.emitAnomaly(event);
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

  /**
   * Subscribe to structured, non-fatal anomalies surfaced at the single-writer
   * invariant boundaries (e.g. orphaned tool results). Mirrors
   * {@link onHistoryEvent}/{@link onCommittedMessage}: the reducer produces the
   * events; the host records them. Observability only — no commit-flow change.
   */
  onAnomaly(handler: (event: AnomalyEvent) => void): { unsubscribe: () => void } {
    if (this.disposed || this.projection.getState().completed) {
      return {
        unsubscribe: () => {},
      };
    }
    this.anomalyListeners.add(handler);
    return {
      unsubscribe: () => {
        this.anomalyListeners.delete(handler);
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
    this.anomalyListeners.clear();
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

  private emitAnomaly(event: AnomalyEvent): void {
    for (const listener of [...this.anomalyListeners]) {
      listener(event);
    }
  }
}

function clonePendingAssistant(pending: PendingAssistantState): PendingAssistantState {
  return {
    ...pending,
    content: [...pending.content],
    reasoning: [...pending.reasoning],
    toolCalls: pending.toolCalls.map((toolCall) => ({ ...toolCall, input: { ...toolCall.input } })),
  };
}

/**
 * Pure semantic->committed merge core. This is the single implementation of
 * the message-assembly commit boundary: the MessageHistoryGraph class above
 * and the conversation capsule's messageAssemblyDerivation both reduce with
 * this function. It never mutates the input state.
 */
export function reduceHistoryProjection(
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
    lastAnomalyBatch: [],
    seenToolCallIds: [...state.seenToolCallIds],
    pendingAssistant: state.pendingAssistant ? clonePendingAssistant(state.pendingAssistant) : null,
  };

  const emit = (event: MessageHistoryEvent) => {
    next.lastBatch = [...next.lastBatch, event];
  };

  const emitCommitted = (event: CommittedHistoryMessageEvent) => {
    next.lastCommittedBatch = [...next.lastCommittedBatch, event];
  };

  const emitAnomaly = (event: AnomalyEvent) => {
    next.lastAnomalyBatch = [...next.lastAnomalyBatch, event];
  };

  // Record an assistant tool-call's id so a later tool_call_result can be
  // matched. Pure: only mutates the freshly-cloned `seenToolCallIds`.
  const markToolCallSeen = (toolCallId: string) => {
    if (toolCallId && !next.seenToolCallIds.includes(toolCallId)) {
      next.seenToolCallIds = [...next.seenToolCallIds, toolCallId];
    }
  };

  const flushCommittedAssistant = () => {
    if (!next.pendingAssistant) return;
    // Hollow-commit detection (observability only): a pending assistant whose
    // content, reasoning, AND toolCalls are ALL empty assembles to no message
    // (`createCommittedAssistantMessage` returns null) — the assistant turn
    // produced nothing recordable, yet it flushed silently. Surface it via the
    // existing anomaly channel BEFORE committing. This does NOT change what is
    // committed: the empty-pending commit behavior below is unchanged.
    const pending = next.pendingAssistant;
    const isHollow =
      pending.content.join("") === "" &&
      pending.reasoning.join("") === "" &&
      pending.toolCalls.length === 0;
    if (isHollow) {
      emitAnomaly({
        kind: "anomaly",
        reason: "hollow_assistant_commit",
        agentKey: pending.agentKey,
        agentActorId: pending.agentActorId,
      });
    }
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
      // Record the assistant tool-call id so its later result is not flagged as
      // orphaned. Use the raw event id (what the result event carries).
      markToolCallSeen(String(ev.tool_call.tool_call_id ?? "").trim());
      const toolCall = toCommittedToolCall(ev);
      if (toolCall) {
        upsertPendingToolCall(pending, toolCall);
      }
      const mapped = toHistoryEvent(ev);
      if (mapped) {
        emit(mapped);
      }
      return next;
    }
    case "semantic_tool_call_result": {
      flushTranscriptBuffers();
      // Orphan detection (observability only): a tool result whose tool_call_id
      // was never registered by an assistant tool-call (start/planned, or a
      // pending assistant's toolCalls) signals the single-writer consumed a
      // result with no paired call — the codex-adapter bug's signature. Read
      // pending toolCalls BEFORE flushing clears pendingAssistant.
      const resultToolCallId = String(ev.tool_call.tool_call_id ?? "").trim();
      const pendingHasToolCall =
        next.pendingAssistant?.toolCalls.some((toolCall) => toolCall.id === resultToolCallId) ?? false;
      if (resultToolCallId && !next.seenToolCallIds.includes(resultToolCallId) && !pendingHasToolCall) {
        emitAnomaly({
          kind: "anomaly",
          reason: "orphaned_tool_result",
          toolCallId: resultToolCallId,
          agentKey,
          agentActorId,
        });
      }
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
      // Stream-level projection only (TUI questionnaire_result history event).
      // The committed conversation message for a questionnaire answer is the
      // canonical JSON tool message (questionnaireId/rawText/status/answers/
      // errors, paired by tool_call_id) which the executor commits through the
      // tool-result semantic channel — matching the provider-visible shape of
      // the pre-spine assembly. Committing ev.response_text here as a second
      // bare tool message would duplicate/diverge from that canonical form
      // (track refactor-ai-semantic-conversation-spine, T4.3).
      flushTranscriptBuffers();
      flushCommittedAssistant();
      const mapped = toHistoryEvent(ev);
      if (mapped) {
        emit(mapped);
      }
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
