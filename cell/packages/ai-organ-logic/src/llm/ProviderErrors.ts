import type { LlmStreamResult } from "@cell/ai-core-contract/LlmTypes";

export class ProviderExecutionError extends Error {
  readonly providerErrorCode: string;
  readonly retryAfterSeconds?: number;
  readonly requestedDelaySeconds?: number;
  readonly statusCode?: number;

  constructor(
    message: string,
    options: {
      providerErrorCode?: string;
      retryAfterSeconds?: number;
      requestedDelaySeconds?: number;
      statusCode?: number;
    } = {},
  ) {
    super(message);
    this.name = "ProviderExecutionError";
    this.providerErrorCode = String(options.providerErrorCode ?? "").trim();
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.requestedDelaySeconds = options.requestedDelaySeconds ?? options.retryAfterSeconds;
    this.statusCode = options.statusCode;
  }
}

export type ProviderRetryClassification = {
  retryable: boolean;
  classificationReason: string;
  layer?: string;
  phase?: string;
  retryScope?: string;
  replaySafety?: string;
};

export type ProviderRetryPolicy = {
  maxRetries: number;
  /** Optional operation deadline, including provider request time. */
  maxTotalElapsedSeconds?: number;
  /** Cumulative retry waiting budget, independent of provider request time. */
  maxTotalBackoffSeconds?: number;
  maxDelaySeconds: number;
  baseDelaySeconds: number;
  backoffMultiplier?: number;
  jitterMinRatio?: number;
  jitterMaxRatio?: number;
};

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  maxRetries: 3,
  maxTotalBackoffSeconds: 120,
  maxDelaySeconds: 30,
  baseDelaySeconds: 1,
  backoffMultiplier: 2,
  jitterMinRatio: 0.9,
  jitterMaxRatio: 1.1,
};

export const FIRST_EVENT_TIMEOUT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  ...DEFAULT_PROVIDER_RETRY_POLICY,
  maxRetries: 1,
  maxTotalElapsedSeconds: 5 * 60,
  maxDelaySeconds: 15,
};

export const TRANSPORT_TIMEOUT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  ...DEFAULT_PROVIDER_RETRY_POLICY,
  maxRetries: 1,
  maxTotalElapsedSeconds: 10 * 60,
  maxDelaySeconds: 5,
};

export const RESPONSES_TOOL_CONTEXT_RECOVERY_POLICY: ProviderRetryPolicy = {
  ...DEFAULT_PROVIDER_RETRY_POLICY,
  maxRetries: 1,
  maxTotalElapsedSeconds: 30,
  maxDelaySeconds: 0,
  baseDelaySeconds: 0,
};

export const CHAT_TOOL_PAYLOAD_RECOVERY_POLICY: ProviderRetryPolicy = {
  ...DEFAULT_PROVIDER_RETRY_POLICY,
  maxRetries: 1,
  maxTotalElapsedSeconds: 15 * 60,
  maxDelaySeconds: 0,
  baseDelaySeconds: 0,
};

export const CHAT_INCOMPLETE_SEMANTIC_COMPLETION_POLICY: ProviderRetryPolicy = {
  ...DEFAULT_PROVIDER_RETRY_POLICY,
  // The generic attempt-count executor does not own DeepSeek semantic
  // completion. AiAgentExecutor admits replay by cumulative output-token
  // progress and the outer operation deadline instead.
  maxRetries: 0,
  maxTotalElapsedSeconds: 15 * 60,
  maxDelaySeconds: 0,
  baseDelaySeconds: 0,
};

const HTTP_STATUS_RE = /\b(?:http|fetch error)\s*(\d{3})\b/i;
const NON_RETRYABLE_PATTERNS = [
  "unauthorized",
  "forbidden",
  "permission denied",
  "invalid api key",
  "authentication",
  "invalid_request_error",
  "bad request",
  "malformed",
  "schema validation",
  "not found",
  "unsupported",
  "invalid model",
  "model not found",
];
const RETRYABLE_PATTERNS = [
  "timeout",
  "timed out",
  "network error",
  "connection reset",
  "connection aborted",
  "connection refused",
  "temporarily unavailable",
  "temporarily overloaded",
  "service unavailable",
  "too many requests",
  "rate limit",
  "upstream overloaded",
  "upstream error",
  "do request failed",
  "do_request_failed",
  "overloaded",
];

