import type { ErrorData, StructuredNodeData, ToolCallData } from "@cell/ai-core-contract/stream/common";
import { buildDefaultTranscriptNaming } from "@cell/ai-core-contract/stream/transcriptNaming";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { SyntacticEvent } from "@cell/ai-core-contract/stream/syntactic";

import type { TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";

export function buildSyntacticTranscriptRecords(events: SyntacticEvent[]): TranscriptRecord[] {
  const naming = buildDefaultTranscriptNaming();

  const records = events.map((event) => {
    switch (event.event_type) {
      case "syntactic_thinking_start":
        return { stream: naming.streams.syntactic.thinking_start, payload: "" };
      case "syntactic_thinking_delta":
        return { stream: naming.streams.syntactic.thinking_delta, payload: event.text };
      case "syntactic_thinking_end":
        return { stream: naming.streams.syntactic.thinking_end, payload: "" };
      case "syntactic_content_start":
        return { stream: naming.streams.syntactic.content_start, payload: "" };
      case "syntactic_content_delta":
        return { stream: naming.streams.syntactic.content_delta, payload: event.text };
      case "syntactic_content_end":
        return { stream: naming.streams.syntactic.content_end, payload: "" };
      case "syntactic_quote":
        return {
          stream: naming.streams.syntactic.quote,
          payload: JSON.stringify({ source: event.source, text: event.text }),
        };
      case "syntactic_structured_node": {
        const payload: Record<string, unknown> = {
          source: event.source,
          nodes: event.nodes.map(serializeStructuredNode),
        };
        if (event.errors.length > 0) {
          payload.errors = event.errors.map(serializeError);
        }
        return {
          stream: naming.streams.syntactic.structured_node,
          payload: JSON.stringify(payload),
        };
      }
      case "syntactic_tool_call":
        return {
          stream: naming.streams.syntactic.tool_call,
          payload: JSON.stringify(serializeToolCall(event.tool_call)),
        };
      case "syntactic_tool_text":
        return { stream: naming.streams.syntactic.tool_text, payload: event.text };
      case "syntactic_error":
        return {
          stream: naming.streams.syntactic.error,
          payload: JSON.stringify({
            source: event.source,
            raw_text: event.raw_text,
            errors: event.errors.map(serializeError),
          }),
        };
    }
  });

  return withFinalJsonPayloadNewline(records);
}

export function buildSemanticTranscriptRecords(events: SemanticEvent[]): TranscriptRecord[] {
  const naming = buildDefaultTranscriptNaming();

  const records = events.flatMap((event) => {
    switch (event.event_type) {
      case "semantic_think_start":
        return [{ stream: naming.streams.semantic.think_start, payload: "" }];
      case "semantic_think_delta":
        return [{ stream: naming.streams.semantic.think_delta, payload: event.text }];
      case "semantic_think_end":
        return [{ stream: naming.streams.semantic.think_end, payload: "" }];
      case "semantic_content_start":
        return [{ stream: naming.streams.semantic.content_start, payload: "" }];
      case "semantic_content_delta":
        return [{ stream: naming.streams.semantic.content_delta, payload: event.text }];
      case "semantic_content_end":
        return [{ stream: naming.streams.semantic.content_end, payload: "" }];
      case "semantic_quote":
        return [{
          stream: naming.streams.semantic.quote,
          payload: JSON.stringify({ source: event.source, text: event.text }),
        }];
      case "semantic_tool_call_planned":
        return [{
          stream: naming.streams.semantic.tool_call_planned,
          payload: JSON.stringify(serializeToolCall(event.tool_call)),
        }];
      case "semantic_tool_call_start":
        return [{
          stream: naming.streams.semantic.tool_call_start,
          payload: JSON.stringify(serializeToolCall(event.tool_call)),
        }];
      case "semantic_tool_call_result": {
        const payload = serializeToolCall(event.tool_call);
        return [{
          stream: naming.streams.semantic.tool_call_result,
          payload: JSON.stringify({
            ...payload,
            output_text: event.output_text,
            is_error: event.is_error,
          }),
        }];
      }
      case "semantic_notice":
        return [{
          stream: naming.streams.semantic.notice,
          payload: JSON.stringify({ level: event.level, message: event.message }),
        }];
      case "semantic_error":
        return [{
          stream: naming.streams.semantic.error,
          payload: JSON.stringify(serializeError(event.error)),
        }];
      default:
        return [];
    }
  });

  return withFinalJsonPayloadNewline(records);
}

function serializeToolCall(toolCall: ToolCallData): Record<string, unknown> {
  return {
    tool_call_id: toolCall.tool_call_id,
    tool_name: toolCall.tool_name,
    arguments_text: toolCall.arguments_text,
    protocol: toolCall.protocol,
    call_kind: toolCall.call_kind,
  };
}

function serializeStructuredNode(node: StructuredNodeData): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tag: node.tag,
    text: node.text,
  };

  if (node.attributes.length > 0) {
    payload.attrs = Object.fromEntries(
      node.attributes.map((attribute) => [attribute.name, attribute.value]),
    );
  }

  return payload;
}

function serializeError(error: ErrorData): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    provider_status: error.provider_status,
    detail_text: error.detail_text,
  };
}

function withFinalJsonPayloadNewline(records: TranscriptRecord[]): TranscriptRecord[] {
  if (records.length === 0) {
    return records;
  }

  const next = [...records];
  const last = next[next.length - 1]!;
  if (last.payload && isJsonPayload(last.payload) && !last.payload.endsWith("\n")) {
    next[next.length - 1] = {
      ...last,
      payload: `${last.payload}\n`,
    };
  }
  return next;
}

function isJsonPayload(payload: string): boolean {
  const trimmed = payload.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}
