import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";
import * as depaDataGraphCore from "depa-data-graph-core";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");

describe("vendor data-graph surface boundary", () => {
  it("exports generic timeline foundations without AI-specific public surface names", () => {
    const exportedNames = Object.keys(depaDataGraphCore);

    expect(exportedNames).toContain("OrderedTimeline");
    expect(exportedNames).toContain("AppendOnlyEventLog");
    expect(exportedNames).toContain("ReducerProjection");
    expect(exportedNames).toContain("createReducerProjection");

    const aiSpecificExports = exportedNames.filter((name) =>
      /lexical|syntactic|semantic|questionnaire|toolcall|transcript/i.test(name),
    );

    expect(aiSpecificExports).toEqual([]);
  });

  it("keeps AI-specific stage and transcript semantics in cell layers", () => {
    const expectedFiles = [
      "cell/packages/core-contract/src/stream/semantic.ts",
      "cell/packages/core-logic/src/stream/transcript/StageTranscript.ts",
      "cell/packages/symbiont-logic/src/stream/OpenAICompletionsNodejsFetchStreamAdapter.ts",
    ];

    for (const relativePath of expectedFiles) {
      expect(fs.existsSync(path.join(repoRoot, relativePath))).toBe(true);
    }
  });
});
