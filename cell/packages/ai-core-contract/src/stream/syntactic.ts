import type {
  ActorRefData,
  ErrorData,
  StructuredNodeData,
  TeamRefData,
  ToolCallData,
  TraceData,
} from "./common";

export const SYNTACTIC_EVENT_TYPES = [
  "syntactic_thinking_start",
  "syntactic_thinking_delta",
  "syntactic_thinking_end",
  "syntactic_content_start",
  "syntactic_content_delta",
  "syntactic_content_end",
  "syntactic_tool_text",
  "syntactic_quote",
  "syntactic_structured_node",
  "syntactic_tool_call",
  "syntactic_error",
] as const;

export type SyntacticEventType = (typeof SYNTACTIC_EVENT_TYPES)[number];

export type SyntacticThinkingSource = "thinking";
export type SyntacticContentSource = "content";
export type SyntacticToolTextSource = "tool";
export type SyntacticQuoteSource = "thinking" | "content" | "tool";
export type SyntacticStructuredNodeSource = "thinking" | "content" | "unquote" | "tool";
export type SyntacticToolCallSource = "toolcall" | "content" | "unquote" | "tool";
export type SyntacticErrorSource =
  | "thinking"
  | "content"
  | "unquote"
  | "tool"
  | "toolcall"
  | "parser"
  | "executor"
  | "system";

type SyntacticEventBase<TEventType extends SyntacticEventType> = {
  trace: TraceData;
  actor: ActorRefData;
  team: TeamRefData;
  event_type: TEventType;
};

export type SyntacticThinkingStartEvent = SyntacticEventBase<"syntactic_thinking_start">;

export type SyntacticThinkingDeltaEvent = SyntacticEventBase<"syntactic_thinking_delta"> & {
  text: string;
  source: SyntacticThinkingSource;
};

export type SyntacticThinkingEndEvent = SyntacticEventBase<"syntactic_thinking_end">;

export type SyntacticContentStartEvent = SyntacticEventBase<"syntactic_content_start">;

export type SyntacticContentDeltaEvent = SyntacticEventBase<"syntactic_content_delta"> & {
  text: string;
  source: SyntacticContentSource;
};

export type SyntacticContentEndEvent = SyntacticEventBase<"syntactic_content_end">;

export type SyntacticToolTextEvent = SyntacticEventBase<"syntactic_tool_text"> & {
  text: string;
  source: SyntacticToolTextSource;
};

export type SyntacticQuoteEvent = SyntacticEventBase<"syntactic_quote"> & {
  source: SyntacticQuoteSource;
  text: string;
};

export type SyntacticStructuredNodeEvent = SyntacticEventBase<"syntactic_structured_node"> & {
  source: SyntacticStructuredNodeSource;
  raw_text: string;
  nodes: StructuredNodeData[];
  errors: ErrorData[];
};

export type SyntacticToolCallEvent = SyntacticEventBase<"syntactic_tool_call"> & {
  tool_call: ToolCallData;
  source: SyntacticToolCallSource;
};

export type SyntacticErrorEvent = SyntacticEventBase<"syntactic_error"> & {
  source: SyntacticErrorSource;
  errors: ErrorData[];
  raw_text: string;
};

export type SyntacticThinkingEvents =
  | SyntacticThinkingStartEvent
  | SyntacticThinkingDeltaEvent
  | SyntacticThinkingEndEvent;

export type SyntacticContentEvents =
  | SyntacticContentStartEvent
  | SyntacticContentDeltaEvent
  | SyntacticContentEndEvent;

export type SyntacticToolEvents =
  | SyntacticToolTextEvent
  | SyntacticQuoteEvent
  | SyntacticStructuredNodeEvent
  | SyntacticToolCallEvent;

export type SyntacticControlEvents = SyntacticErrorEvent;

export type SyntacticEvent =
  | SyntacticThinkingStartEvent
  | SyntacticThinkingDeltaEvent
  | SyntacticThinkingEndEvent
  | SyntacticContentStartEvent
  | SyntacticContentDeltaEvent
  | SyntacticContentEndEvent
  | SyntacticToolTextEvent
  | SyntacticQuoteEvent
  | SyntacticStructuredNodeEvent
  | SyntacticToolCallEvent
  | SyntacticErrorEvent;
