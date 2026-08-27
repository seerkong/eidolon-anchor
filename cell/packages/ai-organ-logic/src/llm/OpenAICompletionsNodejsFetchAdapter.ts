import type {
  LlmAdapter,
  LlmGenerateOptions,
  LlmStreamResult,
} from "@cell/ai-core-contract/LlmTypes";
import type { ToolSchema } from "@cell/ai-core-contract/types";
import type { ChatCompletionsEffectBundle } from "@cell/ai-organ-contract/llm/ChatCompletionsEffectBundle";
import { ProviderExecutionError } from "./ProviderErrors";
import type { ProviderOptions } from "./ProviderPlugins";
import type { ProviderTransportRequestObserver } from "@cell/ai-organ-contract/llm/ProviderRuntime";
import { observeProviderTransportRequest } from "./ProviderTransportObservation";
import { redactCanonicalImages } from "./CanonicalImageProjection";
import { openAIOfficialChatEffectBundle } from "./ChatCompletionsEffectBundles";
import { validateProviderContextFactsInFinalWire } from "./ProviderContextFactWireProfile";
import type { ProviderToolSchemaProjectionAuthority } from "@cell/ai-organ-contract/llm/ProviderToolSchemaProjection";
import {
  admitProviderRequest,
  assertProviderToolSchemaProtocol,
  prepareProviderToolSchemaProjection,
  readAdmittedProviderRequest,
  readProviderToolSchemaProjection,
} from "./tool-schema/ProviderRequestAdmission";

type OpenAICompletionsNodejsFetchAdapterSettings = {
  apiKey: string;
  baseUrl?: string;
  effectBundle?: ChatCompletionsEffectBundle;
  providerOptions?: ProviderOptions;
  requestObserver?: ProviderTransportRequestObserver;
};

type AdmittedChatGenerateOptions = Omit<
  LlmGenerateOptions,
  "tools" | "providerToolSchemaProjectionAuthority"
>;

const INTERNAL_EXTRA_BODY_KEYS = new Set(["prompt_plan", "work_context"]);
const TRANSPORT_EXTRA_BODY_KEYS = new Set([
  "timeout",
  "first_event_timeout",
  "first_event_timeout_seconds",
  "stream_idle_timeout",
  "stream_idle_timeout_seconds",
]);
const DEFAULT_FIRST_EVENT_TIMEOUT_SECONDS = 120;

type OpenAIStreamTimeouts = {
  requestStartedAt: number;
  firstEventTimeoutSeconds: number;
  totalTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
};

type OpenAIChatUsage = Readonly<{
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
}>;

function normalizeOpenAIChatUsage(value: unknown): OpenAIChatUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const source = value as Record<string, unknown>;
  const keys = [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_miss_tokens",
  ] as const;
  const usage = {} as Record<(typeof keys)[number], number>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const numeric = descriptor.value;
    if (!Number.isFinite(numeric) || numeric < 0) return undefined;
    usage[key] = numeric;
  }
  return Object.freeze(usage);
}

function observeOpenAIChatUsage(
  source: AsyncIterable<any>,
): Pick<LlmStreamResult, "stream" | "providerOutput"> {
  let resolveOutput!: (value: unknown | undefined) => void;
  const providerOutput = new Promise<unknown | undefined>((resolve) => {
    resolveOutput = resolve;
  });
  const stream = (async function* () {
    let usage: OpenAIChatUsage | undefined;
    try {
      for await (const chunk of source) {
        const candidate = normalizeOpenAIChatUsage(chunk?.usage);
        if (candidate) usage = candidate;
        yield chunk;
      }
      resolveOutput(usage ? Object.freeze({ usage }) : undefined);
    } catch (error) {
      resolveOutput(undefined);
      throw error;
    }
  })();
  return { stream, providerOutput };
}

