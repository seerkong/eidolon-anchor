import type { DataGraph } from "depa-data-graph-core";
import type {
  DiagnosticSubgraph,
  CompactionEntry,
  RetryEntry,
  ToolCallEntry,
  TurnTimingEntry,
  ModelSelectionSignal,
  ContinuationSignal,
} from "./DiagnosticSubgraph";

export type ProviderCollectorOptions = {
  diag?: DiagnosticSubgraph;
  graph?: DataGraph<unknown>;
};

export type ProviderCollector = {
  onModelSelection: (entry: NonNullable<ModelSelectionSignal>) => void;
  onContinuation: (entry: NonNullable<ContinuationSignal>) => void;
  onTurnPhase: (phase: TurnTimingEntry["phase"]) => void;
  onCompaction: (entry: Omit<CompactionEntry, "ts">) => void;
  onToolCall: (entry: Omit<ToolCallEntry, "ts">) => void;
  onRetry: (entry: Omit<RetryEntry, "ts">) => void;
};

export function createProviderCollector(
  options: ProviderCollectorOptions,
): ProviderCollector {
  const diag = options.diag;
  const graph = options.graph;

  // No-op when no diag or graph is provided
  if (!diag || !graph) {
    return {
      onModelSelection: () => {},
      onContinuation: () => {},
      onTurnPhase: () => {},
      onCompaction: () => {},
      onToolCall: () => {},
      onRetry: () => {},
    };
  }

  const set = <T>(nodeId: string, value: T) => {
    graph.set(nodeId, value);
  };

  const append = <T>(nodeId: string, entry: Omit<T, "ts">) => {
    const ts = Date.now();
    const existing = graph.get<T[]>(nodeId) ?? [];
    set(nodeId, [...existing, { ...entry, ts } as unknown as T]);
  };

  return {
    onModelSelection(entry) {
      set(diag.nodeIds.modelSelection, entry);
    },

    onContinuation(entry) {
      set(diag.nodeIds.continuation, entry);
    },

    onTurnPhase(phase) {
      append<TurnTimingEntry>(diag.nodeIds.turnTimings, {
        phase,
      } as Omit<TurnTimingEntry, "ts">);
    },

    onCompaction(entry) {
      append<CompactionEntry>(diag.nodeIds.compactions, entry);
    },

    onToolCall(entry) {
      append<ToolCallEntry>(diag.nodeIds.toolStats, entry);
    },

    onRetry(entry) {
      append<RetryEntry>(diag.nodeIds.retries, entry);
    },
  };
}
