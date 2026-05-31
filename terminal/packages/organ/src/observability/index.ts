// ── Re-exports from @cell/ai-organ-logic (canonical implementations) ──
export {
  createDiagnosticPipeline,
  createDiagnosticSubgraph,
  SceneStore,
  SceneRecorder,
  SceneReplay,
  manifestToNode,
  nodeToManifest,
  messageToNode,
  nodeToMessage,
  observableGraphMiddleware,
  createObservableGraph,
  createSessionTraceSink,
  sessionTraceExportXnl,
  sessionTraceImportFile,
} from "@cell/ai-organ-logic";

export type {
  DiagnosticPipeline,
  DiagnosticPipelineOptions,
  DiagnosticPipelineStats,
  PipelineRecord,
  DiagnosticSubgraph,
  DiagnosticModule,
  DiagnosticSummary,
  ModelSelectionSignal,
  ContinuationSignal,
  TurnTimingEntry,
  CompactionEntry,
  ToolCallEntry,
  RetryEntry,
  SceneRecorderOptions,
  ReplayTurn,
  ReplayDiff,
  SceneReplayOptions,
  ToolDef,
  SceneManifest,
  SceneMessage,
  SceneToolCall,
  ObservableGraphMiddlewareOptions,
  ObservableGraph,
  ObservableGraphOptions,
  SessionTraceSinkOptions,
} from "@cell/ai-organ-logic";

// ── Deprecated (terminal/ legacy, keep for backward compat until tests migrate) ──
/** @deprecated Use observableGraphMiddleware from @cell/ai-organ-logic */
export { traceMiddleware } from "./TraceMiddleware";
/** @deprecated Use ObservableRecord from @cell/ai-core-contract */
export type { TraceRecord, TraceMiddlewareOptions } from "./TraceMiddleware";

/** @deprecated Use createSessionTraceSink from @cell/ai-organ-logic */
export { createSessionTraceStore } from "./SessionTraceStore";
/** @deprecated Use SessionTraceSinkOptions from @cell/ai-organ-logic */
export type { SessionTraceStore, SessionTraceStoreOptions } from "./SessionTraceStore";

/** @deprecated Use createProviderSceneCaptureHook from @cell/ai-organ-logic */
export { createProviderCollector } from "./ProviderCollector";
/** @deprecated Use ProviderSceneCaptureHook from @cell/ai-organ-logic */
export type { ProviderCollector, ProviderCollectorOptions } from "./ProviderCollector";