async function* streamToOpenAIChunks(
  response: Response,
  timeouts: OpenAIStreamTimeouts,
  abortController: AbortController,
  cleanupAbortLink: () => void,
  getInternalTimeoutError: () => Error | undefined,
  abortForTimeout: (error: Error) => void,
): AsyncIterable<any> {
  if (!response.body) {
    try {
      const timeout = resolveReadTimeout(timeouts, false, Date.now());
      const payload = await raceWithTimeout(
        response.json().catch(() => null),
        timeout.seconds,
        () => timeout.error,
        abortForTimeout,
      );
      if (payload) {
        yield payload;
      }
    } catch (error) {
      throw getInternalTimeoutError() ?? error;
    } finally {
      cleanupAbortLink();
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawProviderEvent = false;
  let lastActivityAt = timeouts.requestStartedAt;

  const flushLine = (line: string): any | "DONE" | undefined => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return;
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.replace(/^data:\s*/, "");
    if (payload === "[DONE]") return "DONE";
    try {
      return JSON.parse(payload);
    } catch {
      return;
    }
  };

  try {
    while (true) {
      const timeout = resolveReadTimeout(
        timeouts,
        sawProviderEvent,
        lastActivityAt,
      );
      const { done, value } = await raceWithTimeout(
        reader.read(),
        timeout.seconds,
        () => timeout.error,
        abortForTimeout,
      );
      if (done) break;
      lastActivityAt = Date.now();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const result = flushLine(line);
        if (result === "DONE") {
          sawProviderEvent = true;
          return;
        }
        if (result) {
          sawProviderEvent = true;
          yield result;
        }
      }
    }
  } catch (error) {
    throw getInternalTimeoutError() ?? error;
  } finally {
    if (abortController.signal.aborted) {
      void reader.cancel(abortController.signal.reason).catch(() => {});
    }
    try {
      reader.releaseLock();
    } catch {}
    cleanupAbortLink();
  }

  if (buffer.trim()) {
    const result = flushLine(buffer);
    if (result && result !== "DONE") {
      yield result;
    }
  }
}

function toOpenAITools(tools: ToolSchema[]): ToolSchema[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools;
}

function sanitizeExtraBody(extraBody: unknown): Record<string, unknown> {
  if (!extraBody || typeof extraBody !== "object" || Array.isArray(extraBody))
    return {};
  return Object.fromEntries(
    Object.entries(extraBody as Record<string, unknown>).filter(
      ([key, value]) =>
        value !== undefined &&
        !INTERNAL_EXTRA_BODY_KEYS.has(key) &&
        !TRANSPORT_EXTRA_BODY_KEYS.has(key),
    ),
  );
}

function resolveStreamTimeouts(
  extraBody: unknown,
  providerOptions: ProviderOptions,
): OpenAIStreamTimeouts {
  const requestOptions =
    extraBody && typeof extraBody === "object" && !Array.isArray(extraBody)
      ? (extraBody as Record<string, unknown>)
      : {};
  const firstEventTimeoutSeconds =
    readPositiveNumber(
      requestOptions,
      "first_event_timeout_seconds",
      "first_event_timeout",
    ) ??
    readPositiveNumber(
      providerOptions,
      "first_event_timeout_seconds",
      "first_event_timeout",
    ) ??
    DEFAULT_FIRST_EVENT_TIMEOUT_SECONDS;
  return {
    requestStartedAt: Date.now(),
    firstEventTimeoutSeconds,
    totalTimeoutSeconds:
      readPositiveNumber(requestOptions, "timeout") ??
      readPositiveNumber(providerOptions, "timeout"),
    idleTimeoutSeconds:
      readPositiveNumber(
        requestOptions,
        "stream_idle_timeout_seconds",
        "stream_idle_timeout",
      ) ??
      readPositiveNumber(
        providerOptions,
        "stream_idle_timeout_seconds",
        "stream_idle_timeout",
      ),
  };
}

function readPositiveNumber(
  source: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const numeric = Number(source[key]);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return undefined;
}

