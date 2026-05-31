import { describe, expect, it } from "bun:test";
import { createDiagnosticPipeline } from "../DiagnosticPipeline";
import type { TraceRecord } from "../TraceMiddleware";

function makeRecord(opts: Partial<TraceRecord> & { op: TraceRecord["op"]; phase: TraceRecord["phase"] }): TraceRecord {
  return {
    id: crypto.randomUUID(),
    seq: 0,
    ts: Date.now(),
    ...opts,
  };
}

describe("DiagnosticPipeline", () => {
  it("creates a pipeline with push and dispose", () => {
    const pipeline = createDiagnosticPipeline();
    expect(typeof pipeline.push).toBe("function");
    expect(typeof pipeline.dispose).toBe("function");
    pipeline.dispose();
  });

  it("pushes records through to onRecord callback", () => {
    const records: Array<any> = [];
    const pipeline = createDiagnosticPipeline({ onRecord: (r) => records.push(r) });

    pipeline.push(makeRecord({ op: "get", phase: "before", nodeId: "foo" }));
    pipeline.push(makeRecord({ op: "set", phase: "after", nodeId: "bar" }));
    pipeline.push(makeRecord({ op: "get", phase: "before", nodeId: "foo" }));

    expect(records.length).toBe(3);
    expect(records[0].nodeId).toBe("foo");
    expect(records[1].nodeId).toBe("bar");

    pipeline.dispose();
  });

  it("aggregates byNode correctly", () => {
    const results: Array<Record<string, any[]>> = [];
    const pipeline = createDiagnosticPipeline({ onByNode: (g) => results.push(g) });

    pipeline.push(makeRecord({ op: "get", phase: "before", nodeId: "a" }));
    pipeline.push(makeRecord({ op: "get", phase: "before", nodeId: "a" }));
    pipeline.push(makeRecord({ op: "set", phase: "after", nodeId: "b" }));

    expect(results.length).toBeGreaterThanOrEqual(1);
    const last = results[results.length - 1];
    expect(last["a"]?.length).toBeGreaterThanOrEqual(2);
    expect(last["b"]?.length).toBeGreaterThanOrEqual(1);

    pipeline.dispose();
  });

  it("bounds retained records per node while keeping cumulative stats", () => {
    const groups: Array<Record<string, any[]>> = [];
    const stats: Array<{ totalEvents: number; byOp: Record<string, number>; byNode: Record<string, number> }> = [];
    const pipeline = createDiagnosticPipeline({
      maxRecordsPerNode: 2,
      onByNode: (g) => groups.push(g),
      onStats: (s) => stats.push(s),
    });

    pipeline.push(makeRecord({ op: "get", phase: "before", nodeId: "a", seq: 1 }));
    pipeline.push(makeRecord({ op: "get", phase: "before", nodeId: "a", seq: 2 }));
    pipeline.push(makeRecord({ op: "get", phase: "before", nodeId: "a", seq: 3 }));

    const lastGroup = groups[groups.length - 1];
    expect(lastGroup["a"]?.map((record) => record.seq)).toEqual([2, 3]);

    const lastStats = stats[stats.length - 1];
    expect(lastStats.totalEvents).toBe(3);
    expect(lastStats.byNode.a).toBe(3);

    pipeline.dispose();
  });

  it("aggregates stats correctly", () => {
    const results: Array<{ totalEvents: number; byOp: Record<string, number>; byNode: Record<string, number> }> = [];
    const pipeline = createDiagnosticPipeline({ onStats: (s) => results.push(s) });

    pipeline.push(makeRecord({ op: "get", phase: "before", nodeId: "x" }));
    pipeline.push(makeRecord({ op: "get", phase: "before", nodeId: "x" }));
    pipeline.push(makeRecord({ op: "set", phase: "after", nodeId: "y" }));
    pipeline.push(makeRecord({ op: "batch", phase: "before", batchPhase: "start" }));

    expect(results.length).toBeGreaterThanOrEqual(1);
    const last = results[results.length - 1];
    expect(last.totalEvents).toBeGreaterThanOrEqual(4);
    expect(last.byOp["get"]).toBeGreaterThanOrEqual(2);
    expect(last.byOp["set"]).toBeGreaterThanOrEqual(1);

    pipeline.dispose();
  });

  it("dispose stops callbacks and is safe for repeated calls", () => {
    const pipeline = createDiagnosticPipeline();
    pipeline.push(makeRecord({ op: "get", phase: "before", nodeId: "test" }));
    pipeline.dispose();
    // After dispose, push should be safe (no-op)
    pipeline.push(makeRecord({ op: "get", phase: "before", nodeId: "after" }));
  });
});
