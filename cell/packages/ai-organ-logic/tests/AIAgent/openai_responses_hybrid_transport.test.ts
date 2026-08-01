import { describe, expect, it } from "bun:test";

import type {
  ResponsesProviderOutputSnapshot,
  ResponsesTransportResult,
  ResponsesTransportRequestContext,
} from "@cell/ai-organ-contract/llm/ResponsesReplay";
import {
  OpenAIResponsesNodejsFetchLlmAdapter,
  ProviderRuntimeLlmAdapter,
  decideResponsesCallLineage,
} from "@cell/ai-organ-logic/llm";
import { buildOpenAIResponsesProviderDriver } from "@cell/ai-organ-logic/llm/drivers/OpenAIResponsesDriver";

function sse(events: readonly unknown[]): Response {
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function sseWithoutDone(events: readonly unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Provider output is finalized only after the stream has been consumed.
  }
}

function requestContext(params: {
  primary: ResponsesTransportRequestContext["primary"];
  fallback?: ResponsesTransportRequestContext["statelessFallback"];
  instructions?: string;
}): ResponsesTransportRequestContext {
  return {
    schemaVersion: 1,
    kind: "responses_transport_request_context",
    ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
    primary: params.primary,
    statelessFallback: params.fallback ??
      (params.primary.kind === "stateless_replay" ? params.primary : undefined),
  };
}

function statelessPlan(input: readonly Record<string, unknown>[], promptCacheKey = "responses_v1_stable") {
  const lineageProof = decideResponsesCallLineage(input);
  if (lineageProof.status !== "valid") throw new Error(lineageProof.reason);
  return {
    kind: "stateless_replay" as const,
    source: "canonical_rebuild" as const,
    input,
    contextDigest: `sha256:${"a".repeat(43)}`,
    messageFrontier: {
      schemaVersion: 1 as const,
      algorithm: "sha256" as const,
      messageCount: 1,
      digest: `sha256:${"b".repeat(43)}`,
    },
    promptCacheKey,
    lineageProof,
  };
}

function statefulPlan(input: readonly Record<string, unknown>[]) {
  const lineageProof = decideResponsesCallLineage([
    { type: "function_call", call_id: "call_1", name: "fixture", arguments: "{}" },
    ...input,
  ]);
  if (lineageProof.status !== "valid") throw new Error(lineageProof.reason);
  return {
    kind: "stateful_incremental" as const,
    previousResponseId: "resp_previous_explicit",
    input,
    contextDigest: `sha256:${"a".repeat(43)}`,
    messageFrontier: {
      schemaVersion: 1 as const,
      algorithm: "sha256" as const,
      messageCount: 3,
      digest: `sha256:${"c".repeat(43)}`,
    },
    lineageProof,
  };
}

function fakeWebSocketFactory(params: {
  sent: Record<string, unknown>[];
  events?: readonly unknown[];
  fail?: boolean;
}) {
  return () => {
    if (params.fail) throw new Error("ws unavailable");
    const socket: any = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(body: string) {
        params.sent.push(JSON.parse(body));
      },
      close() {},
    };
    queueMicrotask(() => {
      socket.onopen?.({});
      for (const event of params.events ?? []) {
        socket.onmessage?.({ data: JSON.stringify(event) });
      }
      socket.onmessage?.({ data: "[DONE]" });
      socket.onclose?.({ code: 1000 });
    });
    return socket;
  };
}

