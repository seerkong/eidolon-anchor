import { DataGraph, defineGraphModule, internal, mountGraph, state } from "depa-data-graph-core";

import type {
  ActorRefData,
  ErrorData,
  StructuredNodeAttributeData,
  StructuredNodeData,
  TeamRefData,
  ToolCallData,
  ToolCallDeltaData,
  TraceData,
} from "@cell/ai-core-contract/stream/common";
import type {
  LexicalContentDeltaEvent,
  LexicalContentEndEvent,
  LexicalContentEvents,
  LexicalContentStartEvent,
  LexicalControlEvents,
  LexicalErrorEvent,
  LexicalEvent,
  LexicalThinkingDeltaEvent,
  LexicalThinkingEndEvent,
  LexicalThinkingEvents,
  LexicalThinkingStartEvent,
  LexicalToolCallDeltaEvent,
  LexicalToolCallEndEvent,
  LexicalToolCallStartEvent,
  LexicalUnquoteDeltaEvent,
  LexicalUnquoteEndEvent,
  LexicalUnquoteStartEvent,
} from "@cell/ai-core-contract/stream/lexical";
import type {
  SemanticContentDeltaEvent,
  SemanticContentEndEvent,
  SemanticContentEvents,
  SemanticContentStartEvent,
  SemanticErrorEvent,
  SemanticEvent,
  SemanticNoticeEvent,
  SemanticQuoteEvent,
  SemanticThinkDeltaEvent,
  SemanticThinkEndEvent,
  SemanticThinkingEvents,
  SemanticThinkStartEvent,
  SemanticToolCallPlannedEvent,
} from "@cell/ai-core-contract/stream/semantic";
import type {
  SyntacticContentDeltaEvent,
  SyntacticContentEndEvent,
  SyntacticContentEvents,
  SyntacticContentStartEvent,
  SyntacticErrorEvent,
  SyntacticEvent,
  SyntacticQuoteEvent,
  SyntacticStructuredNodeEvent,
  SyntacticThinkingDeltaEvent,
  SyntacticThinkingEndEvent,
  SyntacticThinkingEvents,
  SyntacticThinkingStartEvent,
  SyntacticToolCallEvent,
  SyntacticToolEvents,
  SyntacticToolTextEvent,
} from "@cell/ai-core-contract/stream/syntactic";

type TextChannel = "thinking" | "content";

type TextParseState = {
  mode: "normal" | "quote" | "unquote";
  pending: string;
  quoteBuffer: string;
  unquoteBuffer: string;
};

type ToolCallAccumulator = {
  toolCallId: string;
  toolCallType: string;
  functionName: string;
  functionArguments: string;
};

type ToolCallParseState = {
  started: boolean;
  accumulators: Map<number, ToolCallAccumulator>;
};

type LexicalBuckets = {
  thinking: LexicalThinkingEvents[];
  content: LexicalContentEvents[];
  control: LexicalControlEvents[];
};

type StageGraphRuntime = Record<string, never>;
export type StageGraphCallbacks = {
  onLexicalEvent?: (event: LexicalEvent) => void;
  onSyntacticEvent?: (event: SyntacticEvent) => void;
  onSemanticEvent?: (event: SemanticEvent) => void;
};

export type StagePipelineOutputs = {
  lexical: LexicalEvent[];
  syntacticThinking: SyntacticEvent[];
  syntacticContent: SyntacticEvent[];
  syntacticTool: SyntacticToolEvents[];
  syntacticControl: SyntacticErrorEvent[];
  syntactic: SyntacticEvent[];
  semanticThinking: SemanticThinkingEvents[];
  semanticContent: SemanticContentEvents[];
  semanticControl: SemanticEvent[];
  semantic: SemanticEvent[];
};

const MARKERS = ["!unquote_start", "!unquote_end", "!quote_start", "!quote_end"] as const;
const MAX_MARKER_LEN = Math.max(...MARKERS.map((marker) => marker.length));

export const DEFAULT_TRACE: TraceData = {
  event_id: "",
  actor_id: "",
  session_id: "",
  request_id: "",
  conversation_id: "",
  stream_id: "",
  parent_event_id: "",
  causation_event_id: "",
  correlation_id: "",
  turn_id: "",
  turn_index: 0,
  sequence: 0,
  emitted_at: 0,
  surface: "unknown",
};

export const DEFAULT_ACTOR: ActorRefData = {
  actor_id: "primary",
  actor_name: "Primary",
  actor_kind: "primary",
  agent_definition_name: null,
  agent_manifest_type: "unknown",
  role_label: null,
  actor_projection: null,
  parent_actor_id: null,
  root_actor_id: null,
};

export const DEFAULT_TEAM: TeamRefData = {
  team_id: "team-1",
  team_name: "Team",
  coordinator_actor_id: "",
  teammate_name: "",
  teammate_role: "",
  task_id: "",
};

