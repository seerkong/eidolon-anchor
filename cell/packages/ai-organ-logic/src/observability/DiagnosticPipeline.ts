/**
 * DiagnosticPipeline — lightweight push-based pipeline.
 *
 * No dependency on xstream. Records are pushed in and flow through
 * operator chains to sinks.
 */

export interface PipelineRecord {
  nodeId?: string;
  op?: string;
  eventName?: string;
  [key: string]: unknown;
}

export type DiagnosticPipelineStats = {
  totalEvents: number;
  byOp: Record<string, number>;
  byNode: Record<string, number>;
};

export type DiagnosticPipelineOptions = {
  onRecord?: (record: PipelineRecord) => void;
  onByNode?: (groups: Record<string, PipelineRecord[]>) => void;
  onStats?: (stats: DiagnosticPipelineStats) => void;
  maxRecordsPerNode?: number;
};

export type DiagnosticPipeline = {
  push: (record: PipelineRecord) => void;
  dispose: () => void;
};

export function createDiagnosticPipeline(opts: DiagnosticPipelineOptions = {}): DiagnosticPipeline {
  let disposed = false;
  let byNode: Record<string, PipelineRecord[]> = {};
  let stats: DiagnosticPipelineStats = { totalEvents: 0, byOp: {}, byNode: {} };
  const maxRecordsPerNode = Number.isFinite(opts.maxRecordsPerNode) && opts.maxRecordsPerNode !== undefined
    ? Math.max(1, Math.floor(opts.maxRecordsPerNode))
    : 100;

  const push = (record: PipelineRecord) => {
    if (disposed) return;

    // raw pass-through
    opts.onRecord?.(record);

    // byNode fold
    const key = record.nodeId ?? "__global__";
    const nodeRecords = [...(byNode[key] ?? []), record].slice(-maxRecordsPerNode);
    byNode = { ...byNode, [key]: nodeRecords };
    opts.onByNode?.(byNode);

    // stats fold
    const op = record.op ?? record.eventName ?? "__unknown__";
    stats = {
      totalEvents: stats.totalEvents + 1,
      byOp: { ...stats.byOp, [op]: (stats.byOp[op] ?? 0) + 1 },
      byNode: record.nodeId
        ? { ...stats.byNode, [record.nodeId]: (stats.byNode[record.nodeId] ?? 0) + 1 }
        : stats.byNode,
    };
    opts.onStats?.(stats);
  };

  return {
    push,
    dispose: () => { disposed = true; byNode = {}; stats = { totalEvents: 0, byOp: {}, byNode: {} }; },
  };
}