describe("Responses hybrid transport request plans", () => {
  it("keeps legacy previous_response_id out of runtime preflight while the explicit plan owns the wire id", async () => {
    const sent: Record<string, unknown>[] = [];
    const explicitPlan = statefulPlan([
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ]);
    const fallback = statelessPlan([
      { type: "message", role: "user", content: [{ type: "input_text", text: "full" }] },
    ]);
    const responsesDriver = buildOpenAIResponsesProviderDriver();
    const driver = {
      ...responsesDriver,
      createStream: (params: Parameters<typeof responsesDriver.createStream>[0]) =>
        responsesDriver.createStream({
          ...params,
          connectionOptions: {
            ...params.connectionOptions,
            webSocketFactory: fakeWebSocketFactory({
              sent,
              events: [
                {
                  type: "response.completed",
                  response: { id: "resp_next", output: [] },
                },
              ],
            }),
          },
        }),
    };
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "openai",
      selectedModel: "gpt-5.5",
      adapterName: "openai-responses",
      driver,
      options: {
        api_key: "test-key",
        transport_mode: "websocket",
        supports_websockets: true,
        previous_response_id: "resp_legacy_must_not_win",
      },
    });
    const context = requestContext({ primary: explicitPlan, fallback });

    const prepared = adapter.prepareRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "canonical" }],
      tools: [],
      providerRequestContext: context,
    });
    expect(prepared.contract.body?.previous_response_id).toBeUndefined();
    expect(prepared.contract.body?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "canonical" }],
      },
    ]);

    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "canonical" }],
      tools: [],
      providerRequestContext: context,
    });
    await drain(result.stream);

    expect(sent).toHaveLength(1);
    expect(sent[0].previous_response_id).toBe("resp_previous_explicit");
    expect(sent[0].previous_response_id).not.toBe("resp_legacy_must_not_win");
    expect(sent[0].input).toEqual(explicitPlan.input);
  });

  it("preserves the actual transport result through the Responses driver", async () => {
    const originalFetch = globalThis.fetch;
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: unknown, init: any) => {
      body = JSON.parse(String(init.body));
      return sse([{
        type: "response.completed",
        response: {
          id: "resp_driver",
          output: [{
            id: "message-driver",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          }],
        },
      }]);
    }) as typeof fetch;
    try {
      const plan = statelessPlan([
        { type: "message", role: "user", content: [{ type: "input_text", text: "driver" }] },
      ]);
      const result = await buildOpenAIResponsesProviderDriver().createStream({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "must not replace plan" }],
        tools: [],
        requestOptions: {},
        extraBody: {},
        connectionOptions: { api_key: "test-key", transport_mode: "http_sse" },
        runtime: {
          providerId: "openai",
          selectedModel: "gpt-5.5",
          adapterName: "openai-responses",
          driverName: "openai-responses",
        },
        providerRequestContext: requestContext({ primary: plan }),
      });
      await drain(result.stream);
      const transportResult = await result.providerOutput as ResponsesTransportResult;

      expect(transportResult.transport).toBe("http_sse");
      expect(transportResult.plan).toEqual(plan);
      expect(transportResult.plan.input).toEqual(body?.input);
      expect(transportResult.outputDecision.status).toBe("complete");
      if (transportResult.outputDecision.status !== "complete") throw new Error("expected complete output");
      expect(transportResult.outputDecision.output.responseId).toBe("resp_driver");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("materializes an explicit stateful plan and never derives previous id from session state", async () => {
    const sent: Record<string, unknown>[] = [];
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        transport_mode: "websocket",
        supports_websockets: true,
        webSocketFactory: fakeWebSocketFactory({
          sent,
          events: [{ type: "response.completed", response: { id: "resp_next", output: [] } }],
        }) as any,
        fetch: async () => sse([]),
      },
    });
    const incremental = [
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ];
    const fallback = statelessPlan([
      { type: "message", role: "user", content: [{ type: "input_text", text: "full" }] },
      { type: "function_call", call_id: "call_1", name: "fixture", arguments: "{}" },
      ...incremental,
    ]);
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "adapter must not rebuild this system text" },
        { role: "user", content: "must not be materialized instead of the plan" },
      ],
      tools: [],
      sessionKey: "ignored-session-key",
      providerRequestContext: requestContext({
        instructions: "executor assembled instructions",
        primary: statefulPlan(incremental),
        fallback,
      }),
    });
    await drain(result.stream);
    const transportResult = await result.providerOutput as ResponsesTransportResult;

    expect(sent).toHaveLength(1);
    expect(sent[0].previous_response_id).toBe("resp_previous_explicit");
    expect(sent[0].instructions).toBe("executor assembled instructions");
    expect(sent[0].input).toEqual(incremental);
    expect(sent[0].prompt_cache_key).toBeUndefined();
    expect(transportResult.transport).toBe("websocket");
    expect(transportResult.plan.kind).toBe("stateful_incremental");
    expect(transportResult.plan.input).toEqual(sent[0].input);
    expect(transportResult.responseStored).toBe(true);
  });

  it("materializes native-window and canonical stateless plans exactly with their stable key", async () => {
    for (const source of ["native_window", "canonical_rebuild"] as const) {
      let body: Record<string, unknown> | undefined;
      const input = [
        { type: "reasoning", encrypted_content: "enc", summary: [] },
        { type: "message", role: "assistant", phase: "analysis", content: [] },
        { type: "message", role: "user", content: [{ type: "input_text", text: source }] },
      ];
      const plan = { ...statelessPlan(input, `responses_v1_${source}`), source };
      const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
        apiKey: "test-key",
        providerOptions: {
          fetch: async (_url: unknown, init: any) => {
            body = JSON.parse(String(init.body));
            return sse([
              {
                type: "response.completed",
                response: { id: `resp_${source}`, output: [] },
              },
            ]);
          },
        },
      });
      const result = await adapter.createStream({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "canonical source messages" }],
        tools: [],
        providerRequestContext: requestContext({ primary: plan }),
      });
      await drain(result.stream);
      const transportResult = await result.providerOutput as ResponsesTransportResult;

      expect(body?.previous_response_id).toBeUndefined();
      expect(body?.input).toEqual(input);
      expect(body?.prompt_cache_key).toBe(`responses_v1_${source}`);
      expect(transportResult.transport).toBe("http_sse");
      expect(transportResult.plan.kind).toBe("stateless_replay");
      expect(transportResult.plan.input).toEqual(body?.input);
      expect(transportResult.responseStored).toBe(false);
    }
  });

  it("re-materializes the explicit full stateless plan for WS to HTTP fallback observation", async () => {
    const observations: Array<{ transportType: string; requestBody: unknown; requestPlan?: Record<string, unknown> }> = [];
    let fetchedBody: Record<string, unknown> | undefined;
    const incremental = [
      { type: "function_call_output", call_id: "call_1", output: "tool result" },
    ];
    const fullInput = [
      { type: "reasoning", encrypted_content: "enc" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "full history" }] },
      { type: "function_call", call_id: "call_1", name: "fixture", arguments: "{}" },
      ...incremental,
    ];
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      requestObserver: (observation) => observations.push(observation as any),
      providerOptions: {
        transport_mode: "websocket",
        supports_websockets: true,
        webSocketFactory: fakeWebSocketFactory({ sent: [], fail: true }) as any,
        fetch: async (_url: unknown, init: any) => {
          fetchedBody = JSON.parse(String(init.body));
          return sse([
            {
              type: "response.completed",
              response: { id: "resp_fallback", output: [] },
            },
          ]);
        },
      },
    });
    const fallback = statelessPlan(fullInput, "responses_v1_fallback");
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "must not be fallback reconstruction source" }],
      tools: [],
      providerRequestContext: requestContext({
        primary: statefulPlan(incremental),
        fallback,
      }),
    });
    await drain(result.stream);
    const transportResult = await result.providerOutput as ResponsesTransportResult;

    expect(observations).toHaveLength(1);
    expect(observations[0].transportType).toBe("http");
    expect(observations[0].requestPlan).toEqual(expect.objectContaining({
      planKind: "stateless_replay",
      replaySource: "canonical_rebuild",
      previousResponseIdDecision: "rejected",
      previousResponseId: "resp_previous_explicit",
      previousResponseIdDecisionReason: "transport_fallback",
    }));
    const observed = JSON.parse(String(observations[0].requestBody));
    expect(observed).toEqual(fetchedBody);
    expect(fetchedBody?.previous_response_id).toBeUndefined();
    expect(fetchedBody?.input).toEqual(fullInput);
    expect(fetchedBody?.prompt_cache_key).toBe("responses_v1_fallback");
    expect(fetchedBody?.store).toBe(true);
    expect(transportResult.transport).toBe("http_sse");
    expect(transportResult.plan.kind).toBe("stateless_replay");
    expect(transportResult.plan).toEqual(fallback);
    expect(transportResult.plan.input).toEqual(observed.input);
    expect(transportResult.responseStored).toBe(true);
  });

  it("fails an invalid canonical lineage before request observation or transport I/O", async () => {
    const observations: unknown[] = [];
    let fetchCalls = 0;
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      requestObserver: (observation) => observations.push(observation),
      providerOptions: {
        fetch: async () => {
          fetchCalls += 1;
          return sse([]);
        },
      },
    });

    await expect(adapter.createStream({
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "before" },
        { role: "tool", tool_call_id: "orphan", content: "bad" },
      ],
      tools: [],
    })).rejects.toThrow("orphan_function_call_output");
    expect(observations).toEqual([]);
    expect(fetchCalls).toBe(0);
  });
});

