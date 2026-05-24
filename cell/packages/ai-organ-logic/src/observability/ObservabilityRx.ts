import type { ErrorData } from "@cell/ai-core-contract/stream/common";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import { ensureVmRxData } from "@cell/ai-core-logic/runtime/runtime";
import type {
  ObservabilityExtensionFactInput,
  ObservabilityLogSinkWriter,
  ObservabilityRecord,
  ObservabilityRxData,
  ObservabilitySink,
  ObservabilitySinkBinding,
  ProviderSceneCaptureData,
  ProviderSceneCaptureHook,
  TraceArtifactSinkWriter,
} from "@cell/ai-organ-contract/observability/Observability";

export function createObservabilityRxData(vm: AiAgentVm): ObservabilityRxData {
  const { publicRxData } = ensureVmRxData(vm);
  return {
    records: publicRxData.observabilityRecords,
    errors: publicRxData.observabilityErrors,
    usage: publicRxData.usage,
    traceSummary: publicRxData.traceSummary,
  };
}

export function emitObservabilityRecord(vm: AiAgentVm, record: ObservabilityRecord): void {
  const { privateRxData } = ensureVmRxData(vm);
  privateRxData.observabilityRecords.append(normalizeObservabilityRecord(record));
  if (record.stage === "error" || record.error) {
    privateRxData.observabilityErrors.append(normalizeObservabilityRecord(record));
  }
}

export function emitSemanticObservabilityRecord(vm: AiAgentVm, event: SemanticEvent): void {
  emitObservabilityRecord(vm, semanticEventToObservabilityRecord(event));
}

export function emitExtensionObservabilityFact(
  vm: AiAgentVm,
  fact: ObservabilityExtensionFactInput,
): void {
  emitObservabilityRecord(vm, {
    eventName: `${fact.factName}.${fact.phase}`,
    source: fact.source,
    stage: fact.phase,
    trace: fact.trace,
    actor: fact.actor,
    team: fact.team,
    payload: {
      ...(fact.payload ?? {}),
      factName: fact.factName,
      correlationId: fact.correlationId,
    },
    visibility: fact.visibility ?? "internal",
    emittedAt: fact.emittedAt ?? Date.now(),
  });
}

export function createProviderSceneCaptureHook(vm: AiAgentVm): ProviderSceneCaptureHook {
  return (data: ProviderSceneCaptureData) => {
    emitObservabilityRecord(vm, providerSceneToObservabilityRecord(data));
  };
}

export function bindObservabilitySinks(
  rxData: ObservabilityRxData,
  sinks: ObservabilitySink[],
): ObservabilitySinkBinding {
  const bindings: ObservabilitySinkBinding[] = [];
  for (const sink of sinks) {
    try {
      bindings.push(sink.bind(createIsolatedObservabilityRxData(rxData)));
    } catch (error) {
      // Sink construction/bind failures must be isolated from user protocol flow.
      // Other sinks are still allowed to consume the same rx data.
      // eslint-disable-next-line no-console
      console.warn("observability sink bind failed", error);
    }
  }
  return createSinkBinding(() => {
    for (const binding of bindings.splice(0)) {
      try {
        binding.dispose();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("observability sink dispose failed", error);
      }
    }
  });
}

export function createLogObservabilitySink(params: {
  channel?: string;
  write: ObservabilityLogSinkWriter;
}): ObservabilitySink {
  const channel = params.channel ?? "ai-runtime";
  return {
    bind: (rxData) => {
      const subscription = rxData.records.subscribe((record) => {
        const level = record.stage === "error" || record.error ? "error" : "info";
        params.write({
          level,
          channel,
          message: record.message ?? record.eventName,
          record,
        });
      });
      return createSinkBinding(() => subscription.unsubscribe());
    },
  };
}

export function createSessionTraceArtifactSink(params: {
  defaultSessionId?: string;
  defaultRequestId?: string;
  write: TraceArtifactSinkWriter;
}): ObservabilitySink {
  return {
    bind: (rxData) => {
      const subscription = rxData.records.subscribe((record) => {
        const sessionId = record.sessionId ?? record.trace?.session_id ?? params.defaultSessionId ?? "";
        const requestId = record.requestId ?? record.trace?.request_id ?? params.defaultRequestId ?? "";
        try {
          void Promise.resolve(params.write({ sessionId, requestId, record })).catch(() => {});
        } catch {
          // Artifact write failure must not affect runtime or sibling sinks.
        }
      });
      return createSinkBinding(() => subscription.unsubscribe());
    },
  };
}

export function semanticEventToObservabilityRecord(event: SemanticEvent): ObservabilityRecord {
  const error = "error" in event ? event.error : undefined;
  return {
    eventName: event.event_type,
    source: "semantic",
    stage: inferStage(event.event_type, error),
    trace: event.trace,
    actor: event.actor,
    team: event.team,
    toolCallId: "tool_call" in event ? event.tool_call?.tool_call_id : undefined,
    message: "message" in event ? String(event.message) : undefined,
    payload: { event },
    error,
    emittedAt: event.trace?.emitted_at ?? Date.now(),
  };
}

export function providerSceneToObservabilityRecord(data: ProviderSceneCaptureData): ObservabilityRecord {
  return {
    eventName: `provider.${data.phase}`,
    source: "provider",
    stage: data.phase === "error" ? "error" : data.phase,
    requestId: data.requestId,
    payload: {
      providerId: data.providerId,
      model: data.model,
      traceId: data.traceId,
      ...(data.payload ?? {}),
    },
    error: data.error ? { message: data.error } : undefined,
    emittedAt: data.emittedAt ?? Date.now(),
  };
}

function normalizeObservabilityRecord(record: ObservabilityRecord): ObservabilityRecord {
  return {
    ...record,
    emittedAt: record.emittedAt ?? Date.now(),
    payload: record.payload ?? {},
  };
}

function inferStage(eventType: string, error?: ErrorData): ObservabilityRecord["stage"] {
  if (error || eventType.endsWith("_error")) return "error";
  if (eventType.endsWith("_start")) return "start";
  if (eventType.endsWith("_delta")) return "delta";
  if (eventType.endsWith("_end") || eventType.endsWith("_result")) return "end";
  return "info";
}

function createSinkBinding(onDispose: () => void): ObservabilitySinkBinding {
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      onDispose();
    },
  };
}

function createIsolatedObservabilityRxData(rxData: ObservabilityRxData): ObservabilityRxData {
  return {
    ...rxData,
    records: {
      subscribe: (listener) => rxData.records.subscribe((record) => {
        try {
          listener(record);
        } catch {
          // Sink record handler failures are isolated per sink.
        }
      }),
    },
    errors: {
      subscribe: (listener) => rxData.errors.subscribe((record) => {
        try {
          listener(record);
        } catch {
          // Sink error handler failures are isolated per sink.
        }
      }),
    },
  };
}