const REFERENCE_ALIGNED_STAGE_REFS = mountGraph(
  defineGraphModule("referenceAlignedStage", {
    state: {
      lexicalEvents: state<LexicalEvent[]>(),
      lexicalSeq: state<number>(),
      syntacticEvents: state<SyntacticEvent[]>(),
      syntacticSeq: state<number>(),
      semanticEvents: state<SemanticEvent[]>(),
      semanticSeq: state<number>(),
    },
    internals: {
      lexicalToSyntactic: internal<void>(),
      syntacticToSemantic: internal<void>(),
      collectLexical: internal<void>(),
      collectSyntactic: internal<void>(),
      collectSemantic: internal<void>(),
    },
  } as const),
  { scope: "pipeline/reference-aligned-stage" },
);

export function createDefaultTrace(sequence: number): TraceData {
  return {
    ...DEFAULT_TRACE,
    event_id: `stage-${sequence}`,
    sequence,
  };
}

export function createLLMStagePipeline(lexicalEvents: LexicalEvent[]): StagePipelineOutputs {
  const graph = new ReferenceAlignedStageDataGraph();
  graph.consumeLexicalEvents(lexicalEvents);
  return graph.getOutputs();
}

export class ReferenceAlignedStageDataGraph {
  private readonly graph: DataGraph<StageGraphRuntime>;
  private readonly callbacks: StageGraphCallbacks;
  private lexical: LexicalEvent[] = [];
  private syntactic: SyntacticEvent[] = [];
  private semantic: SemanticEvent[] = [];
  private thinkingState = newTextParseState();
  private contentState = newTextParseState();
  private toolCallState = newToolCallParseState();
  private lexicalDispatchCount = 0;

  constructor(callbacks: StageGraphCallbacks = {}) {
    this.callbacks = callbacks;
    this.graph = new DataGraph<StageGraphRuntime>(() => ({}));
    this.graph.addSignal(REFERENCE_ALIGNED_STAGE_REFS.state.lexicalEvents, []);
    this.graph.addSignal(REFERENCE_ALIGNED_STAGE_REFS.state.lexicalSeq, 0);
    this.graph.addSignal(REFERENCE_ALIGNED_STAGE_REFS.state.syntacticEvents, []);
    this.graph.addSignal(REFERENCE_ALIGNED_STAGE_REFS.state.syntacticSeq, 0);
    this.graph.addSignal(REFERENCE_ALIGNED_STAGE_REFS.state.semanticEvents, []);
    this.graph.addSignal(REFERENCE_ALIGNED_STAGE_REFS.state.semanticSeq, 0);

    this.graph.addConsumer(REFERENCE_ALIGNED_STAGE_REFS.internals.lexicalToSyntactic, [REFERENCE_ALIGNED_STAGE_REFS.state.lexicalSeq], (ctx) => {
      const lexical = ctx.get(REFERENCE_ALIGNED_STAGE_REFS.state.lexicalEvents);
      const appended = lexical.slice(this.lexical.length);
      const syntactic = this.consumeAppendedLexicalEvents(appended);
      this.graph.batch(() => {
        if (syntactic.length > 0) {
          this.graph.set(REFERENCE_ALIGNED_STAGE_REFS.state.syntacticEvents, (prev) => [...prev, ...syntactic]);
        }
        this.graph.set(REFERENCE_ALIGNED_STAGE_REFS.state.syntacticSeq, (prev) => prev + 1);
      });
    });

    this.graph.addConsumer(REFERENCE_ALIGNED_STAGE_REFS.internals.syntacticToSemantic, [REFERENCE_ALIGNED_STAGE_REFS.state.syntacticSeq], (ctx) => {
      const syntactic = ctx.get(REFERENCE_ALIGNED_STAGE_REFS.state.syntacticEvents);
      const appended = syntactic.slice(this.syntactic.length);
      const semantic = buildSemanticStage(appended);
      this.graph.batch(() => {
        if (semantic.length > 0) {
          this.graph.set(REFERENCE_ALIGNED_STAGE_REFS.state.semanticEvents, (prev) => [...prev, ...semantic]);
        }
        this.graph.set(REFERENCE_ALIGNED_STAGE_REFS.state.semanticSeq, (prev) => prev + 1);
      });
    });

    this.graph.addConsumer(REFERENCE_ALIGNED_STAGE_REFS.internals.collectLexical, [REFERENCE_ALIGNED_STAGE_REFS.state.lexicalSeq], (ctx) => {
      this.lexical = [...ctx.get(REFERENCE_ALIGNED_STAGE_REFS.state.lexicalEvents)];
      const appended = this.lexical.slice(this.lexicalDispatchCount);
      this.lexicalDispatchCount = this.lexical.length;
      for (const event of appended) {
        this.callbacks.onLexicalEvent?.(event);
      }
    });
    this.graph.addConsumer(REFERENCE_ALIGNED_STAGE_REFS.internals.collectSyntactic, [REFERENCE_ALIGNED_STAGE_REFS.state.syntacticSeq], (ctx) => {
      const syntactic = ctx.get(REFERENCE_ALIGNED_STAGE_REFS.state.syntacticEvents);
      const appended = syntactic.slice(this.syntactic.length);
      this.syntactic = [...syntactic];
      for (const event of appended) {
        this.callbacks.onSyntacticEvent?.(event);
      }
    });
    this.graph.addConsumer(REFERENCE_ALIGNED_STAGE_REFS.internals.collectSemantic, [REFERENCE_ALIGNED_STAGE_REFS.state.semanticSeq], (ctx) => {
      const semantic = ctx.get(REFERENCE_ALIGNED_STAGE_REFS.state.semanticEvents);
      const appended = semantic.slice(this.semantic.length);
      this.semantic = [...semantic];
      for (const event of appended) {
        this.callbacks.onSemanticEvent?.(event);
      }
    });
  }

