import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");

const computedRuntimeTargets = [
  {
    label: "Cell DiagnosticSubgraph production source",
    path: "cell/packages/ai-organ-logic/src/observability/DiagnosticSubgraph.ts",
  },
  {
    label: "terminal organ DiagnosticSubgraph production source",
    path: "terminal/packages/organ/src/observability/DiagnosticSubgraph.ts",
  },
  {
    label: "terminal DiagnosticSubgraph fixture",
    path: "terminal/packages/organ/src/observability/__tests__/DiagnosticSubgraph.test.ts",
  },
  {
    label: "terminal createObservableGraph fixture",
    path: "terminal/packages/organ/src/observability/__tests__/createObservableGraph.test.ts",
  },
] as const;

describe("observability unified computed runtime boundary", () => {
  it("uses runtime.graph.get instead of the removed ctx.get callback API", () => {
    const violations: string[] = [];

    for (const target of computedRuntimeTargets) {
      const source = fs.readFileSync(path.join(repoRoot, target.path), "utf8");

      if (/\bctx\.get\b/.test(source)) {
        violations.push(`${target.label} still reads computed state through ctx.get`);
      }

      if (!/addComputed\s*(?:<[^>]+>)?\s*\([\s\S]*?\(\s*runtime\s*\)\s*=>[\s\S]*?runtime\.graph\.get\s*(?:<[^>]+>)?\s*\(/.test(source)) {
        violations.push(`${target.label} does not read its computed state through runtime.graph.get`);
      }
    }

    expect(violations).toEqual([]);
  });
});
