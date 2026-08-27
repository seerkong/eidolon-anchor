import type { ToolSchema } from "./types";

export type LlmAdapterType = "openai" | "anthropic" | "codex" | "claude" | "deepseek";

export type LlmModelFamily = LlmAdapterType | "unknown";

export type LlmModality = "text" | "image" | "audio" | "video" | "pdf";

export type LlmModelModalities = {
  input: LlmModality[];
  output: LlmModality[];
};

export type LlmModelCachePolicy = {
  stablePrefix: boolean;
  providerManagedPrefixCache: boolean;
  preferLateCompaction: boolean;
  compactionThresholdTokens?: number;
};

export type LlmModelCapabilities = {
  family: LlmModelFamily;
  modalities?: LlmModelModalities;
  contextWindow?: number;
  outputLimit?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  cachePolicy?: LlmModelCachePolicy;
};

/** Local execution correlation for one concrete LLM request; never serialized to a provider. */
export type LlmRequestExecutionIdentity = Readonly<{
  actorId: string;
  turnId: string;
  operationId: string;
  requestId: string;
}>;

/** Local-only context for deriving value-safe provider cache-cost evidence. */
export type ProviderCacheCostObservationContext = Readonly<{
  /** Domain-owned attribution label; generic transport assigns no semantics. */
  actorClass: string;
  contextEpoch: number;
  tokenEstimates: Readonly<{
    toolSurfaceTokens: number;
    workflowControlTokens: number;
  }>;
  priceWeights?: Readonly<{
    cacheHitWeight: number;
    cacheMissWeight: number;
  }>;
}>;

export type LlmGenerateOptions = {
  model: string;
  messages: any[];
  tools: ToolSchema[];
  extraBody?: any;
  signal?: AbortSignal;
  /**
   * Stable session/actor identity for provider-specific request correlation.
   * It must not be used as an implicit continuation-state key; Responses
   * continuation is supplied explicitly through `providerRequestContext`.
   */
  sessionKey?: string;
  /**
   * Provider-specific request data passed through the provider runtime without
   * being serialized as request body fields. Provider packages own its schema.
   */
  providerRequestContext?: unknown;
  /** Provider-call-scoped opaque authority prepared by the configured driver. */
  providerToolSchemaProjectionAuthority?: unknown;
  executionIdentity?: LlmRequestExecutionIdentity;
  /** Diagnostic-only and never serialized into a provider request. */
  providerCacheCostObservation?: ProviderCacheCostObservationContext;
};

export type LlmStreamResult = {
  stream: AsyncIterable<any>;
  toolContext?: any;
  /** Provider-native completion data, finalized after `stream` is consumed. */
  providerOutput?: Promise<unknown | undefined>;
  /** True once the provider has emitted assistant-visible output for this attempt. */
  outputObserved?: () => boolean;
};

export interface LlmAdapter {
  readonly type: LlmAdapterType;
  createStream(options: LlmGenerateOptions): Promise<LlmStreamResult>;
}

export type LlmProcessStreamOptions = {
  signal?: AbortSignal;
  llmAdapter?: LlmAdapter;
};