  consumeLexicalEvent(event: LexicalEvent): void {
    this.graph.batch(() => {
      this.graph.set(REFERENCE_ALIGNED_STAGE_REFS.state.lexicalEvents, (prev) => [...prev, event]);
      this.graph.set(REFERENCE_ALIGNED_STAGE_REFS.state.lexicalSeq, (prev) => prev + 1);
    });
  }

  consumeLexicalEvents(events: LexicalEvent[]): void {
    for (const event of events) {
      this.consumeLexicalEvent(event);
    }
  }

  getOutputs(): StagePipelineOutputs {
    return buildStagePipelineOutputs(this.lexical, this.syntactic, this.semantic);
  }

  private consumeAppendedLexicalEvents(events: LexicalEvent[]): SyntacticEvent[] {
    const output: SyntacticEvent[] = [];
    for (const event of events) {
      switch (event.event_type) {
        case "lexical_thinking_start":
          this.thinkingState = newTextParseState();
          output.push({
            trace: event.trace,
            actor: event.actor,
            team: event.team,
            event_type: "syntactic_thinking_start",
          });
          break;
        case "lexical_thinking_delta": {
          const result = processTextChunk(
            this.thinkingState,
            event.text,
            "thinking",
            event.trace,
            event.actor,
            event.team,
          );
          this.thinkingState = result.state;
          output.push(...result.events);
          break;
        }
        case "lexical_thinking_end":
          output.push(...flushTextState(this.thinkingState, "thinking", event.trace, event.actor, event.team));
          this.thinkingState = newTextParseState();
          output.push({
            trace: event.trace,
            actor: event.actor,
            team: event.team,
            event_type: "syntactic_thinking_end",
          });
          break;
        case "lexical_content_start":
          this.contentState = newTextParseState();
          output.push({
            trace: event.trace,
            actor: event.actor,
            team: event.team,
            event_type: "syntactic_content_start",
          });
          break;
        case "lexical_content_delta": {
          const result = processTextChunk(
            this.contentState,
            event.text,
            "content",
            event.trace,
            event.actor,
            event.team,
          );
          this.contentState = result.state;
          output.push(...result.events);
          break;
        }
        case "lexical_content_end":
          output.push(...flushTextState(this.contentState, "content", event.trace, event.actor, event.team));
          this.contentState = newTextParseState();
          output.push({
            trace: event.trace,
            actor: event.actor,
            team: event.team,
            event_type: "syntactic_content_end",
          });
          break;
        case "lexical_unquote_start":
          this.contentState = {
            ...this.contentState,
            mode: "unquote",
            unquoteBuffer: "",
          };
          break;
        case "lexical_unquote_delta":
          this.contentState = {
            ...this.contentState,
            unquoteBuffer: this.contentState.unquoteBuffer + event.text,
          };
          break;
        case "lexical_unquote_end":
          output.push(...flushExplicitUnquote(this.contentState, event.trace, event.actor, event.team, "content"));
          this.contentState = {
            ...this.contentState,
            mode: "normal",
            unquoteBuffer: "",
          };
          break;
        case "lexical_tool_call_start":
          this.toolCallState = newToolCallParseState();
          this.toolCallState.started = true;
          break;
        case "lexical_tool_call_delta":
          if (!this.toolCallState.started) {
            this.toolCallState.started = true;
          }
          processToolCallDelta(this.toolCallState, event.tool_call_delta);
          break;
        case "lexical_tool_call_end":
          output.push(...flushToolCallState(this.toolCallState, event.trace, event.actor, event.team));
          this.toolCallState = newToolCallParseState();
          break;
        case "lexical_error":
          output.push(buildLexicalErrorEvent(event));
          break;
        default:
          break;
      }
    }
    return output;
  }
}

