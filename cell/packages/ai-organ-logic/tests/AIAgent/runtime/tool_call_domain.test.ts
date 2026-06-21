import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import type { ToolCallRecord } from "@cell/ai-core-contract/runtime/ToolCallDomain";
import { isTerminalToolCallStatus } from "@cell/ai-core-contract/runtime/ToolCallDomain";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { serializeVM } from "@cell/ai-core-logic/runtime/snapshot/vmSnapshot";
import {
  createToolCallDomainRuntime,
  ensureVmToolCallDomain,
  getVmToolCallDomain,
  reconstructToolResultsFromDomain,
  restoreVmToolCallDomain,
} from "@cell/ai-organ-logic/runtime/ToolCallDomainRuntime";
import { buildPendingAiGeneratedFromCompletedEffect } from "@cell/ai-organ-logic/persistence/RuntimeSnapshots";

function plan(domain: ReturnType<typeof createToolCallDomainRuntime>, toolCallId: string, at: number, funcName = "read_file"): ToolCallRecord {
  return domain.planTool({ toolCallId, actorKey: "actor-1", turnId: 1, funcName, args: { path: "README.md" }, at });
}

describe("ToolCallDomain state machine", () => {
  it("walks the allow path planned → dispatched → executing → completed", () => {
    const domain = createToolCallDomainRuntime();
    const planned = plan(domain, "tc-1", 100);
    expect(planned.status).toBe("planned");
    expect(planned.plannedAt).toBe(100);

    const dispatched = domain.recordGateDecision({ toolCallId: "tc-1", gateOutcome: "allow", at: 110 });
    expect(dispatched.status).toBe("dispatched");
    expect(dispatched.gateOutcome).toBe("allow");
    expect(dispatched.dispatchedAt).toBe(110);

    const executing = domain.markExecuting({ toolCallId: "tc-1", at: 120 });
    expect(executing.status).toBe("executing");
    expect(executing.executedAt).toBe(120);

    const completed = domain.recordResult({ toolCallId: "tc-1", outputText: "file body", at: 130 });
    expect(completed.status).toBe("completed");
    expect(completed.outputText).toBe("file body");
    expect(completed.resultAt).toBe(130);
    expect(isTerminalToolCallStatus(completed.status)).toBe(true);
  });

  it("moves a denied gate decision straight to the terminal denied status", () => {
    const domain = createToolCallDomainRuntime();
    plan(domain, "tc-deny", 200);
    const denied = domain.recordGateDecision({ toolCallId: "tc-deny", gateOutcome: "deny", at: 210 });
    expect(denied.status).toBe("denied");
    expect(denied.gateOutcome).toBe("deny");
    expect(isTerminalToolCallStatus(denied.status)).toBe(true);
    // Executing a denied tool is an invalid transition.
    expect(() => domain.markExecuting({ toolCallId: "tc-deny", at: 220 })).toThrow();
  });

  it("parks a deferred gate decision in the non-terminal deferred status", () => {
    const domain = createToolCallDomainRuntime();
    plan(domain, "tc-defer", 300);
    const deferred = domain.recordGateDecision({ toolCallId: "tc-defer", gateOutcome: "defer", at: 310 });
    expect(deferred.status).toBe("deferred");
    expect(isTerminalToolCallStatus(deferred.status)).toBe(false);
  });

  it("records a failure with an explicit failure kind", () => {
    const domain = createToolCallDomainRuntime();
    plan(domain, "tc-fail", 400);
    domain.recordGateDecision({ toolCallId: "tc-fail", gateOutcome: "allow", at: 410 });
    domain.markExecuting({ toolCallId: "tc-fail", at: 420 });
    const failed = domain.recordFailure({ toolCallId: "tc-fail", failureKind: "tool_error", outputText: "Error: boom", at: 430 });
    expect(failed.status).toBe("failed");
    expect(failed.failureKind).toBe("tool_error");
    expect(failed.outputText).toBe("Error: boom");
    expect(isTerminalToolCallStatus(failed.status)).toBe(true);
  });
});

