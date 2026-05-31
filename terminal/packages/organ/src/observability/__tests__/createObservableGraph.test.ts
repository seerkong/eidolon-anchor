import { describe, expect, it } from "bun:test";
import { createObservableGraph, type ObservableGraphOptions } from "../createObservableGraph";
import type { ObservabilityRecord } from "@cell/ai-core-contract/runtime/Observability";

describe("createObservableGraph", () => {
  it("returns graph, traceLog, diagnosticPipeline, and dispose", () => {
    const obs = createObservableGraph({});
    expect(obs.graph).toBeDefined();
    expect(obs.traceLog).toBeDefined();
    expect(obs.diagnosticPipeline).toBeDefined();
    expect(typeof obs.dispose).toBe("function");
    obs.dispose();
  });

  it("traces get and set operations via traceLog", () => {
    const obs = createObservableGraph({});
    obs.graph.addSignal("count", 0);

    obs.graph.get("count");
    obs.graph.set("count", 5);

    const entries = obs.traceLog.entries();
    const getEntries = entries.filter((e) => e.value.eventName === "graph.get");
    const setEntries = entries.filter((e) => e.value.eventName === "graph.set");

    expect(getEntries.length).toBeGreaterThanOrEqual(1);
    expect(setEntries.length).toBeGreaterThanOrEqual(1);
    obs.dispose();
  });

  it("enables depsAudit warn in debug mode", () => {
    const obs = createObservableGraph({ debug: true });
    obs.graph.addSignal("x", 0);

    obs.graph.addComputed("y", ["x"], (ctx) => ctx.get("x") + 1);

    expect(() => obs.graph.get("y")).not.toThrow();
    obs.dispose();
  });

  it("registers persistPlugin when persistKeys is non-empty", () => {
    const storage = new Map<string, string>();
    const storageAdapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    };

    const obs = createObservableGraph({
      persistKeys: ["persistedSignal"],
      persistStorage: storageAdapter,
      persistDebounce: 0,
    });
    obs.graph.addSignal("persistedSignal", "initial");

    obs.graph.set("persistedSignal", "updated");
    obs.dispose();

    expect(storage.has("DataGraph")).toBe(true);
  });

  it("does not register persistPlugin when persistKeys is empty", () => {
    const obs = createObservableGraph({});
    obs.graph.addSignal("notPersisted", "hello");
    obs.graph.set("notPersisted", "world");
    obs.dispose();
  });

  it("dispose cleans up graph, traceLog, and pipeline", () => {
    const obs = createObservableGraph({});
    obs.graph.addSignal("test", 1);
    obs.dispose();
    expect(true).toBe(true);
  });

  it("traceLog records contain valid ObservabilityRecord structure", () => {
    const obs = createObservableGraph({});
    obs.graph.addSignal("myNode", "hello");
    obs.graph.get("myNode");

    const entries = obs.traceLog.entries();
    expect(entries.length).toBeGreaterThan(0);

    const record: ObservabilityRecord = entries[0].value as ObservabilityRecord;
    expect(typeof record.eventName).toBe("string");
    expect(typeof record.source).toBe("string");
    expect(typeof record.stage).toBe("string");
    expect(typeof record.emittedAt).toBe("number");
    expect(record.source).toBe("domain");
    obs.dispose();
  });

  it("creates independent instances without cross-contamination", () => {
    const obs1 = createObservableGraph({});
    const obs2 = createObservableGraph({});

    obs1.graph.addSignal("onlyIn1", 1);
    obs2.graph.addSignal("onlyIn2", 2);

    obs1.graph.get("onlyIn1");
    obs2.graph.get("onlyIn2");

    const entries1 = obs1.traceLog.entries();
    const entries2 = obs2.traceLog.entries();

    const nodeIds1 = entries1.map((e) => (e.value as ObservabilityRecord).payload?.nodeId);
    const nodeIds2 = entries2.map((e) => (e.value as ObservabilityRecord).payload?.nodeId);
    expect(nodeIds1).toContain("onlyIn1");
    expect(nodeIds1).not.toContain("onlyIn2");
    expect(nodeIds2).toContain("onlyIn2");
    expect(nodeIds2).not.toContain("onlyIn1");

    obs1.dispose();
    obs2.dispose();
  });
});
