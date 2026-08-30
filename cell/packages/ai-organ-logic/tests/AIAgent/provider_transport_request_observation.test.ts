import { describe, expect, it } from "bun:test";
import type {
  ProviderDriverDefinition,
  ProviderDriverStreamParams,
  ProviderRequestOutcomeObservationData,
  ProviderRequestObservationData,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";
import {
  AnthropicNodejsFetchLlmAdapter,
  ClaudeNodejsFetchLlmAdapter,
  decideResponsesCallLineage,
  OpenAICompletionsNodejsFetchLlmAdapter,
  OpenAIResponsesNodejsFetchLlmAdapter,
  ProviderRuntimeLlmAdapter,
} from "@cell/ai-organ-logic/llm";
import { pairAutonomousPlanningProviderAttempts } from "../../../../../scripts/run-autonomous-ai-data-live";

function sse(events: unknown[] = []): Response {
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Native provider output is finalized while the real stream is consumed.
  }
}

function createRuntimeAdapter(params: {
  driver: ProviderDriverDefinition;
  observations: ProviderRequestObservationData[];
  outcomes?: ProviderRequestOutcomeObservationData[];
  diagnostics?: unknown[];
}) {
  return new ProviderRuntimeLlmAdapter({
    providerId: "provider-1",
    selectedModel: "selected-model",
    adapterName: "openai-responses",
    driver: params.driver,
    runtime: {
      sessionId: "session-1",
      actorId: "actor-1",
      turnId: "turn-1",
      requestObservationPort: {
        append: (event) => params.observations.push(event),
        appendOutcome: (event) => params.outcomes?.push(event),
      },
      diagnostics: params.diagnostics
        ? {
            requestObservationEvents: {
              onNext: (event) => params.diagnostics!.push(event),
            },
          }
        : undefined,
    },
  });
}

