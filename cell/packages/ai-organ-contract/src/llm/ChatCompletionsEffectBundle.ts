export type ChatCompletionsStreamReasoningPolicy = Readonly<{
  reasoningContent: "ignore" | "preserve";
  reasoningDetails: "ignore" | "preserve";
  thinkTags: "content" | "reasoning";
}>;

export type ChatCompletionsStreamEventContract = Readonly<{
  event: "think" | "content";
  data: string;
}>;

export type ChatCompletionsStreamReductionContract = Readonly<{
  state: unknown;
  events: readonly ChatCompletionsStreamEventContract[];
}>;

export type ChatCompletionsStreamCoreContract = Readonly<{
  createState: () => unknown;
  reduceChunk: (
    state: unknown,
    chunk: unknown,
    policy: ChatCompletionsStreamReasoningPolicy,
  ) => ChatCompletionsStreamReductionContract;
  buildAssistantMessage: (state: unknown) => unknown;
}>;

export type ChatCompletionsRequestProjectionInput = Readonly<{
  model: string;
  messages: readonly unknown[];
  tools?: readonly unknown[];
  extraBody?: Readonly<Record<string, unknown>>;
}>;

export type NormalizedChatCompletionsStreamBinding = Readonly<{
  id: string;
  streamReasoningPolicy: ChatCompletionsStreamReasoningPolicy;
  streamCore: ChatCompletionsStreamCoreContract;
}>;

export type ChatCompletionsEffectBundle = NormalizedChatCompletionsStreamBinding & Readonly<{
  id: "openai-official-chat" | "deepseek-official-chat";
  resolveEndpoint: (baseUrl?: string) => string;
  projectMessages: (messages: readonly unknown[]) => unknown[];
  projectRequest: (
    input: ChatCompletionsRequestProjectionInput,
  ) => Record<string, unknown>;
}>;
