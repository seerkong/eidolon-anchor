import type { LlmProviderAdapterType } from "./ProviderConfig";
import type {
  ChatCompletionsEffectBundle,
  NormalizedChatCompletionsStreamBinding,
} from "./ChatCompletionsEffectBundle";
import type { ProviderSceneCaptureHook } from "../observability/Observability";
import type {
  ProviderToolSchemaCoverageObservation,
  ProviderToolSchemaProjectionAuthority,
  ProviderToolSchemaProjector,
} from "./ProviderToolSchemaProjection";

export type ProviderRequestObservationCaptureLayer =
  "provider_transport_before_send" | "provider_runtime_before_driver";
export type ProviderRequestTransportType = "http" | "websocket";

export type ProviderRequestPlanObservation = Readonly<{
  planKind: "stateful_incremental" | "stateless_replay";
  replaySource: "native_window" | "canonical_rebuild" | null;
  previousResponseIdDecision: "adopted" | "rejected";
  previousResponseId: string | null;
  previousResponseIdDecisionReason: string | null;
}>;

export type ProviderResponseCompletenessObservation = Readonly<{
  status: "complete" | "incomplete" | "not_observed";
  source: "completed_output" | "indexed_done_items" | "reconstructed_event_items" | null;
  reason: string | null;
}>;

/** Final transport input, supplied synchronously immediately before I/O. */
export type ProviderTransportRequestObservationInput = Readonly<{
  transportType: ProviderRequestTransportType;
  requestBody: unknown;
  url?: string;
  method?: string;
  requestPlan?: ProviderRequestPlanObservation;
  toolSchemaCoverage?: ProviderToolSchemaCoverageObservation;
}>;

export type ProviderTransportOutcomeObservationInput = Readonly<{
  terminalState: "completed" | "failed" | "aborted" | "incomplete";
  fallbackUsed: boolean;
  completeness: ProviderResponseCompletenessObservation;
  responseId: string | null;
}>;

export type ProviderTransportOutcomeObserver = Readonly<{
  appendOutcome: (input: ProviderTransportOutcomeObservationInput) => void;
}>;

export type ProviderTransportRequestObserver = (
  input: ProviderTransportRequestObservationInput,
) => unknown;

/**
 * Immutable diagnostic copy of the final request sent by a provider transport.
 * Source messages/tools are correlation data; requestBody is the wire fact.
 */
export type ProviderRequestObservationData = Readonly<{
  schemaVersion: 1;
  sessionId?: string;
  actorId?: string;
  turnId?: string;
  traceId?: string;
  providerCallId: string;
  providerCallOrdinal: number;
  /** Present on transport-layer observations; optional only for ledger v1 input compatibility. */
  providerAttemptOrdinal?: number;
  /** @deprecated Use providerAttemptOrdinal. Retained for ledger v1 compatibility. */
  attemptOrdinal: number;
  transportAttemptOrdinal?: number;
  transportType?: ProviderRequestTransportType;
  providerId: string;
  model: string;
  requestModel: string;
  adapterName: string;
  driverName: string;
  captureLayer: ProviderRequestObservationCaptureLayer;
  capturedAt: number;
  messages: readonly unknown[];
  tools: readonly unknown[];
  requestBody?: unknown;
  planKind: ProviderRequestPlanObservation["planKind"] | null;
  replaySource: ProviderRequestPlanObservation["replaySource"];
  previousResponseIdDecision: ProviderRequestPlanObservation["previousResponseIdDecision"] | null;
  previousResponseId: string | null;
  previousResponseIdDecisionReason: string | null;
  toolSchemaCoverage?: ProviderToolSchemaCoverageObservation;
  /** @deprecated Compatibility envelope for ledger v1 readers. */
  requestContract: Readonly<Record<string, unknown>>;
}>;

/** Immutable response-after fact correlated to one real transport send. */
export type ProviderRequestOutcomeObservationData = Readonly<{
  schemaVersion: 1;
  sessionId?: string;
  actorId?: string;
  turnId?: string;
  traceId?: string;
  providerCallId: string;
  providerCallOrdinal: number;
  providerAttemptOrdinal: number;
  /** @deprecated Use providerAttemptOrdinal. */
  attemptOrdinal: number;
  transportAttemptOrdinal: number;
  transportType: ProviderRequestTransportType;
  providerId: string;
  model: string;
  terminalState: ProviderTransportOutcomeObservationInput["terminalState"];
  fallbackUsed: boolean;
  completenessStatus: ProviderResponseCompletenessObservation["status"];
  completenessSource: ProviderResponseCompletenessObservation["source"];
  completenessReason: string | null;
  responseId: string | null;
  capturedAt: number;
}>;

