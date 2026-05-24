import type {
  AiAgentVmReadonlyRxSignal,
  AiAgentVmRxStream,
  AiAgentVmTraceSummaryData,
  AiAgentVmUsageData,
} from "@cell/ai-core-contract/runtime/AiAgentVm";
export type {
  ObservabilityExtensionFactInput,
  ObservabilityRecord,
  ObservabilityRecordSource,
  ObservabilityRecordStage,
  ObservabilityRecordVisibility,
  ProviderSceneCaptureData,
  ProviderSceneCaptureHook,
  ProviderSceneCapturePhase,
} from "@cell/ai-core-contract/runtime/Observability";

import type { ObservabilityRecord } from "@cell/ai-core-contract/runtime/Observability";

export type ObservabilityRxData = {
  records: AiAgentVmRxStream<ObservabilityRecord>;
  errors: AiAgentVmRxStream<ObservabilityRecord>;
  usage: AiAgentVmReadonlyRxSignal<AiAgentVmUsageData>;
  traceSummary: AiAgentVmReadonlyRxSignal<AiAgentVmTraceSummaryData>;
};

export type ObservabilitySinkBinding = {
  dispose: () => void;
};

export type ObservabilitySink = {
  bind: (rxData: ObservabilityRxData) => ObservabilitySinkBinding;
};

export type ObservabilityLogSinkEntry = {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  channel: string;
  record: ObservabilityRecord;
};

export type ObservabilityLogSinkWriter = (entry: ObservabilityLogSinkEntry) => void;

export type TraceArtifactSinkEntry = {
  sessionId: string;
  requestId: string;
  record: ObservabilityRecord;
};

export type TraceArtifactSinkWriter = (entry: TraceArtifactSinkEntry) => void | Promise<void>;
