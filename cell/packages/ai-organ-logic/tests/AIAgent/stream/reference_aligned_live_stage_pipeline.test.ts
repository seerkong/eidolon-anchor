import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import type { LexicalEvent } from "@cell/ai-core-contract/stream/lexical";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { SyntacticEvent } from "@cell/ai-core-contract/stream/syntactic";
import { createLLMStagePipeline, LiveLLMStagePipeline } from "@cell/ai-core-logic";

import { load_ingress_records } from "./ingress_fixture";

describe("reference aligned live stage pipeline", () => {
  test("routes ingress through the shared reference-aligned stage graph kernel", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
    const stagePipelineSource = fs.readFileSync(
      path.join(repoRoot, "cell/packages/ai-core-logic/src/stream/pipeline/createLLMStagePipeline.ts"),
      "utf-8",
    );
    const livePipelineSource = fs.readFileSync(
      path.join(repoRoot, "cell/packages/ai-core-logic/src/stream/pipeline/LiveLLMStagePipeline.ts"),
      "utf-8",
    );
    const semanticPipelineSource = fs.readFileSync(
      path.join(repoRoot, "cell/packages/ai-organ-logic/src/stream/SemanticStreamPipeline.ts"),
      "utf-8",
    );

    expect(stagePipelineSource).toContain("new DataGraph");
    expect(stagePipelineSource).toContain("defineGraphModule");
    expect(stagePipelineSource).toContain("mountGraph");
    expect(stagePipelineSource).toContain("ReferenceAlignedStageDataGraph");
    expect(livePipelineSource).toContain("ReferenceAlignedStageDataGraph");
    expect(semanticPipelineSource).toContain("AppendOnlyEventLog");
  });

  test("streams many small content chunks without dropping the final safe tail", () => {
    const semanticEvents: SemanticEvent[] = [];
    const pipeline = new LiveLLMStagePipeline(
      { agentKey: "main", agentActorId: "actor-1" },
      {
        onSemanticEvent: (event) => semanticEvents.push(event),
      },
    );
    const chunks = Array.from({ length: 1200 }, (_, index) => {
      const markerLikeTail = index % 17 === 0 ? "!quo" : "";
      return `第${index}段内容，用于验证长文本流式输出不会卡顿或丢失尾部。${markerLikeTail}`;
    });

    for (const chunk of chunks) {
      pipeline.consumeTimelineEvent({ event: "content", data: chunk });
    }
    pipeline.finish();

    const streamedText = semanticEvents
      .filter((event): event is Extract<SemanticEvent, { event_type: "semantic_content_delta" }> => event.event_type === "semantic_content_delta")
      .map((event) => event.text)
      .join("");

    expect(streamedText).toBe(chunks.join(""));
    expect(semanticEvents.at(0)?.event_type).toBe("semantic_content_start");
    expect(semanticEvents.at(-1)?.event_type).toBe("semantic_content_end");
  });

  for (const scenario of ["default", "toolcall-delta", "toolcall-multiple", "toolcall-alt-format"] as const) {
    test(`keeps live final stage outputs in parity with replay for ${scenario}`, () => {
      const live = runLiveScenarioDetailed(scenario);
      const replay = createLLMStagePipeline(live.lexicalEvents);

      expect(live.outputs.syntactic).toEqual(replay.syntactic);
      expect(live.outputs.semantic).toEqual(replay.semantic);
    });
  }

  test("derives the expected default semantic tool-call payload through the shared kernel", () => {
    const live = runLiveScenarioDetailed("default");

    expect(
      live.outputs.semantic.find((event) => event.event_type === "semantic_tool_call_planned"),
    ).toMatchObject({
      event_type: "semantic_tool_call_planned",
      tool_call: {
        tool_call_id: "query_order_xxx",
        tool_name: "Custom",
        arguments_text: "Custom.orderDetail(`ORDER-1234`)",
      },
    });
  });

  test("coalesces toolcall delta ingress events into semantic_tool_call_planned", () => {
    const { outputs } = runLiveScenarioDetailed("toolcall-delta");

    expect(outputs.semantic).toEqual([
      expect.objectContaining({
        event_type: "semantic_tool_call_planned",
        tool_call: expect.objectContaining({
          tool_name: "get_weather",
          arguments_text: "{\"location\": \"San Francisco, US\"}",
        }),
      }),
    ]);
  });

  test("coalesces multiple tool calls from one ingress stream", () => {
    const { outputs } = runLiveScenarioDetailed("toolcall-multiple");

    expect(outputs.semantic).toEqual([
      expect.objectContaining({
        event_type: "semantic_tool_call_planned",
        tool_call: expect.objectContaining({
          tool_call_id: "call_123",
          tool_name: "get_weather",
          arguments_text: "{\"location\":\"SF\"}",
        }),
      }),
      expect.objectContaining({
        event_type: "semantic_tool_call_planned",
        tool_call: expect.objectContaining({
          tool_call_id: "call_456",
          tool_name: "get_time",
          arguments_text: "{\"timezone\":\"PST\"}",
        }),
      }),
    ]);
  });

  test("accepts split alt-format tool-call arguments from ingress deltas", () => {
    const { outputs } = runLiveScenarioDetailed("toolcall-alt-format");

    expect(outputs.semantic).toEqual([
      expect.objectContaining({
        event_type: "semantic_tool_call_planned",
        tool_call: expect.objectContaining({
          tool_call_id: "abcd",
          tool_name: "get_weather",
          arguments_text: "{\"location\": \"San Francisco, US\"}",
        }),
      }),
    ]);
  });
});

function denormalizeIngressStream(stream: string): string {
  switch (stream) {
    case "ingressControl":
      return "control";
    case "ingressThink":
      return "think";
    case "ingressContent":
      return "content";
    case "ingressTool":
      return "tool";
    default:
      return stream;
  }
}

function runLiveScenarioDetailed(scenario: string): {
  lexicalEvents: LexicalEvent[];
  syntacticEvents: SyntacticEvent[];
  semanticEvents: SemanticEvent[];
  outputs: ReturnType<LiveLLMStagePipeline["getOutputs"]>;
} {
  const lexicalEvents: LexicalEvent[] = [];
  const syntacticEvents: SyntacticEvent[] = [];
  const semanticEvents: SemanticEvent[] = [];
  const pipeline = new LiveLLMStagePipeline(
    { agentKey: "main", agentActorId: "actor-1" },
    {
      onLexicalEvent: (event) => lexicalEvents.push(event),
      onSyntacticEvent: (event) => syntacticEvents.push(event),
      onSemanticEvent: (event) => semanticEvents.push(event),
    },
  );

  for (const record of load_ingress_records(scenario)) {
    pipeline.consumeTimelineEvent({
      event: denormalizeIngressStream(record.stream),
      data: record.payload.trim(),
    });
  }
  pipeline.finish();
  return { lexicalEvents, syntacticEvents, semanticEvents, outputs: pipeline.getOutputs() };
}
