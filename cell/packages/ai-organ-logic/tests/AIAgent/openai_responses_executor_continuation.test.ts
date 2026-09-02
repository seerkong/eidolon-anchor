import { describe, expect, it } from "bun:test";

import { WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl";
import {
  applyActorModelConfigControlSignals,
  createActor,
} from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import type { ResponsesTransportRequestContext } from "@cell/ai-organ-contract";
import {
  aiAgentCooperativeStep,
  aiAgentLoopStreaming,
} from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  getConversationSessionRawStateFromVm,
  getVmConversationDomainRuntime,
  upsertProviderProjectionFactToConversationDomainRuntime,
} from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime";
import {
  createResponsesProviderOutputSnapshot,
  decideResponsesNativeOutputCompleteness,
} from "@cell/ai-organ-logic/llm";
import {
  resetActorContinuationBaseline,
  setActorWorkMode,
} from "@cell/ai-organ-logic/runtime/ContextControlPlane";
import {
  createMockProcessStream,
  createMockProviderCacheCostObservation,
} from "./__test_support__/mockProcessStream";

function responsesResult(
  context: ResponsesTransportRequestContext,
  responseId: string,
  useFallback = false,
) {
  const plan = useFallback ? context.statelessFallback! : context.primary;
  return {
    schemaVersion: 1 as const,
    kind: "responses_transport_result" as const,
    plan,
    transport: useFallback ? "http_sse" as const : "websocket" as const,
    responseStored: true,
    outputDecision: {
      schemaVersion: 1 as const,
      kind: "responses_native_output_completeness_decision" as const,
      status: "complete" as const,
      output: createResponsesProviderOutputSnapshot({
        responseId,
        items: responseId === "resp-1"
          ? [{ type: "function_call", call_id: "call-1", name: "inspect", arguments: "{}" }]
          : [{
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: "done" }],
            }],
      }),
    },
  };
}

function responsesAdapter(params: {
  contexts: ResponsesTransportRequestContext[];
  omitProviderOutput?: boolean;
  responseStored?: boolean;
  incompleteOutput?: boolean;
  reconstructedOutput?: boolean;
}) {
  return {
    type: "openai" as const,
    runtime: { adapterName: "openai-responses", providerId: "openai" },
    options: {
      responses_continuation_mode: "stateful_chain",
      transport_mode: "websocket",
      supports_websockets: true,
      instructions: "provider configured instructions",
    },
    async createStream(options: any) {
      const context = options.providerRequestContext as ResponsesTransportRequestContext;
      params.contexts.push(context);
      async function* stream() {
        yield { ok: true };
      }
      const ordinal = params.contexts.length;
      const requestObservation = {
        provider_cache_cost_observation: createMockProviderCacheCostObservation(options),
      };
      return {
        stream: stream(),
        providerOutput: Promise.resolve(params.omitProviderOutput
          ? requestObservation
          : {
              ...responsesResult(
                context,
                `resp-${ordinal}`,
                ordinal === 2,
              ),
              ...requestObservation,
              responseStored: params.responseStored ?? true,
                ...(params.reconstructedOutput ? {
                  outputDecision: decideResponsesNativeOutputCompleteness({
                    schemaVersion: 1,
                    kind: "responses_native_output_evidence",
                    responseId: `resp-${ordinal}`,
                    completedOutput: { observed: true, items: [] },
                    addedItems: [{
                      outputIndex: 0,
                      item: {
                        id: `message-${ordinal}`,
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "done" }],
                      },
                    }],
                    doneItems: [{
                      outputIndex: 0,
                      item: {
                        id: `message-${ordinal}`,
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "done" }],
                      },
                    }],
                    functionCallArgumentDeltas: [],
                  }),
                } : {}),
                ...(params.incompleteOutput ? {
                  outputDecision: {
                    schemaVersion: 1 as const,
                    kind: "responses_native_output_completeness_decision" as const,
                    status: "incomplete" as const,
                    reason: "terminal_output_conflict" as const,
                  },
                } : {}),
              }),
      };
    },
  };
}