export function mapSyntacticEventToSemanticEvents(event: SyntacticEvent): SemanticEvent[] {
  switch (event.event_type) {
    case "syntactic_tool_call":
      return [
        {
          trace: event.trace,
          actor: event.actor,
          team: event.team,
          event_type: "semantic_tool_call_planned",
          tool_call: event.tool_call,
        },
      ];
    case "syntactic_structured_node":
      return extractToolCalls(event).map((toolCall) => ({
        trace: event.trace,
        actor: event.actor,
        team: event.team,
        event_type: "semantic_tool_call_planned" as const,
        tool_call: toolCall,
      }));
    case "syntactic_quote":
      return [
        {
          trace: event.trace,
          actor: event.actor,
          team: event.team,
          event_type: "semantic_quote",
          source: event.source,
          text: event.text,
        },
      ];
    case "syntactic_tool_text":
      return [
        {
          trace: event.trace,
          actor: event.actor,
          team: event.team,
          event_type: "semantic_notice",
          message: event.text,
          level: "info",
        },
      ];
    case "syntactic_error":
      return [
        {
          trace: event.trace,
          actor: event.actor,
          team: event.team,
          event_type: "semantic_error",
          error: coalesceErrors(event.errors, event.raw_text),
        },
      ];
    default:
      return [];
  }
}

function partitionLexicalEvents(events: LexicalEvent[]): LexicalBuckets {
  const thinking: LexicalThinkingEvents[] = [];
  const content: LexicalContentEvents[] = [];
  const control: LexicalControlEvents[] = [];

  for (const event of events) {
    switch (event.event_type) {
      case "lexical_thinking_start":
      case "lexical_thinking_delta":
      case "lexical_thinking_end":
        thinking.push(event);
        break;
      case "lexical_content_start":
      case "lexical_content_delta":
      case "lexical_content_end":
      case "lexical_unquote_start":
      case "lexical_unquote_delta":
      case "lexical_unquote_end":
        content.push(event);
        break;
      default:
        control.push(event);
        break;
    }
  }

  return { thinking, content, control };
}

function buildSyntacticStage(lexical: LexicalEvent[]): SyntacticEvent[] {
  const buckets = partitionLexicalEvents(lexical);
  return [
    ...parseTextStream(buckets.thinking, "thinking"),
    ...parseTextStream(buckets.content, "content"),
    ...parseToolCallStream(buckets.control),
    ...parseControlStream(buckets.control),
  ];
}

function buildSemanticStage(syntactic: SyntacticEvent[]): SemanticEvent[] {
  const semanticThinking = syntactic
    .filter(isSyntacticThinkingEvent)
    .map(mapThinkingEvent);
  const semanticContent = syntactic
    .filter(isSyntacticContentEvent)
    .map(mapContentEvent);
  const semanticControl = syntactic.flatMap(mapSyntacticEventToSemanticEvents);
  return [
    ...semanticThinking,
    ...semanticContent,
    ...semanticControl,
  ];
}

function buildStagePipelineOutputs(
  lexical: LexicalEvent[],
  syntactic: SyntacticEvent[],
  semantic: SemanticEvent[],
): StagePipelineOutputs {
  const syntacticThinking = syntactic.filter(isSyntacticThinkingEvent);
  const syntacticContent = syntactic.filter(isSyntacticContentEvent);
  const syntacticTool = syntactic.filter(isSyntacticToolEvent);
  const syntacticControl = syntactic.filter(isSyntacticErrorEvent);
  const semanticThinking = semantic.filter(isSemanticThinkingEvent);
  const semanticContent = semantic.filter(isSemanticContentEvent);
  const semanticControl = semantic.filter((event) => !isSemanticThinkingEvent(event) && !isSemanticContentEvent(event));

  return {
    lexical,
    syntacticThinking,
    syntacticContent,
    syntacticTool,
    syntacticControl,
    syntactic,
    semanticThinking,
    semanticContent,
    semanticControl,
    semantic,
  };
}

