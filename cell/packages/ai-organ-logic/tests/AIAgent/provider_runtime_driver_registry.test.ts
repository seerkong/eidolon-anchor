import { describe, expect, it } from "bun:test";
import { buildProviderDriverRegistry, getProviderDriver, ProviderExecutionError, ProviderRuntimeLlmAdapter } from "@cell/ai-organ-logic/llm";
import type { ProviderDriverDefinition } from "@cell/ai-organ-contract/llm/ProviderRuntime";
import { buildWorkflowNativeToolDefs } from "../../src/workflow/tools";

function sseDone(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

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
    expect(Object.values(prepared.contract.body?.model_capabilities ?? {}))
      .not.toContain(undefined);
  });

  it("sends the real authoring-session schema through the configured DeepSeek runtime", async () => {
    const workflowOpen = buildWorkflowNativeToolDefs().find(
      (definition) => definition.schema.function.name === "WorkflowOpenAuthoringSession",
    );
    if (!workflowOpen) throw new Error("WorkflowOpenAuthoringSession ToolDef missing");
    const observations: any[] = [];
    let fetchedBody = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      fetchedBody = String(init?.body ?? "");
      return sseDone();
    }) as typeof fetch;
    try {
      const adapter = new ProviderRuntimeLlmAdapter({
        providerId: "deepseek",
        selectedModel: "deepseek/deepseek-v4-flash",
        adapterName: "deepseek",
        options: {
          apiKey: "test-key",
          baseURL: "https://api.deepseek.com/v1",
        },
        runtime: {
          requestObservationPort: {
            append: (observation) => observations.push(observation),
            appendOutcome: () => undefined,
          },
        },
      });

      const result = await adapter.createStream({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "Open an authoring session" }],
        tools: [workflowOpen.schema],
      });
      for await (const _chunk of result.stream) {
        // Consume the real configured transport stream.
      }

      expect(observations).toHaveLength(1);
      expect(observations[0].requestBody).toBe(fetchedBody);
      const body = JSON.parse(fetchedBody);
      expect(body.tools[0].function.parameters).toEqual(
        workflowOpen.schema.function.parameters,
      );
      expect(body.tools[0].function.parameters.type).toBe("object");
      expect(body.tools[0].function.parameters.oneOf).toHaveLength(3);
      expect(body.model_capabilities).toEqual({
        family: "deepseek",
        cachePolicy: {
          stablePrefix: true,
          providerManagedPrefixCache: true,
          preferLateCompaction: true,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
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

    const result = await adapter.createStream({ model: "test-model", messages: [], tools: [] });
    for await (const _chunk of result.stream) {
      // consume the attempt so response capture reflects a completed stream
    }

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

    const result = await adapter.createStream({ model: "test-model", messages: [], tools: [] });
    await expect((async () => {
      for await (const _chunk of result.stream) {
        // consume until the provider creation failure is surfaced
      }
    })()).rejects.toThrow("provider unavailable");

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

    const result = await adapter.createStream({ model: "test-model", messages: [], tools: [] });
    for await (const _chunk of result.stream) {
      // consume the successful retry
    }

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

  it("prepares one tool projection authority and reuses it across stream retries", async () => {
    const preparedAuthorities: unknown[] = [];
    const observedAuthorities: unknown[] = [];
    let attempts = 0;
    const authority = Object.freeze({ projection: "fixture" });
    const driver: ProviderDriverDefinition = {
      name: "projection-fixture",
      adapterNames: ["openai-chat"],
      prepareRequest: () => {
        preparedAuthorities.push(authority);
        return {
          contract: { body: { model: "test-model" } },
          toolSchemaProjectionAuthority: authority as any,
        };
      },
      createStream: async (params) => {
        attempts += 1;
        observedAuthorities.push(params.toolSchemaProjectionAuthority);
        if (attempts === 1) {
          throw new ProviderExecutionError("temporary provider failure", {
            statusCode: 503,
            requestedDelaySeconds: 0,
          });
        }
        return { stream: (async function* () { yield { type: "done" }; })() };
      },
    };
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "test-provider",
      selectedModel: "test-model",
      adapterName: "openai-chat",
      driver,
    });

    const result = await adapter.createStream({ model: "test-model", messages: [], tools: [] });
    for await (const _chunk of result.stream) {
      // consume the successful retry
    }

    expect(preparedAuthorities).toEqual([authority]);
    expect(observedAuthorities).toEqual([authority, authority]);
  });

  it("retries a retryable failure raised while consuming a stream before visible output", async () => {
    const diagnostics: any[] = [];
    let attempts = 0;
    const driver: ProviderDriverDefinition = {
      name: "test-driver",
      adapterNames: ["openai-chat"],
      createStream: async () => {
        attempts += 1;
        return {
          stream: (async function* () {
            if (attempts === 1) {
              throw new ProviderExecutionError("server_error: Upstream service temporarily unavailable", {
                statusCode: 503,
              });
            }
            yield { choices: [{ delta: { content: "ok" } }] };
          })(),
        };
      },
    };
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "test-provider",
      selectedModel: "test-model",
      adapterName: "openai-chat",
      driver,
      runtime: { diagnostics: { retryEvents: { onNext: (event) => diagnostics.push(event) } } },
    });

    const result = await adapter.createStream({ model: "test-model", messages: [], tools: [] });
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);

    expect(chunks).toEqual([{ choices: [{ delta: { content: "ok" } }] }]);
    expect(attempts).toBe(2);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        classificationReason: "http_503_retryable",
        terminationReason: "retry_scheduled",
        replaySafety: "safe_same_contract",
      }),
    ]);
  });

  it("does not replay a stream failure after visible output", async () => {
    const diagnostics: any[] = [];
    let attempts = 0;
    const driver: ProviderDriverDefinition = {
      name: "test-driver",
      adapterNames: ["openai-chat"],
      createStream: async () => {
        attempts += 1;
        return {
          stream: (async function* () {
            yield { choices: [{ delta: { content: "partial" } }] };
            throw new ProviderExecutionError("server_error: Upstream service temporarily unavailable", {
              statusCode: 503,
            });
          })(),
        };
      },
    };
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "test-provider",
      selectedModel: "test-model",
      adapterName: "openai-chat",
      driver,
      runtime: { diagnostics: { retryEvents: { onNext: (event) => diagnostics.push(event) } } },
    });

    const result = await adapter.createStream({ model: "test-model", messages: [], tools: [] });
    const consume = async () => {
      for await (const _chunk of result.stream) {
        // consume until the provider failure
      }
    };

    await expect(consume()).rejects.toThrow("temporarily unavailable");
    expect(attempts).toBe(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        classificationReason: "http_503_retryable",
        terminationReason: "indeterminate_after_accept",
        replaySafety: "indeterminate_after_accept",
      }),
    ]);
  });
});