function registerInspectTool(registry: ToolFuncRegistry): void {
  registry.register({
    schema: {
      type: "function",
      function: {
        name: "inspect",
        description: "inspect",
        parameters: { type: "object", properties: {} },
      },
    },
    briefPromptXnl: "<tool name=\"inspect\" />",
    run: async () => "inspection result",
  } as any);
}

function replayCheckpoint(vm: any, sessionId: string) {
  return getConversationSessionRawStateFromVm({ vm, sessionId })
    ?.contextAssets?.find((asset) => asset.replayCheckpoint)?.replayCheckpoint;
}

type ContinuationInvalidationFixture = ReturnType<typeof createContinuationInvalidationFixture>;

function createContinuationInvalidationFixture(sessionId: string) {
  const contexts: ResponsesTransportRequestContext[] = [];
  let toolDescription = "stable inspect schema";
  let completion = 0;
  const adapter = {
    type: "openai" as const,
    runtime: { adapterName: "openai-responses", providerId: "openai" },
    options: {
      responses_continuation_mode: "stateful_chain",
      transport_mode: "websocket",
      supports_websockets: true,
      instructions: "provider configured instructions",
    },
    async createStream(options: any) {
      const context = options.providerRequestContext as ResponsesTransportRequestContext;
      contexts.push(context);
      const ordinal = contexts.length;
      async function* stream() { yield { ok: true }; }
      return {
        stream: stream(),
        providerOutput: Promise.resolve({
          provider_cache_cost_observation: createMockProviderCacheCostObservation(options),
          schemaVersion: 1 as const,
          kind: "responses_transport_result" as const,
          plan: context.primary,
          transport: "websocket" as const,
          responseStored: true,
          outputDecision: {
            schemaVersion: 1 as const,
            kind: "responses_native_output_completeness_decision" as const,
            status: "complete" as const,
            output: createResponsesProviderOutputSnapshot({
              responseId: `invalidation-resp-${ordinal}`,
              items: [{
                type: "message",
                role: "assistant",
                phase: "final_answer",
                content: [{ type: "output_text", text: `answer-${ordinal}` }],
              }],
            }),
          },
        }),
      };
    },
  };
  const actor = createActor({
    key: "main",
    systemPrompts: ["stable actor system prompt"],
    llmClient: adapter,
    modelConfig: { model: "gpt-5.5" },
    callbacks: {
      buildToolset: () => [{
        type: "function",
        function: {
          name: "inspect",
          description: toolDescription,
          parameters: { type: "object", properties: {} },
        },
      }],
      processStream: createMockProcessStream(async () => {
        completion += 1;
        return { role: "assistant", content: `answer-${completion}` };
      }),
    },
  });
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { main: actor },
    registries: { toolRegistry: new ToolFuncRegistry() },
    outerCtx: { metadata: { sessionId } },
  });
  return {
    actor,
    contexts,
    vm,
    changeToolSchema: () => { toolDescription = "changed inspect schema"; },
  };
}

async function establishContinuationAndRunNextTurn(
  fixture: ContinuationInvalidationFixture,
  mutate: (fixture: ContinuationInvalidationFixture) => void,
) {
  await aiAgentLoopStreaming({
    vm: fixture.vm,
    actor: fixture.actor,
    messages: [{ role: "user", content: "first canonical user" }],
  });
  expect(fixture.contexts[0]?.primary.kind).toBe("stateless_replay");
  expect(fixture.actor.continuationBaseline).toEqual(expect.objectContaining({
    latestResponseId: "invalidation-resp-1",
    contextDigest: fixture.contexts[0]?.primary.contextDigest,
  }));
  expect(getConversationSessionRawStateFromVm({
    vm: fixture.vm,
    sessionId: String((fixture.vm.outerCtx.metadata as any).sessionId),
  })?.contextAssets?.some((asset) => asset.replayCheckpoint)).toBe(true);

  mutate(fixture);
  appendLiveHistoryMessageToConversationDomainRuntime({
    vm: fixture.vm,
    actorKey: fixture.actor.key,
    actorId: fixture.actor.id,
    message: { role: "user", content: "second canonical user" },
  });
  await aiAgentLoopStreaming({ vm: fixture.vm, actor: fixture.actor, messages: [] });
  return fixture.contexts[1]!.primary;
}

