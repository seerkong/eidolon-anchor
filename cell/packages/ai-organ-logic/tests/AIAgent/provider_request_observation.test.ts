import { describe, expect, it } from "bun:test";
import type {
  ProviderDriverDefinition,
  ProviderRequestObservationData,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";
import {
  ProviderExecutionError,
  ProviderRuntimeLlmAdapter,
} from "@cell/ai-organ-logic/llm";

function successfulStream() {
  return {
    stream: (async function* () {
      yield { type: "done" };
    })(),
  };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Provider retry and response capture settle while the stream is consumed.
  }
}

function observeFakeHttp(
  params: Parameters<ProviderDriverDefinition["createStream"]>[0],
  body: unknown = { model: params.model },
  url = "https://provider.test/v1",
) {
  params.transportRequestObserver?.({
    transportType: "http",
    requestBody: JSON.stringify(body),
    url,
    method: "POST",
  });
}

describe("provider request observation", () => {
  it("appends one ordered, identified observation before every real retry attempt", async () => {
    const events: ProviderRequestObservationData[] = [];
    const sceneCaptures: any[] = [];
    const timeline: string[] = [];
    let attempts = 0;
    const driver: ProviderDriverDefinition = {
      name: "test-driver",
      adapterNames: ["openai-chat"],
      buildRequest: ({ model, messages, tools }) => ({
        method: "POST",
        body: { model, messages, tools },
      }),
      createStream: async (params) => {
        attempts += 1;
        observeFakeHttp(params, {
          model: params.model,
          messages: params.messages,
          tools: params.tools,
        });
        timeline.push(`driver:${attempts}`);
        if (attempts === 1) {
          throw new ProviderExecutionError("temporary upstream failure", {
            providerErrorCode: "do_request_failed",
            requestedDelaySeconds: 0,
            statusCode: 500,
          });
        }
        return successfulStream();
      },
    };
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ];
    const tools = [
      {
        type: "function",
        function: { name: "Read", parameters: { type: "object" } },
      },
      {
        type: "function",
        function: { name: "Bash", parameters: { type: "object" } },
      },
    ] as any[];
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "provider-1",
      selectedModel: "selected-model-1",
      adapterName: "openai-chat",
      driver,
      runtime: {
        sessionId: "session-1",
        actorId: "actor-1",
        turnId: "turn-7",
        providerCallId: "provider-call-7",
        requestObservationPort: {
          append: (event) => {
            timeline.push(`append:${event.attemptOrdinal}`);
            events.push(event);
          },
        },
        sceneCaptureHook: (data) => sceneCaptures.push(data),
      },
    });

    const result = await adapter.createStream({ model: "wire-model", messages, tools });
    await drain(result.stream);

    expect(timeline).toEqual(["append:1", "driver:1", "append:2", "driver:2"]);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.attemptOrdinal)).toEqual([1, 2]);
    expect(events.map((event) => event.providerCallOrdinal)).toEqual([1, 1]);
    expect(events[0]).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        sessionId: "session-1",
        actorId: "actor-1",
        turnId: "turn-7",
        providerCallId: "provider-call-7",
        providerCallOrdinal: 1,
        attemptOrdinal: 1,
        providerId: "provider-1",
        model: "selected-model-1",
        requestModel: "wire-model",
        adapterName: "openai-chat",
        driverName: "test-driver",
        providerAttemptOrdinal: 1,
        transportAttemptOrdinal: 1,
        transportType: "http",
        captureLayer: "provider_transport_before_send",
        messages,
        tools,
        requestBody: JSON.stringify({ model: "wire-model", messages, tools }),
        requestContract: {
          url: "https://provider.test/v1",
          method: "POST",
          body: JSON.stringify({ model: "wire-model", messages, tools }),
        },
      }),
    );
    expect(events[0].messages).not.toBe(messages);
    expect(events[0].tools).not.toBe(tools);
    expect(events[0].requestContract).not.toBe(events[1].requestContract);
    expect(sceneCaptures.map((capture) => capture.phase)).toEqual([
      "request",
      "request",
      "response",
    ]);
    expect(
      sceneCaptures
        .slice(0, 2)
        .map((capture) => capture.payload.attemptOrdinal),
    ).toEqual([1, 2]);
  });

  it("redacts only the deep observation copy and never includes connection options", async () => {
    const events: ProviderRequestObservationData[] = [];
    const messages = [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ];
    const tools = [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            type: "object",
            properties: { secret: { type: "string" } },
          },
        },
      },
    ] as any[];
    const options = {
      apiKey: "connection-api-key",
      baseURL: "https://provider.test/v1",
    };
    const originalMessages = structuredClone(messages);
    const originalTools = structuredClone(tools);
    const driverInputs: unknown[] = [];
    const driver: ProviderDriverDefinition = {
      name: "redaction-driver",
      adapterNames: ["openai-chat"],
      buildRequest: ({ model, messages: requestMessages }) => ({
        url: "https://user:password@provider.test/v1?access_token=url-token&page=1",
        headers: {
          Authorization: "Bearer contract-secret",
          "X-Api-Key": "contract-api-key",
        },
        body: {
          model,
          messages: requestMessages,
          max_tokens: 4_096,
          nested: { access_token: "body-token", ordinary: "kept" },
        },
        metadata: {
          connectionOptions: { apiKey: "metadata-api-key" },
          region: "local",
        },
      }),
      createStream: async (params) => {
        driverInputs.push(params);
        observeFakeHttp(
          params,
          {
            model: params.model,
            messages: params.messages,
            max_tokens: 4_096,
            nested: { access_token: "body-token", ordinary: "kept" },
          },
          "https://user:password@provider.test/v1?access_token=url-token&page=1",
        );
        return successfulStream();
      },
    };
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "provider-1",
      selectedModel: "selected-model-1",
      adapterName: "openai-chat",
      options,
      driver,
      runtime: {
        requestObservationPort: { append: (event) => events.push(event) },
      },
    });

    const result = await adapter.createStream({ model: "wire-model", messages, tools });
    await drain(result.stream);

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain("connection-api-key");
    expect(JSON.stringify(events[0])).not.toContain("contract-secret");
    expect(JSON.stringify(events[0])).not.toContain("contract-api-key");
    expect(JSON.stringify(events[0])).not.toContain("body-token");
    expect(JSON.stringify(events[0])).not.toContain("metadata-api-key");
    expect(JSON.stringify(events[0])).not.toContain("url-token");
    expect(JSON.stringify(events[0])).not.toContain("user:password");
    expect(events[0].requestContract).toEqual({
      url: "https://provider.test/v1?page=1",
      method: "POST",
      body: JSON.stringify({
        model: "wire-model",
        messages,
        max_tokens: 4_096,
        nested: { ordinary: "kept" },
      }),
    });
    expect(JSON.parse(String(events[0].requestBody))).toEqual(
      expect.objectContaining({
        max_tokens: 4_096,
        nested: { ordinary: "kept" },
      }),
    );
    expect(events[0]).not.toHaveProperty("connectionOptions");
    expect(messages).toEqual(originalMessages);
    expect(tools).toEqual(originalTools);
    expect(options).toEqual({
      apiKey: "connection-api-key",
      baseURL: "https://provider.test/v1",
    });
    expect((driverInputs[0] as any).messages).toBe(messages);
    expect((driverInputs[0] as any).tools).toBe(tools);
    expect((driverInputs[0] as any).connectionOptions.api_key).toBe(
      "connection-api-key",
    );
  });

  it("separates logical provider-call ordinals from per-call attempt ordinals", async () => {
    const events: ProviderRequestObservationData[] = [];
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "provider-1",
      selectedModel: "model-1",
      adapterName: "openai-chat",
      driver: {
        name: "test-driver",
        adapterNames: ["openai-chat"],
        createStream: async (params) => {
          observeFakeHttp(params);
          return successfulStream();
        },
      },
      runtime: {
        sessionId: "session-1",
        actorId: "actor-1",
        turnId: "turn-1",
        requestObservationPort: { append: (event) => events.push(event) },
      },
    });

    const first = await adapter.createStream({ model: "model-1", messages: [], tools: [] });
    await drain(first.stream);
    const second = await adapter.createStream({ model: "model-1", messages: [], tools: [] });
    await drain(second.stream);

    expect(
      events.map(({ providerCallOrdinal, attemptOrdinal }) => ({
        providerCallOrdinal,
        attemptOrdinal,
      })),
    ).toEqual([
      { providerCallOrdinal: 1, attemptOrdinal: 1 },
      { providerCallOrdinal: 2, attemptOrdinal: 1 },
    ]);
    expect(events[0].providerCallId).not.toBe(events[1].providerCallId);
  });

  it("uses invocation execution identity across fresh adapter instances", async () => {
    const events: ProviderRequestObservationData[] = [];
    const createAdapter = () =>
      new ProviderRuntimeLlmAdapter({
        providerId: "provider-1",
        selectedModel: "model-1",
        adapterName: "openai-chat",
        driver: {
          name: "identity-driver",
          adapterNames: ["openai-chat"],
          createStream: async (params) => {
            observeFakeHttp(params);
            return successfulStream();
          },
        },
        runtime: {
          sessionId: "session-1",
          requestObservationPort: { append: (event) => events.push(event) },
        },
      });

    const first = await createAdapter().createStream({
      model: "model-1",
      messages: [],
      tools: [],
      executionIdentity: {
        actorId: "actor-actual",
        turnId: "7",
        operationId: "llm:fiber-1:9",
        requestId: "llm:fiber-1:9:request-1",
      },
    });
    await drain(first.stream);
    const second = await createAdapter().createStream({
      model: "model-1",
      messages: [],
      tools: [],
      executionIdentity: {
        actorId: "actor-actual",
        turnId: "8",
        operationId: "llm:fiber-1:10",
        requestId: "llm:fiber-1:10:request-1",
      },
    });
    await drain(second.stream);

    expect(events.map((event) => ({
      actorId: event.actorId,
      turnId: event.turnId,
      traceId: event.traceId,
      providerCallId: event.providerCallId,
      providerCallOrdinal: event.providerCallOrdinal,
    }))).toEqual([
      {
        actorId: "actor-actual",
        turnId: "7",
        traceId: "llm:fiber-1:9",
        providerCallId: "llm:fiber-1:9:request-1",
        providerCallOrdinal: 1,
      },
      {
        actorId: "actor-actual",
        turnId: "8",
        traceId: "llm:fiber-1:10",
        providerCallId: "llm:fiber-1:10:request-1",
        providerCallOrdinal: 1,
      },
    ]);
    expect(events[0].providerCallId).not.toBe(events[1].providerCallId);
  });

  it("fails open with a bounded diagnostic when append throws", async () => {
    const diagnostics: unknown[] = [];
    let driverCalls = 0;
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "provider-1",
      selectedModel: "selected-model-1",
      adapterName: "openai-chat",
      driver: {
        name: "test-driver",
        adapterNames: ["openai-chat"],
        createStream: async (params) => {
          observeFakeHttp(params);
          driverCalls += 1;
          return successfulStream();
        },
      },
      runtime: {
        sessionId: "session-1",
        actorId: "actor-1",
        turnId: "turn-1",
        requestObservationPort: {
          append: () => {
            throw new Error("x".repeat(2_000));
          },
        },
        diagnostics: {
          requestObservationEvents: {
            onNext: (event) => diagnostics.push(event),
          },
        },
      },
    });

    const result = await adapter.createStream({
      model: "wire-model",
      messages: [],
      tools: [],
    });
    await drain(result.stream);

    expect(result.stream).toBeDefined();
    expect(driverCalls).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        eventType: "provider_request_observation_diagnostic",
        providerCallOrdinal: 1,
        attemptOrdinal: 1,
        providerId: "provider-1",
        sessionId: "session-1",
        actorId: "actor-1",
        turnId: "turn-1",
        stage: "append_failed",
      }),
    );
    expect(String((diagnostics[0] as any).error).length).toBeLessThanOrEqual(
      512,
    );
  });

  it("records real error and aborted attempts but records no preflight-only work", async () => {
    const errorEvents: ProviderRequestObservationData[] = [];
    const errorAdapter = new ProviderRuntimeLlmAdapter({
      providerId: "provider-1",
      selectedModel: "model-1",
      adapterName: "openai-chat",
      driver: {
        name: "error-driver",
        adapterNames: ["openai-chat"],
        createStream: async (params) => {
          observeFakeHttp(params);
          throw new Error("non-retryable");
        },
      },
      runtime: {
        requestObservationPort: { append: (event) => errorEvents.push(event) },
      },
    });
    errorAdapter.prepareRequest({ model: "model-1", messages: [], tools: [] });
    expect(errorEvents).toEqual([]);
    const errorResult = await errorAdapter.createStream({
      model: "model-1",
      messages: [],
      tools: [],
    });
    await expect(drain(errorResult.stream)).rejects.toThrow("non-retryable");
    expect(errorEvents).toHaveLength(1);

    const abortEvents: ProviderRequestObservationData[] = [];
    const controller = new AbortController();
    let abortDriverCalls = 0;
    const abortAdapter = new ProviderRuntimeLlmAdapter({
      providerId: "provider-1",
      selectedModel: "model-1",
      adapterName: "openai-chat",
      driver: {
        name: "abort-driver",
        adapterNames: ["openai-chat"],
        createStream: async (params) => {
          abortDriverCalls += 1;
          const { signal } = params;
          expect(signal?.aborted).toBe(false);
          observeFakeHttp(params);
          controller.abort(new DOMException("aborted", "AbortError"));
          signal?.throwIfAborted();
          throw new Error("abort must interrupt the issued request");
        },
      },
      runtime: {
        requestObservationPort: { append: (event) => abortEvents.push(event) },
      },
    });
    const abortResult = await abortAdapter.createStream({
      model: "model-1",
      messages: [],
      tools: [],
      signal: controller.signal,
    });
    await expect(drain(abortResult.stream)).rejects.toThrow("aborted");
    expect(abortDriverCalls).toBe(1);
    expect(abortEvents).toHaveLength(1);
  });

  it("does not call the driver or record a request or outcome when already cancelled", async () => {
    const events: ProviderRequestObservationData[] = [];
    const outcomes: unknown[] = [];
    let driverCalls = 0;
    const controller = new AbortController();
    const cancelled = new DOMException("cancelled before request", "AbortError");
    controller.abort(cancelled);
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "provider-1",
      selectedModel: "model-1",
      adapterName: "openai-chat",
      driver: {
        name: "pre-aborted-driver",
        adapterNames: ["openai-chat"],
        createStream: async (params) => {
          driverCalls += 1;
          observeFakeHttp(params);
          return successfulStream();
        },
      },
      runtime: {
        requestObservationPort: {
          append: (event) => events.push(event),
          appendOutcome: (event) => outcomes.push(event),
        },
      },
    });
    const result = await adapter.createStream({
      model: "model-1", messages: [], tools: [], signal: controller.signal,
    });
    await expect(drain(result.stream)).rejects.toBe(cancelled);
    expect(driverCalls).toBe(0);
    expect(events).toEqual([]);
    expect(outcomes).toEqual([]);
  });
});
