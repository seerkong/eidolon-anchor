import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");

describe("vendor projection cutover", () => {
  it("uses unified vendor state-signal projections for shared stateful projections", () => {
    const messageHistorySource = fs.readFileSync(
      path.join(repoRoot, "cell/packages/ai-core-logic/src/stream/MessageHistoryGraph.ts"),
      "utf-8",
    );
    const execProtocolSource = fs.readFileSync(
      path.join(repoRoot, "terminal/packages/organ/src/stream/ExecProtocolGraph.ts"),
      "utf-8",
    );

    for (const source of [messageHistorySource, execProtocolSource]) {
      expect(source).toContain("new DataGraph");
      expect(source).toContain("addStreamDrivenStateSignalNode");
      expect(source).not.toContain("createReducerProjection");
    }
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
