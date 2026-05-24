import { describe, expect, test } from "bun:test";

import { load_stage_records } from "./stage_fixture";

import { buildSemanticTranscriptRecords } from "@cell/ai-core-logic/stream/transcript/StageTranscript";
import { runReferenceAlignedStageScenarioDetailed } from "@cell/ai-core-logic/stream/testing/referenceAlignedStageScenario";
import { LLMSemanticProjector } from "@cell/ai-organ-logic/stream/semantic/LLMSemanticProjector";

describe("reference aligned semantic projection", () => {
  test("semantic projector consumes syntactic events and reproduces semantic fixtures", async () => {
    const detail = await runReferenceAlignedStageScenarioDetailed("toolcall-delta");
    const projector = new LLMSemanticProjector();

    for (const event of detail.lexicalEvents) {
      void event;
    }

    const pipeline = await import("@cell/ai-core-logic/stream/pipeline/createLLMStagePipeline");
    const outputs = pipeline.createLLMStagePipeline(detail.lexicalEvents);
    for (const event of outputs.syntactic) {
      projector.consumeSyntacticEvent(event);
    }

    expect(buildSemanticTranscriptRecords(projector.getEvents())).toEqual(
      load_stage_records("toolcall-delta", "semantic.txt").map((record) => ({
        stream: record.stream,
        payload: record.payload,
      })),
    );
  });
});
