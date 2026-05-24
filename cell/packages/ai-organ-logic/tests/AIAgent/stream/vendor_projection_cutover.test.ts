import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");

describe("vendor projection cutover", () => {
  it("uses vendor reducer projection for shared stateful projections", () => {
    const messageHistorySource = fs.readFileSync(
      path.join(repoRoot, "cell/packages/core-logic/src/stream/MessageHistoryGraph.ts"),
      "utf-8",
    );
    const tuiTextSource = fs.readFileSync(
      path.join(repoRoot, "terminal/packages/organ/src/stream/TuiTextGraph.ts"),
      "utf-8",
    );

    expect(messageHistorySource).toContain("createReducerProjection");
    expect(tuiTextSource).toContain("createReducerProjection");
  });

  it("keeps the symbiont stream facade explicitly marked as compatibility-only", () => {
    const streamFacadeSource = fs.readFileSync(
      path.join(repoRoot, "cell/packages/symbiont-contract/src/stream/stream.ts"),
      "utf-8",
    );

    expect(streamFacadeSource).toContain("Compatibility facade");
    expect(streamFacadeSource).toContain("depa-data-graph-core");
  });
});