function createLinkedAbortController(signal?: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  if (!signal) return { controller, cleanup: () => {} };
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    forwardAbort();
    return { controller, cleanup: () => {} };
  }
  signal.addEventListener("abort", forwardAbort, { once: true });
  return {
    controller,
    cleanup: () => signal.removeEventListener("abort", forwardAbort),
  };
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutSeconds: number | undefined,
  createError: () => Error,
  abortForTimeout: (error: Error) => void,
): Promise<T> {
  if (
    timeoutSeconds === undefined ||
    !Number.isFinite(timeoutSeconds)
  ) {
    return promise;
  }
  if (timeoutSeconds <= 0) {
    const error = createError();
    abortForTimeout(error);
    throw error;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = createError();
          abortForTimeout(error);
          reject(error);
        }, timeoutSeconds * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveReadTimeout(
  timeouts: OpenAIStreamTimeouts,
  sawProviderEvent: boolean,
  lastActivityAt: number,
): { seconds?: number; error: Error } {
  const now = Date.now();
  if (!sawProviderEvent) {
    const firstEventRemaining =
      timeouts.firstEventTimeoutSeconds -
      (now - timeouts.requestStartedAt) / 1000;
    const totalRemaining =
      timeouts.totalTimeoutSeconds === undefined
        ? undefined
        : timeouts.totalTimeoutSeconds -
          (now - timeouts.requestStartedAt) / 1000;
    const seconds = minDefined(firstEventRemaining, totalRemaining);
    return {
      seconds,
      error: createFirstEventTimeoutError(
        Math.min(
          timeouts.firstEventTimeoutSeconds,
          timeouts.totalTimeoutSeconds ?? Number.POSITIVE_INFINITY,
        ),
      ),
    };
  }

  const idleRemaining =
    timeouts.idleTimeoutSeconds === undefined
      ? undefined
      : timeouts.idleTimeoutSeconds - (now - lastActivityAt) / 1000;
  const totalRemaining =
    timeouts.totalTimeoutSeconds === undefined
      ? undefined
      : timeouts.totalTimeoutSeconds -
        (now - timeouts.requestStartedAt) / 1000;
  const seconds = minDefined(idleRemaining, totalRemaining);
  const configuredTimeoutSeconds =
    idleRemaining !== undefined &&
    (totalRemaining === undefined || idleRemaining <= totalRemaining)
      ? timeouts.idleTimeoutSeconds
      : timeouts.totalTimeoutSeconds;
  return {
    seconds,
    error: createStreamTimeoutError(configuredTimeoutSeconds ?? 0),
  };
}

function minDefined(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function createFirstEventTimeoutError(seconds: number): Error {
  return new Error(
    `first event exceeded timeout after ${formatTimeoutSeconds(seconds)}s`,
  );
}

function createStreamTimeoutError(seconds: number): Error {
  return new Error(
    `stream exceeded timeout after ${formatTimeoutSeconds(seconds)}s`,
  );
}

function formatTimeoutSeconds(seconds: number): string {
  return Number.isInteger(seconds)
    ? String(seconds)
    : String(Number(seconds.toFixed(3)));
}

function parseOpenAIErrorCode(errorText: string): string {
  try {
    const parsed = JSON.parse(errorText);
    const error =
      parsed && typeof parsed === "object" ? (parsed as any).error : null;
    return typeof error?.code === "string" ? error.code : "";
  } catch {
    return "";
  }
}

export class OpenAICompletionsNodejsFetchLlmAdapter implements LlmAdapter {
  readonly type = "openai" as const;
  readonly chatCompletionsEffectBundle: ChatCompletionsEffectBundle;
  private apiKey: string;
  private baseUrl?: string;
  private providerOptions: ProviderOptions;
  private requestObserver?: ProviderTransportRequestObserver;

  constructor(settings: OpenAICompletionsNodejsFetchAdapterSettings) {
    this.apiKey = settings.apiKey;
    this.baseUrl = settings.baseUrl;
    this.chatCompletionsEffectBundle =
      settings.effectBundle ?? openAIOfficialChatEffectBundle;
    this.providerOptions = settings.providerOptions ?? {};
    this.requestObserver = settings.requestObserver;
  }

  async createStream(options: LlmGenerateOptions): Promise<LlmStreamResult> {
    const authority = prepareProviderToolSchemaProjection(
      this.chatCompletionsEffectBundle.toolSchemaProjector,
      toOpenAITools(options.tools) ?? [],
    );
    const { tools: _tools, providerToolSchemaProjectionAuthority: _authority, ...admittedOptions } = options;
    return this.createAdmittedStream(admittedOptions, authority);
  }

  async createAdmittedStream(
    options: AdmittedChatGenerateOptions,
    toolSchemaProjectionAuthority: ProviderToolSchemaProjectionAuthority,
  ): Promise<LlmStreamResult> {
    const { model, messages, extraBody, signal } = options;
    const timeouts = resolveStreamTimeouts(extraBody, this.providerOptions);
    const abortLink = createLinkedAbortController(signal);
    let internalTimeoutError: Error | undefined;
    const abortForTimeout = (error: Error) => {
      internalTimeoutError = error;
      abortLink.controller.abort(error);
    };

    const extra = sanitizeExtraBody(extraBody);
    if (
      this.chatCompletionsEffectBundle.id.startsWith("deepseek-")
      && !Object.prototype.hasOwnProperty.call(extra, "stream_options")
    ) {
      extra.stream_options = { include_usage: true };
    }
    const providerOptions = this.providerOptions;
    const toolProjection = readProviderToolSchemaProjection(toolSchemaProjectionAuthority);
    assertProviderToolSchemaProtocol(
      toolProjection.protocol,
      this.chatCompletionsEffectBundle.toolSchemaProjector.protocol,
    );
    const body = this.chatCompletionsEffectBundle.projectRequest({
      model,
      messages,
      tools: toolProjection.tools,
      extraBody: extra,
      toolSchemaProjectionAuthority,
    });
    const url = this.chatCompletionsEffectBundle.resolveEndpoint(
      (providerOptions.baseURL as string | undefined) || this.baseUrl,
    );
    const apiKey =
      (providerOptions.apiKey as string | undefined) || this.apiKey;
    if (!apiKey) {
      throw new Error("OpenAI API key missing");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(providerOptions.headers || {}),
    };
    const admitted = admitProviderRequest(toolSchemaProjectionAuthority, body);
    const admittedRequest = readAdmittedProviderRequest(admitted);
    const serializedBody = admittedRequest.serializedBody;
    validateProviderContextFactsInFinalWire({
      profileId: this.chatCompletionsEffectBundle.id === "deepseek-official-chat"
        ? "deepseek-official-chat@1"
        : this.chatCompletionsEffectBundle.id === "deepseek-compatible-chat"
          ? "deepseek-compatible-chat@1"
          : "openai-chat@1",
      serializedBody,
    });

    if (process.env.MINIMAX_DEBUG === "1") {
      console.log("[openai] request", JSON.stringify(redactCanonicalImages({ url, body: JSON.parse(serializedBody) }), null, 2));
    }

    const fetchFn = providerOptions.fetch || fetch;
    observeProviderTransportRequest(this.requestObserver, {
      transportType: "http",
      requestBody: serializedBody,
      url,
      method: "POST",
      toolSchemaCoverage: admittedRequest.coverageObservation,
    });
    let res: Response;
    try {
      const headerTimeoutSeconds =
        minDefined(
          timeouts.firstEventTimeoutSeconds,
          timeouts.totalTimeoutSeconds,
        ) ?? timeouts.firstEventTimeoutSeconds;
      res = await raceWithTimeout(
        fetchFn(url, {
          method: "POST",
          headers,
          body: serializedBody,
          signal: abortLink.controller.signal,
        }),
        headerTimeoutSeconds,
        () => createFirstEventTimeoutError(headerTimeoutSeconds),
        abortForTimeout,
      );
    } catch (error) {
      abortLink.cleanup();
      throw internalTimeoutError ?? error;
    }

    if (!res.ok) {
      let errorText = "";
      try {
        const timeout = resolveReadTimeout(
          timeouts,
          false,
          timeouts.requestStartedAt,
        );
        errorText = await raceWithTimeout(
          res.text().catch(() => ""),
          timeout.seconds,
          () => timeout.error,
          abortForTimeout,
        );
      } catch (error) {
        throw internalTimeoutError ?? error;
      } finally {
        abortLink.cleanup();
      }
      throw new ProviderExecutionError(
        `OpenAI fetch error ${res.status}: ${errorText || res.statusText}`,
        {
          providerErrorCode: parseOpenAIErrorCode(errorText),
          statusCode: res.status,
        },
      );
    }

    return observeOpenAIChatUsage(
      streamToOpenAIChunks(
        res,
        timeouts,
        abortLink.controller,
        abortLink.cleanup,
        () => internalTimeoutError,
        abortForTimeout,
      ),
    );
  }
}

/** Capability-only transport boundary used by configured provider drivers. */
export class OpenAICompletionsAdmittedFetchTransport {
  private readonly compatibilityAdapter: OpenAICompletionsNodejsFetchLlmAdapter;

  constructor(settings: OpenAICompletionsNodejsFetchAdapterSettings) {
    this.compatibilityAdapter = new OpenAICompletionsNodejsFetchLlmAdapter(settings);
  }

  createStream(
    options: AdmittedChatGenerateOptions,
    authority: ProviderToolSchemaProjectionAuthority,
  ): Promise<LlmStreamResult> {
    return this.compatibilityAdapter.createAdmittedStream(options, authority);
  }
}
