import { DataGraph, mountGraph, toNodeId } from "depa-data-graph-core";

export type ModelSelectionSignal = {
  selectedModel: string;
  provider: string;
  ts: number;
} | null;

export type ContinuationSignal = {
  fromSessionId: string;
  messageCount: number;
  ts: number;
} | null;

export type TurnTimingEntry = {
  phase: "request_send" | "progress" | "response_complete";
  ts: number;
  elapsedMs?: number;
};

export type CompactionEntry = {
  ts: number;
  beforeMessageCount: number;
  afterMessageCount: number;
  reason: string;
};

export type ToolCallEntry = {
  ts: number;
  toolName: string;
  durationMs: number;
  success: boolean;
};

export type RetryEntry = {
  ts: number;
  attempt: number;
  reason: string;
};

export type DiagnosticSummary = {
  totalToolCalls: number;
  totalRetries: number;
  totalCompactions: number;
  turnCount: number;
  modelUsed: string | null;
  lastTurnPhase: TurnTimingEntry["phase"] | null;
};

export type DiagnosticModule = {
  modelSelection: ModelSelectionSignal;
  continuation: ContinuationSignal;
  turnTimings: TurnTimingEntry[];
  compactions: CompactionEntry[];
  toolStats: ToolCallEntry[];
  retries: RetryEntry[];
  summary: DiagnosticSummary;
};

export type DiagnosticSubgraph = {
  nodeIds: {
    modelSelection: string;
    continuation: string;
    turnTimings: string;
    compactions: string;
    toolStats: string;
    retries: string;
    summary: string;
  };
  mount: (graph: DataGraph<unknown>) => void;
};

export function createDiagnosticSubgraph(scope?: string): DiagnosticSubgraph {
  const namespace = scope ?? "diag";
  const modNodeIds = {
    modelSelection: `${namespace}/modelSelection`,
    continuation: `${namespace}/continuation`,
    turnTimings: `${namespace}/turnTimings`,
    compactions: `${namespace}/compactions`,
    toolStats: `${namespace}/toolStats`,
    retries: `${namespace}/retries`,
    summary: `${namespace}/summary`,
  };

  return {
    nodeIds: modNodeIds,

    mount: (graph: DataGraph<unknown>) => {
      // Initialize all 6 signal nodes
      graph.addSignal<ModelSelectionSignal>(modNodeIds.modelSelection, null);
      graph.addSignal<ContinuationSignal>(modNodeIds.continuation, null);
      graph.addSignal<TurnTimingEntry[]>(modNodeIds.turnTimings, []);
      graph.addSignal<CompactionEntry[]>(modNodeIds.compactions, []);
      graph.addSignal<ToolCallEntry[]>(modNodeIds.toolStats, []);
      graph.addSignal<RetryEntry[]>(modNodeIds.retries, []);

      // Computed summary node
      graph.addComputed<DiagnosticSummary>(
        modNodeIds.summary,
        [
          modNodeIds.modelSelection,
          modNodeIds.toolStats,
          modNodeIds.retries,
          modNodeIds.compactions,
          modNodeIds.turnTimings,
        ],
        (ctx) => ({
          totalToolCalls: ctx.get<ToolCallEntry[]>(modNodeIds.toolStats).length,
          totalRetries: ctx.get<RetryEntry[]>(modNodeIds.retries).length,
          totalCompactions: ctx.get<CompactionEntry[]>(modNodeIds.compactions).length,
          turnCount: ctx.get<TurnTimingEntry[]>(modNodeIds.turnTimings).length,
          modelUsed: ctx.get<ModelSelectionSignal>(modNodeIds.modelSelection)?.selectedModel ?? null,
          lastTurnPhase: (() => {
            const timings = ctx.get<TurnTimingEntry[]>(modNodeIds.turnTimings);
            return timings.length > 0 ? timings[timings.length - 1].phase : null;
          })(),
        }),
      );
    },
  };
}