/** Synchronous append-only boundary so the fact exists before driver I/O. */
export type ProviderRequestObservationPort = {
  append: (data: ProviderRequestObservationData) => void;
  appendOutcome: (data: ProviderRequestOutcomeObservationData) => void;
};

export type ResponsesContinuationMode = "stateless_replay" | "stateful_chain";

export type LlmResolvedModelSelection = {
  agentName: string;
  selectedModel: string;
  providerId: string;
  modelId: string;
  adapterName?: string;
  driverName?: string;
  actorId?: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  attemptedModels?: string[];
  fallbackUsed?: boolean;
  eventType: "agent_model_selection";
};

export type LlmProviderRetryDiagnosticData = {
  agentName: string;
  providerId: string;
  selectedModel: string;
  stage: string;
  attemptNumber: number;
  retryCount: number;
  maxRetries: number;
  delaySeconds?: number;
  elapsedSeconds?: number;
  error?: string;
  classificationReason?: string;
  classificationLayer?: string;
  classificationPhase?: string;
  retryScope?: string;
  replaySafety?: string;
  retryBudgetKind?: "fixed_attempts" | "cumulative_output_tokens";
  consumedOutputTokens?: number;
  remainingOutputTokens?: number;
  maxOutputTokens?: number;
  outputTokenProgressSource?: "provider_usage" | "reasoning_bytes_estimate";
  terminationReason?: string;
  actorId?: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  eventType: "provider_retry_diagnostic";
};

export type LlmProviderProgressDiagnosticData = {
  agentName: string;
  providerId: string;
  selectedModel: string;
  stage: string;
  eventName?: string;
  progressClass?: string;
  visibilityClass?: string;
  providerPhase?: string;
  itemType?: string;
  responseId?: string;
  metadata?: Record<string, unknown>;
  eventIndex?: number;
  elapsedSeconds?: number;
  actorId?: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  eventType: "provider_progress_diagnostic";
};

export type LlmProviderContinuationState = {
  providerId?: string;
  selectedModel?: string;
  previousResponseId?: string;
  attemptedResponseIds?: string[];
  requestCount?: number;
  mode?: ResponsesContinuationMode;
};

export type LlmProviderContinuationDiagnosticData = {
  agentName: string;
  providerId: string;
  selectedModel: string;
  stage: string;
  mode?: ResponsesContinuationMode | "";
  previousResponseId?: string;
  nextResponseId?: string;
  requestCount?: number;
  eventName?: string;
  actorId?: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  eventType: "provider_continuation_diagnostic";
};

export type LlmProviderRequestObservationDiagnosticData = {
  eventType: "provider_request_observation_diagnostic";
  stage: "append_failed";
  providerId: string;
  selectedModel: string;
  providerCallId: string;
  providerCallOrdinal: number;
  providerAttemptOrdinal?: number;
  /** @deprecated Use providerAttemptOrdinal. */
  attemptOrdinal: number;
  transportAttemptOrdinal?: number;
  transportType?: ProviderRequestTransportType;
  error: string;
  actorId?: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
};

export type LlmProviderDiagnosticsRuntime = {
  retryEvents?: {
    onNext: (event: LlmProviderRetryDiagnosticData) => void;
  } | null;
  progressEvents?: {
    onNext: (event: LlmProviderProgressDiagnosticData) => void;
  } | null;
  continuationEvents?: {
    onNext: (event: LlmProviderContinuationDiagnosticData) => void;
  } | null;
  modelSelectionEvents?: {
    onNext: (event: LlmResolvedModelSelection) => void;
  } | null;
  requestObservationEvents?: {
    onNext: (event: LlmProviderRequestObservationDiagnosticData) => void;
  } | null;
};

