import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
const stagePipelinePath = path.join(
  repoRoot,
  "cell/packages/ai-core-logic/src/stream/pipeline/createLLMStagePipeline.ts",
);

describe("reference aligned stage DataGraph unified consumer contract", () => {
  test("does not read declared DataGraph state through removed addConsumer ctx.get callbacks", () => {
    const stagePipelineSource = fs.readFileSync(stagePipelinePath, "utf-8");
    const legacyCallbackReads =
      stagePipelineSource.match(/\.addConsumer\s*\([\s\S]*?\(\s*ctx\s*\)\s*=>\s*\{[\s\S]*?\bctx\.get\s*\(/g) ?? [];

    expect(
      legacyCallbackReads,
      "DataGraph addConsumer callbacks receive an effect trigger, not a ctx.get state reader",
    ).toEqual([]);
  });
});