function retryable(
  classificationReason: string,
  extra: Omit<ProviderRetryClassification, "retryable" | "classificationReason"> = {},
): ProviderRetryClassification {
  return { retryable: true, classificationReason, ...extra };
}

function nonRetryable(classificationReason: string): ProviderRetryClassification {
  return { retryable: false, classificationReason };
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function statusFromError(error: unknown): number | undefined {
  const value = (error as { statusCode?: unknown; status?: unknown } | null | undefined)?.statusCode
    ?? (error as { status?: unknown } | null | undefined)?.status;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function classifyProviderRetry(error: unknown): ProviderRetryClassification {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lowered = message.toLowerCase();
  const statusCode = statusFromError(error);
  const protocolError = error as { name?: unknown; code?: unknown } | null | undefined;
  if (protocolError?.name === "ChatCompletionsProtocolError"
    && protocolError.code === "invalid_tool_call_payload") {
    return retryable("chat_tool_payload_recoverable", {
      layer: "stream_protocol",
      phase: "before_tool_dispatch",
      retryScope: "assistant_turn_repair",
      replaySafety: "safe_before_tool_dispatch",
    });
  }
  if (protocolError?.name === "ChatCompletionsOutputTruncatedError"
    && protocolError.code === "provider_output_truncated") {
    return retryable("chat_output_truncated_recoverable", {
      layer: "stream_protocol",
      phase: "before_tool_dispatch",
      retryScope: "assistant_turn_semantic_completion",
      replaySafety: "safe_before_tool_dispatch",
    });
  }
  if (protocolError?.name === "ChatCompletionsReasoningOnlyError"
    && protocolError.code === "provider_reasoning_only_response") {
    return retryable("chat_reasoning_only_recoverable", {
      layer: "stream_protocol",
      phase: "before_tool_dispatch",
      retryScope: "assistant_turn_semantic_completion",
      replaySafety: "safe_before_tool_dispatch",
    });
  }
  if (typeof statusCode === "number") {
    if (isRetryableStatus(statusCode)) return retryable(`http_${statusCode}_retryable`, { phase: "request_sent" });
    if (statusCode >= 400 && statusCode < 500) return nonRetryable(`http_${statusCode}_non_retryable`);
  }

  const match = HTTP_STATUS_RE.exec(message);
  if (match) {
    const code = Number(match[1]);
    if (isRetryableStatus(code)) return retryable(`http_${code}_retryable`, { phase: "request_sent" });
    if (code >= 400 && code < 500) return nonRetryable(`http_${code}_non_retryable`);
  }

  if (NON_RETRYABLE_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return nonRetryable("provider_error_non_retryable");
  }
  if (lowered.includes("first event exceeded timeout")) {
    return retryable("first_event_timeout_retryable", {
      layer: "stream_protocol",
      phase: "before_accept",
      retryScope: "stream_recover",
      replaySafety: "safe_same_contract",
    });
  }
  if (lowered.includes("stream exceeded timeout")) {
    return retryable("stream_timeout_retryable", {
      layer: "stream_protocol",
      phase: "provider_accepted",
      retryScope: "stream_recover",
      replaySafety: "indeterminate_after_accept",
    });
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return retryable("transport_timeout_retryable", {
      layer: "transport",
      phase: "before_accept",
      retryScope: "request_replay",
      replaySafety: "safe_same_contract",
    });
  }
  if (lowered.includes("socket connection was closed unexpectedly")) {
    return retryable("transport_socket_closed_retryable", {
      layer: "transport",
      phase: "before_accept",
      retryScope: "request_replay",
      replaySafety: "safe_same_contract",
    });
  }
  if (error instanceof Error && error.name === "ConnectionError") {
    return retryable("transport_error_retryable", { phase: "request_sent" });
  }
  if (RETRYABLE_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return retryable("provider_error_retryable", { phase: "request_sent" });
  }
  return nonRetryable("provider_error_non_retryable");
}

export function resolveProviderRetryPolicy(classificationReason: string): ProviderRetryPolicy {
  if (classificationReason === "first_event_timeout_retryable") return FIRST_EVENT_TIMEOUT_PROVIDER_RETRY_POLICY;
  if (classificationReason === "transport_timeout_retryable") return TRANSPORT_TIMEOUT_PROVIDER_RETRY_POLICY;
  if (classificationReason === "responses_tool_context_recoverable") return RESPONSES_TOOL_CONTEXT_RECOVERY_POLICY;
  if (classificationReason === "chat_tool_payload_recoverable") return CHAT_TOOL_PAYLOAD_RECOVERY_POLICY;
  if (classificationReason === "chat_output_truncated_recoverable") return CHAT_INCOMPLETE_SEMANTIC_COMPLETION_POLICY;
  if (classificationReason === "chat_reasoning_only_recoverable") return CHAT_INCOMPLETE_SEMANTIC_COMPLETION_POLICY;
  return DEFAULT_PROVIDER_RETRY_POLICY;
}

export function extractProviderRetryDelayOverrideSeconds(error: unknown): number | undefined {
  const source = error as { requestedDelaySeconds?: unknown; retryAfterSeconds?: unknown } | null | undefined;
  for (const value of [source?.requestedDelaySeconds, source?.retryAfterSeconds]) {
    if (value === undefined || value === null) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.max(0, numeric);
  }
  return undefined;
}

export function resolveProviderRetryDelay(params: {
  retryNumber: number;
  policy: ProviderRetryPolicy;
  elapsedSeconds: number;
  cumulativeBackoffSeconds?: number;
  overrideSeconds?: number;
  random?: () => number;
}): { delaySeconds: number; terminationReason: string } {
  const policy = { ...DEFAULT_PROVIDER_RETRY_POLICY, ...params.policy };
  if (params.retryNumber > policy.maxRetries) return { delaySeconds: 0, terminationReason: "retry_exhausted" };
  const deadline = Number.isFinite(policy.maxTotalElapsedSeconds) ? policy.maxTotalElapsedSeconds! : Infinity;
  if (params.elapsedSeconds >= deadline) {
    return { delaySeconds: 0, terminationReason: "retry_time_budget_exhausted" };
  }
  let delay = params.overrideSeconds;
  if (delay === undefined) {
    delay = policy.baseDelaySeconds * ((policy.backoffMultiplier ?? 2) ** Math.max(0, params.retryNumber - 1));
    const jitterMin = policy.jitterMinRatio ?? 0.9;
    const jitterMax = policy.jitterMaxRatio ?? 1.1;
    delay *= jitterMin + ((params.random ?? Math.random)() * (jitterMax - jitterMin));
  }
  delay = Math.min(policy.maxDelaySeconds, Math.max(0, delay));
  if (params.elapsedSeconds + delay >= deadline) {
    return { delaySeconds: 0, terminationReason: "retry_time_budget_exhausted" };
  }
  if ((params.cumulativeBackoffSeconds ?? 0) + delay > (policy.maxTotalBackoffSeconds ?? 120)) {
    return { delaySeconds: 0, terminationReason: "retry_backoff_budget_exhausted" };
  }
  return { delaySeconds: delay, terminationReason: "retry_scheduled" };
}

export type ProviderRetryDiagnostic = {
  providerId: string;
  selectedModel: string;
  stage: string;
  attemptNumber: number;
  retryCount: number;
  maxRetries: number;
  delaySeconds: number;
  elapsedSeconds: number;
  cumulativeBackoffSeconds: number;
  error: string;
  classificationReason: string;
  classificationLayer?: string;
  classificationPhase?: string;
  retryScope?: string;
  replaySafety?: string;
  terminationReason: string;
};

type ProviderRetryOptions = {
  stage: string;
  providerId: string;
  selectedModel: string;
  signal?: AbortSignal;
  policy?: Partial<ProviderRetryPolicy>;
  sleep?: (delaySeconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  shouldRetry?: (error: unknown, classification: ProviderRetryClassification) => boolean;
  onDiagnostic?: (event: ProviderRetryDiagnostic, context: { error: unknown; attemptNumber: number }) => void;
};

class ProviderRetryDeadlineError extends Error {}

function waitForProviderRetry(delaySeconds: number, options: ProviderRetryOptions, deadlineSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(sleepTimer);
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown) => {
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onAbort = () => finish(options.signal?.reason ?? new DOMException("Provider operation aborted", "AbortError"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }
    if (Number.isFinite(deadlineSeconds)) {
      deadlineTimer = setTimeout(() => finish(new ProviderRetryDeadlineError()), Math.max(0, deadlineSeconds) * 1000);
    }
    if (options.sleep) {
      // Observe injected sleepers even when cancellation wins the race.
      Promise.resolve().then(() => {
        options.signal?.throwIfAborted();
        return options.sleep!(delaySeconds);
      }).then(() => finish(), finish);
    } else {
      sleepTimer = setTimeout(() => finish(), delaySeconds * 1000);
    }
  });
}

function createProviderRetryRunner(options: ProviderRetryOptions, defaultReplaySafety?: string) {
  const now = options.now ?? (() => Date.now() / 1000);
  const startedAt = now();
  let attemptNumber = 0;
  let cumulativeBackoffSeconds = 0;
  let policy = { ...DEFAULT_PROVIDER_RETRY_POLICY, ...options.policy };
  let lastError: unknown;
  let classification: ProviderRetryClassification = nonRetryable("operation_not_started");
  let outputObserved = false;
  const elapsed = () => Math.max(0, now() - startedAt);
  const remainingSeconds = () => Number.isFinite(policy.maxTotalElapsedSeconds)
    ? policy.maxTotalElapsedSeconds! - elapsed()
    : Infinity;
  const emit = (terminationReason: string, delaySeconds = 0) => options.onDiagnostic?.({
    providerId: options.providerId,
    selectedModel: options.selectedModel,
    stage: options.stage,
    attemptNumber,
    retryCount: attemptNumber,
    maxRetries: policy.maxRetries,
    delaySeconds,
    elapsedSeconds: elapsed(),
    cumulativeBackoffSeconds,
    error: lastError instanceof Error ? lastError.message : String(lastError ?? ""),
    classificationReason: classification.classificationReason,
    classificationLayer: classification.layer,
    classificationPhase: outputObserved ? "provider_accepted" : classification.phase,
    retryScope: classification.retryScope,
    replaySafety: outputObserved ? "indeterminate_after_accept" : classification.replaySafety ?? defaultReplaySafety,
    terminationReason,
  }, { error: lastError, attemptNumber });
  const checkInterrupted = () => {
    if (options.signal?.aborted) {
      emit("aborted");
      throw options.signal.reason ?? new DOMException("Provider operation aborted", "AbortError");
    }
    if (remainingSeconds() <= 0) {
      emit("retry_time_budget_exhausted");
      throw lastError ?? new DOMException("Provider operation deadline exceeded", "TimeoutError");
    }
    if (cumulativeBackoffSeconds > (policy.maxTotalBackoffSeconds ?? 120)) {
      emit("retry_backoff_budget_exhausted");
      throw lastError;
    }
  };
  return {
    beginAttempt() {
      checkInterrupted();
      return ++attemptNumber;
    },
    async retry(error: unknown, observed = false) {
      lastError = error;
      outputObserved = observed;
      classification = classifyProviderRetry(error);
      policy = { ...resolveProviderRetryPolicy(classification.classificationReason), ...options.policy };
      checkInterrupted();
      const allowed = classification.retryable && (options.shouldRetry?.(error, classification) ?? true);
      let delay: { delaySeconds: number; terminationReason: string };
      if (outputObserved) {
        delay = { delaySeconds: 0, terminationReason: "indeterminate_after_accept" };
      } else if (allowed) {
        delay = resolveProviderRetryDelay({
          retryNumber: attemptNumber,
          policy,
          elapsedSeconds: elapsed(),
          cumulativeBackoffSeconds,
          overrideSeconds: extractProviderRetryDelayOverrideSeconds(error),
          random: options.random,
        });
      } else {
        delay = { delaySeconds: 0, terminationReason: classification.retryable ? "retry_filtered" : "non_retryable" };
      }
      emit(delay.terminationReason, delay.delaySeconds);
      if (delay.terminationReason !== "retry_scheduled") throw error;
      checkInterrupted();
      const waitStartedAt = now();
      try {
        await waitForProviderRetry(delay.delaySeconds, options, remainingSeconds());
      } catch (waitError) {
        cumulativeBackoffSeconds += Math.max(0, now() - waitStartedAt);
        if (options.signal?.aborted) checkInterrupted();
        if (waitError instanceof ProviderRetryDeadlineError) {
          emit("retry_time_budget_exhausted");
          throw error;
        }
        throw waitError;
      }
      // Charge the scheduled wait even when a deterministic test sleeper does not advance its clock.
      cumulativeBackoffSeconds += Math.max(delay.delaySeconds, now() - waitStartedAt);
      checkInterrupted();
    },
  };
}

export async function executeWithProviderRetry<T>(
  operation: () => Promise<T>,
  options: ProviderRetryOptions,
): Promise<T> {
  const runner = createProviderRetryRunner(options);
  while (true) {
    runner.beginAttempt();
    try {
      return await operation();
    } catch (error) {
      await runner.retry(error);
    }
  }
}

export function createProviderStreamWithRetry(
  createAttempt: (attemptNumber: number) => Promise<LlmStreamResult>,
  options: ProviderRetryOptions,
): LlmStreamResult {
  let resolveProviderOutput: (value: unknown | undefined) => void = () => {};
  let rejectProviderOutput: (error: unknown) => void = () => {};
  const providerOutput = new Promise<unknown | undefined>((resolve, reject) => {
    resolveProviderOutput = resolve;
    rejectProviderOutput = reject;
  });
  const runner = createProviderRetryRunner(options, "safe_same_contract");
  let currentAttempt: LlmStreamResult | undefined;

  const stream = (async function* () {
    try {
      while (true) {
        const attemptNumber = runner.beginAttempt();
        let outputObserved = false;
        try {
          currentAttempt = await createAttempt(attemptNumber);
          for await (const chunk of currentAttempt.stream) {
            if (!outputObserved && (
              currentAttempt.outputObserved?.() === true
              || providerStreamChunkHasVisibleOutput(chunk)
            )) {
              outputObserved = true;
            }
            yield chunk;
          }
          const output = currentAttempt.providerOutput
            ? await currentAttempt.providerOutput
            : undefined;
          resolveProviderOutput(output);
          return;
        } catch (error) {
          const failedAttempt = currentAttempt;
          if (!outputObserved && failedAttempt?.outputObserved) {
            try {
              outputObserved = failedAttempt.outputObserved() === true;
            } catch {
              // A broken observation hook cannot prove provider acceptance.
            }
          }
          void failedAttempt?.providerOutput?.catch(() => undefined);
          currentAttempt = undefined;
          await runner.retry(error, outputObserved);
        }
      }
    } catch (error) {
      rejectProviderOutput(error);
      throw error;
    }
  })();

  return { stream, providerOutput };
}

export function providerStreamChunkHasVisibleOutput(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  const choices = (chunk as any).choices;
  if (!Array.isArray(choices)) return false;
  return choices.some((choice: any) => {
    const delta = choice?.delta ?? choice?.message ?? {};
    if (typeof delta?.content === "string" && delta.content.length > 0) return true;
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
    if (typeof delta?.reasoning === "string" && delta.reasoning.length > 0) return true;
    return Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;
  });
}

export function toProviderExecutionError(error: unknown, fallbackCode = "provider_error"): ProviderExecutionError {
  if (error instanceof ProviderExecutionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderExecutionError(message, { providerErrorCode: fallbackCode });
}
