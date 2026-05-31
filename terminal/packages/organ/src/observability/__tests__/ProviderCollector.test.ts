import { describe, expect, it } from "bun:test";
import { DataGraph } from "depa-data-graph-core";
import { createDiagnosticSubgraph } from "../DiagnosticSubgraph";
import { createProviderCollector, type ProviderCollector } from "../ProviderCollector";

describe("ProviderCollector", () => {
  let graph: DataGraph<undefined>;
  let diag: ReturnType<typeof createDiagnosticSubgraph>;
  let collector: ProviderCollector;

  function setup() {
    graph = new DataGraph<undefined>(() => undefined);
    diag = createDiagnosticSubgraph();
    diag.mount(graph);
    collector = createProviderCollector({ diag, graph });
    return { graph, diag, collector };
  }

  it("onModelSelection writes to diag/modelSelection", () => {
    const { graph, diag, collector } = setup();
    collector.onModelSelection({ selectedModel: "gpt-4", provider: "openai", ts: 1000 });

    const signal = graph.get<unknown>(diag.nodeIds.modelSelection) as { selectedModel: string };
    expect(signal.selectedModel).toBe("gpt-4");
    expect(signal.provider).toBe("openai");
    graph.dispose();
  });

  it("onContinuation writes to diag/continuation", () => {
    const { graph, diag, collector } = setup();
    collector.onContinuation({ fromSessionId: "s1", messageCount: 5, ts: 2000 });

    const signal = graph.get<unknown>(diag.nodeIds.continuation) as { fromSessionId: string };
    expect(signal.fromSessionId).toBe("s1");
    expect(signal.messageCount).toBe(5);
    graph.dispose();
  });

  it("onTurnPhase appends to diag/turnTimings", () => {
    const { graph, diag, collector } = setup();
    collector.onTurnPhase("request_send");
    collector.onTurnPhase("progress");

    const timings = graph.get<unknown[]>(diag.nodeIds.turnTimings) as { phase: string }[];
    expect(timings.length).toBe(2);
    expect(timings[0].phase).toBe("request_send");
    expect(timings[1].phase).toBe("progress");
    graph.dispose();
  });

  it("onCompaction appends to diag/compactions", () => {
    const { graph, diag, collector } = setup();
    collector.onCompaction({ beforeMessageCount: 20, afterMessageCount: 10, reason: "token_limit" });

    const compactions = graph.get<unknown[]>(diag.nodeIds.compactions) as { reason: string }[];
    expect(compactions.length).toBe(1);
    expect(compactions[0].reason).toBe("token_limit");
    graph.dispose();
  });

  it("onToolCall appends to diag/toolStats", () => {
    const { graph, diag, collector } = setup();
    collector.onToolCall({ toolName: "bash", durationMs: 150, success: true });

    const stats = graph.get<unknown[]>(diag.nodeIds.toolStats) as { toolName: string; success: boolean }[];
    expect(stats.length).toBe(1);
    expect(stats[0].toolName).toBe("bash");
    expect(stats[0].success).toBe(true);
    graph.dispose();
  });

  it("onRetry appends to diag/retries", () => {
    const { graph, diag, collector } = setup();
    collector.onRetry({ attempt: 1, reason: "timeout" });
    collector.onRetry({ attempt: 2, reason: "rate_limit" });

    const retries = graph.get<unknown[]>(diag.nodeIds.retries) as { attempt: number }[];
    expect(retries.length).toBe(2);
    expect(retries[0].attempt).toBe(1);
    expect(retries[1].attempt).toBe(2);
    graph.dispose();
  });

  it("summary updates when signals are written", () => {
    const { graph, diag, collector } = setup();
    collector.onToolCall({ toolName: "read", durationMs: 10, success: true });
    collector.onRetry({ attempt: 1, reason: "error" });
    collector.onCompaction({ beforeMessageCount: 10, afterMessageCount: 5, reason: "budget" });
    collector.onTurnPhase("request_send");
    collector.onModelSelection({ selectedModel: "claude", provider: "anthropic", ts: 5000 });

    const summary = graph.get<unknown>(diag.nodeIds.summary) as {
      totalToolCalls: number;
      totalRetries: number;
      totalCompactions: number;
      modelUsed: string | null;
    };
    expect(summary.totalToolCalls).toBe(1);
    expect(summary.totalRetries).toBe(1);
    expect(summary.totalCompactions).toBe(1);
    expect(summary.modelUsed).toBe("claude");
    graph.dispose();
  });

  it("collector works with no diag (no-op, does not throw)", () => {
    // If diag is not provided, collector should be a no-op
    const collector2 = createProviderCollector({});
    expect(() => collector2.onModelSelection({ selectedModel: "x", provider: "y", ts: 0 })).not.toThrow();
    expect(() => collector2.onTurnPhase("progress")).not.toThrow();
    expect(() => collector2.onToolCall({ toolName: "z", durationMs: 0, success: false })).not.toThrow();
    expect(() => collector2.onRetry({ attempt: 1, reason: "err" })).not.toThrow();
    expect(() => collector2.onCompaction({ beforeMessageCount: 1, afterMessageCount: 1, reason: "r" })).not.toThrow();
  });
});
