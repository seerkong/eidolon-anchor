import { describe, expect, it } from "bun:test";
import { buildProviderDriverRegistry, getProviderDriver, ProviderExecutionError, ProviderRuntimeLlmAdapter } from "@cell/ai-organ-logic/llm";
import type { ProviderDriverDefinition } from "@cell/ai-organ-contract/llm/ProviderRuntime";

describe("provider runtime driver registry", () => {
  it("resolves Sparrow-style provider driver aliases", () => {
    const registry = buildProviderDriverRegistry();
    expect(Object.keys(registry).sort()).toEqual(["anthropic", "claude-code", "deepseek-chat", "openai-chat", "openai-responses"]);
    expect(getProviderDriver("openai-chat").name).toBe("openai-chat");
    expect(getProviderDriver("openai_responses").name).toBe("openai-responses");
    expect(getProviderDriver("claude_code").name).toBe("claude-code");
    expect(getProviderDriver("anthropic-chat").name).toBe("anthropic");
    expect(getProviderDriver("deepseek").name).toBe("deepseek-chat");
  });

  it("prepares DeepSeek provider requests with cache-aware metadata", () => {
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "deepseek",
      selectedModel: "deepseek/deepseek-reasoner",
      adapterName: "deepseek",
      options: {
        apiKey: "k-deepseek",
        baseURL: "https://api.deepseek.com/v1",
      },
    });

    const prepared = adapter.prepareRequest({ model: "deepseek-reasoner", messages: [], tools: [] });
    expect(adapter.type).toBe("deepseek");
    expect(prepared.driver.name).toBe("deepseek-chat");
    expect(prepared.connectionOptions.api_key).toBe("k-deepseek");
    expect(prepared.contract.body?.model).toBe("deepseek-reasoner");
    expect(prepared.contract.body?.cache_profile).toEqual(
      expect.objectContaining({
        provider_family: "deepseek",
        stable_prefix: true,
        provider_managed_prefix_cache: true,
        prefer_late_compaction: true,
      }),
    );
    expect(prepared.contract.body?.model_capabilities).toEqual(
      expect.objectContaining({
        family: "deepseek",
        reasoningEffort: "high",
      }),
    );
  });

  it("keeps runtime-only prompt diagnostics out of DeepSeek request contracts", () => {
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "deepseek",
      selectedModel: "deepseek/deepseek-reasoner",
      adapterName: "deepseek",
      options: {
        apiKey: "k-deepseek",
        baseURL: "https://api.deepseek.com/v1",
      },
    });

    const prepared = adapter.prepareRequest({
      model: "deepseek-reasoner",
      messages: [],
      tools: [],
      extraBody: {
        prompt_plan: { id: "plan", turn: 1 },
        work_context: { task_phase: "implementation" },
        thinking: { type: "enabled" },
      },
    });

    expect(prepared.contract.body).not.toHaveProperty("prompt_plan");
    expect(prepared.contract.body).not.toHaveProperty("work_context");
    expect(prepared.contract.body?.thinking).toEqual({ type: "enabled" });
  });

  it("prepares connection, request, extra body, and continuation options", () => {
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "codex",
      selectedModel: "codex/gpt-5",
      adapterName: "openai-responses",
      options: {
        apiKey: "k",
        baseURL: "https://example.test/v1",
        temperature: 0.2,
        reasoning: { effort: "high" },
        reasoningSplit: true,
        responsesContinuationMode: "stateful_chain",
      },
    });

    const prepared = adapter.prepareRequest({ model: "gpt-5", messages: [], tools: [] });
    expect(prepared.driver.name).toBe("openai-responses");
    expect(prepared.connectionOptions.api_key).toBe("k");
    expect(prepared.connectionOptions.base_url).toBe("https://example.test/v1");
    expect(prepared.requestOptions.temperature).toBe(0.2);
    expect(prepared.requestOptions.reasoning).toEqual({ effort: "high" });
    expect(prepared.extraBody.reasoning_split).toBe(true);
    expect(prepared.continuation.mode).toBe("stateful_chain");
  });

  it("invokes provider scene capture hook for request and response without driver coupling", async () => {
    const captures: unknown[] = [];
    const driver: ProviderDriverDefinition = {
      name: "test-driver",
      adapterNames: ["openai-chat"],
      buildRequest: (params) => ({
        body: {
          model: params.model,
        },
      }),
      createStream: async () => ({
        stream: (async function* () {
          yield { type: "done" };
        })(),
      }),
    };
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "test-provider",
      selectedModel: "test-model",
      adapterName: "openai-chat",
      driver,
      runtime: {
        turnId: "request-1",
        traceId: "trace-1",
        sceneCaptureHook: (data) => captures.push(data),
      },
    });

    await adapter.createStream({ model: "test-model", messages: [], tools: [] });

    expect(captures).toEqual([
      expect.objectContaining({
        providerId: "test-provider",
        model: "test-model",
        phase: "request",
        requestId: "request-1",
        traceId: "trace-1",
      }),
      expect.objectContaining({
        providerId: "test-provider",
        model: "test-model",
        phase: "response",
        requestId: "request-1",
        traceId: "trace-1",
      }),
    ]);
  });

  it("isolates provider scene capture failures and captures driver errors", async () => {
    const captures: unknown[] = [];
    const driver: ProviderDriverDefinition = {
      name: "test-driver",
      adapterNames: ["openai-chat"],
      createStream: async () => {
        throw new Error("provider unavailable");
      },
    };
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "test-provider",
      selectedModel: "test-model",
      adapterName: "openai-chat",
      driver,
      runtime: {
        sceneCaptureHook: (data) => {
          captures.push(data);
          if (data.phase === "request") {
            throw new Error("capture unavailable");
          }
        },
      },
    });

    await expect(adapter.createStream({ model: "test-model", messages: [], tools: [] })).rejects.toThrow(
      "provider unavailable",
    );

    expect(captures).toEqual([
      expect.objectContaining({ phase: "request" }),
      expect.objectContaining({ phase: "error", error: "provider unavailable" }),
    ]);
  });

  it("retries transient provider runtime stream failures and emits diagnostics", async () => {
    const diagnostics: unknown[] = [];
    let attempts = 0;
    const driver: ProviderDriverDefinition = {
      name: "test-driver",
      adapterNames: ["openai-chat"],
      createStream: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new ProviderExecutionError(
            "OpenAI fetch error 500: {\"error\":{\"message\":\"upstream error: do request failed\",\"code\":\"do_request_failed\"}}",
            { providerErrorCode: "do_request_failed", requestedDelaySeconds: 0, statusCode: 500 },
          );
        }
        return {
          stream: (async function* () {
            yield { type: "done" };
          })(),
        };
      },
    };
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "test-provider",
      selectedModel: "test-model",
      adapterName: "openai-chat",
      driver,
      runtime: {
        actorId: "actor-1",
        sessionId: "session-1",
        turnId: "turn-1",
        traceId: "trace-1",
        diagnostics: {
          retryEvents: { onNext: (event) => diagnostics.push(event) },
        },
      },
    });

    await adapter.createStream({ model: "test-model", messages: [], tools: [] });

    expect(attempts).toBe(2);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        eventType: "provider_retry_diagnostic",
        providerId: "test-provider",
        selectedModel: "test-model",
        classificationReason: "http_500_retryable",
        retryCount: 1,
        terminationReason: "retry_scheduled",
        actorId: "actor-1",
        sessionId: "session-1",
        turnId: "turn-1",
        traceId: "trace-1",
      }),
    ]);
  });
});
