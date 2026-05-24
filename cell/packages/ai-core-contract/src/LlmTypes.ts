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

export type LlmGenerateOptions = {
  model: string;
  messages: any[];
  tools: ToolSchema[];
  extraBody?: any;
  signal?: AbortSignal;
};

export type LlmStreamResult = {
  stream: AsyncIterable<any>;
  toolContext?: any;
};

export interface LlmAdapter {
  readonly type: LlmAdapterType;
  createStream(options: LlmGenerateOptions): Promise<LlmStreamResult>;
}
