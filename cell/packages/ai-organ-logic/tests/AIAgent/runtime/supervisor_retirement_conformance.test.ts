import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { createToolCallDomainRuntime } from "@cell/ai-organ-logic/runtime/ToolCallDomainRuntime";

// From tests/AIAgent/runtime → up 4 = cell/packages.
const cellPackagesRoot = path.resolve(import.meta.dir, "../../../..");
const terminalPackagesRoot = path.resolve(cellPackagesRoot, "../../terminal/packages");

const FORBIDDEN_SUPERVISOR_SYMBOL = /AiRuntimeTurnSupervisor|TurnSupervisor/;

function walkTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...walkTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(fullPath);
    }
  }
  return files;
}

function scanPackageSrcForSupervisor(packagesRoot: string): string[] {
  const offenders: string[] = [];
  if (!fs.existsSync(packagesRoot)) return offenders;
  for (const pkg of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = path.join(packagesRoot, pkg.name, "src");
    if (!fs.existsSync(srcDir)) continue;
    for (const file of walkTypeScriptFiles(srcDir)) {
      if (FORBIDDEN_SUPERVISOR_SYMBOL.test(fs.readFileSync(file, "utf8"))) {
        offenders.push(path.relative(packagesRoot, file));
      }
    }
  }
  return offenders;
}

describe("supervisor retirement (source-level)", () => {
  it("has no AiRuntimeTurnSupervisor / TurnSupervisor symbol anywhere in cell or terminal src", () => {
    const offenders = [...scanPackageSrcForSupervisor(cellPackagesRoot), ...scanPackageSrcForSupervisor(terminalPackagesRoot)];
    expect(offenders).toEqual([]);
  });
});

describe("tool_call_id consumed-once defense (replaces the retired guardrail)", () => {
  it("rejects a second result for the same tool_call_id and preserves the first", () => {
    const domain = createToolCallDomainRuntime();
    domain.planTool({ toolCallId: "tc", actorKey: "a", turnId: 1, funcName: "read_file", args: {}, at: 1 });
    domain.recordGateDecision({ toolCallId: "tc", gateOutcome: "allow", at: 2 });
    domain.markExecuting({ toolCallId: "tc", at: 3 });
    domain.recordResult({ toolCallId: "tc", outputText: "first", at: 4 });

    // The data-layer root-cause defense: the same tool_call_id can neither be
    // re-resulted nor re-planned (this is what made the supervisor redundant).
    expect(() => domain.recordResult({ toolCallId: "tc", outputText: "second", at: 5 })).toThrow();
    expect(() => domain.planTool({ toolCallId: "tc", actorKey: "a", turnId: 1, funcName: "read_file", args: {}, at: 6 })).toThrow();
    expect(domain.getRecord("tc")?.outputText).toBe("first");
  });
});