function parseTextStream(
  events: Array<LexicalThinkingEvents | LexicalContentEvents>,
  channel: TextChannel,
): SyntacticEvent[] {
  const output: SyntacticEvent[] = [];
  let state = newTextParseState();
  let currentContext = {
    trace: DEFAULT_TRACE,
    actor: DEFAULT_ACTOR,
    team: DEFAULT_TEAM,
  };

  for (const event of events) {
    currentContext = {
      trace: event.trace,
      actor: event.actor,
      team: event.team,
    };

    switch (event.event_type) {
      case "lexical_thinking_start":
        output.push({
          trace: event.trace,
          actor: event.actor,
          team: event.team,
          event_type: "syntactic_thinking_start",
        });
        break;
      case "lexical_thinking_end":
        output.push(...flushTextState(state, channel, event.trace, event.actor, event.team));
        state = newTextParseState();
        output.push({
          trace: event.trace,
          actor: event.actor,
          team: event.team,
          event_type: "syntactic_thinking_end",
        });
        break;
      case "lexical_content_start":
        output.push({
          trace: event.trace,
          actor: event.actor,
          team: event.team,
          event_type: "syntactic_content_start",
        });
        break;
      case "lexical_content_end":
        output.push(...flushTextState(state, channel, event.trace, event.actor, event.team));
        state = newTextParseState();
        output.push({
          trace: event.trace,
          actor: event.actor,
          team: event.team,
          event_type: "syntactic_content_end",
        });
        break;
      case "lexical_thinking_delta":
      case "lexical_content_delta": {
        const result = processTextChunk(
          state,
          event.text,
          channel,
          event.trace,
          event.actor,
          event.team,
        );
        state = result.state;
        output.push(...result.events);
        break;
      }
      case "lexical_unquote_start":
        state = {
          ...state,
          mode: "unquote",
          unquoteBuffer: "",
        };
        break;
      case "lexical_unquote_delta":
        state = {
          ...state,
          unquoteBuffer: state.unquoteBuffer + event.text,
        };
        break;
      case "lexical_unquote_end":
        output.push(
          ...flushExplicitUnquote(state, event.trace, event.actor, event.team, channel),
        );
        state = {
          ...state,
          mode: "normal",
          unquoteBuffer: "",
        };
        break;
      default:
        break;
    }
  }

  output.push(
    ...flushTextState(
      state,
      channel,
      currentContext.trace,
      currentContext.actor,
      currentContext.team,
    ),
  );
  return output;
}

function parseToolCallStream(events: LexicalControlEvents[]): SyntacticToolEvents[] {
  const output: SyntacticToolEvents[] = [];
  let state = newToolCallParseState();
  let currentContext = {
    trace: DEFAULT_TRACE,
    actor: DEFAULT_ACTOR,
    team: DEFAULT_TEAM,
  };

  const emitAccumulators = () => {
    const ordered = [...state.accumulators.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, accumulator] of ordered) {
      if (!accumulator.functionName) {
        continue;
      }
      output.push({
        trace: currentContext.trace,
        actor: currentContext.actor,
        team: currentContext.team,
        event_type: "syntactic_tool_call",
        tool_call: {
          tool_call_id: accumulator.toolCallId || accumulator.functionName,
          tool_name: accumulator.functionName,
          arguments_text: accumulator.functionArguments,
          protocol: "openai",
          call_kind: "json_function",
          raw_payload_text: JSON.stringify(
            {
              id: accumulator.toolCallId || accumulator.functionName,
              type: accumulator.toolCallType || "function",
              function: {
                name: accumulator.functionName,
                arguments: accumulator.functionArguments,
              },
            },
            null,
            0,
          ),
        },
        source: "toolcall",
      });
    }
    state = newToolCallParseState();
  };

  for (const event of events) {
    if (
      event.event_type === "lexical_tool_call_start" ||
      event.event_type === "lexical_tool_call_delta" ||
      event.event_type === "lexical_tool_call_end"
    ) {
      currentContext = {
        trace: event.trace,
        actor: event.actor,
        team: event.team,
      };
    }

    switch (event.event_type) {
      case "lexical_tool_call_start":
        state = newToolCallParseState();
        state.started = true;
        break;
      case "lexical_tool_call_delta":
        if (!state.started) {
          state.started = true;
        }
        processToolCallDelta(state, event.tool_call_delta);
        break;
      case "lexical_tool_call_end":
        emitAccumulators();
        break;
      default:
        break;
    }
  }

  return output;
}

function parseControlStream(events: LexicalControlEvents[]): SyntacticErrorEvent[] {
  const output: SyntacticErrorEvent[] = [];
  for (const event of events) {
    if (event.event_type !== "lexical_error") {
      continue;
    }

    output.push({
      trace: event.trace,
      actor: event.actor,
      team: event.team,
      event_type: "syntactic_error",
      source: "parser",
      raw_text: event.error.detail_text,
      errors: [event.error],
    });
  }
  return output;
}

function mapThinkingEvent(
  event: SyntacticThinkingEvents,
): SemanticThinkingEvents {
  switch (event.event_type) {
    case "syntactic_thinking_start":
      return {
        trace: event.trace,
        actor: event.actor,
        team: event.team,
        event_type: "semantic_think_start",
      };
    case "syntactic_thinking_delta":
      return {
        trace: event.trace,
        actor: event.actor,
        team: event.team,
        event_type: "semantic_think_delta",
        text: event.text,
      };
    case "syntactic_thinking_end":
      return {
        trace: event.trace,
        actor: event.actor,
        team: event.team,
        event_type: "semantic_think_end",
      };
  }
}

