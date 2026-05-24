import type {
  LlmProviderContinuationDiagnosticData,
  LlmProviderDiagnosticsRuntime,
  LlmProviderProgressDiagnosticData,
  LlmProviderRetryDiagnosticData,
  LlmResolvedModelSelection,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";

export type ProviderDiagnosticKind = "retry" | "progress" | "continuation" | "modelSelection";

export type ProviderDiagnosticsCollector = {
  runtime: LlmProviderDiagnosticsRuntime;
  events: {
    retry: LlmProviderRetryDiagnosticData[];
    progress: LlmProviderProgressDiagnosticData[];
    continuation: LlmProviderContinuationDiagnosticData[];
    modelSelection: LlmResolvedModelSelection[];
  };
};

export function createProviderDiagnosticsCollector(): ProviderDiagnosticsCollector {
  const events: ProviderDiagnosticsCollector["events"] = {
    retry: [],
    progress: [],
    continuation: [],
    modelSelection: [],
  };
  return {
    events,
    runtime: {
      retryEvents: { onNext: (event) => events.retry.push(event) },
      progressEvents: { onNext: (event) => events.progress.push(event) },
      continuationEvents: { onNext: (event) => events.continuation.push(event) },
      modelSelectionEvents: { onNext: (event) => events.modelSelection.push(event) },
    },
  };
}

export function emitProviderDiagnostic(
  runtime: LlmProviderDiagnosticsRuntime | undefined | null,
  kind: "retry",
  event: LlmProviderRetryDiagnosticData,
): void;
export function emitProviderDiagnostic(
  runtime: LlmProviderDiagnosticsRuntime | undefined | null,
  kind: "progress",
  event: LlmProviderProgressDiagnosticData,
): void;
export function emitProviderDiagnostic(
  runtime: LlmProviderDiagnosticsRuntime | undefined | null,
  kind: "continuation",
  event: LlmProviderContinuationDiagnosticData,
): void;
export function emitProviderDiagnostic(
  runtime: LlmProviderDiagnosticsRuntime | undefined | null,
  kind: "modelSelection",
  event: LlmResolvedModelSelection,
): void;
export function emitProviderDiagnostic(
  runtime: LlmProviderDiagnosticsRuntime | undefined | null,
  kind: ProviderDiagnosticKind,
  event: unknown,
): void {
  if (!runtime) return;
  if (kind === "retry") runtime.retryEvents?.onNext(event as LlmProviderRetryDiagnosticData);
  if (kind === "progress") runtime.progressEvents?.onNext(event as LlmProviderProgressDiagnosticData);
  if (kind === "continuation") runtime.continuationEvents?.onNext(event as LlmProviderContinuationDiagnosticData);
  if (kind === "modelSelection") runtime.modelSelectionEvents?.onNext(event as LlmResolvedModelSelection);
}
