import { describe, expect, test } from "bun:test";

import { load_stage_records, resolve_stage_path } from "./stage_fixture";

const SCENARIOS = [
  "default",
  "chunked-markers",
  "content-unquote",
  "quote-chunked",
  "toolcall-delta",
  "toolcall-multiple",
  "toolcall-alt-format",
] as const;

const STAGE_FILES = [
  "lexical.txt",
  "syntactic.txt",
  "semantic.txt",
] as const;

describe("reference aligned stage pipeline fixtures", () => {
  for (const scenario of SCENARIOS) {
    test(`ships ${scenario} stage fixtures with canonical transcript naming`, () => {
      for (const fileName of STAGE_FILES) {
        const filePath = resolve_stage_path(scenario, fileName);
        expect(Bun.file(filePath).size).toBeGreaterThan(0);

        const records = load_stage_records(scenario, fileName);
        expect(records.length).toBeGreaterThan(0);
      }
    });
  }

  test("replays the reference-aligned stage fixtures through the canonical pipeline", async () => {
    const { runReferenceAlignedStageScenario } = await import(
      "@cell/ai-core-logic/stream/testing/referenceAlignedStageScenario"
    );

    for (const scenario of SCENARIOS) {
      const actual = await runReferenceAlignedStageScenario(scenario);
      const expected = {
        lexical: load_stage_records(scenario, "lexical.txt").map((record) => ({
          stream: record.stream,
          payload: record.payload,
        })),
        syntactic: load_stage_records(scenario, "syntactic.txt").map((record) => ({
          stream: record.stream,
          payload: record.payload,
        })),
        semantic: load_stage_records(scenario, "semantic.txt").map((record) => ({
          stream: record.stream,
          payload: record.payload,
        })),
      };

      expect(actual).toEqual(expected);
    }
  });
});