function mapContentEvent(
  event: SyntacticContentEvents,
): SemanticContentEvents {
  switch (event.event_type) {
    case "syntactic_content_start":
      return {
        trace: event.trace,
        actor: event.actor,
        team: event.team,
        event_type: "semantic_content_start",
      };
    case "syntactic_content_delta":
      return {
        trace: event.trace,
        actor: event.actor,
        team: event.team,
        event_type: "semantic_content_delta",
        text: event.text,
      };
    case "syntactic_content_end":
      return {
        trace: event.trace,
        actor: event.actor,
        team: event.team,
        event_type: "semantic_content_end",
      };
  }
}

function isSyntacticThinkingEvent(event: SyntacticEvent): event is SyntacticThinkingEvents {
  return (
    event.event_type === "syntactic_thinking_start" ||
    event.event_type === "syntactic_thinking_delta" ||
    event.event_type === "syntactic_thinking_end"
  );
}

function isSyntacticContentEvent(event: SyntacticEvent): event is SyntacticContentEvents {
  return (
    event.event_type === "syntactic_content_start" ||
    event.event_type === "syntactic_content_delta" ||
    event.event_type === "syntactic_content_end"
  );
}

function isSyntacticToolEvent(event: SyntacticEvent): event is SyntacticToolEvents {
  return (
    event.event_type === "syntactic_quote" ||
    event.event_type === "syntactic_structured_node" ||
    event.event_type === "syntactic_tool_call" ||
    event.event_type === "syntactic_tool_text"
  );
}

function isSyntacticErrorEvent(event: SyntacticEvent): event is SyntacticErrorEvent {
  return event.event_type === "syntactic_error";
}

function isSemanticThinkingEvent(event: SemanticEvent): event is SemanticThinkingEvents {
  return (
    event.event_type === "semantic_think_start" ||
    event.event_type === "semantic_think_delta" ||
    event.event_type === "semantic_think_end"
  );
}

function isSemanticContentEvent(event: SemanticEvent): event is SemanticContentEvents {
  return (
    event.event_type === "semantic_content_start" ||
    event.event_type === "semantic_content_delta" ||
    event.event_type === "semantic_content_end"
  );
}

function newTextParseState(): TextParseState {
  return {
    mode: "normal",
    pending: "",
    quoteBuffer: "",
    unquoteBuffer: "",
  };
}

function newToolCallParseState(): ToolCallParseState {
  return {
    started: false,
    accumulators: new Map(),
  };
}

function processTextChunk(
  state: TextParseState,
  chunk: string,
  channel: TextChannel,
  trace: TraceData,
  actor: ActorRefData,
  team: TeamRefData,
): {
  state: TextParseState;
  events: Array<SyntacticThinkingEvents | SyntacticContentEvents | SyntacticToolEvents>;
} {
  let buffer = state.pending + chunk;
  let mode = state.mode;
  let quoteBuffer = state.quoteBuffer;
  let unquoteBuffer = state.unquoteBuffer;
  const events: Array<SyntacticThinkingEvents | SyntacticContentEvents | SyntacticToolEvents> = [];

  while (buffer.length > 0) {
    if (mode === "quote") {
      const combined = quoteBuffer + buffer;
      const markerIndex = combined.indexOf("!quote_end");
      if (markerIndex >= 0) {
        events.push(buildQuoteEvent(trace, actor, team, channel, normalizeQuoteContent(combined.slice(0, markerIndex))));
        buffer = consumeLeadingWhitespace(combined.slice(markerIndex + "!quote_end".length));
        mode = "normal";
        quoteBuffer = "";
        continue;
      }

      quoteBuffer = combined;
      buffer = "";
      break;
    }

    if (mode === "unquote") {
      const combined = unquoteBuffer + buffer;
      const markerIndex = combined.indexOf("!unquote_end");
      if (markerIndex >= 0) {
        events.push(buildNodeEvent(trace, actor, team, channel, combined.slice(0, markerIndex)));
        buffer = consumeLeadingWhitespace(combined.slice(markerIndex + "!unquote_end".length));
        mode = "normal";
        unquoteBuffer = "";
        continue;
      }

      unquoteBuffer = combined;
      buffer = "";
      break;
    }

    const marker = findNextStartMarker(buffer);
    if (!marker) {
      const { emitText, keepTail } = splitSafeTail(buffer);
      if (emitText) {
        events.push(buildDeltaEvent(trace, actor, team, channel, emitText));
      }
      return {
        state: {
          mode,
          pending: keepTail,
          quoteBuffer,
          unquoteBuffer,
        },
        events,
      };
    }

    const before = buffer.slice(0, marker.index);
    if (before) {
      events.push(buildDeltaEvent(trace, actor, team, channel, before));
    }

    buffer = consumeLeadingWhitespace(buffer.slice(marker.index + marker.token.length));
    if (marker.token === "!quote_start") {
      mode = "quote";
      quoteBuffer = "";
      continue;
    }

    mode = "unquote";
    unquoteBuffer = "";
  }

  return {
    state: {
      mode,
      pending: "",
      quoteBuffer,
      unquoteBuffer,
    },
    events,
  };
}