describe("Responses provider-native output side channel", () => {
  it("rejects [DONE] without response.completed and settles no transport result", async () => {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        fetch: async () => sse([
          { type: "response.created", response: { id: "resp_incomplete" } },
          { type: "response.output_text.delta", delta: "partial" },
        ]),
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    await expect(drain(result.stream)).rejects.toThrow(
      "ended before response.completed",
    );
    expect(await result.providerOutput).toBeUndefined();
  });

  it("rejects SSE EOF without response.completed and settles no transport result", async () => {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        fetch: async () => sseWithoutDone([
          { type: "response.created", response: { id: "resp_eof" } },
        ]),
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    await expect(drain(result.stream)).rejects.toThrow(
      "ended before response.completed",
    );
    expect(await result.providerOutput).toBeUndefined();
  });

  it("rejects a bodyless payload that was not delivered as response.completed", async () => {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        fetch: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: null,
          json: async () => ({ id: "resp_not_an_event", output: [] }),
        }) as Response,
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    await expect(drain(result.stream)).rejects.toThrow(
      "ended before response.completed",
    );
    expect(await result.providerOutput).toBeUndefined();
  });

  it("rejects inconsistent response.created and response.completed ids", async () => {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        fetch: async () => sse([
          { type: "response.created", response: { id: "resp_created" } },
          {
            type: "response.completed",
            response: { id: "resp_other", output: [] },
          },
        ]),
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    await expect(drain(result.stream)).rejects.toThrow(
      "response id mismatch",
    );
    expect(await result.providerOutput).toBeUndefined();
  });

  it("rejects response.completed without a non-empty string id", async () => {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        fetch: async () => sse([
          {
            type: "response.completed",
            response: { id: "   ", output: [] },
          },
        ]),
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    await expect(drain(result.stream)).rejects.toThrow(
      "response.completed is missing a response id",
    );
    expect(await result.providerOutput).toBeUndefined();
  });

  it("propagates abnormal WebSocket close and settles no transport result", async () => {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        transport_mode: "websocket",
        supports_websockets: true,
        webSocketFactory: (() => {
          const socket: any = {
            onopen: null,
            onmessage: null,
            onerror: null,
            onclose: null,
            send() {},
            close() {},
          };
          queueMicrotask(() => {
            socket.onopen?.({});
            socket.onmessage?.({
              data: JSON.stringify({
                type: "response.created",
                response: { id: "resp_ws_abnormal" },
              }),
            });
            socket.onclose?.({ code: 1006, reason: "upstream vanished" });
          });
          return socket;
        }) as any,
        fetch: async () => {
          throw new Error("must not fallback after an opened WS stream");
        },
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    await expect(drain(result.stream)).rejects.toThrow(
      "WebSocket closed abnormally (1006): upstream vanished",
    );
    expect(await result.providerOutput).toBeUndefined();
  });

  it("rejects a normal WebSocket close before response.completed", async () => {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        transport_mode: "websocket",
        supports_websockets: true,
        webSocketFactory: (() => {
          const socket: any = {
            onopen: null,
            onmessage: null,
            onerror: null,
            onclose: null,
            send() {},
            close() {},
          };
          queueMicrotask(() => {
            socket.onopen?.({});
            socket.onclose?.({ code: 1000, reason: "normal" });
          });
          return socket;
        }) as any,
        fetch: async () => {
          throw new Error("must not fallback after an opened WS stream");
        },
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    await expect(drain(result.stream)).rejects.toThrow(
      "ended before response.completed",
    );
    expect(await result.providerOutput).toBeUndefined();
  });

  it("propagates abort after WebSocket open and settles no transport result", async () => {
    const controller = new AbortController();
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        transport_mode: "websocket",
        supports_websockets: true,
        webSocketFactory: (() => {
          const socket: any = {
            onopen: null,
            onmessage: null,
            onerror: null,
            onclose: null,
            send() {},
            close() {},
          };
          queueMicrotask(() => socket.onopen?.({}));
          return socket;
        }) as any,
        fetch: async () => {
          throw new Error("must not fallback after an opened WS stream");
        },
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      signal: controller.signal,
    });

    controller.abort();
    await expect(drain(result.stream)).rejects.toThrow(
      "websocket aborted",
    );
    expect(await result.providerOutput).toBeUndefined();
  });

  it("does not publish a successful transport result when stream consumption fails", async () => {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        fetch: async () => sse([
          {
            type: "response.failed",
            response: { id: "resp_failed", error: { message: "provider failed" } },
          },
        ]),
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    await expect(drain(result.stream)).rejects.toThrow("provider failed");
    expect(await result.providerOutput).toBeUndefined();
  });

  it("does not publish a successful transport result when stream consumption is cancelled", async () => {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        fetch: async () => sse([
          { type: "response.output_text.delta", delta: "partial" },
          { type: "response.completed", response: { id: "resp_unconsumed", output: [] } },
        ]),
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    const iterator = result.stream[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    await iterator.return?.();
    expect(await result.providerOutput).toBeUndefined();
  });

  it("prefers completed.response.output and preserves ordered native reasoning/message/function items", async () => {
    const completedOutput = [
      { id: "reasoning_1", type: "reasoning", encrypted_content: "ciphertext", summary: [] },
      {
        id: "message_1",
        type: "message",
        role: "assistant",
        phase: "analysis",
        content: [{ type: "output_text", text: "thinking" }],
      },
      {
        id: "function_1",
        type: "function_call",
        call_id: "call_1",
        name: "Read",
        arguments: '{"path":"README.md"}',
      },
      { id: "compaction_1", type: "compaction", encrypted_content: "compact" },
    ];
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        fetch: async () => sse([
          {
            type: "response.completed",
            response: { id: "resp_completed", output: completedOutput },
          },
        ]),
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    await drain(result.stream);
    const transportResult = await result.providerOutput as ResponsesTransportResult;
    expect(transportResult.outputDecision.status).toBe("complete");
    if (transportResult.outputDecision.status !== "complete") throw new Error("expected complete output");
    const output = transportResult.outputDecision.output as ResponsesProviderOutputSnapshot;

    expect(transportResult.transport).toBe("http_sse");
    expect(transportResult.responseStored).toBe(false);
    expect(output.responseId).toBe("resp_completed");
    expect(output.items).toEqual(completedOutput);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.items)).toBe(true);
    expect(Object.isFrozen(output.items[0])).toBe(true);
  });

  it("does not publish replayable output when terminal output erases an observed function call", async () => {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        fetch: async () => sse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "fc-broken",
              type: "function_call",
              call_id: "call-broken",
              name: "Bash",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "fc-broken",
            delta: '{"cmd":"pwd"}',
          },
          {
            type: "response.completed",
            response: { id: "resp-broken", output: [] },
          },
        ]),
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "inspect" }],
      tools: [],
    });
    const chunks: unknown[] = [];
    for await (const chunk of result.stream) chunks.push(chunk);
    const transportResult = await result.providerOutput as ResponsesTransportResult;

    expect(JSON.stringify(chunks)).toContain("call-broken");
    expect(transportResult.outputDecision).toEqual(expect.objectContaining({
      status: "incomplete",
      reason: "terminal_output_conflict",
    }));
    expect("output" in transportResult.outputDecision).toBe(false);
  });

  it("publishes reconstructed event items and observes their actual source when terminal output is empty", async () => {
    const outcomes: Record<string, unknown>[] = [];
    const reasoning = {
      id: "reasoning-reconstructed",
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    };
    const functionCall = {
      id: "function-reconstructed",
      type: "function_call",
      call_id: "call-reconstructed",
      name: "inspect",
      arguments: "{}",
    };
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      requestObserver: () => ({ appendOutcome: (outcome) => outcomes.push(outcome) }),
      providerOptions: {
        fetch: async () => sse([
          { type: "response.output_item.added", output_index: 0, item: reasoning },
          { type: "response.output_item.done", output_index: 0, item: reasoning },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { ...functionCall, arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "function-reconstructed",
            delta: "{}",
          },
          { type: "response.output_item.done", output_index: 1, item: functionCall },
          { type: "response.completed", response: { id: "resp-reconstructed", output: [] } },
        ]),
      },
    });
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "inspect" }],
      tools: [],
    });
    await drain(result.stream);
    const transportResult = await result.providerOutput as ResponsesTransportResult;

    expect(transportResult.outputDecision.status).toBe("complete");
    if (transportResult.outputDecision.status !== "complete") throw new Error("expected complete output");
    expect(transportResult.outputDecision.output.items).toEqual([reasoning, functionCall]);
    expect(transportResult.outputDecision.output.completenessProof.source).toBe(
      "reconstructed_event_items",
    );
    expect(outcomes).toEqual([expect.objectContaining({
      terminalState: "completed",
      completeness: {
        status: "complete",
        source: "reconstructed_event_items",
        reason: null,
      },
      responseId: "resp-reconstructed",
    })]);
  });

  it("falls back to output_item.done order for WebSocket and preserves all item kinds", async () => {
    const sent: Record<string, unknown>[] = [];
    const events = [
      { type: "response.created", response: { id: "resp_done_items" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "reasoning_1", type: "reasoning", encrypted_content: "ciphertext" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "message_1", type: "message", role: "assistant", phase: "final", content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { id: "message_1", type: "message", role: "assistant", phase: "final", content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "reasoning_1", type: "reasoning", encrypted_content: "ciphertext" },
      },
      { type: "response.completed", response: { id: "resp_done_items" } },
    ];
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        transport_mode: "websocket",
        supports_websockets: true,
        webSocketFactory: fakeWebSocketFactory({ sent, events }) as any,
        fetch: async () => sse([]),
      },
    });
    const plan = statelessPlan([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      providerRequestContext: requestContext({ primary: plan }),
    });
    await drain(result.stream);
    const transportResult = await result.providerOutput as ResponsesTransportResult;
    expect(transportResult.outputDecision.status).toBe("complete");
    if (transportResult.outputDecision.status !== "complete") throw new Error("expected complete output");
    const output = transportResult.outputDecision.output as ResponsesProviderOutputSnapshot;

    expect(transportResult.transport).toBe("websocket");
    expect(transportResult.plan.kind).toBe("stateless_replay");
    expect(transportResult.responseStored).toBe(true);
    expect(output.responseId).toBe("resp_done_items");
    expect(output.items.map((item) => item.id)).toEqual(["reasoning_1", "message_1"]);
    expect(output.items[0]).toHaveProperty("encrypted_content", "ciphertext");
    expect(output.items[1]).toHaveProperty("phase", "final");
  });
});