describe("ToolCallDomain invariants", () => {
  it("rejects a duplicate tool_call_id at plan time", () => {
    const domain = createToolCallDomainRuntime();
    plan(domain, "tc-dup", 500);
    expect(() => plan(domain, "tc-dup", 501)).toThrow();
  });

  it("rejects a second result on a terminal record and preserves the first", () => {
    const domain = createToolCallDomainRuntime();
    plan(domain, "tc-once", 600);
    domain.recordGateDecision({ toolCallId: "tc-once", gateOutcome: "allow", at: 610 });
    domain.markExecuting({ toolCallId: "tc-once", at: 620 });
    domain.recordResult({ toolCallId: "tc-once", outputText: "first", at: 630 });
    expect(() => domain.recordResult({ toolCallId: "tc-once", outputText: "second", at: 640 })).toThrow();
    expect(domain.getRecord("tc-once")?.outputText).toBe("first");
  });

  it("rejects commands against an unknown tool_call_id", () => {
    const domain = createToolCallDomainRuntime();
    expect(() => domain.recordGateDecision({ toolCallId: "ghost", gateOutcome: "allow", at: 700 })).toThrow();
    expect(() => domain.markExecuting({ toolCallId: "ghost", at: 700 })).toThrow();
    expect(() => domain.recordResult({ toolCallId: "ghost", outputText: "x", at: 700 })).toThrow();
  });

  it("getActiveRecords excludes terminal records", () => {
    const domain = createToolCallDomainRuntime();
    plan(domain, "tc-active", 800);
    plan(domain, "tc-done", 801);
    domain.recordGateDecision({ toolCallId: "tc-done", gateOutcome: "allow", at: 802 });
    domain.markExecuting({ toolCallId: "tc-done", at: 803 });
    domain.recordResult({ toolCallId: "tc-done", outputText: "ok", at: 804 });

    const activeIds = domain.getActiveRecords().map((r) => r.toolCallId);
    expect(activeIds).toContain("tc-active");
    expect(activeIds).not.toContain("tc-done");
  });
});

describe("ToolCallDomain recovery rebuild", () => {
  it("reconstructs tool result messages from terminal records (not from evidence payloads)", () => {
    const domain = createToolCallDomainRuntime();
    plan(domain, "tc-r1", 900, "read_file");
    domain.recordGateDecision({ toolCallId: "tc-r1", gateOutcome: "allow", at: 901 });
    domain.markExecuting({ toolCallId: "tc-r1", at: 902 });
    domain.recordResult({ toolCallId: "tc-r1", outputText: "contents", at: 903 });

    plan(domain, "tc-r2", 910, "run_bash");
    domain.recordGateDecision({ toolCallId: "tc-r2", gateOutcome: "allow", at: 911 });
    domain.markExecuting({ toolCallId: "tc-r2", at: 912 });
    domain.recordFailure({ toolCallId: "tc-r2", failureKind: "tool_error", outputText: "Error: nope", at: 913 });

    // Still-active records are not reconstructed.
    plan(domain, "tc-r3", 920, "search");

    const rebuilt = reconstructToolResultsFromDomain(domain, { actorKey: "actor-1" });
    expect(rebuilt).toEqual([
      { toolCallId: "tc-r1", funcName: "read_file", outputText: "contents", isError: false },
      { toolCallId: "tc-r2", funcName: "run_bash", outputText: "Error: nope", isError: true },
    ]);
  });
});