export type LlmProviderRuntime = {
  providerId: string;
  selectedModel: string;
  adapterName: LlmProviderAdapterType | string;
  driverName: string;
  actorId?: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  providerCallId?: string;
  attemptedModels?: string[];
  fallbackUsed?: boolean;
  continuation?: LlmProviderContinuationState;
  diagnostics?: LlmProviderDiagnosticsRuntime;
  sceneCaptureHook?: ProviderSceneCaptureHook | null;
  requestObservationPort?: ProviderRequestObservationPort | null;
  chatCompatibilityProfileId?: ProviderChatCompatibilityProfileId;
};

export type ProviderChatCompatibilityProfileId =
  | "deepseek-chat@1"
  /** @deprecated persisted migration input only */
  | "deepseek-official-chat@1"
  /** @deprecated persisted migration input only */
  | "deepseek-compatible-chat@1";

export type ResponsesContinuationConfig = {
  mode: ResponsesContinuationMode;
  unmanagedPreviousResponseId?: string;
};

export type ProviderRequestContract = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  timeoutSeconds?: number;
  firstEventTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  metadata?: Record<string, unknown>;
};

export type ProviderRetryContext = {
  stage: string;
  attemptNumber: number;
  retryCount: number;
  maxRetries: number;
};

export type NormalizedToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type NormalizedProviderProgressEvent = {
  eventName: string;
  progressClass?: string;
  visibilityClass?: string;
  providerPhase?: string;
  itemType?: string;
  responseId?: string;
  metadata?: Record<string, unknown>;
};

export type NormalizedLLMResponse = {
  contentText: string;
  assistantContent?: unknown[];
  toolCalls?: NormalizedToolCall[];
  usage?: Record<string, unknown>;
  stopReason?: string;
  responseId?: string;
  progressEvents?: NormalizedProviderProgressEvent[];
};

export type RuntimePreparedProviderRequest = {
  driver: ProviderDriverDefinition;
  runtime: LlmProviderRuntime;
  contract: ProviderRequestContract;
  connectionOptions: Record<string, unknown>;
  requestOptions: Record<string, unknown>;
  extraBody: Record<string, unknown>;
  continuation: ResponsesContinuationConfig;
  toolSchemaProjectionAuthority?: ProviderToolSchemaProjectionAuthority;
};

export type ProviderDriverPreparedRequest = Readonly<{
  contract: ProviderRequestContract;
  toolSchemaProjectionAuthority?: ProviderToolSchemaProjectionAuthority;
}>;

export type ProviderDriverDefinition = {
  name: string;
  adapterNames: string[];
  chatCompletionsEffectBundle?: ChatCompletionsEffectBundle;
  toolSchemaProjector?: ProviderToolSchemaProjector;
  normalizedChatCompletionsStreamBinding?: NormalizedChatCompletionsStreamBinding;
  createStream: (
    params: ProviderDriverStreamParams,
  ) => Promise<{
    stream: AsyncIterable<unknown>;
    toolContext?: unknown;
    providerOutput?: Promise<unknown | undefined>;
    outputObserved?: () => boolean;
  }>;
  buildRequest?: (
    params: ProviderDriverRequestParams,
  ) => ProviderRequestContract;
  prepareRequest?: (
    params: ProviderDriverRequestParams,
  ) => ProviderDriverPreparedRequest;
  createMessage?: (
    params: ProviderDriverStreamParams,
  ) => Promise<NormalizedLLMResponse>;
};

export type ProviderDriverRequestParams = {
  model: string;
  messages: unknown[];
  tools: unknown[];
  requestOptions: Record<string, unknown>;
  extraBody: Record<string, unknown>;
  connectionOptions: Record<string, unknown>;
  runtime: LlmProviderRuntime;
  providerRequestContext?: unknown;
  /** Construction-time selected Chat Completions authority, reused by request and ingress. */
  chatCompletionsEffectBundle?: ChatCompletionsEffectBundle;
};

export type ProviderDriverStreamParams = ProviderDriverRequestParams & {
  signal?: AbortSignal;
  transportRequestObserver?: ProviderTransportRequestObserver;
  /**
   * Stable session/actor identity for provider-specific request correlation.
   * Responses continuation state is carried only by `providerRequestContext`.
   */
  sessionKey?: string;
  toolSchemaProjectionAuthority?: ProviderToolSchemaProjectionAuthority;
};