describe("Responses continuation lifecycle in both executor entries", () => {
  const invalidationCases: Array<{
    name: string;
    mutate: (fixture: ContinuationInvalidationFixture) => void;
  }> = [
    {
      name: "compaction baseline epoch",
      mutate: ({ actor }) => {
        const beforeEpoch = actor.continuationBaseline.baselineEpoch;
        const after = resetActorContinuationBaseline({
          actor,
          reason: "compaction:test",
          occurredAt: "2026-07-18T12:01:00.000Z",
        });
        expect(after.baselineEpoch).toBe(beforeEpoch + 1);
        expect(after.latestResponseId).toBeNull();
      },
    },
    {
      name: "actor system prompt",
      mutate: ({ actor }) => {
        actor.systemPrompts = ["changed actor system prompt"];
      },
    },
    {
      name: "active model control",
      mutate: ({ actor }) => {
        actor.send("control", {
          kind: "set_active_model_config",
          modelConfig: { model: "gpt-5.6" },
          source: "test-control",
        });
        expect(applyActorModelConfigControlSignals(actor)?.modelConfig.model).toBe("gpt-5.6");
      },
    },
    {
      name: "tool schema",
      mutate: ({ changeToolSchema }) => changeToolSchema(),
    },
  ];

  it("keeps an unchanged second turn on the stateful chain", async () => {
    const plan = await establishContinuationAndRunNextTurn(
      createContinuationInvalidationFixture("responses-invalidation-control"),
      () => {},
    );

    expect(plan).toEqual(expect.objectContaining({
      kind: "stateful_incremental",
      previousResponseId: "invalidation-resp-1",
    }));
    expect(plan.input).toEqual([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "second canonical user" }],
    }]);
  });

  it("keeps runtime-only work context outside stateful Responses continuation", async () => {
    const fixture = createContinuationInvalidationFixture(
      "responses-instructions-single-source",
    );
    await establishContinuationAndRunNextTurn(fixture, ({ actor }) => {
      setActorWorkMode({ actor, workMode: WORK_MODES.plan, source: "test-control" });
    });

    const first = fixture.contexts[0]!;
    const second = fixture.contexts[1]!;
    expect(first.instructions).toContain("Sandbox permissions:");
    expect(first.instructions).toContain("provider configured instructions");
    expect(first.instructions).toContain("stable actor system prompt");
    expect(second.instructions).toBe(first.instructions);

    const configuredEnd = first.instructions!.indexOf("provider configured instructions")
      + "provider configured instructions".length;
    expect(configuredEnd).toBeGreaterThan("provider configured instructions".length);
    expect(second.instructions!.slice(0, configuredEnd)).toBe(
      first.instructions!.slice(0, configuredEnd),
    );
    expect(second.primary.contextDigest).toBe(first.primary.contextDigest);
    expect(first.primary.kind).toBe("stateless_replay");
    expect(second.primary.kind).toBe("stateful_incremental");
    if (first.primary.kind !== "stateless_replay" || second.primary.kind !== "stateful_incremental") {
      throw new Error("expected append-only stateful plan after dynamic context change");
    }
    expect(second.primary.previousResponseId).toBe("invalidation-resp-1");
    expect(second.primary.input).toEqual([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "second canonical user" }],
    }]);
    expect(JSON.stringify(second.primary.input)).not.toContain("eidolon-context-fact/v1");
    expect(second.statelessFallback?.promptCacheKey).toBe(first.primary.promptCacheKey);
  });

  it("keeps an unadmitted provider projection revision outside the Responses request", async () => {
    const fixture = createContinuationInvalidationFixture("responses-provider-projection-append-only");
    const plan = await establishContinuationAndRunNextTurn(fixture, ({ actor, vm }) => {
      const runtime = getVmConversationDomainRuntime(vm);
      expect(runtime).not.toBeNull();
      upsertProviderProjectionFactToConversationDomainRuntime({
        runtime: runtime!,
        sessionId: String((vm.outerCtx.metadata as any).sessionId),
        projectionFact: {
          actorKey: actor.key,
          projectionKey: "mutable-state",
          revision: "revision-2",
          content: "changed provider projection",
          placement: "late",
          sourceToolCalls: [],
          observedAt: "2026-07-18T12:00:00.000Z",
        },
      });
    });
    expect(plan).toEqual(expect.objectContaining({
      kind: "stateful_incremental",
      previousResponseId: "invalidation-resp-1",
    }));
    expect(JSON.stringify(plan.input)).not.toContain("changed provider projection");
  });

  it("changes prompt-cache routing when stable actor instructions change", async () => {
    const fixture = createContinuationInvalidationFixture(
      "responses-stable-instructions-cache-key",
    );
    await establishContinuationAndRunNextTurn(fixture, ({ actor }) => {
      actor.systemPrompts = ["changed actor system prompt"];
    });

    const first = fixture.contexts[0]!.primary;
    const second = fixture.contexts[1]!.primary;
    expect(first.kind).toBe("stateless_replay");
    expect(second.kind).toBe("stateless_replay");
    if (first.kind !== "stateless_replay" || second.kind !== "stateless_replay") {
      throw new Error("expected stateless plans after stable instruction invalidation");
    }
    expect(second.promptCacheKey).not.toBe(first.promptCacheKey);
  });

  for (const scenario of invalidationCases) {
    it(`uses canonical full replay after ${scenario.name} changes`, async () => {
      const plan = await establishContinuationAndRunNextTurn(
        createContinuationInvalidationFixture(`responses-invalidation-${scenario.name.replaceAll(" ", "-")}`),
        scenario.mutate,
      );

      expect(plan).toEqual(expect.objectContaining({
        kind: "stateless_replay",
        source: "canonical_rebuild",
      }));
      expect("previousResponseId" in plan).toBe(false);
      const body = JSON.stringify(plan.input);
      expect(body).toContain("first canonical user");
      expect(body).toContain("second canonical user");
    });
  }

  it("advances the canonical frontier past assistant output so the next stateful turn contains only the new user", async () => {
    const contexts: ResponsesTransportRequestContext[] = [];
    const options: Record<string, unknown> = {
      responses_continuation_mode: "stateful_chain",
      transport_mode: "auto",
      websocket_url: "wss://example.test/v1/responses",
    };
    const adapter = {
      type: "openai" as const,
      runtime: { adapterName: "openai-responses", providerId: "openai" },
      options,
      async createStream(input: any) {
        const context = input.providerRequestContext as ResponsesTransportRequestContext;
        contexts.push(context);
        const ordinal = contexts.length;
        async function* stream() { yield { ok: true }; }
        return {
          stream: stream(),
          providerOutput: Promise.resolve({
            provider_cache_cost_observation: createMockProviderCacheCostObservation(input),
            schemaVersion: 1 as const,
            kind: "responses_transport_result" as const,
            plan: context.primary,
            transport: context.primary.kind === "stateful_incremental"
              ? "websocket" as const
              : "http_sse" as const,
            responseStored: true,
            outputDecision: {
              schemaVersion: 1 as const,
              kind: "responses_native_output_completeness_decision" as const,
              status: "complete" as const,
              output: createResponsesProviderOutputSnapshot({
                responseId: `user-resp-${ordinal}`,
                items: [{
                  type: "message",
                  role: "assistant",
                  phase: "final_answer",
                  content: [{ type: "output_text", text: `answer-${ordinal}` }],
                }],
              }),
            },
          }),
        };
      },
    };
    let ordinal = 0;
    const registry = new ToolFuncRegistry();
    const actor = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "gpt-5.5" },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async () => {
          ordinal += 1;
          return { role: "assistant", content: `answer-${ordinal}` };
        }),
      },
    });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { main: actor },
      registries: { toolRegistry: registry },
      outerCtx: { metadata: { sessionId: "responses-user-frontier" } },
    });

    await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "first user" }],
    });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "second user" },
    });
    await aiAgentLoopStreaming({ vm, actor, messages: [] });

    expect(contexts[1]?.primary.kind).toBe("stateful_incremental");
    expect(contexts[1]?.primary.input).toEqual([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "second user" }],
    }]);
    expect(JSON.stringify(contexts[1]?.primary.input)).not.toContain("answer-1");

    options.transport_mode = "http_sse";
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "forced http user" },
    });
    await aiAgentLoopStreaming({ vm, actor, messages: [] });
    expect(contexts[2]?.primary.kind).toBe("stateless_replay");
  });

  it("uses the pure plan in streaming turns and commits the actual stateless fallback", async () => {
    const contexts: ResponsesTransportRequestContext[] = [];
    const registry = new ToolFuncRegistry();
    registerInspectTool(registry);
    let completion = 0;
    const actor = createActor({
      key: "main",
      llmClient: responsesAdapter({ contexts }),
      modelConfig: { model: "gpt-5.5" },
      callbacks: {
        buildToolset: () => [registry.get("inspect")!.schema],
        processStream: createMockProcessStream(async () => {
          completion += 1;
          return completion === 1
            ? {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call-1",
                  type: "function",
                  function: { name: "inspect", arguments: "{}" },
                }],
              }
            : { role: "assistant", content: "done" };
        }),
      },
    });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { main: actor },
      registries: { toolRegistry: registry },
      outerCtx: { metadata: { sessionId: "responses-streaming" } },
    });

    await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "inspect then finish" }],
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.primary.kind).toBe("stateless_replay");
    expect(contexts[1]?.primary.kind).toBe("stateful_incremental");
    expect(contexts[1]?.statelessFallback?.kind).toBe("stateless_replay");
    expect(contexts[1]?.primary.input).toEqual([{
      type: "function_call_output",
      call_id: "call-1",
      output: "inspection result",
    }]);

    expect(actor.continuationBaseline).toEqual(expect.objectContaining({
      latestResponseId: "resp-2",
      contextDigest: contexts[1]?.statelessFallback?.contextDigest,
    }));
    const checkpoint = replayCheckpoint(vm, "responses-streaming");
    expect(checkpoint).toEqual(expect.objectContaining({
      requestKind: "stateless_replay",
      requestInput: contexts[1]?.statelessFallback?.input,
    }));
    expect(checkpoint.nativeWindow).toEqual([
      ...contexts[1]!.statelessFallback!.input,
      ...checkpoint.output.items,
    ]);
  });

  it("commits a completed Responses result through the cooperative entry", async () => {
    const contexts: ResponsesTransportRequestContext[] = [];
    const registry = new ToolFuncRegistry();
    const actor = createActor({
      key: "main",
      llmClient: responsesAdapter({ contexts }),
      modelConfig: { model: "gpt-5.5" },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async () => ({ role: "assistant", content: "done" })),
      },
    });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { main: actor },
      registries: { toolRegistry: registry },
      outerCtx: { metadata: { sessionId: "responses-cooperative" } },
    });
    const fiberId = `${actor.key}:${actor.id}`;
    let state: any;
    const step = () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor,
      messages: [],
      state,
      setState: (next) => { state = next; },
      resumeFiber: () => {},
    });
    actor.send("humanInput", "continue");
    for (let index = 0; index < 20; index += 1) {
      const result = await step();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (result.kind === "suspend" && result.reason === "idle_external") break;
    }

    expect(contexts).toHaveLength(1);
    expect(actor.continuationBaseline.latestResponseId).toBe("resp-1");
    expect(actor.continuationBaseline.contextDigest).toBe(contexts[0]?.primary.contextDigest);
  });

  it("does not advance baseline or write a checkpoint for a pseudo-completion without transport output", async () => {
    const contexts: ResponsesTransportRequestContext[] = [];
    const registry = new ToolFuncRegistry();
    const actor = createActor({
      key: "main",
      llmClient: responsesAdapter({ contexts, omitProviderOutput: true }),
      modelConfig: { model: "gpt-5.5" },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async () => ({ role: "assistant", content: "looks done" })),
      },
    });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { main: actor },
      registries: { toolRegistry: registry },
      outerCtx: { metadata: { sessionId: "responses-pseudo" } },
    });

    await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "continue" }] });

    expect(actor.continuationBaseline).toEqual(expect.objectContaining({
      latestResponseId: null,
      contextDigest: null,
      lastResetReason: "provider_epoch:openai-responses@1",
    }));
    expect(replayCheckpoint(vm, "responses-pseudo")).toBeUndefined();
  });

  it("does not advance baseline or write a checkpoint for an incomplete native output decision", async () => {
    const contexts: ResponsesTransportRequestContext[] = [];
    const actor = createActor({
      key: "main",
      llmClient: responsesAdapter({ contexts, incompleteOutput: true }),
      modelConfig: { model: "gpt-5.5" },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async () => ({ role: "assistant", content: "tool call observed" })),
      },
    });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { main: actor },
      registries: { toolRegistry: new ToolFuncRegistry() },
      outerCtx: { metadata: { sessionId: "responses-incomplete-native" } },
    });

    await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "continue" }] });

    expect(actor.continuationBaseline).toEqual(expect.objectContaining({
      latestResponseId: null,
      contextDigest: null,
      lastResetReason: "provider_epoch:openai-responses@1",
    }));
    expect(replayCheckpoint(vm, "responses-incomplete-native")).toBeUndefined();
  });

  it("advances checkpoint and baseline for a complete reconstructed event proof", async () => {
    const contexts: ResponsesTransportRequestContext[] = [];
    const actor = createActor({
      key: "main",
      llmClient: responsesAdapter({ contexts, reconstructedOutput: true }),
      modelConfig: { model: "gpt-5.5" },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async () => ({ role: "assistant", content: "done" })),
      },
    });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { main: actor },
      registries: { toolRegistry: new ToolFuncRegistry() },
      outerCtx: { metadata: { sessionId: "responses-reconstructed-native" } },
    });

    await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "continue" }] });

    expect(actor.continuationBaseline.latestResponseId).toBe("resp-1");
    const checkpoint = replayCheckpoint(vm, "responses-reconstructed-native");
    expect(checkpoint?.output.completenessProof.source).toBe("reconstructed_event_items");
  });

  it("keeps native replay but does not advance latestResponseId when the response was not stored", async () => {
    const contexts: ResponsesTransportRequestContext[] = [];
    const registry = new ToolFuncRegistry();
    const actor = createActor({
      key: "main",
      llmClient: responsesAdapter({ contexts, responseStored: false }),
      modelConfig: { model: "gpt-5.5" },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async () => ({ role: "assistant", content: "done" })),
      },
    });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { main: actor },
      registries: { toolRegistry: registry },
      outerCtx: { metadata: { sessionId: "responses-not-stored" } },
    });

    await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "continue" }] });

    expect(actor.continuationBaseline.latestResponseId).toBeNull();
    expect(actor.continuationBaseline.contextDigest).toBe(contexts[0]?.primary.contextDigest);
    expect(replayCheckpoint(vm, "responses-not-stored")?.output.responseId).toBe("resp-1");
  });
});
