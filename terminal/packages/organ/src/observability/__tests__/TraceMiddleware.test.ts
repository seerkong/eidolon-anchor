import { describe, expect, it } from "bun:test";
import { DataGraph, type GraphMiddleware } from "depa-data-graph-core";
import { traceMiddleware, type TraceRecord } from "../TraceMiddleware";

describe("traceMiddleware", () => {
  it("records beforeGet for signal reads", () => {
    const records: TraceRecord[] = [];
    const mw = traceMiddleware({ onRecord: (r) => records.push(r) });
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("foo", 42);

    graph.get("foo");

    expect(records.length).toBeGreaterThanOrEqual(1);
    const getRecord = records.find((r) => r.op === "get");
    expect(getRecord).toBeDefined();
    expect(getRecord!.phase).toBe("before");
    expect(getRecord!.nodeId).toBe("foo");
    expect(getRecord!.id).toBeString();
    expect(typeof getRecord!.seq).toBe("number");
    expect(typeof getRecord!.ts).toBe("number");
  });

  it("records afterSet for signal writes", () => {
    const records: TraceRecord[] = [];
    const mw = traceMiddleware({ onRecord: (r) => records.push(r) });
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("foo", 0);

    graph.set("foo", 99);

    const setRecords = records.filter((r) => r.op === "set");
    expect(setRecords.length).toBeGreaterThanOrEqual(1);
    expect(setRecords[0].phase).toBe("after");
    expect(setRecords[0].nodeId).toBe("foo");
  });

  it("records onBatch start and end", () => {
    const records: TraceRecord[] = [];
    const mw = traceMiddleware({ onRecord: (r) => records.push(r) });
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("a", 1);
    graph.addSignal("b", 2);

    graph.batch(() => {
      graph.set("a", 10);
      graph.set("b", 20);
    });

    const batchRecords = records.filter((r) => r.op === "batch");
    expect(batchRecords.length).toBe(2);
    expect(batchRecords[0].batchPhase).toBe("start");
    expect(batchRecords[1].batchPhase).toBe("end");
  });

  it("records onNodeAdd when node is added", () => {
    const records: TraceRecord[] = [];
    const mw = traceMiddleware({ onRecord: (r) => records.push(r) });
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);

    graph.addSignal("newNode", "hello");

    const addRecords = records.filter((r) => r.op === "nodeAdd");
    expect(addRecords.length).toBe(1);
    expect(addRecords[0].nodeId).toBe("newNode");
    expect(addRecords[0].phase).toBe("after");
  });

  it("records onDispose when graph is disposed", () => {
    const records: TraceRecord[] = [];
    const mw = traceMiddleware({ onRecord: (r) => records.push(r) });
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("x", 1);

    graph.dispose();

    const disposeRecords = records.filter((r) => r.op === "dispose");
    expect(disposeRecords.length).toBe(1);
  });

  it("filters by nodeId when filter option is provided", () => {
    const records: TraceRecord[] = [];
    const mw = traceMiddleware({
      onRecord: (r) => records.push(r),
      filter: (nodeId) => nodeId === "tracked",
    });
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("tracked", 1);
    graph.addSignal("ignored", 2);

    // Read both signals
    graph.get("tracked");
    graph.get("ignored");

    // Only "tracked" reads should be recorded
    const getRecords = records.filter((r) => r.op === "get");
    const nodeIds = getRecords.map((r) => r.nodeId);
    expect(nodeIds).toContain("tracked");
    expect(nodeIds).not.toContain("ignored");
  });

  it("filter also applies to set operations", () => {
    const records: TraceRecord[] = [];
    const mw = traceMiddleware({
      onRecord: (r) => records.push(r),
      filter: (nodeId) => nodeId === "tracked",
    });
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("tracked", 0);
    graph.addSignal("ignored", 0);

    graph.set("tracked", 99);
    graph.set("ignored", 99);

    const setRecords = records.filter((r) => r.op === "set");
    const nodeIds = setRecords.map((r) => r.nodeId);
    expect(nodeIds).toContain("tracked");
    expect(nodeIds).not.toContain("ignored");
  });

  it("generates monotonically increasing sequence numbers", () => {
    const records: TraceRecord[] = [];
    const mw = traceMiddleware({ onRecord: (r) => records.push(r) });
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("a", 1);
    graph.addSignal("b", 2);

    graph.get("a");
    graph.get("b");
    graph.set("a", 10);

    const seqs = records.map((r) => r.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});
