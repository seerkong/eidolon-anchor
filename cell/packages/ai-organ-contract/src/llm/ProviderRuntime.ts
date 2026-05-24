import type { LlmProviderAdapterType } from "./ProviderConfig";
import type { ProviderSceneCaptureHook } from "../observability/Observability";

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

export type LlmProviderDiagnosticsRuntime = {
  retryEvents?: { onNext: (event: LlmProviderRetryDiagnosticData) => void } | null;
  progressEvents?: { onNext: (event: LlmProviderProgressDiagnosticData) => void } | null;
  continuationEvents?: { onNext: (event: LlmProviderContinuationDiagnosticData) => void } | null;
  modelSelectionEvents?: { onNext: (event: LlmResolvedModelSelection) => void } | null;
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
  attemptedModels?: string[];
  fallbackUsed?: boolean;
  continuation?: LlmProviderContinuationState;
  diagnostics?: LlmProviderDiagnosticsRuntime;
  sceneCaptureHook?: ProviderSceneCaptureHook | null;
};

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
};

export type ProviderDriverDefinition = {
  name: string;
  adapterNames: string[];
  createStream: (params: ProviderDriverStreamParams) => Promise<{ stream: AsyncIterable<unknown>; toolContext?: unknown }>;
  buildRequest?: (params: ProviderDriverRequestParams) => ProviderRequestContract;
  createMessage?: (params: ProviderDriverStreamParams) => Promise<NormalizedLLMResponse>;
};

export type ProviderDriverRequestParams = {
  model: string;
  messages: unknown[];
  tools: unknown[];
  requestOptions: Record<string, unknown>;
  extraBody: Record<string, unknown>;
  connectionOptions: Record<string, unknown>;
  runtime: LlmProviderRuntime;
};

export type ProviderDriverStreamParams = ProviderDriverRequestParams & {
  signal?: AbortSignal;
};
