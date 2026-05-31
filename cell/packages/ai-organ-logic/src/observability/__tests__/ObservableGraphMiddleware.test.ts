import { describe, expect, it } from "bun:test";
import { DataGraph } from "depa-data-graph-core";
import { observableGraphMiddleware, type ObservableGraphMiddlewareOptions } from "../ObservableGraphMiddleware";
import type { ObservabilityRecord } from "@cell/ai-core-contract/runtime/Observability";

describe("observableGraphMiddleware", () => {
  function makeMiddleware(overrides?: Partial<ObservableGraphMiddlewareOptions>) {
    const records: ObservabilityRecord[] = [];
    const mw = observableGraphMiddleware({
      onRecord: (r) => records.push(r),
      ...overrides,
    });
    return { records, mw };
  }

  it("emits graph.get on beforeGet", () => {
    const { records, mw } = makeMiddleware();
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("foo", 0);

    // get triggers beforeGet
    graph.get("foo");

    const gets = records.filter((r) => r.eventName === "graph.get");
    expect(gets.length).toBe(1);
    expect(gets[0].source).toBe("domain");
    expect(gets[0].stage).toBe("start"); // before → start
    expect(gets[0].payload?.nodeId).toBe("foo");
    graph.dispose();
  });

  it("emits graph.set on afterSet", () => {
    const { records, mw } = makeMiddleware();
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("bar", 0);

    graph.set("bar", 42);

    const sets = records.filter((r) => r.eventName === "graph.set");
    expect(sets.length).toBe(1);
    expect(sets[0].source).toBe("domain");
    expect(sets[0].stage).toBe("end"); // after → end
    expect(sets[0].payload?.nodeId).toBe("bar");
    graph.dispose();
  });

  it("emits graph.nodeAdd onNodeAdd", () => {
    const { records, mw } = makeMiddleware();
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("baz", 0);

    const adds = records.filter((r) => r.eventName === "graph.nodeAdd");
    expect(adds.length).toBe(1);
    expect(adds[0].payload?.nodeId).toBe("baz");
    graph.dispose();
  });

  it("emits graph.dispose on disposal", () => {
    const { records, mw } = makeMiddleware();
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("qux", 0);
    graph.dispose();

    const disposes = records.filter((r) => r.eventName === "graph.dispose");
    expect(disposes.length).toBe(1);
  });

  it("filters by nodeId when filter is set", () => {
    const { records, mw } = makeMiddleware({
      filter: (id) => id === "a",
    });
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("a", 1);
    graph.addSignal("b", 2);

    graph.get("a");
    graph.get("b");

    const gets = records.filter((r) => r.eventName === "graph.get");
    expect(gets.length).toBe(1);
    expect(gets[0].payload?.nodeId).toBe("a");
    graph.dispose();
  });

  it("payload seq is monotonically increasing", () => {
    const { records, mw } = makeMiddleware();
    const graph = new DataGraph<undefined>(() => undefined);
    graph.use(mw);
    graph.addSignal("a", 0);
    graph.get("a");
    graph.set("a", 1);
    graph.dispose();

    const seqs = records.map((r) => r.payload?.seq as number).filter((s) => typeof s === "number");
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});
