import type { ResponsesContinuationConfig } from "@cell/ai-organ-contract/llm/ProviderRuntime";

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .toLowerCase();
}

export function normalizeProviderModelOptions(options: Record<string, unknown> = {}): Record<string, unknown> {
  const aliases: Record<string, string> = {
    max_output_tokens: "max_tokens",
    max_completion_tokens: "max_tokens",
    max_new_tokens: "max_tokens",
    reasoningeffort: "reasoning_effort",
    defaultheaders: "default_headers",
    defaultquery: "default_query",
  };
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    const snakeKey = toSnakeCase(String(key));
    normalized[aliases[snakeKey] ?? snakeKey] = value;
  }
  return normalized;
}

export function extractProviderConnectionOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  const normalized = normalizeProviderModelOptions(options ?? {});
  const connectionKeys = new Set([
    "base_url",
    "baseurl",
    "api_key",
    "apikey",
    "organization",
    "project",
    "default_headers",
    "default_query",
    "transport_mode",
    "supports_websockets",
    "websocket_url",
    "websocket_connect_timeout_seconds",
  ]);
  return Object.fromEntries(Object.entries(normalized).filter(([key, value]) => connectionKeys.has(key) && value != null));
}

function splitByKeys(
  options: Record<string, unknown> | undefined,
  requestKeys: Set<string>,
  extraBodyKeys: Set<string>,
): { requestOptions: Record<string, unknown>; extraBody: Record<string, unknown> } {
  const normalized = normalizeProviderModelOptions(options ?? {});
  const requestOptions: Record<string, unknown> = {};
  const extraBody: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) continue;
    if (requestKeys.has(key)) requestOptions[key] = value;
    else if (extraBodyKeys.has(key)) extraBody[key] = value;
  }
  return { requestOptions, extraBody };
}

export function splitChatModelOptions(options?: Record<string, unknown>): {
  requestOptions: Record<string, unknown>;
  extraBody: Record<string, unknown>;
  continuation: ResponsesContinuationConfig;
} {
  const requestKeys = new Set([
    "frequency_penalty",
    "logit_bias",
    "logprobs",
    "max_tokens",
    "metadata",
    "modalities",
    "n",
    "parallel_tool_calls",
    "prediction",
    "presence_penalty",
    "reasoning_effort",
    "response_format",
    "seed",
    "service_tier",
    "stop",
    "store",
    "stream_options",
    "temperature",
    "timeout",
    "first_event_timeout",
    "first_event_timeout_seconds",
    "stream_idle_timeout",
    "stream_idle_timeout_seconds",
    "top_logprobs",
    "top_p",
    "user",
  ]);
  const extraBodyKeys = new Set(["reasoning_split", "thinking"]);
  return { ...splitByKeys(options, requestKeys, extraBodyKeys), continuation: { mode: "stateless_replay" } };
}

export function splitResponsesModelOptions(options?: Record<string, unknown>): {
  requestOptions: Record<string, unknown>;
  extraBody: Record<string, unknown>;
  continuation: ResponsesContinuationConfig;
} {
  const normalized = normalizeProviderModelOptions(options ?? {});
  const requestKeys = new Set([
    "background",
    "include",
    "instructions",
    "max_tool_calls",
    "max_tokens",
    "metadata",
    "parallel_tool_calls",
    "previous_response_id",
    "prompt",
    "prompt_cache_key",
    "reasoning",
    "service_tier",
    "store",
    "temperature",
    "text",
    "timeout",
    "first_event_timeout",
    "first_event_timeout_seconds",
    "stream_idle_timeout",
    "stream_idle_timeout_seconds",
    "tool_choice",
    "top_p",
    "truncation",
    "user",
  ]);
  const extraBodyKeys = new Set(["reasoning_split", "work_context", "prompt_plan"]);
  const split = splitByKeys(normalized, requestKeys, extraBodyKeys);
  const modeValue = normalized.responses_continuation_mode ?? normalized.continuation_mode;
  const mode = modeValue === "stateful_chain" ? "stateful_chain" : "stateless_replay";
  const unmanagedPreviousResponseId =
    typeof normalized.previous_response_id === "string" ? normalized.previous_response_id : undefined;
  return { ...split, continuation: { mode, unmanagedPreviousResponseId } };
}

export function splitClaudeCodeModelOptions(options?: Record<string, unknown>): {
  requestOptions: Record<string, unknown>;
  extraBody: Record<string, unknown>;
  continuation: ResponsesContinuationConfig;
} {
  const requestKeys = new Set([
    "max_tokens",
    "metadata",
    "parallel_tool_calls",
    "reasoning_effort",
    "stop_sequences",
    "temperature",
    "thinking",
    "timeout",
    "first_event_timeout",
    "first_event_timeout_seconds",
    "stream_idle_timeout",
    "stream_idle_timeout_seconds",
    "top_k",
    "top_p",
  ]);
  return { ...splitByKeys(options, requestKeys, new Set()), continuation: { mode: "stateless_replay" } };
}
