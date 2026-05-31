import { DataGraph } from "depa-data-graph-core";

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
  const ns = scope ?? "diag";
  const ids = {
    modelSelection: `${ns}/modelSelection`,
    continuation: `${ns}/continuation`,
    turnTimings: `${ns}/turnTimings`,
    compactions: `${ns}/compactions`,
    toolStats: `${ns}/toolStats`,
    retries: `${ns}/retries`,
    summary: `${ns}/summary`,
  };

  return {
    nodeIds: ids,
    mount: (graph: DataGraph<unknown>) => {
      graph.addSignal<ModelSelectionSignal>(ids.modelSelection, null);
      graph.addSignal<ContinuationSignal>(ids.continuation, null);
      graph.addSignal<TurnTimingEntry[]>(ids.turnTimings, []);
      graph.addSignal<CompactionEntry[]>(ids.compactions, []);
      graph.addSignal<ToolCallEntry[]>(ids.toolStats, []);
      graph.addSignal<RetryEntry[]>(ids.retries, []);

      graph.addComputed<DiagnosticSummary>(
        ids.summary,
        [ids.modelSelection, ids.toolStats, ids.retries, ids.compactions, ids.turnTimings],
        (ctx) => ({
          totalToolCalls: ctx.get<ToolCallEntry[]>(ids.toolStats).length,
          totalRetries: ctx.get<RetryEntry[]>(ids.retries).length,
          totalCompactions: ctx.get<CompactionEntry[]>(ids.compactions).length,
          turnCount: ctx.get<TurnTimingEntry[]>(ids.turnTimings).length,
          modelUsed: ctx.get<ModelSelectionSignal>(ids.modelSelection)?.selectedModel ?? null,
          lastTurnPhase: (() => {
            const t = ctx.get<TurnTimingEntry[]>(ids.turnTimings);
            return t.length > 0 ? t[t.length - 1].phase : null;
          })(),
        }),
      );
    },
  };
}
