import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

function walkTsFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "build") {
        continue;
      }
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (e.isFile() && p.endsWith(".ts") && !p.endsWith(".d.ts")) {
        out.push(p);
      }
    }
  }
  return out;
}

test("only allowed files reference aiAgentLoopStreaming", () => {
  const repoRoot = path.resolve(import.meta.dir, "../../../../..");

  // Only scan production source trees.
  const searchRoots = [
    path.join(repoRoot, "cell/packages/ai-organ-logic/src"),
    path.join(repoRoot, "terminal/packages/minimal/src"),
    path.join(repoRoot, "terminal/packages/tui/src"),
  ];

  const allowedRel = new Set([
    // Single allowed loop definition guard.
    "cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts",
  ]);

  const offenders: string[] = [];
  for (const root of searchRoots) {
    for (const filePath of walkTsFiles(root)) {
      const rel = path.relative(repoRoot, filePath).replace(/\\/g, "/");
      const text = fs.readFileSync(filePath, "utf-8");
      if (!text.includes("aiAgentLoopStreaming")) {
        continue;
      }
      if (!allowedRel.has(rel)) {
        offenders.push(rel);
      }
    }
  }

  expect(offenders).toEqual([]);
});
