import { describe, expect, it } from "bun:test";
import { DataGraph, defineGraphModule, mountGraph, toNodeId } from "depa-data-graph-core";
import { createDiagnosticSubgraph, type DiagnosticModule } from "../DiagnosticSubgraph";

describe("DiagnosticSubgraph", () => {
  it("defines 6 signal nodes with correct types", () => {
    const mod = createDiagnosticSubgraph();

    expect(mod.nodeIds.modelSelection).toBeString();
    expect(mod.nodeIds.continuation).toBeString();
    expect(mod.nodeIds.turnTimings).toBeString();
    expect(mod.nodeIds.compactions).toBeString();
    expect(mod.nodeIds.toolStats).toBeString();
    expect(mod.nodeIds.retries).toBeString();
  });

  it("mounts as diag/ namespace with mountGraph", () => {
    const mod = createDiagnosticSubgraph();

    // All node IDs should be prefixed with diag/
    expect(mod.nodeIds.modelSelection.startsWith("diag/")).toBe(true);
    expect(mod.nodeIds.continuation.startsWith("diag/")).toBe(true);
    expect(mod.nodeIds.turnTimings.startsWith("diag/")).toBe(true);
    expect(mod.nodeIds.compactions.startsWith("diag/")).toBe(true);
    expect(mod.nodeIds.toolStats.startsWith("diag/")).toBe(true);
    expect(mod.nodeIds.retries.startsWith("diag/")).toBe(true);
  });

  it("can initialize nodes in a DataGraph", () => {
    const mod = createDiagnosticSubgraph();
    const graph = new DataGraph<undefined>(() => undefined);

    graph.addSignal(mod.nodeIds.modelSelection, null as DiagnosticModule["modelSelection"] | null);
    graph.addSignal(mod.nodeIds.continuation, null as DiagnosticModule["continuation"] | null);
    graph.addSignal(mod.nodeIds.turnTimings, [] as DiagnosticModule["turnTimings"]);
    graph.addSignal(mod.nodeIds.compactions, [] as DiagnosticModule["compactions"]);
    graph.addSignal(mod.nodeIds.toolStats, [] as DiagnosticModule["toolStats"]);
    graph.addSignal(mod.nodeIds.retries, [] as DiagnosticModule["retries"]);

    // Verify reads
    expect(graph.get<unknown>(mod.nodeIds.modelSelection)).toBe(null);
    expect(graph.get<unknown[]>(mod.nodeIds.turnTimings)).toEqual([]);

    // Write and verify
    graph.set(mod.nodeIds.modelSelection, { selectedModel: "test-model", provider: "test-provider", ts: Date.now() });
    expect(graph.get<unknown>(mod.nodeIds.modelSelection)).toBeDefined();

    graph.dispose();
  });

  it("supports computed summary node", () => {
    const mod = createDiagnosticSubgraph();
    const graph = new DataGraph<undefined>(() => undefined);

    graph.addSignal(mod.nodeIds.retries, [] as DiagnosticModule["retries"]);
    graph.addSignal(mod.nodeIds.toolStats, [] as DiagnosticModule["toolStats"]);

    // Add a summary computed node
    graph.addComputed(
      "diag/summary",
      [mod.nodeIds.retries, mod.nodeIds.toolStats],
      (ctx) => ({
        totalRetries: ctx.get<DiagnosticModule["retries"]>(mod.nodeIds.retries).length,
        totalToolCalls: ctx.get<DiagnosticModule["toolStats"]>(mod.nodeIds.toolStats).length,
      }),
    );

    graph.set(mod.nodeIds.retries, [{ ts: Date.now(), attempt: 1, reason: "timeout" }]);
    graph.set(mod.nodeIds.toolStats, [
      { ts: Date.now(), toolName: "bash", durationMs: 100, success: true },
      { ts: Date.now(), toolName: "read", durationMs: 50, success: true },
    ]);

    const summary = graph.get<{ totalRetries: number; totalToolCalls: number }>("diag/summary");
    expect(summary.totalRetries).toBe(1);
    expect(summary.totalToolCalls).toBe(2);

    graph.dispose();
  });

  it("mount method adds all 6 signals to a graph", () => {
    const mod = createDiagnosticSubgraph();
    const graph = new DataGraph<undefined>(() => undefined);

    mod.mount(graph);

    // All signals should be readable
    expect(graph.get<unknown>(mod.nodeIds.modelSelection)).toBe(null);
    expect(graph.get<unknown>(mod.nodeIds.continuation)).toBe(null);
    expect(graph.get<unknown[]>(mod.nodeIds.turnTimings)).toEqual([]);
    expect(graph.get<unknown[]>(mod.nodeIds.compactions)).toEqual([]);
    expect(graph.get<unknown[]>(mod.nodeIds.toolStats)).toEqual([]);
    expect(graph.get<unknown[]>(mod.nodeIds.retries)).toEqual([]);

    // Summary should exist and be readable
    const summary = graph.get<unknown>("diag/summary");
    expect(summary).toBeDefined();

    graph.dispose();
  });
});
