import type { GraphMiddleware, MiddlewareContext } from "depa-data-graph-core";

export type TraceRecord = {
  id: string;
  seq: number;
  ts: number;
  phase: "before" | "after";
  op: "get" | "set" | "batch" | "nodeAdd" | "dispose";
  nodeId?: string;
  valueSnapshot?: unknown;
  batchPhase?: "start" | "end";
};

export type TraceMiddlewareOptions<TRuntime> = {
  onRecord: (record: TraceRecord) => void;
  filter?: (nodeId: string) => boolean;
};

export function traceMiddleware<TRuntime>(
  config: TraceMiddlewareOptions<TRuntime>,
): GraphMiddleware<TRuntime> {
  let seq = 0;
  const shouldTrace = config.filter ?? (() => true);

  const record = (
    op: TraceRecord["op"],
    phase: TraceRecord["phase"],
    extras?: Partial<Pick<TraceRecord, "nodeId" | "batchPhase">>,
  ): void => {
    if (extras?.nodeId && !shouldTrace(extras.nodeId)) {
      return;
    }
    config.onRecord({
      id: crypto.randomUUID(),
      seq: ++seq,
      ts: Date.now(),
      phase,
      op,
      ...extras,
    });
  };

  return {
    name: "trace",

    beforeGet(id, _ctx) {
      record("get", "before", { nodeId: id });
    },

    afterSet(id, _value, _ctx) {
      record("set", "after", { nodeId: id });
    },

    onBatch(event, _ctx) {
      record("batch", "before", { batchPhase: event.phase });
    },

    onNodeAdd(node, _ctx) {
      record("nodeAdd", "after", { nodeId: node.id });
    },

    onDispose(_ctx) {
      record("dispose", "after");
    },
  };
}
