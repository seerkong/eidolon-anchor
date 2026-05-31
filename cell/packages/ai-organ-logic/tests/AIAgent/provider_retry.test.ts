import { describe, expect, it } from "bun:test";
import {
  classifyProviderRetry,
  executeWithProviderRetry,
  ProviderExecutionError,
  resolveProviderRetryPolicy,
} from "@cell/ai-organ-logic/llm";

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
});
