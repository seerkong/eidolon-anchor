import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { isTerminalProviderCallStatus } from "@cell/ai-core-contract/runtime/ProviderCallDomain";
import { createProviderCallDomainRuntime } from "@cell/ai-organ-logic/runtime/ProviderCallDomainRuntime";

function start(domain: ReturnType<typeof createProviderCallDomainRuntime>, providerCallId: string, at: number) {
  return domain.startProviderCall({
    providerCallId,
    actorKey: "actor-1",
    turnId: 3,
    modelRef: "mock-model",
    modelParams: { temperature: 0.7, maxTokens: 1024 },
    toolSchemas: [{ name: "read_file", hash: "h1" }],
    promptGenerationRef: "gen-1",
    at,
  });
}

describe("ProviderCallDomain record completeness", () => {
  it("starts a provider call with full request metadata", () => {
    const domain = createProviderCallDomainRuntime();
    const record = start(domain, "pc-1", 100);
    expect(record.status).toBe("started");
    expect(record.modelRef).toBe("mock-model");
    expect(record.modelParams).toEqual({ temperature: 0.7, maxTokens: 1024 });
    expect(record.toolSchemas).toEqual([{ name: "read_file", hash: "h1" }]);
    expect(record.promptGenerationRef).toBe("gen-1");
    expect(record.startedAt).toBe(100);
    expect(record.turnId).toBe(3);
  });

  it("stamps the first token time", () => {
    const domain = createProviderCallDomainRuntime();
    start(domain, "pc-ft", 100);
    const record = domain.recordFirstToken({ providerCallId: "pc-ft", at: 120 });
    expect(record.firstTokenAt).toBe(120);
    expect(record.status).toBe("streaming");
  });

  it("completes a provider call with tool call ids", () => {
    const domain = createProviderCallDomainRuntime();
    start(domain, "pc-c", 100);
    const record = domain.completeProviderCall({ providerCallId: "pc-c", completedAt: 200, toolCallIds: ["tc-1", "tc-2"] });
    expect(record.status).toBe("completed");
    expect(record.completedAt).toBe(200);
    expect(record.toolCallIds).toEqual(["tc-1", "tc-2"]);
    expect(isTerminalProviderCallStatus(record.status)).toBe(true);
  });

  it("classifies a provider failure with an explicit failure kind", () => {
    const domain = createProviderCallDomainRuntime();
    start(domain, "pc-f", 100);
    const record = domain.failProviderCall({ providerCallId: "pc-f", failureKind: "provider_rate_limit", rawError: "429", at: 150 });
    expect(record.status).toBe("failed");
    expect(record.failureKind).toBe("provider_rate_limit");
    expect(record.rawError).toBe("429");
    expect(isTerminalProviderCallStatus(record.status)).toBe(true);
  });
});

describe("ProviderCallDomain reasoning/content split", () => {
  it("accumulates reasoning and content as two separate fact channels", () => {
    const domain = createProviderCallDomainRuntime();
    start(domain, "pc-split", 100);

    domain.appendReasoningSegment({ providerCallId: "pc-split", startAt: 110, endAt: 115, text: "let me " });
    domain.appendReasoningSegment({ providerCallId: "pc-split", startAt: 115, endAt: 120, text: "think." });
    domain.appendContentSegment({ providerCallId: "pc-split", startAt: 120, endAt: 125, text: "Hello " });
    domain.appendContentSegment({ providerCallId: "pc-split", startAt: 125, endAt: 130, text: "world." });

    const record = domain.getRecord("pc-split");
    expect(record?.reasoning?.text).toBe("let me think.");
    expect(record?.reasoning?.segments).toHaveLength(2);
    expect(record?.content?.text).toBe("Hello world.");
    expect(record?.content?.segments).toHaveLength(2);
    // The two channels are distinct facts, not a merged content_parts array.
    expect(record?.reasoning?.text).not.toBe(record?.content?.text);
  });

  it("leaves reasoning undefined when only content streams", () => {
    const domain = createProviderCallDomainRuntime();
    start(domain, "pc-content-only", 100);
    domain.appendContentSegment({ providerCallId: "pc-content-only", startAt: 110, endAt: 115, text: "just content" });
    const record = domain.getRecord("pc-content-only");
    expect(record?.content?.text).toBe("just content");
    expect(record?.reasoning).toBeUndefined();
  });
});

describe("ProviderCallDomain invariants", () => {
  it("rejects a duplicate provider_call_id at start", () => {
    const domain = createProviderCallDomainRuntime();
    start(domain, "pc-dup", 100);
    expect(() => start(domain, "pc-dup", 101)).toThrow();
  });

  it("rejects commands against an unknown provider_call_id", () => {
    const domain = createProviderCallDomainRuntime();
    expect(() => domain.recordFirstToken({ providerCallId: "ghost", at: 1 })).toThrow();
    expect(() => domain.appendContentSegment({ providerCallId: "ghost", startAt: 1, endAt: 2, text: "x" })).toThrow();
    expect(() => domain.completeProviderCall({ providerCallId: "ghost", completedAt: 1 })).toThrow();
  });

  it("rejects appending to a terminal record", () => {
    const domain = createProviderCallDomainRuntime();
    start(domain, "pc-term", 100);
    domain.completeProviderCall({ providerCallId: "pc-term", completedAt: 200 });
    expect(() => domain.appendContentSegment({ providerCallId: "pc-term", startAt: 210, endAt: 215, text: "late" })).toThrow();
  });

  it("getActiveRecords excludes terminal records", () => {
    const domain = createProviderCallDomainRuntime();
    start(domain, "pc-active", 100);
    start(domain, "pc-done", 101);
    domain.completeProviderCall({ providerCallId: "pc-done", completedAt: 200 });
    const activeIds = domain.getActiveRecords().map((r) => r.providerCallId);
    expect(activeIds).toContain("pc-active");
    expect(activeIds).not.toContain("pc-done");
  });
});

describe("reasoning is read via the domain fact, not content_parts (spec: downstream-explicit-access)", () => {
  const cellPackagesRoot = path.resolve(import.meta.dir, "../../../..");
  const terminalPackagesRoot = path.resolve(cellPackagesRoot, "../../terminal/packages");

  function walkTs(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        out.push(...walkTs(full));
      } else if (entry.isFile() && full.endsWith(".ts")) {
        out.push(full);
      }
    }
    return out;
  }

  function scanSrcForReasoningContentPartsRead(packagesRoot: string): string[] {
    const offenders: string[] = [];
    if (!fs.existsSync(packagesRoot)) return offenders;
    for (const pkg of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      for (const file of walkTs(path.join(packagesRoot, pkg.name, "src"))) {
        const text = fs.readFileSync(file, "utf8");
        // Any code that pairs content_parts with a reasoning type predicate.
        if (/content_parts[\s\S]{0,80}type\s*===\s*["']reasoning["']/.test(text)) {
          offenders.push(path.relative(packagesRoot, file));
        }
      }
    }
    return offenders;
  }

  it("the only content_parts + reasoning pairing is the executor back-compat write-guard (no render-read consumer)", () => {
    const offenders = [
      ...scanSrcForReasoningContentPartsRead(cellPackagesRoot),
      ...scanSrcForReasoningContentPartsRead(terminalPackagesRoot),
    ].filter((rel) => !rel.endsWith("exec/AiAgentExecutor.ts"));
    // Everything else must read reasoning through the ProviderCallDomain
    // accessors (getProviderReasoningFact / getLatestActorProviderReasoning).
    expect(offenders).toEqual([]);
  });
});
