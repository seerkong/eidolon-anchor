import { describe, expect, it } from "bun:test";
import {
  classifyProviderRetry,
  createProviderStreamWithRetry,
  executeWithProviderRetry,
  ProviderExecutionError,
  resolveProviderRetryPolicy,
} from "@cell/ai-organ-logic/llm";
import {
  ChatCompletionsOutputTruncatedError,
  ChatCompletionsProtocolError,
  ChatCompletionsReasoningOnlyError,
} from "@cell/ai-organ-logic/stream/ChatCompletionsStreamCore";

describe("provider retry classification", () => {
  it("classifies retryable HTTP and retry-after provider errors", () => {
    const error = new ProviderExecutionError("too many requests", {
      statusCode: 429,
      providerErrorCode: "rate_limit_exceeded",
      retryAfterSeconds: 3,
    });

    const classification = classifyProviderRetry(error);

    expect(classification.retryable).toBe(true);
    expect(classification.classificationReason).toBe("http_429_retryable");
    expect(classification.phase).toBe("request_sent");
    expect(error.providerErrorCode).toBe("rate_limit_exceeded");
    expect(error.retryAfterSeconds).toBe(3);
    expect(error.requestedDelaySeconds).toBe(3);
  });

  it("classifies client authentication and invalid request failures as non-retryable", () => {
    const auth = classifyProviderRetry(new ProviderExecutionError("invalid api key", { statusCode: 401 }));
    const invalidModel = classifyProviderRetry(new Error("invalid model requested"));

    expect(auth.retryable).toBe(false);
    expect(auth.classificationReason).toBe("http_401_non_retryable");
    expect(invalidModel.retryable).toBe(false);
    expect(invalidModel.classificationReason).toBe("provider_error_non_retryable");
  });

  it("classifies OpenAI-compatible upstream 500 do_request_failed errors as retryable", () => {
    const classification = classifyProviderRetry(
      new Error(
        "OpenAI fetch error 500: {\"error\":{\"message\":\"upstream error: do request failed\",\"type\":\"new_api_error\",\"code\":\"do_request_failed\"}}",
      ),
    );

    expect(classification.retryable).toBe(true);
    expect(classification.classificationReason).toBe("http_500_retryable");
  });

  it("classifies first-event timeout as safe stream recovery with a narrow policy", () => {
    const classification = classifyProviderRetry(new Error("first event exceeded timeout after 5s"));
    const policy = resolveProviderRetryPolicy(classification.classificationReason);

    expect(classification.retryable).toBe(true);
    expect(classification.classificationReason).toBe("first_event_timeout_retryable");
    expect(classification.layer).toBe("stream_protocol");
    expect(classification.phase).toBe("before_accept");
    expect(classification.retryScope).toBe("stream_recover");
    expect(classification.replaySafety).toBe("safe_same_contract");
    expect(policy.maxRetries).toBe(1);
    expect(policy.maxTotalElapsedSeconds).toBeGreaterThan(120);
  });

  it("allows one retry after a transport timeout that outlives the generic retry budget", () => {
    const error = new DOMException("The operation timed out.", "TimeoutError");
    const classification = classifyProviderRetry(error);
    const policy = resolveProviderRetryPolicy(classification.classificationReason);

    expect(classification.retryable).toBe(true);
    expect(classification.classificationReason).toBe("transport_timeout_retryable");
    expect(classification.phase).toBe("before_accept");
    expect(classification.replaySafety).toBe("safe_same_contract");
    expect(policy.maxRetries).toBe(1);
    expect(policy.maxTotalElapsedSeconds).toBeGreaterThan(300);
  });

  it("classifies malformed chat tool arguments as one safe pre-dispatch repair", () => {
    const error = new ChatCompletionsProtocolError([{
      code: "invalid_tool_call_payload",
      message: "tool call call_1 has invalid JSON arguments",
    }]);
    const classification = classifyProviderRetry(error);
    const policy = resolveProviderRetryPolicy(classification.classificationReason);

    expect(classification).toMatchObject({
      retryable: true,
      classificationReason: "chat_tool_payload_recoverable",
      phase: "before_tool_dispatch",
      retryScope: "assistant_turn_repair",
      replaySafety: "safe_before_tool_dispatch",
    });
    expect(policy.maxRetries).toBe(1);
    expect(policy.baseDelaySeconds).toBe(0);
  });

  it("routes output-limit truncation to semantic-completion budget ownership", () => {
    const classification = classifyProviderRetry(new ChatCompletionsOutputTruncatedError());
    const policy = resolveProviderRetryPolicy(classification.classificationReason);

    expect(classification).toMatchObject({
      retryable: true,
      classificationReason: "chat_output_truncated_recoverable",
      phase: "before_tool_dispatch",
      retryScope: "assistant_turn_semantic_completion",
      replaySafety: "safe_before_tool_dispatch",
    });
    expect(policy.maxRetries).toBe(0);
    expect(policy.baseDelaySeconds).toBe(0);
  });

  it("routes a reasoning-only normal stop to semantic-completion budget ownership", () => {
    const classification = classifyProviderRetry(new ChatCompletionsReasoningOnlyError("stop"));

    expect(classification).toMatchObject({
      retryable: true,
      classificationReason: "chat_reasoning_only_recoverable",
      phase: "before_tool_dispatch",
      retryScope: "assistant_turn_semantic_completion",
      replaySafety: "safe_before_tool_dispatch",
    });
    expect(resolveProviderRetryPolicy(classification.classificationReason).maxRetries).toBe(0);
  });

  it("classifies Bun premature socket closure as safe pre-accept transport replay", () => {
    const classification = classifyProviderRetry(
      new Error("The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()"),
    );

    expect(classification).toEqual({
      retryable: true,
      classificationReason: "transport_socket_closed_retryable",
      layer: "transport",
      phase: "before_accept",
      retryScope: "request_replay",
      replaySafety: "safe_same_contract",
    });
    expect(resolveProviderRetryPolicy(classification.classificationReason)).toEqual(
      resolveProviderRetryPolicy("provider_error_retryable"),
    );
  });
});