function flushTextState(
  state: TextParseState,
  channel: TextChannel,
  trace: TraceData,
  actor: ActorRefData,
  team: TeamRefData,
): Array<SyntacticThinkingEvents | SyntacticContentEvents | SyntacticToolEvents | SyntacticErrorEvent> {
  if (state.mode === "unquote") {
    return [
      buildErrorEvent(
        trace,
        actor,
        team,
        "Unclosed !unquote_start block",
        state.unquoteBuffer + state.pending,
      ),
    ];
  }

  if (state.mode === "quote") {
    return [buildQuoteEvent(trace, actor, team, channel, state.quoteBuffer + state.pending)];
  }

  if (!state.pending) {
    return [];
  }

  return [buildDeltaEvent(trace, actor, team, channel, state.pending)];
}

function flushExplicitUnquote(
  state: TextParseState,
  trace: TraceData,
  actor: ActorRefData,
  team: TeamRefData,
  channel: TextChannel,
): SyntacticStructuredNodeEvent[] {
  if (!state.unquoteBuffer.trim()) {
    return [];
  }

  return [buildNodeEvent(trace, actor, team, channel, state.unquoteBuffer)];
}

function flushToolCallState(
  state: ToolCallParseState,
  trace: TraceData,
  actor: ActorRefData,
  team: TeamRefData,
): SyntacticToolCallEvent[] {
  const output: SyntacticToolCallEvent[] = [];
  const ordered = [...state.accumulators.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, accumulator] of ordered) {
    if (!accumulator.functionName) {
      continue;
    }
    output.push({
      trace,
      actor,
      team,
      event_type: "syntactic_tool_call",
      tool_call: {
        tool_call_id: accumulator.toolCallId || accumulator.functionName,
        tool_name: accumulator.functionName,
        arguments_text: accumulator.functionArguments,
        protocol: "openai",
        call_kind: "json_function",
        raw_payload_text: JSON.stringify(
          {
            id: accumulator.toolCallId || accumulator.functionName,
            type: accumulator.toolCallType || "function",
            function: {
              name: accumulator.functionName,
              arguments: accumulator.functionArguments,
            },
          },
          null,
          0,
        ),
      },
      source: "toolcall",
    });
  }
  return output;
}

function buildDeltaEvent(
  trace: TraceData,
  actor: ActorRefData,
  team: TeamRefData,
  channel: TextChannel,
  text: string,
): SyntacticThinkingDeltaEvent | SyntacticContentDeltaEvent {
  if (channel === "thinking") {
    return {
      trace,
      actor,
      team,
      event_type: "syntactic_thinking_delta",
      text,
      source: "thinking",
    };
  }

  return {
    trace,
    actor,
    team,
    event_type: "syntactic_content_delta",
    text,
    source: "content",
  };
}

function buildQuoteEvent(
  trace: TraceData,
  actor: ActorRefData,
  team: TeamRefData,
  channel: TextChannel,
  text: string,
): SyntacticQuoteEvent {
  return {
    trace,
    actor,
    team,
    event_type: "syntactic_quote",
    source: channel,
    text: text.trim(),
  };
}

function buildNodeEvent(
  trace: TraceData,
  actor: ActorRefData,
  team: TeamRefData,
  channel: TextChannel,
  rawText: string,
): SyntacticStructuredNodeEvent {
  const errors: ErrorData[] = [];
  const nodes = parseStructuredNodes(rawText, errors);

  return {
    trace,
    actor,
    team,
    event_type: "syntactic_structured_node",
    source: channel === "content" ? "unquote" : channel,
    raw_text: rawText,
    nodes,
    errors,
  };
}

function buildErrorEvent(
  trace: TraceData,
  actor: ActorRefData,
  team: TeamRefData,
  message: string,
  rawText: string,
): SyntacticErrorEvent {
  return {
    trace,
    actor,
    team,
    event_type: "syntactic_error",
    source: "parser",
    raw_text: rawText,
    errors: [
      {
        code: "",
        message,
        retryable: false,
        provider_status: 0,
        detail_text: rawText,
      },
    ],
  };
}

function buildLexicalErrorEvent(event: LexicalErrorEvent): SyntacticErrorEvent {
  return {
    trace: event.trace,
    actor: event.actor,
    team: event.team,
    event_type: "syntactic_error",
    source: "parser",
    raw_text: event.error.detail_text,
    errors: [event.error],
  };
}

