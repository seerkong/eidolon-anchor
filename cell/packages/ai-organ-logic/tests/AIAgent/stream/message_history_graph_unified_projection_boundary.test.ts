import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
const messageHistoryGraphPath = path.join(
  repoRoot,
  "cell/packages/ai-core-logic/src/stream/MessageHistoryGraph.ts",
);

describe("MessageHistoryGraph unified projection boundary", () => {
  it("owns history projection through one DataGraph source and a stream-driven state-signal output", () => {
    const source = fs.readFileSync(messageHistoryGraphPath, "utf8");
    const violations: string[] = [];
    const assertSource = (condition: boolean, message: string) => {
      if (!condition) violations.push(message);
    };
    const has = (pattern: RegExp) => pattern.test(source);

    assertSource(
      !has(/\b(?:ReducerProjection|createReducerProjection)\b/),
      "removed ReducerProjection/createReducerProjection APIs are absent",
    );
    assertSource(has(/\bDataGraph\b/) && has(/\bnew\s+DataGraph\b/), "MessageHistoryGraph owns a DataGraph instance");
    assertSource(has(/\.addSource\s*\([\s\S]*inputLog\.stream\s*\(\s*\)/), "inputLog.stream() is registered as a DataGraph source");
    assertSource(has(/\baddStreamDrivenStateSignalNode\s*\(/), "projection is a stream-driven state-signal node");
    assertSource(has(/addStreamDrivenStateSignalNode\s*\([\s\S]*input\s*:/), "state-signal input comes from a graph source handle");
    assertSource(
      has(/initial\s*:\s*(?:\(\s*\)\s*=>\s*)?createInitialHistoryProjectionState\s*\(\s*\)/),
      "state-signal starts from a fresh history projection state",
    );
    assertSource(
      has(/reducer\s*:\s*\([^)]*\bstate\b[^)]*,[^)]*\binput\b[^)]*\)\s*=>\s*reduceHistoryProjection\s*\(\s*state\s*,\s*input\s*\)/s),
      "state-signal reducer delegates directly to reduceHistoryProjection(state, input)",
    );
    assertSource(has(/\.get\s*\(\s*[\s\S]{0,160}\.output\s*\)/), "current completion/listener state is read through handle.output");
    assertSource(
      has(/\.output[\s\S]{0,360}(?:subscribe|createViewModelSignal|addSignalToStream|addConsumer|stream)\s*\(/) ||
        has(/(?:subscribe|createViewModelSignal|addSignalToStream|addConsumer|stream)\s*\([\s\S]{0,360}\.output/),
      "listener dispatch watches the state-signal output boundary",
    );
    assertSource(
      has(/dispose\(\):\s*void\s*\{[\s\S]*\.unsubscribe\s*\(\s*\)[\s\S]*\.dispose\s*\(\s*\)[\s\S]*inputLog\.dispose\s*\(\s*\)/),
      "dispose stops output observation and graph-owned projection lifecycle before disposing the independent input log",
    );

    expect(violations).toEqual([]);
  });
});