describe("ToolCallDomain snapshot persistence", () => {
  it("persists domain records into the vm snapshot and restores them", () => {
    const vm = createVM({ controlActorKey: "main", actors: {} });
    const domain = ensureVmToolCallDomain(vm);
    domain.planTool({ toolCallId: "tc-x", actorKey: "main", turnId: 1, funcName: "read_file", args: { path: "a" }, at: 1 });
    domain.recordGateDecision({ toolCallId: "tc-x", gateOutcome: "allow", at: 2 });
    domain.markExecuting({ toolCallId: "tc-x", at: 3 });
    domain.recordResult({ toolCallId: "tc-x", outputText: "body", at: 4 });

    const snapshot = serializeVM(vm);
    expect(snapshot.toolCallDomain).toHaveLength(1);
    expect(snapshot.toolCallDomain?.[0]).toMatchObject({ toolCallId: "tc-x", status: "completed", outputText: "body" });

    const restoredVm = createVM({ controlActorKey: "main", actors: {} });
    restoreVmToolCallDomain(restoredVm, snapshot.toolCallDomain);
    const restored = getVmToolCallDomain(restoredVm)?.getRecord("tc-x");
    expect(restored?.status).toBe("completed");
    expect(restored?.outputText).toBe("body");
  });

  it("restores to an empty domain when the snapshot predates P4 (no field)", () => {
    const restoredVm = createVM({ controlActorKey: "main", actors: {} });
    restoreVmToolCallDomain(restoredVm, undefined);
    expect(getVmToolCallDomain(restoredVm)?.getAllRecords()).toEqual([]);
  });
});

describe("ToolCallDomain recovery reads the domain, not the (link-only) evidence (spec: recovery-reads-domain)", () => {
  const toolInflightExecState = {
    inflight: { kind: "tool", opId: "op-1", funcName: "read_file", toolCallId: "tc-1", args: { path: "x" } },
  };
  const linkOnlyResultEvidence = [
    {
      kind: "result",
      effectKind: "tool_call",
      effectId: "op-1",
      handlerKey: "read_file",
      resultId: "op-1:tool_done",
      payload: { toolCallId: "tc-1" }, // link-only: no outputText
    },
  ] as any;

  it("rebuilds the interrupted tool result's output text FROM the domain when evidence is link-only", () => {
    const domain = createToolCallDomainRuntime();
    domain.planTool({ toolCallId: "tc-1", actorKey: "a", turnId: 1, funcName: "read_file", args: {}, at: 1 });
    domain.recordGateDecision({ toolCallId: "tc-1", gateOutcome: "allow", at: 2 });
    domain.markExecuting({ toolCallId: "tc-1", at: 3 });
    domain.recordResult({ toolCallId: "tc-1", outputText: "FROM DOMAIN", at: 4 });

    const rebuilt = buildPendingAiGeneratedFromCompletedEffect(toolInflightExecState, linkOnlyResultEvidence, domain);
    expect(rebuilt).toMatchObject({ kind: "tool_done", opId: "op-1", toolCallId: "tc-1", outputText: "FROM DOMAIN" });
  });

  it("falls back to the evidence payload output text when the domain has no record (older snapshots)", () => {
    const evidenceWithOutput = [
      { ...linkOnlyResultEvidence[0], payload: { toolCallId: "tc-1", outputText: "FROM EVIDENCE" } },
    ] as any;
    const rebuilt = buildPendingAiGeneratedFromCompletedEffect(toolInflightExecState, evidenceWithOutput, null);
    expect(rebuilt).toMatchObject({ kind: "tool_done", outputText: "FROM EVIDENCE" });
  });
});

describe("ToolCallDomain evidence boundary is link-only (spec: evidence-as-audit-only / evidence-payload-shape)", () => {
  const executorSource = fs.readFileSync(
    path.resolve(import.meta.dir, "../../../src/exec/AiAgentExecutor.ts"),
    "utf8",
  );

  it("tool effect-evidence payloads carry only the tool_call_id link, not full args/output text", () => {
    // P4/D3: the ToolCallDomain owns args + output; runtime-control effect
    // evidence is demoted to audit/link-only. The pre-reduction payload shapes
    // ({ toolCallId, args } and { toolCallId, output, outputText }) must be gone.
    expect(executorSource).not.toMatch(/payload:\s*\{\s*toolCallId,\s*args\s*\}/);
    expect(executorSource).not.toMatch(/payload:\s*\{\s*toolCallId,\s*output/);
  });
});