function processToolCallDelta(state: ToolCallParseState, delta: ToolCallDeltaData): void {
  const index = delta.provider_call_index;
  let accumulator = state.accumulators.get(index);
  if (!accumulator) {
    accumulator = {
      toolCallId: "",
      toolCallType: "function",
      functionName: "",
      functionArguments: "",
    };
    state.accumulators.set(index, accumulator);
  }

  if (delta.provider_call_id) {
    accumulator.toolCallId = delta.provider_call_id;
  }
  if (delta.provider_call_type) {
    accumulator.toolCallType = delta.provider_call_type;
  }
  if (delta.function) {
    if (delta.function.name_fragment) {
      accumulator.functionName += delta.function.name_fragment;
    }
    if (delta.function.arguments_fragment) {
      accumulator.functionArguments += delta.function.arguments_fragment;
    }
  }
}

function parseStructuredNodes(rawText: string, errors: ErrorData[]): StructuredNodeData[] {
  const nodes: StructuredNodeData[] = [];
  const pattern = /<([a-zA-Z0-9_:-]+)([^>]*)>([\s\S]*?)<\/\1>/g;
  const attrPattern = /([a-zA-Z0-9_:-]+)\s*=\s*"([^"]*)"/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawText))) {
    const [, tag, attrTextRaw, innerTextRaw] = match;
    const attributes: StructuredNodeAttributeData[] = [];
    const attrText = attrTextRaw || "";
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrPattern.exec(attrText))) {
      attributes.push({ name: attrMatch[1], value: attrMatch[2] });
    }

    nodes.push({
      tag,
      text: (innerTextRaw || "").trim(),
      attributes,
    });
  }

  if (nodes.length === 0 && rawText.trim()) {
    errors.push({
      code: "",
      message: "XML parse error: no tags found",
      retryable: false,
      provider_status: 0,
      detail_text: rawText,
    });
  }

  return nodes;
}

function extractToolCalls(event: SyntacticStructuredNodeEvent): ToolCallData[] {
  const toolCalls: ToolCallData[] = [];

  for (const node of event.nodes) {
    if (node.tag !== "tool_call") {
      continue;
    }

    const attrs = Object.fromEntries(node.attributes.map((attribute) => [attribute.name, attribute.value]));
    const toolCallId = attrs.id || "";
    if (!toolCallId) {
      continue;
    }

    toolCalls.push({
      tool_call_id: toolCallId,
      tool_name: attrs.name || inferToolName(node.text),
      arguments_text: node.text,
      protocol: "xml",
      call_kind: "xml_tag",
      raw_payload_text: event.raw_text,
    });
  }

  return toolCalls;
}

function coalesceErrors(errors: ErrorData[], rawText: string): ErrorData {
  if (errors.length === 0) {
    return {
      code: "",
      message: "Unknown syntactic error",
      retryable: false,
      provider_status: 0,
      detail_text: rawText,
    };
  }

  if (errors.length === 1) {
    return errors[0];
  }

  return {
    code: "",
    message: errors.map((error) => error.message).filter(Boolean).join("; "),
    retryable: false,
    provider_status: 0,
    detail_text: rawText,
  };
}

function inferToolName(rawText: string): string {
  const match = rawText.match(/([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[1] ?? "tool_call";
}

function findNextStartMarker(
  buffer: string,
): { index: number; token: "!unquote_start" | "!quote_start" } | null {
  const tokens = ["!unquote_start", "!quote_start"] as const;
  let best: { index: number; token: "!unquote_start" | "!quote_start" } | null = null;

  for (const token of tokens) {
    const index = buffer.indexOf(token);
    if (index === -1) {
      continue;
    }

    const after = buffer[index + token.length];
    if (after !== undefined && !/\s/.test(after)) {
      continue;
    }

    if (!best || index < best.index) {
      best = { index, token };
    }
  }

  return best;
}

function splitSafeTail(buffer: string): { emitText: string; keepTail: string } {
  let keepTail = "";

  for (let size = 1; size < Math.min(buffer.length + 1, MAX_MARKER_LEN); size += 1) {
    const tail = buffer.slice(-size);
    if (MARKERS.some((marker) => marker.startsWith(tail))) {
      keepTail = tail;
    }
  }

  if (!keepTail) {
    return { emitText: buffer, keepTail: "" };
  }

  return {
    emitText: buffer.slice(0, buffer.length - keepTail.length),
    keepTail,
  };
}

function consumeLeadingWhitespace(text: string): string {
  return text.replace(/^\s+/, "");
}

function normalizeQuoteContent(content: string): string {
  const startIndex = content.indexOf("!unquote_start");
  const endIndex = content.lastIndexOf("!unquote_end");
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    return content.slice(startIndex + "!unquote_start".length, endIndex).trim();
  }
  return content.trim();
}