describe("provider retry executor", () => {
  it("retries transient failures and emits retry diagnostics", async () => {
    const diagnostics: any[] = [];
    let attempts = 0;

    const result = await executeWithProviderRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new ProviderExecutionError("upstream overloaded", { statusCode: 503 });
        }
        return "ok";
      },
      {
        stage: "stream",
        providerId: "openai",
        selectedModel: "openai/gpt-4o",
        policy: { maxRetries: 2, baseDelaySeconds: 0, maxDelaySeconds: 0, maxTotalElapsedSeconds: 10 },
        sleep: async () => {},
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].classificationReason).toBe("http_503_retryable");
    expect(diagnostics[0].attemptNumber).toBe(1);
    expect(diagnostics[0].retryCount).toBe(1);
    expect(diagnostics[0].terminationReason).toBe("retry_scheduled");
  });

  it("does not retry non-retryable failures", async () => {
    let attempts = 0;

    await expect(
      executeWithProviderRetry(
        async () => {
          attempts += 1;
          throw new ProviderExecutionError("invalid api key", { statusCode: 401 });
        },
        {
          stage: "stream",
          providerId: "openai",
          selectedModel: "openai/gpt-4o",
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("invalid api key");

    expect(attempts).toBe(1);
  });

  it("retries a native transport timeout after a five-minute first attempt", async () => {
    const diagnostics: any[] = [];
    let attempts = 0;
    let now = 0;

    const result = await executeWithProviderRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          now = 295;
          throw new DOMException("The operation timed out.", "TimeoutError");
        }
        return "ok";
      },
      {
        stage: "stream",
        providerId: "deepseek-iqingwa",
        selectedModel: "deepseek-v4-flash",
        now: () => now,
        random: () => 0.5,
        sleep: async () => {},
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].classificationReason).toBe("transport_timeout_retryable");
    expect(diagnostics[0].terminationReason).toBe("retry_scheduled");
  });

  it("retries Bun premature socket closure before the first visible stream output", async () => {
    const diagnostics: any[] = [];
    let attempts = 0;
    const socketClose = new Error("The socket connection was closed unexpectedly");
    const result = createProviderStreamWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            stream: (async function* () {
              throw socketClose;
            })(),
          };
        }
        return {
          stream: (async function* () {
            yield { choices: [{ delta: { content: "recovered" } }] };
          })(),
          providerOutput: Promise.resolve({ id: "second-attempt" }),
        };
      },
      {
        stage: "stream",
        providerId: "deepseek",
        selectedModel: "deepseek-v4-flash",
        sleep: async () => {},
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );

    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);

    expect(chunks).toEqual([{ choices: [{ delta: { content: "recovered" } }] }]);
    expect(await result.providerOutput).toEqual({ id: "second-attempt" });
    expect(attempts).toBe(2);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      classificationReason: "transport_socket_closed_retryable",
      classificationLayer: "transport",
      classificationPhase: "before_accept",
      retryScope: "request_replay",
      replaySafety: "safe_same_contract",
      terminationReason: "retry_scheduled",
    });
  });

  it("does not replay Bun socket closure after visible stream output", async () => {
    const diagnostics: any[] = [];
    let attempts = 0;
    const socketClose = new Error("The socket connection was closed unexpectedly");
    const result = createProviderStreamWithRetry(
      async () => {
        attempts += 1;
        return {
          stream: (async function* () {
            yield { choices: [{ delta: { content: "accepted" } }] };
            throw socketClose;
          })(),
        };
      },
      {
        stage: "stream",
        providerId: "deepseek",
        selectedModel: "deepseek-v4-flash",
        sleep: async () => {},
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );

    const providerOutput = result.providerOutput.catch((error) => error);
    const iterator = result.stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { choices: [{ delta: { content: "accepted" } }] },
    });
    await expect(iterator.next()).rejects.toThrow("socket connection was closed unexpectedly");
    expect((await providerOutput).message).toContain("socket connection was closed unexpectedly");
    expect(attempts).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      classificationReason: "transport_socket_closed_retryable",
      classificationPhase: "provider_accepted",
      replaySafety: "indeterminate_after_accept",
      terminationReason: "indeterminate_after_accept",
    });
  });

  it("trusts attempt output observation when failure precedes chunk delivery", async () => {
    const diagnostics: any[] = [];
    let attempts = 0;
    const socketClose = new Error("The socket connection was closed unexpectedly");
    const result = createProviderStreamWithRetry(
      async () => {
        attempts += 1;
        return {
          stream: (async function* () {
            throw socketClose;
          })(),
          outputObserved: () => true,
        };
      },
      {
        stage: "stream",
        providerId: "deepseek",
        selectedModel: "deepseek-v4-flash",
        sleep: async () => {},
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );

    const providerOutput = result.providerOutput.catch((error) => error);
    await expect(result.stream[Symbol.asyncIterator]().next()).rejects.toThrow(
      "socket connection was closed unexpectedly",
    );
    expect((await providerOutput).message).toContain("socket connection was closed unexpectedly");
    expect(attempts).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      classificationReason: "transport_socket_closed_retryable",
      classificationPhase: "provider_accepted",
      replaySafety: "indeterminate_after_accept",
      terminationReason: "indeterminate_after_accept",
    });
  });
});
