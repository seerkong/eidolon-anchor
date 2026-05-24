import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");

const REMOVED_LEGACY_ENTRYPOINTS = [
  "terminal/packages/organ/src/AIAgent/ActorScopedTuiConsumer.ts",
  "terminal/packages/organ/src/AIAgent/SessionStreamGraph.ts",
  "terminal/packages/organ/src/AIAgent/TextualEventGraph.ts",
  "terminal/packages/organ/src/AIAgent/TuiEventGraph.ts",
  "backend/packages/organ/tests/AIAgent/stream/llm_graph_pipeline.test.ts",
  "backend/packages/organ/tests/AIAgent/stream/llm_semantic_graph.test.ts",
  "backend/packages/organ/tests/AIAgent/stream/stream_events.test.ts",
  "backend/packages/organ/tests/AIAgent/stream/transcript_fixture.ts",
] as const;

describe("reference aligned stage phase-1 guardrails", () => {
  test("removes legacy runtime and terminal entry points instead of leaving dormant compatibility shells", () => {
    for (const relativePath of REMOVED_LEGACY_ENTRYPOINTS) {
      const absolutePath = path.join(repoRoot, relativePath);
      expect(fs.existsSync(absolutePath)).toBe(false);
    }
  });

  test("requires stream fixtures to use canonical stage transcript naming", () => {
    const resourceRoot = path.join(repoRoot, "cell/packages/ai-organ-logic/tests/resources/stages");
    const scenarioDirs = fs.readdirSync(resourceRoot).sort();
    expect(scenarioDirs.length).toBeGreaterThan(0);

    for (const scenario of scenarioDirs) {
      const scenarioPath = path.join(resourceRoot, scenario);
      const entries = fs.readdirSync(scenarioPath).sort();
      expect(entries).toEqual([
        "lexical.txt",
        "semantic.txt",
        "syntactic.txt",
      ]);
    }
  });
});
