import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

test("terminal drivers do not call aiAgentLoopStreaming directly", () => {
  const repoRoot = path.resolve(import.meta.dir, "../../../..");

  const cliEntry = path.join(repoRoot, "terminal/packages/cli/src/commands/run.ts");
  const tuiMockRuntime = path.join(repoRoot, "terminal/packages/tui/src/runtime/bridge/TuiRuntime.ts");

  const cliText = readText(cliEntry);
  const tuiText = readText(tuiMockRuntime);

  expect(cliText.includes("aiAgentLoopStreaming")).toBe(false);
  expect(tuiText.includes("aiAgentLoopStreaming")).toBe(false);
});
