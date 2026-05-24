import type { ActorRefData, ErrorData, TeamRefData, TraceData } from "../stream/common";

export type ObservabilityRecordSource =
  | "semantic"
  | "domain"
  | "extension"
  | "provider"
  | "runtime"
  | "sink";

export type ObservabilityRecordStage =
  | "start"
  | "delta"
  | "end"
  | "error"
  | "info";

export type ObservabilityRecordVisibility = "internal" | "user_visible";

export type ObservabilityRecord = {
  eventName: string;
  source: ObservabilityRecordSource | string;
  stage: ObservabilityRecordStage | string;
  trace?: TraceData;
  actor?: ActorRefData;
  team?: TeamRefData;
  sessionId?: string;
  requestId?: string;
  conversationId?: string;
  toolCallId?: string;
  message?: string;
  payload?: Record<string, unknown>;
  error?: ErrorData | { message: string; code?: string; detail?: string };
  visibility?: ObservabilityRecordVisibility;
  emittedAt: number;
};

export type ObservabilityExtensionFactInput = {
  source: string;
  factName: string;
  phase: ObservabilityRecordStage | string;
  payload?: Record<string, unknown>;
  visibility?: ObservabilityRecordVisibility;
  trace?: TraceData;
  actor?: ActorRefData;
  team?: TeamRefData;
  correlationId?: string;
  emittedAt?: number;
};

export type ProviderSceneCapturePhase = "request" | "response" | "error";

export type ProviderSceneCaptureData = {
  providerId?: string;
  model?: string;
  phase: ProviderSceneCapturePhase;
  requestId?: string;
  traceId?: string;
  payload?: Record<string, unknown>;
  error?: string;
  emittedAt?: number;
};

export type ProviderSceneCaptureHook = (data: ProviderSceneCaptureData) => void | Promise<void>;
