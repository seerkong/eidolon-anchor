import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

test("delegate-task runner does not call aiAgentLoopStreaming directly", () => {
  // import.meta.dir = backend/packages/organ/tests/AIAgent
  // repo root is 5 levels up.
  const repoRoot = path.resolve(import.meta.dir, "../../../../..");
  const filePath = path.join(repoRoot, "cell/packages/ai-organ-logic/src/agent/DelegateActor.ts");
  const text = readText(filePath);
  expect(text.includes("aiAgentLoopStreaming")).toBe(false);
});
