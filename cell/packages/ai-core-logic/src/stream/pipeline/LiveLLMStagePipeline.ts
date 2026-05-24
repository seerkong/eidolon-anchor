import type { StreamEvent } from "@cell/symbiont-contract/stream/stream";
import type { ActorRefData, TeamRefData, ToolCallData, ToolCallDeltaData, TraceData } from "@cell/ai-core-contract/stream/common";
import type { LexicalContextData, LexicalEvent } from "@cell/ai-core-contract/stream/lexical";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { SyntacticEvent } from "@cell/ai-core-contract/stream/syntactic";

import type { StagePipelineOutputs } from "./createLLMStagePipeline";
import { ReferenceAlignedStageDataGraph } from "./createLLMStagePipeline";

type TextChannel = "thinking" | "content";

type CallbackMap = {
  onLexicalEvent?: (event: LexicalEvent) => void;
  onSemanticEvent?: (event: SemanticEvent) => void;
  onSyntacticEvent?: (event: SyntacticEvent) => void;
};

export class LiveLLMStagePipeline {
  private sequence = 0;
  private lexicalChunkIndex = 0;
  private readonly stageGraph: ReferenceAlignedStageDataGraph;
  private thinkingOpen = false;
  private contentOpen = false;
  private toolCallOpen = false;
  private pendingToolCallDeltas: ToolCallDeltaData[] = [];
  private actor: ActorRefData;
  private team: TeamRefData;

  constructor(
    private readonly meta: { agentKey: string; agentActorId: string },
    private readonly callbacks: CallbackMap = {},
  ) {
    this.actor = buildActorRef(meta);
    this.team = buildTeamRef();
    this.stageGraph = new ReferenceAlignedStageDataGraph({
      onLexicalEvent: (event) => {
        this.callbacks.onLexicalEvent?.(event);
      },
      onSyntacticEvent: (event) => {
        this.callbacks.onSyntacticEvent?.(event);
      },
      onSemanticEvent: (event) => {
        this.callbacks.onSemanticEvent?.(event);
      },
    });
  }

  consumeTimelineEvent(event: StreamEvent): void {
    switch (event.event) {
      case "think":
        this.ensureTextChannel("thinking");
        this.emitLexicalEvent({
          event_type: "lexical_thinking_delta",
          text: event.data,
        });
        break;
      case "content":
        this.ensureTextChannel("content");
        this.emitLexicalEvent({
          event_type: "lexical_content_delta",
          text: event.data,
        });
        break;
      case "tool":
        this.consumeToolEvent(event.data);
        break;
      case "control": {
        const parsed = safeParseJson(event.data);
        if (parsed?.event === "StreamEnd") {
          this.finish();
        }
        break;
      }
      default:
        break;
    }
  }

  finish(): void {
    this.closeToolCall();
    this.closeThinking();
    this.closeContent();
  }

  getOutputs(): StagePipelineOutputs {
    return this.stageGraph.getOutputs();
  }

  private ensureTextChannel(channel: TextChannel): void {
    this.closeToolCall();
    if (channel === "thinking") {
      if (this.contentOpen) {
        this.closeContent();
      }
      if (!this.thinkingOpen) {
        this.thinkingOpen = true;
        this.emitLexicalEvent({ event_type: "lexical_thinking_start" });
      }
      return;
    }

    if (this.thinkingOpen) {
      this.closeThinking();
    }
    if (!this.contentOpen) {
      this.contentOpen = true;
      this.emitLexicalEvent({ event_type: "lexical_content_start" });
    }
  }

  private closeThinking(): void {
    if (!this.thinkingOpen) {
      return;
    }
    this.thinkingOpen = false;
    this.emitLexicalEvent({ event_type: "lexical_thinking_end" });
  }

  private closeContent(): void {
    if (!this.contentOpen) {
      return;
    }
    this.contentOpen = false;
    this.emitLexicalEvent({ event_type: "lexical_content_end" });
  }

  private consumeToolEvent(chunk: string): void {
    const raw = safeParseJson(chunk);
    if (!raw || typeof raw !== "object") {
      return;
    }

    const delta = asToolCallDelta(raw);
    if (delta) {
      if (!this.toolCallOpen) {
        this.toolCallOpen = true;
      }
      this.pendingToolCallDeltas.push(delta);
      return;
    }

    const full = asFullToolCall(raw);
    if (!full) {
      return;
    }

    if (!this.toolCallOpen) {
      this.toolCallOpen = true;
    }
    this.pendingToolCallDeltas.push(asLexicalToolCallDelta(full));
    this.closeToolCall();
  }

