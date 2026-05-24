import type {
  ActorRefData,
  ErrorData,
  TeamRefData,
  ToolCallDeltaData,
  TraceData,
  UsageData,
} from "./common";

export const LEXICAL_EVENT_TYPES = [
  "lexical_turn_start",
  "lexical_thinking_start",
  "lexical_thinking_delta",
  "lexical_thinking_end",
  "lexical_content_start",
  "lexical_content_delta",
  "lexical_content_end",
  "lexical_unquote_start",
  "lexical_unquote_delta",
  "lexical_unquote_end",
  "lexical_tool_call_start",
  "lexical_tool_call_delta",
  "lexical_tool_call_end",
  "lexical_usage",
  "lexical_stop",
  "lexical_error",
] as const;

export type LexicalEventType = (typeof LEXICAL_EVENT_TYPES)[number];

export type LexicalProtocol = "openai" | "anthropic" | "openai_compatible" | "unknown";

export type LexicalContextData = {
  provider_name: string;
  adapter_name: string;
  model_name: string;
  protocol: LexicalProtocol;
  response_id: string;
  stop_reason: string;
  chunk_index: number;
};

type LexicalEventBase<TEventType extends LexicalEventType> = {
  trace: TraceData;
  actor: ActorRefData;
  team: TeamRefData;
  lexical: LexicalContextData;
  event_type: TEventType;
};

export type LexicalTurnStartEvent = LexicalEventBase<"lexical_turn_start">;

export type LexicalThinkingStartEvent = LexicalEventBase<"lexical_thinking_start">;

export type LexicalThinkingDeltaEvent = LexicalEventBase<"lexical_thinking_delta"> & {
  text: string;
};

export type LexicalThinkingEndEvent = LexicalEventBase<"lexical_thinking_end">;

export type LexicalContentStartEvent = LexicalEventBase<"lexical_content_start">;

export type LexicalContentDeltaEvent = LexicalEventBase<"lexical_content_delta"> & {
  text: string;
};

export type LexicalContentEndEvent = LexicalEventBase<"lexical_content_end">;

export type LexicalUnquoteStartEvent = LexicalEventBase<"lexical_unquote_start">;

export type LexicalUnquoteDeltaEvent = LexicalEventBase<"lexical_unquote_delta"> & {
  text: string;
};

export type LexicalUnquoteEndEvent = LexicalEventBase<"lexical_unquote_end">;

export type LexicalToolCallStartEvent = LexicalEventBase<"lexical_tool_call_start">;

export type LexicalToolCallDeltaEvent = LexicalEventBase<"lexical_tool_call_delta"> & {
  tool_call_delta: ToolCallDeltaData;
};

export type LexicalToolCallEndEvent = LexicalEventBase<"lexical_tool_call_end">;

export type LexicalUsageEvent = LexicalEventBase<"lexical_usage"> & {
  usage: UsageData;
};

export type LexicalStopEvent = LexicalEventBase<"lexical_stop"> & {
  stop_reason: string;
};

export type LexicalErrorEvent = LexicalEventBase<"lexical_error"> & {
  error: ErrorData;
};

export type LexicalThinkingEvents =
  | LexicalThinkingStartEvent
  | LexicalThinkingDeltaEvent
  | LexicalThinkingEndEvent;

export type LexicalUnquoteEvents =
  | LexicalUnquoteStartEvent
  | LexicalUnquoteDeltaEvent
  | LexicalUnquoteEndEvent;

export type LexicalContentEvents =
  | LexicalContentStartEvent
  | LexicalContentDeltaEvent
  | LexicalContentEndEvent
  | LexicalUnquoteStartEvent
  | LexicalUnquoteDeltaEvent
  | LexicalUnquoteEndEvent;

export type LexicalControlEvents =
  | LexicalTurnStartEvent
  | LexicalToolCallStartEvent
  | LexicalToolCallDeltaEvent
  | LexicalToolCallEndEvent
  | LexicalUsageEvent
  | LexicalStopEvent
  | LexicalErrorEvent;

export type LexicalEvent =
  | LexicalTurnStartEvent
  | LexicalThinkingStartEvent
  | LexicalThinkingDeltaEvent
  | LexicalThinkingEndEvent
  | LexicalContentStartEvent
  | LexicalContentDeltaEvent
  | LexicalContentEndEvent
  | LexicalUnquoteStartEvent
  | LexicalUnquoteDeltaEvent
  | LexicalUnquoteEndEvent
  | LexicalToolCallStartEvent
  | LexicalToolCallDeltaEvent
  | LexicalToolCallEndEvent
  | LexicalUsageEvent
  | LexicalStopEvent
  | LexicalErrorEvent;
