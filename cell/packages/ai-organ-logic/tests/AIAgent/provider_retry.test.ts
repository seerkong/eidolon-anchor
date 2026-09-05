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
  for (const mode of ["operation", "stream"] as const) {
    const run = async (operation: () => Promise<string>, options: any) => {
      if (mode === "operation") return executeWithProviderRetry(operation, options);
      const result = createProviderStreamWithRetry(async () => ({
        stream: (async function* () {
          yield await operation();
        })(),
      }), options);
      void result.providerOutput.catch(() => undefined);
      for await (const _chunk of result.stream) { /* Consume the attempt. */ }
      return "ok";
    };
    const identity = { stage: "stream", providerId: "compatible", selectedModel: "model" };

    it(`${mode}: preserves three exponential retries after a 121-second first request`, async () => {
      let now = 0;
      let attempts = 0;
      const waits: number[] = [];
      const diagnostics: any[] = [];
      const failure = new Error("The socket connection was closed unexpectedly");
      await expect(run(async () => {
        attempts += 1;
        now += 121;
        throw failure;
      }, {
        ...identity, now: () => now, random: () => 0.5,
        sleep: async (seconds: number) => { waits.push(seconds); now += seconds; },
        onDiagnostic: (event: any) => diagnostics.push(event),
      })).rejects.toThrow(failure.message);
      expect(attempts).toBe(4);
      expect(waits).toEqual([1, 2, 4]);
      expect(diagnostics.map((event) => event.cumulativeBackoffSeconds)).toEqual([0, 1, 3, 7]);
      expect(diagnostics[0].elapsedSeconds).toBe(121);
      expect(diagnostics.at(-1).terminationReason).toBe("retry_exhausted");
    });

    it(`${mode}: enforces cumulative backoff independently of request time`, async () => {
      let attempts = 0;
      const waits: number[] = [];
      const diagnostics: any[] = [];
      await expect(run(async () => {
        attempts += 1;
        throw new Error("network error");
      }, {
        ...identity, policy: { maxTotalBackoffSeconds: 2 }, now: () => 0, random: () => 0.5,
        sleep: async (seconds: number) => { waits.push(seconds); },
        onDiagnostic: (event: any) => diagnostics.push(event),
      })).rejects.toThrow("network error");
      expect(attempts).toBe(2);
      expect(waits).toEqual([1]);
      expect(diagnostics.at(-1).terminationReason).toBe("retry_backoff_budget_exhausted");
    });

    for (const point of ["initial", "failure", "before_wait", "during_wait", "after_wait"] as const) {
      it(`${mode}: does not start another attempt when cancelled ${point}`, async () => {
        const controller = new AbortController();
        const cancelled = new Error("user cancelled");
        let attempts = 0;
        let waits = 0;
        const diagnostics: any[] = [];
        if (point === "initial") controller.abort(cancelled);
        await expect(run(async () => {
          attempts += 1;
          if (point === "failure") controller.abort(cancelled);
          throw new Error("network error");
        }, {
          ...identity, signal: controller.signal,
          onDiagnostic: (event: any) => {
            diagnostics.push(event);
            if (point === "before_wait") controller.abort(cancelled);
          },
          sleep: async () => {
            waits += 1;
            if (point === "during_wait") {
              queueMicrotask(() => controller.abort(cancelled));
              await new Promise(() => {});
            }
            if (point === "after_wait") controller.abort(cancelled);
          },
        })).rejects.toThrow("user cancelled");
        expect(attempts).toBe(point === "initial" ? 0 : 1);
        expect(waits).toBe(point === "during_wait" || point === "after_wait" ? 1 : 0);
        expect(diagnostics.at(-1).terminationReason).toBe("aborted");
      });
    }

    it(`${mode}: refuses a wait that reaches the explicit operation deadline`, async () => {
      let now = 0;
      let attempts = 0;
      let waits = 0;
      const diagnostics: any[] = [];
      await expect(run(async () => {
        attempts += 1;
        now = 9;
        throw new Error("network error");
      }, {
        ...identity, policy: { maxTotalElapsedSeconds: 10 }, now: () => now, random: () => 0.5,
        sleep: async () => { waits += 1; },
        onDiagnostic: (event: any) => diagnostics.push(event),
      })).rejects.toThrow("network error");
      expect(attempts).toBe(1);
      expect(waits).toBe(0);
      expect(diagnostics.at(-1).terminationReason).toBe("retry_time_budget_exhausted");
    });

    it(`${mode}: rechecks the deadline after waiting`, async () => {
      let now = 0;
      let attempts = 0;
      const diagnostics: any[] = [];
      await expect(run(async () => {
        attempts += 1;
        throw new Error("network error");
      }, {
        ...identity, policy: { maxTotalElapsedSeconds: 10 }, now: () => now,
        sleep: async () => { now = 10; },
        onDiagnostic: (event: any) => diagnostics.push(event),
      })).rejects.toThrow("network error");
      expect(attempts).toBe(1);
      expect(diagnostics.at(-1).terminationReason).toBe("retry_time_budget_exhausted");
    });

    it(`${mode}: stops if actual waiting overshoots the backoff budget`, async () => {
      let now = 0;
      let attempts = 0;
      const diagnostics: any[] = [];
      await expect(run(async () => {
        attempts += 1;
        throw new Error("network error");
      }, {
        ...identity, policy: { maxTotalBackoffSeconds: 2 }, now: () => now, random: () => 0.5,
        sleep: async () => { now = 3; },
        onDiagnostic: (event: any) => diagnostics.push(event),
      })).rejects.toThrow("network error");
      expect(attempts).toBe(1);
      expect(diagnostics.at(-1)).toMatchObject({
        cumulativeBackoffSeconds: 3, terminationReason: "retry_backoff_budget_exhausted",
      });
    });

    it(`${mode}: an expired explicit deadline prevents even the first attempt`, async () => {
      let attempts = 0;
      await expect(run(async () => { attempts += 1; return "ok"; }, {
        ...identity, policy: { maxTotalElapsedSeconds: 0 }, now: () => 0,
      })).rejects.toThrow("deadline exceeded");
      expect(attempts).toBe(0);
    });

    it(`${mode}: interrupts a stalled sleeper when the deadline expires`, async () => {
      let attempts = 0;
      const diagnostics: any[] = [];
      await expect(run(async () => {
        attempts += 1;
        throw new Error("network error");
      }, {
        ...identity,
        policy: { maxTotalElapsedSeconds: 0.02, baseDelaySeconds: 0, maxDelaySeconds: 0 },
        sleep: async () => { await new Promise(() => {}); },
        onDiagnostic: (event: any) => diagnostics.push(event),
      })).rejects.toThrow("network error");
      expect(attempts).toBe(1);
      expect(diagnostics.at(-1).terminationReason).toBe("retry_time_budget_exhausted");
    });

    it(`${mode}: cancels the default timer without waiting for the backoff`, async () => {
      let attempts = 0;
      const controller = new AbortController();
      const diagnostics: any[] = [];
      await expect(run(async () => {
        attempts += 1;
        throw new Error("network error");
      }, {
        ...identity, signal: controller.signal,
        policy: { baseDelaySeconds: 30, maxDelaySeconds: 30 },
        onDiagnostic: (event: any) => {
          diagnostics.push(event);
          if (event.terminationReason === "retry_scheduled") {
            setTimeout(() => controller.abort(new Error("user cancelled")), 0);
          }
        },
      })).rejects.toThrow("user cancelled");
      expect(attempts).toBe(1);
      expect(diagnostics.at(-1).terminationReason).toBe("aborted");
    });
  }

  it("lets the completion owner exclude semantic repair without changing classification", async () => {
    const error = new ChatCompletionsProtocolError([{
      code: "invalid_tool_call_payload", message: "invalid JSON arguments",
    }]);
    let attempts = 0;
    const diagnostics: any[] = [];
    await expect(executeWithProviderRetry(async () => {
      attempts += 1;
      throw error;
    }, {
      stage: "stream", providerId: "compatible", selectedModel: "model",
      shouldRetry: (_error, classification) => classification.retryScope !== "assistant_turn_repair",
      sleep: async () => {},
      onDiagnostic: (event, context) => diagnostics.push({ event, context }),
    })).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(diagnostics[0].context).toEqual({ error, attemptNumber: 1 });
    expect(diagnostics[0].event.terminationReason).toBe("retry_filtered");
  });

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
