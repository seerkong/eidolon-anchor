/**
 * createObservableGraph — DataGraph factory with observability wiring.
 *
 * Produces a DataGraph instrumented with:
 *   - ObservableGraphMiddleware (graph hooks → ObservabilityRecord)
 *   - DiagnosticPipeline (in-memory byNode/stats aggregation)
 *   - AppendOnlyEventLog + OrderedTimeline (historical replay)
 *   - Optional SessionTraceSink (xnl persistence via Rx bind)
 *   - Optional persist plugin
 *   - Optional debug logging
 */

import {
  AppendOnlyEventLog,
  DataGraph,
  loggerPlugin,
  OrderedTimeline,
  persistPlugin,
  type PersistStorage,
} from "depa-data-graph-core";
import type { ObservabilityRecord } from "@cell/ai-core-contract/runtime/Observability";
import type { ObservabilitySink, ObservabilityRxData } from "@cell/ai-organ-contract/observability/Observability";
import { observableGraphMiddleware } from "./ObservableGraphMiddleware";
import { createDiagnosticPipeline, type DiagnosticPipeline } from "./DiagnosticPipeline";

export type ObservableGraphOptions = {
  debug?: boolean;
  persistKeys?: string[];
  persistStorage?: PersistStorage;
  persistDebounce?: number;
  traceSink?: ObservabilitySink;        // replaces traceStore
  traceRxData?: ObservabilityRxData;     // needed when traceSink is set
};

export type ObservableGraph = {
  graph: DataGraph<undefined>;
  traceLog: AppendOnlyEventLog<ObservabilityRecord>;
  diagnosticPipeline: DiagnosticPipeline;
  flushTrace?: () => Promise<void>;
  dispose: () => void;
};

export function createObservableGraph(
  options: ObservableGraphOptions = {},
): ObservableGraph {
  const graph = new DataGraph<undefined>(() => undefined);
  const traceLog = new AppendOnlyEventLog<ObservabilityRecord>();
  const traceTimeline = new OrderedTimeline<ObservabilityRecord>();

  // 1. Diagnostic pipeline — in-memory fold/sink
  const diagnosticPipeline = createDiagnosticPipeline({
    onRecord: (r) => traceTimeline.append(r),
  });

  // 2. ObservableGraphMiddleware — always registered
  //    Push records to traceLog, diagnostic pipeline, and optional trace sink
  graph.use(
    observableGraphMiddleware({
      onRecord: (record) => {
        traceLog.append(record);
        diagnosticPipeline.push(record);
      },
    }),
  );

  // 3. Bind trace sink if provided
  let sinkBinding: { dispose: () => void } | null = null;
  if (options.traceSink && options.traceRxData) {
    sinkBinding = options.traceSink.bind(options.traceRxData);
  }

  // 4. Logger plugin — debug mode only
  if (options.debug) {
    graph.use(
      loggerPlugin({
        level: "debug",
        prefix: "[ObservableGraph]",
      }),
    );
  }

  // 5. Deps audit — debug mode only
  if (options.debug) {
    graph.setDepsAudit("warn");
  }

  // 6. Persist plugin — when persistKeys is non-empty
  if (options.persistKeys && options.persistKeys.length > 0) {
    const storage = options.persistStorage ?? defaultMemoryStorage();
    graph.use(
      persistPlugin({
        storage,
        keys: options.persistKeys,
        storageKey: "DataGraph",
        debounce: options.persistDebounce ?? 500,
      }),
    );
  }

  return {
    graph,
    traceLog,
    diagnosticPipeline,
    flushTrace: async () => {
      if (sinkBinding && "flush" in sinkBinding) {
        await (sinkBinding as any).flush();
      }
    },
    dispose: () => {
      graph.dispose();
      diagnosticPipeline.dispose();
      traceTimeline.dispose();
      traceLog.dispose();
      sinkBinding?.dispose();
    },
  };
}

function defaultMemoryStorage(): PersistStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  };
}