describe("provider transport request observation", () => {
  it("observes every HTTP adapter body immediately before fetch", async () => {
    const cases = [
      {
        name: "openai-chat",
        create: (requestObserver: any, fetchFn: any) =>
          new OpenAICompletionsNodejsFetchLlmAdapter({
            apiKey: "test-key",
            requestObserver,
            providerOptions: { fetch: fetchFn },
          }),
      },
      {
        name: "anthropic",
        create: (requestObserver: any, fetchFn: any) =>
          new AnthropicNodejsFetchLlmAdapter({
            apiKey: "test-key",
            baseUrl: "https://provider.test",
            requestObserver,
            providerOptions: { fetch: fetchFn },
          }),
      },
      {
        name: "claude",
        create: (requestObserver: any, fetchFn: any) =>
          new ClaudeNodejsFetchLlmAdapter({
            apiKey: "test-key",
            requestObserver,
            providerOptions: { fetch: fetchFn },
          }),
      },
    ];

    for (const testCase of cases) {
      const timeline: string[] = [];
      let observedBody: unknown;
      let fetchedBody: unknown;
      const adapter = testCase.create(
        (input: any) => {
          timeline.push(`${testCase.name}:observe`);
          observedBody = input.requestBody;
          expect(input.transportType).toBe("http");
        },
        async (_url: unknown, init: any) => {
          timeline.push(`${testCase.name}:fetch`);
          fetchedBody = init.body;
          return sse();
        },
      );

      await adapter.createStream({
        model: "wire-model",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      });

      expect(timeline).toEqual([
        `${testCase.name}:observe`,
        `${testCase.name}:fetch`,
      ]);
      expect(observedBody).toBe(fetchedBody);
    }
  });

  it("records the exact ordinary HTTP fetch body at the send boundary", async () => {
    const observations: ProviderRequestObservationData[] = [];
    const fetchBodies: string[] = [];
    const timeline: string[] = [];
    const driver: ProviderDriverDefinition = {
      name: "openai-chat-wire-test",
      adapterNames: ["openai-responses"],
      async createStream(params: ProviderDriverStreamParams) {
        const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
          apiKey: "test-key",
          baseUrl: "https://provider.test/v1",
          requestObserver: params.transportRequestObserver,
          providerOptions: {
            fetch: async (_url, init) => {
              timeline.push("fetch");
              fetchBodies.push(String(init?.body));
              return sse();
            },
          },
        });
        return adapter.createStream({
          model: params.model,
          messages: params.messages as any[],
          tools: params.tools as any[],
          extraBody: params.extraBody,
          signal: params.signal,
        });
      },
    };
    const sourceMessages = [{ role: "user", content: "hello" }];
    const sourceTools = [
      {
        type: "function",
        function: { name: "Read", parameters: { type: "object" } },
      },
    ] as any[];
    const adapter = createRuntimeAdapter({ driver, observations });
    adapter.runtime.requestObservationPort = {
      append: (event) => {
        timeline.push("observe");
        observations.push(event);
      },
    };

    const result = await adapter.createStream({
      model: "wire-model",
      messages: sourceMessages,
      tools: sourceTools,
    });
    await drain(result.stream);

    expect(timeline).toEqual(["observe", "fetch"]);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual(
      expect.objectContaining({
        captureLayer: "provider_transport_before_send",
        providerCallOrdinal: 1,
        providerAttemptOrdinal: 1,
        transportAttemptOrdinal: 1,
        transportType: "http",
        requestBody: fetchBodies[0],
        messages: sourceMessages,
        tools: sourceTools,
      }),
    );
    expect(observations[0].messages).not.toBe(sourceMessages);
    expect(observations[0].tools).not.toBe(sourceTools);
    expect(JSON.parse(String(observations[0].requestBody))).toEqual(
      JSON.parse(fetchBodies[0]),
    );
  });

  it("keeps an ordinary chat outcome bound to its request-time identity when runtime context changes", async () => {
    const observations: ProviderRequestObservationData[] = [];
    const outcomes: ProviderRequestOutcomeObservationData[] = [];
    let adapter!: ProviderRuntimeLlmAdapter;
    const driver: ProviderDriverDefinition = {
      name: "openai-chat-outcome-correlation-test",
      adapterNames: ["openai-responses"],
      async createStream(params: ProviderDriverStreamParams) {
        const transport = new OpenAICompletionsNodejsFetchLlmAdapter({
          apiKey: "test-key",
          requestObserver: params.transportRequestObserver,
          providerOptions: {
            fetch: async () => {
              Object.assign(adapter.runtime, {
                sessionId: "session-mutated",
                actorId: "actor-mutated",
                turnId: "turn-mutated",
                traceId: "trace-mutated",
                providerId: "provider-mutated",
                selectedModel: "model-mutated",
              });
              return sse([{ id: "chatcmpl-1", choices: [] }]);
            },
          },
        });
        return transport.createStream({
          model: params.model,
          messages: params.messages as any[],
          tools: params.tools as any[],
          extraBody: params.extraBody,
          signal: params.signal,
        });
      },
    };
    adapter = createRuntimeAdapter({ driver, observations, outcomes });
    adapter.runtime.traceId = "trace-1";

    const result = await adapter.createStream({
      model: "wire-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    await drain(result.stream);

    expect(observations).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
    const identityFields = ({
      providerCallId,
      providerCallOrdinal,
      providerAttemptOrdinal,
      transportAttemptOrdinal,
      transportType,
      providerId,
      model,
      actorId,
      sessionId,
      turnId,
      traceId,
    }: ProviderRequestObservationData | ProviderRequestOutcomeObservationData) => ({
      providerCallId,
      providerCallOrdinal,
      providerAttemptOrdinal,
      transportAttemptOrdinal,
      transportType,
      providerId,
      model,
      actorId,
      sessionId,
      turnId,
      traceId,
    });
    expect(identityFields(outcomes[0]!)).toEqual(identityFields(observations[0]!));
    expect(outcomes[0]).toEqual(expect.objectContaining({
      terminalState: "completed",
      fallbackUsed: false,
      completenessStatus: "complete",
      completenessSource: "completed_output",
      responseId: "chatcmpl-1",
    }));
    expect(pairAutonomousPlanningProviderAttempts({
      requests: observations,
      outcomes,
      providerId: "provider-1",
      model: "selected-model",
    })).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({
          actorId: "actor-1",
          sessionId: "session-1",
          turnId: "turn-1",
          traceId: "trace-1",
        }),
        terminalState: "completed",
      }),
    ]);
  });

  it.each([
    ["failed", "not_observed", "http_400"],
    ["aborted", "not_observed", "aborted"],
    ["incomplete", "not_observed", "missing_done_marker"],
  ] as const)("records exactly one %s ordinary chat terminal outcome", async (
    expectedState,
    expectedCompleteness,
    expectedReason,
  ) => {
    const observations: ProviderRequestObservationData[] = [];
    const outcomes: ProviderRequestOutcomeObservationData[] = [];
    const controller = new AbortController();
    if (expectedState === "aborted") controller.abort();
    const driver: ProviderDriverDefinition = {
      name: `openai-chat-${expectedState}-outcome-test`,
      adapterNames: ["openai-responses"],
      async createStream(params: ProviderDriverStreamParams) {
        const transport = new OpenAICompletionsNodejsFetchLlmAdapter({
          apiKey: "test-key",
          requestObserver: params.transportRequestObserver,
          providerOptions: {
            fetch: async (_url, init) => {
              if ((init?.signal as AbortSignal | undefined)?.aborted) {
                throw new DOMException("aborted", "AbortError");
              }
              if (expectedState === "failed") {
                return new Response("denied", { status: 400 });
              }
              return new Response('data: {"id":"chatcmpl-incomplete","choices":[]}\n\n', {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
              });
            },
          },
        });
        return transport.createStream({
          model: params.model,
          messages: params.messages as any[],
          tools: params.tools as any[],
          extraBody: params.extraBody,
          signal: params.signal,
        });
      },
    };
    const adapter = createRuntimeAdapter({ driver, observations, outcomes });
    const result = await adapter.createStream({
      model: "wire-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      signal: controller.signal,
    });

    if (expectedState === "failed" || expectedState === "aborted") {
      await expect(drain(result.stream)).rejects.toThrow();
    } else {
      await drain(result.stream);
    }

    expect(observations).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual(expect.objectContaining({
      terminalState: expectedState,
      fallbackUsed: false,
      completenessStatus: expectedCompleteness,
      completenessSource: null,
      completenessReason: expectedReason,
      responseId: null,
    }));
  });

  it("records the actual Responses WS payload selected by the explicit request plan", async () => {
    const observations: ProviderRequestObservationData[] = [];
    const outcomes: ProviderRequestOutcomeObservationData[] = [];
    const sentBodies: string[] = [];
    let responseOrdinal = 0;
    const driver: ProviderDriverDefinition = {
      name: "responses-wire-test",
      adapterNames: ["openai-responses"],
      async createStream(params: ProviderDriverStreamParams) {
        responseOrdinal += 1;
        const responseId = responseOrdinal === 1 ? "resp-seed" : "resp-next";
        const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
          apiKey: "test-key",
          baseUrl: "https://provider.test/v1",
          requestObserver: params.transportRequestObserver,
          providerOptions: {
            transport_mode: "websocket",
            supports_websockets: true,
            webSocketFactory: ((_url: string, _options: unknown) => {
              const socket: any = {
                onopen: null,
                onmessage: null,
                onerror: null,
                onclose: null,
                send(body: string) {
                  sentBodies.push(body);
                },
                close() {},
              };
              queueMicrotask(() => {
                socket.onopen?.({});
                socket.onmessage?.({
                  data: JSON.stringify({
                    type: "response.created",
                    response: { id: responseId },
                  }),
                });
                socket.onmessage?.({
                  data: JSON.stringify({
                    type: "response.completed",
                    response: {
                      id: responseId,
                      output: [{
                        id: `message-${responseOrdinal}`,
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "done" }],
                      }],
                    },
                  }),
                });
                socket.onmessage?.({ data: "[DONE]" });
              });
              return socket;
            }) as any,
            fetch: async () => sse(),
          },
        });
        return adapter.createStream({
          model: params.model,
          messages: params.messages as any[],
          tools: params.tools as any[],
          extraBody: params.extraBody,
          providerRequestContext: params.providerRequestContext,
          signal: params.signal,
          sessionKey: params.sessionKey,
        });
      },
    };
    const adapter = createRuntimeAdapter({ driver, observations, outcomes });

    await drain(
      (
        await adapter.createStream({
          model: "wire-model",
          messages: [{ role: "user", content: "read" }],
          tools: [],
          sessionKey: "session-1/actor-1",
          providerRequestContext: {
            schemaVersion: 1,
            kind: "responses_transport_request_context",
            primary: {
              kind: "stateful_incremental",
              previousResponseId: "resp-explicit",
              input: [
                {
                  type: "function_call",
                  call_id: "call-1",
                  name: "Read",
                  arguments: "{}",
                },
                {
                  type: "function_call_output",
                  call_id: "call-1",
                  output: "contents",
                },
              ],
              contextDigest: "digest",
              messageFrontier: {
                schemaVersion: 1,
                algorithm: "sha256",
                messageCount: 3,
                digest: "frontier",
              },
              lineageProof: decideResponsesCallLineage([
                {
                  type: "function_call",
                  call_id: "call-1",
                  name: "Read",
                  arguments: "{}",
                },
                {
                  type: "function_call_output",
                  call_id: "call-1",
                  output: "contents",
                },
              ]),
            },
            statelessFallback: {
              kind: "stateless_replay",
              source: "canonical_rebuild",
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "read" }],
                },
              ],
              contextDigest: "digest",
              messageFrontier: {
                schemaVersion: 1,
                algorithm: "sha256",
                messageCount: 3,
                digest: "frontier",
              },
              promptCacheKey: "responses_v1_stable",
              lineageProof: decideResponsesCallLineage([
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "read" }],
                },
              ]),
            },
          },
        })
      ).stream,
    );
    await drain(
      (
        await adapter.createStream({
          model: "wire-model",
          messages: [
            { role: "user", content: "read" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "Read", arguments: "{}" },
                },
              ],
            },
            { role: "tool", tool_call_id: "call-1", content: "contents" },
          ],
          tools: [],
          sessionKey: "session-1/actor-1",
        })
      ).stream,
    );

    expect(observations).toHaveLength(2);
    const observed = observations[0];
    expect(observed.providerCallOrdinal).toBe(1);
    expect(observed.providerAttemptOrdinal).toBe(1);
    expect(observed.transportAttemptOrdinal).toBe(1);
    expect(observed.transportType).toBe("websocket");
    expect(observed.requestBody).toBe(sentBodies[0]);
    expect(observed).toEqual(expect.objectContaining({
      planKind: "stateful_incremental",
      replaySource: null,
      previousResponseIdDecision: "adopted",
      previousResponseId: "resp-explicit",
      previousResponseIdDecisionReason: null,
    }));
    const body = JSON.parse(String(observed.requestBody));
    expect(body.previous_response_id).toBe("resp-explicit");
    expect(body.input.map((item: any) => item.type)).toEqual([
      "function_call",
      "function_call_output",
    ]);
    expect(outcomes[0]).toEqual(expect.objectContaining({
      transportType: "websocket",
      terminalState: "completed",
      fallbackUsed: false,
      completenessStatus: "complete",
      responseId: "resp-seed",
    }));
  });

  it("records WS send and HTTP fallback as ordered transports of one provider attempt", async () => {
    const observations: ProviderRequestObservationData[] = [];
    const outcomes: ProviderRequestOutcomeObservationData[] = [];
    const attemptedWsBodies: string[] = [];
    const fetchBodies: string[] = [];
    const timeline: string[] = [];
    const driver: ProviderDriverDefinition = {
      name: "responses-fallback-wire-test",
      adapterNames: ["openai-responses"],
      async createStream(params: ProviderDriverStreamParams) {
        const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
          apiKey: "test-key",
          baseUrl: "https://provider.test/v1",
          requestObserver: params.transportRequestObserver,
          providerOptions: {
            transport_mode: "websocket",
            supports_websockets: true,
            webSocketFactory: (() => {
              const socket: any = {
                onopen: null,
                onmessage: null,
                onerror: null,
                onclose: null,
                send(body: string) {
                  timeline.push("ws-send");
                  attemptedWsBodies.push(body);
                  throw new Error("send failed");
                },
                close() {},
              };
              queueMicrotask(() => socket.onopen?.({}));
              return socket;
            }) as any,
            fetch: async (_url, init) => {
              timeline.push("fetch");
              fetchBodies.push(String(init?.body));
              return sse([{
                type: "response.completed",
                response: {
                  id: "resp-http-fallback",
                  output: [{
                    id: "message-http-fallback",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "done" }],
                  }],
                },
              }]);
            },
          },
        });
        return adapter.createStream({
          model: params.model,
          messages: params.messages as any[],
          tools: params.tools as any[],
          extraBody: params.extraBody,
          signal: params.signal,
          sessionKey: params.sessionKey,
        });
      },
    };
    const adapter = createRuntimeAdapter({ driver, observations, outcomes });
    adapter.runtime.requestObservationPort = {
      append: (event) => {
        timeline.push(`observe-${event.transportType}`);
        observations.push(event);
      },
      appendOutcome: (event) => outcomes.push(event),
    };

    const result = await adapter.createStream({
      model: "wire-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    await drain(result.stream);

    expect(timeline).toEqual([
      "observe-websocket",
      "ws-send",
      "observe-http",
      "fetch",
    ]);
    expect(observations).toHaveLength(2);
    expect(observations.map((event) => event.providerAttemptOrdinal)).toEqual([
      1, 1,
    ]);
    expect(observations.map((event) => event.transportAttemptOrdinal)).toEqual([
      1, 2,
    ]);
    expect(observations.map((event) => event.transportType)).toEqual([
      "websocket",
      "http",
    ]);
    expect(observations[0].requestBody).toBe(attemptedWsBodies[0]);
    expect(observations[1].requestBody).toBe(fetchBodies[0]);
    expect(observations.map((event) => ({
      planKind: event.planKind,
      replaySource: event.replaySource,
      decision: event.previousResponseIdDecision,
      reason: event.previousResponseIdDecisionReason,
    }))).toEqual([
      {
        planKind: "stateless_replay",
        replaySource: "canonical_rebuild",
        decision: "rejected",
        reason: "stateless_plan",
      },
      {
        planKind: "stateless_replay",
        replaySource: "canonical_rebuild",
        decision: "rejected",
        reason: "transport_fallback",
      },
    ]);
    expect(outcomes.map((event) => ({
      transportAttemptOrdinal: event.transportAttemptOrdinal,
      transportType: event.transportType,
      terminalState: event.terminalState,
      fallbackUsed: event.fallbackUsed,
      completenessStatus: event.completenessStatus,
    }))).toEqual([
      {
        transportAttemptOrdinal: 1,
        transportType: "websocket",
        terminalState: "failed",
        fallbackUsed: true,
        completenessStatus: "not_observed",
      },
      {
        transportAttemptOrdinal: 2,
        transportType: "http",
        terminalState: "completed",
        fallbackUsed: true,
        completenessStatus: "complete",
      },
    ]);
  });

  it("does not record a websocket transport when connection fails before send", async () => {
    const observations: ProviderRequestObservationData[] = [];
    const driver: ProviderDriverDefinition = {
      name: "responses-connect-fallback-wire-test",
      adapterNames: ["openai-responses"],
      async createStream(params: ProviderDriverStreamParams) {
        const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
          apiKey: "test-key",
          requestObserver: params.transportRequestObserver,
          providerOptions: {
            transport_mode: "websocket",
            supports_websockets: true,
            webSocketFactory: (() => {
              throw new Error("connect failed");
            }) as any,
            fetch: async () => sse([{
              type: "response.completed",
              response: { id: "resp-connect-fallback", output: [] },
            }]),
          },
        });
        return adapter.createStream({
          model: params.model,
          messages: params.messages as any[],
          tools: [],
        });
      },
    };
    const adapter = createRuntimeAdapter({ driver, observations });

    const result = await adapter.createStream({
      model: "wire-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    await drain(result.stream);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual(
      expect.objectContaining({
        transportType: "http",
        transportAttemptOrdinal: 1,
        providerAttemptOrdinal: 1,
      }),
    );
  });

  it.each([
    ["failed", undefined, async () => new Response("denied", { status: 400 })],
    ["aborted", "abort", async () => { throw new Error("aborted") }],
  ] as const)("records %s HTTP terminal outcome without inventing completeness", async (
    expectedState,
    abortMode,
    fetchFn,
  ) => {
    const observations: ProviderRequestObservationData[] = [];
    const outcomes: ProviderRequestOutcomeObservationData[] = [];
    const driver: ProviderDriverDefinition = {
      name: `responses-${expectedState}-outcome-test`,
      adapterNames: ["openai-responses"],
      async createStream(params) {
        const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
          apiKey: "test-key",
          requestObserver: params.transportRequestObserver,
          providerOptions: { fetch: fetchFn, transport_mode: "http_sse" },
        });
        return adapter.createStream({
          model: params.model,
          messages: params.messages as any[],
          tools: [],
          signal: params.signal,
        });
      },
    };
    const adapter = createRuntimeAdapter({ driver, observations, outcomes });
    const controller = new AbortController();
    if (abortMode) controller.abort();

    const result = await adapter.createStream({
      model: "wire-model",
      messages: [],
      tools: [],
      signal: controller.signal,
    });
    await expect(drain(result.stream)).rejects.toThrow();

    expect(observations).toHaveLength(1);
    expect(outcomes).toEqual([
      expect.objectContaining({
        terminalState: expectedState,
        fallbackUsed: false,
        completenessStatus: "not_observed",
        completenessSource: null,
        completenessReason: expectedState === "aborted" ? "aborted" : "http_400",
      }),
    ]);
  });

  it("records an incomplete terminal outcome when SSE ends without response.completed", async () => {
    const observations: ProviderRequestObservationData[] = [];
    const outcomes: ProviderRequestOutcomeObservationData[] = [];
    const driver: ProviderDriverDefinition = {
      name: "responses-incomplete-outcome-test",
      adapterNames: ["openai-responses"],
      async createStream(params) {
        const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
          apiKey: "test-key",
          requestObserver: params.transportRequestObserver,
          providerOptions: { fetch: async () => sse(), transport_mode: "http_sse" },
        });
        return adapter.createStream({ model: params.model, messages: [], tools: [] });
      },
    };
    const adapter = createRuntimeAdapter({ driver, observations, outcomes });
    const result = await adapter.createStream({ model: "wire-model", messages: [], tools: [] });

    await expect(drain(result.stream)).rejects.toThrow("ended before response.completed");
    expect(outcomes).toEqual([
      expect.objectContaining({
        terminalState: "incomplete",
        fallbackUsed: false,
        completenessStatus: "not_observed",
        completenessReason: "missing_final_output",
      }),
    ]);
  });

  it("fails open when the observation sink throws before a real send", async () => {
    const diagnostics: unknown[] = [];
    let fetchCalls = 0;
    const driver: ProviderDriverDefinition = {
      name: "openai-chat-fail-open-wire-test",
      adapterNames: ["openai-responses"],
      async createStream(params: ProviderDriverStreamParams) {
        const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
          apiKey: "test-key",
          requestObserver: params.transportRequestObserver,
          providerOptions: {
            fetch: async () => {
              fetchCalls += 1;
              return sse();
            },
          },
        });
        return adapter.createStream({
          model: params.model,
          messages: [],
          tools: [],
        });
      },
    };
    const adapter = createRuntimeAdapter({
      driver,
      observations: [],
      diagnostics,
    });
    adapter.runtime.requestObservationPort = {
      append: () => {
        throw new Error("x".repeat(2_000));
      },
    };

    const result = await adapter.createStream({
      model: "wire-model",
      messages: [],
      tools: [],
    });
    await drain(result.stream);

    expect(result.stream).toBeDefined();
    expect(fetchCalls).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        providerAttemptOrdinal: 1,
        transportAttemptOrdinal: 1,
        transportType: "http",
        stage: "append_failed",
      }),
    );
    expect(String((diagnostics[0] as any).error).length).toBeLessThanOrEqual(
      512,
    );
  });
});
