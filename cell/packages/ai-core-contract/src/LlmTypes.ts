import type { ToolSchema } from "./types";

export type LlmAdapterType = "openai" | "anthropic" | "codex" | "claude" | "deepseek";

export type LlmModelFamily = LlmAdapterType | "unknown";

export type LlmModelCachePolicy = {
  stablePrefix: boolean;
  providerManagedPrefixCache: boolean;
  preferLateCompaction: boolean;
  compactionThresholdTokens?: number;
};

export type LlmModelCapabilities = {
  family: LlmModelFamily;
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
  executionIdentity?: LlmRequestExecutionIdentity;
};

export type LlmStreamResult = {
  stream: AsyncIterable<any>;
  toolContext?: any;
  /** Provider-native completion data, finalized after `stream` is consumed. */
  providerOutput?: Promise<unknown | undefined>;
};

export interface LlmAdapter {
  readonly type: LlmAdapterType;
  createStream(options: LlmGenerateOptions): Promise<LlmStreamResult>;
}
