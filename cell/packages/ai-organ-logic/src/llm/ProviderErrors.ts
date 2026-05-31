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
  maxTotalElapsedSeconds: number;
  maxDelaySeconds: number;
  baseDelaySeconds: number;
  backoffMultiplier?: number;
  jitterMinRatio?: number;
  jitterMaxRatio?: number;
};

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  maxRetries: 3,
  maxTotalElapsedSeconds: 120,
  maxDelaySeconds: 30,
  baseDelaySeconds: 1,
  backoffMultiplier: 2,
  jitterMinRatio: 0.9,
  jitterMaxRatio: 1.1,
};

export const FIRST_EVENT_TIMEOUT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  ...DEFAULT_PROVIDER_RETRY_POLICY,
  maxRetries: 1,
  maxDelaySeconds: 15,
};

export const RESPONSES_TOOL_CONTEXT_RECOVERY_POLICY: ProviderRetryPolicy = {
  ...DEFAULT_PROVIDER_RETRY_POLICY,
  maxRetries: 1,
  maxTotalElapsedSeconds: 30,
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
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "ConnectionError")) {
    return retryable("transport_error_retryable", { phase: "request_sent" });
  }
  if (RETRYABLE_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return retryable("provider_error_retryable", { phase: "request_sent" });
  }
  return nonRetryable("provider_error_non_retryable");
}

export function resolveProviderRetryPolicy(classificationReason: string): ProviderRetryPolicy {
  if (classificationReason === "first_event_timeout_retryable") return FIRST_EVENT_TIMEOUT_PROVIDER_RETRY_POLICY;
  if (classificationReason === "responses_tool_context_recoverable") return RESPONSES_TOOL_CONTEXT_RECOVERY_POLICY;
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
  overrideSeconds?: number;
  random?: () => number;
}): { delaySeconds: number; terminationReason: string } {
  const policy = { ...DEFAULT_PROVIDER_RETRY_POLICY, ...params.policy };
  if (params.retryNumber > policy.maxRetries) return { delaySeconds: 0, terminationReason: "retry_exhausted" };
  if (params.elapsedSeconds >= policy.maxTotalElapsedSeconds) {
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
  if (params.elapsedSeconds + delay > policy.maxTotalElapsedSeconds) {
    return { delaySeconds: 0, terminationReason: "retry_time_budget_exhausted" };
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
  error: string;
  classificationReason: string;
  classificationLayer?: string;
  classificationPhase?: string;
  retryScope?: string;
  replaySafety?: string;
  terminationReason: string;
};

export async function executeWithProviderRetry<T>(
  operation: () => Promise<T>,
  options: {
    stage: string;
    providerId: string;
    selectedModel: string;
    policy?: Partial<ProviderRetryPolicy>;
    sleep?: (delaySeconds: number) => Promise<void>;
    now?: () => number;
    random?: () => number;
    onDiagnostic?: (event: ProviderRetryDiagnostic) => void;
  },
): Promise<T> {
  const startedAt = (options.now ?? (() => Date.now() / 1000))();
  let attemptNumber = 0;
  while (true) {
    attemptNumber += 1;
    try {
      return await operation();
    } catch (error) {
      const classification = classifyProviderRetry(error);
      const policy = { ...resolveProviderRetryPolicy(classification.classificationReason), ...(options.policy ?? {}) };
      const elapsedSeconds = Math.max(0, (options.now ?? (() => Date.now() / 1000))() - startedAt);
      const retryCount = Math.max(0, attemptNumber);
      const delay = classification.retryable
        ? resolveProviderRetryDelay({
            retryNumber: retryCount,
            policy,
            elapsedSeconds,
            overrideSeconds: extractProviderRetryDelayOverrideSeconds(error),
            random: options.random,
          })
        : { delaySeconds: 0, terminationReason: "non_retryable" };
      options.onDiagnostic?.({
        providerId: options.providerId,
        selectedModel: options.selectedModel,
        stage: options.stage,
        attemptNumber,
        retryCount,
        maxRetries: policy.maxRetries,
        delaySeconds: delay.delaySeconds,
        elapsedSeconds,
        error: error instanceof Error ? error.message : String(error),
        classificationReason: classification.classificationReason,
        classificationLayer: classification.layer,
        classificationPhase: classification.phase,
        retryScope: classification.retryScope,
        replaySafety: classification.replaySafety,
        terminationReason: delay.terminationReason,
      });
      if (!classification.retryable || delay.terminationReason !== "retry_scheduled") throw error;
      await (options.sleep ?? ((seconds) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000))))(delay.delaySeconds);
    }
  }
}

export function toProviderExecutionError(error: unknown, fallbackCode = "provider_error"): ProviderExecutionError {
  if (error instanceof ProviderExecutionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderExecutionError(message, { providerErrorCode: fallbackCode });
}