  private closeToolCall(): void {
    if (!this.toolCallOpen) {
      return;
    }
    this.emitLexicalEvent({ event_type: "lexical_tool_call_start" });
    for (const delta of this.pendingToolCallDeltas) {
      this.emitLexicalEvent({
        event_type: "lexical_tool_call_delta",
        tool_call_delta: delta,
      });
    }
    this.pendingToolCallDeltas = [];
    this.toolCallOpen = false;
    this.emitLexicalEvent({ event_type: "lexical_tool_call_end" });
  }

  private emitLexicalEvent(
    event:
      | { event_type: "lexical_thinking_start" | "lexical_thinking_end" | "lexical_content_start" | "lexical_content_end" | "lexical_tool_call_start" | "lexical_tool_call_end" }
      | { event_type: "lexical_thinking_delta" | "lexical_content_delta"; text: string }
      | { event_type: "lexical_tool_call_delta"; tool_call_delta: ToolCallDeltaData },
  ): void {
    const trace = this.nextTrace();
    const lexicalEvent = {
      ...event,
      trace,
      actor: this.actor,
      team: this.team,
      lexical: buildLexicalContext(this.lexicalChunkIndex++),
    } satisfies LexicalEvent;
    this.stageGraph.consumeLexicalEvent(lexicalEvent);
  }

  private nextTrace(): TraceData {
    this.sequence += 1;
    return {
      event_id: `live-stage-${this.meta.agentActorId}-${this.sequence}`,
      actor_id: this.meta.agentActorId,
      session_id: "",
      request_id: "",
      conversation_id: "",
      stream_id: "",
      parent_event_id: "",
      causation_event_id: "",
      correlation_id: "",
      turn_id: "",
      turn_index: 0,
      sequence: this.sequence,
      emitted_at: Date.now(),
      surface: "tui",
    };
  }
}

function buildActorRef(meta: { agentKey: string; agentActorId: string }): ActorRefData {
  return {
    actor_id: meta.agentActorId,
    actor_name: meta.agentKey,
    actor_kind: meta.agentKey === "main" ? "primary" : "subagent",
    agent_definition_name: null,
    agent_manifest_type: "unknown",
    role_label: null,
    actor_projection: null,
    parent_actor_id: null,
    root_actor_id: null,
  };
}

function buildTeamRef(): TeamRefData {
  return {
    team_id: "",
    team_name: "",
    coordinator_actor_id: "",
    teammate_name: "",
    teammate_role: "",
    task_id: "",
  };
}

function buildLexicalContext(chunkIndex: number): LexicalContextData {
  return {
    provider_name: "",
    adapter_name: "",
    model_name: "",
    protocol: "unknown",
    response_id: "",
    stop_reason: "",
    chunk_index: chunkIndex,
  };
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asToolCallDelta(raw: Record<string, unknown>): ToolCallDeltaData | null {
  if (typeof raw.index !== "number") return null;
  const fn = raw.function && typeof raw.function === "object" ? (raw.function as Record<string, unknown>) : null;
  return {
    provider_call_index: raw.index,
    provider_call_id: typeof raw.id === "string" ? raw.id : "",
    provider_call_type: typeof raw.type === "string" ? raw.type : "",
    function: fn
      ? {
          name_fragment: typeof fn.name === "string" ? fn.name : "",
          arguments_fragment: typeof fn.arguments === "string" ? fn.arguments : "",
        }
      : null,
  };
}

function asFullToolCall(raw: Record<string, unknown>): ToolCallData | null {
  const fn = raw.function && typeof raw.function === "object" ? (raw.function as Record<string, unknown>) : null;
  const toolName =
    typeof raw.functionName === "string"
      ? raw.functionName
      : typeof fn?.name === "string"
        ? fn.name
        : "";
  if (!toolName) return null;
  return {
    tool_call_id: typeof raw.id === "string" ? raw.id : toolName,
    tool_name: toolName,
    arguments_text:
      typeof raw.functionArguments === "string"
        ? raw.functionArguments
        : typeof fn?.arguments === "string"
          ? fn.arguments
          : "",
    protocol: "openai",
    call_kind: "json_function",
    raw_payload_text: "",
  };
}

function asLexicalToolCallDelta(toolCall: ToolCallData): ToolCallDeltaData {
  return {
    provider_call_index: 0,
    provider_call_id: toolCall.tool_call_id,
    provider_call_type: toolCall.call_kind === "json_function" ? "function" : toolCall.call_kind,
    function: {
      name_fragment: toolCall.tool_name,
      arguments_fragment: toolCall.arguments_text,
    },
  };
}
