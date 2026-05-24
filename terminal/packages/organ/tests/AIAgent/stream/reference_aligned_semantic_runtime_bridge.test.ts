import { describe, expect, test } from "bun:test";

import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import { buildRuntimeSemanticBase } from "@cell/ai-core-logic/stream/runtime/SemanticRuntimeSupport";

import { SemanticTerminalRuntimeBridge } from "@terminal/organ/stream/SemanticTerminalRuntimeBridge";

describe("reference aligned semantic runtime bridge", () => {
  test("maps semantic events into terminal tui output", () => {
    const bridge = new SemanticTerminalRuntimeBridge();
    const events: string[] = [];
    bridge.onTuiEvent((event) => {
      events.push(event.kind === "control" ? `control:${event.payload.category ?? ""}` : `message:${String(event.payload)}`);
    });

    for (const event of makeSemanticStreamEvents()) {
      bridge.consumeSemanticEvent(event);
    }

    expect(events).toEqual([
      "control:think",
      "message:thinking",
      "control:assist",
      "message:answer",
      "control:toolcall",
      "message:searchDocs\n{\"q\":\"semantic\"}\n",
    ]);
  });

  test("maps protocol and detached background events into visible terminal output", () => {
    const bridge = new SemanticTerminalRuntimeBridge();
    const events: string[] = [];
    bridge.onTuiEvent((event) => {
      events.push(
        event.kind === "control"
          ? `control:${event.payload.category ?? ""}`
          : `message:${String(event.payload)}`,
      );
    });

    for (const event of makeSemanticControlEvents()) {
      bridge.consumeSemanticEvent(event);
    }

    expect(events).toEqual([
      "control:questionnaire",
      "message:Plan approval plan-1\nreview this plan\n",
      "control:result",
      "message:Plan approval approved: looks good\n",
      "control:notice",
      "message:Shutdown request shutdown-1 worker-1\nmaintenance\n",
      "control:result",
      "message:Shutdown approved worker-1\nok to stop\n",
      "control:result",
      "message:bg-1: background done\n",
    ]);
  });
});

function makeSemanticStreamEvents(): SemanticEvent[] {
  const next = createSemanticBuilder();
  return [
    { ...next(), event_type: "semantic_think_start" },
    { ...next(), event_type: "semantic_think_delta", text: "thinking" },
    { ...next(), event_type: "semantic_think_end" },
    { ...next(), event_type: "semantic_content_start" },
    { ...next(), event_type: "semantic_content_delta", text: "answer" },
    { ...next(), event_type: "semantic_content_end" },
    {
      ...next(),
      event_type: "semantic_tool_call_planned",
      tool_call: {
        tool_call_id: "call-1",
        tool_name: "searchDocs",
        arguments_text: "{\"q\":\"semantic\"}",
        protocol: "openai",
        call_kind: "json_function",
        raw_payload_text: "",
      },
    },
  ];
}

function makeSemanticControlEvents(): SemanticEvent[] {
  const next = createSemanticBuilder();
  return [
    {
      ...next(),
      event_type: "semantic_plan_approval_request",
      request_id: "plan-1",
      plan_text: "review this plan",
    },
    {
      ...next(),
      event_type: "semantic_plan_approval_result",
      request_id: "plan-1",
      approved: true,
      feedback_text: "looks good",
    },
    {
      ...next(),
      event_type: "semantic_shutdown_request",
      request_id: "shutdown-1",
      target_name: "worker-1",
      reason_text: "maintenance",
    },
    {
      ...next(),
      event_type: "semantic_shutdown_result",
      request_id: "shutdown-1",
      target_name: "worker-1",
      approved: true,
      reason_text: "ok to stop",
    },
    {
      ...next(),
      event_type: "semantic_background_result",
      background_result: {
        task_id: "bg-1",
        status: "completed",
        result_text: "background done",
      },
    },
  ];
}

function createSemanticBuilder(): () => Pick<SemanticEvent, "trace" | "actor" | "team"> {
  let sequence = 0;
  return () => {
    sequence += 1;
    return buildRuntimeSemanticBase({ agentKey: "main", agentActorId: "a1" }, sequence);
  };
}
