import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorHistoryGenerationData,
  type ConversationActorRawState,
  type ConversationSessionIndexSnapshot,
  type LocalConversationContextAssetData,
  type LocalConversationProviderProjectionFact,
} from "@cell/ai-organ-contract";
import {
  createConversationDomainRuntime,
  setConversationDomainPersistHooks,
  upsertProviderProjectionFactToConversationDomainRuntime,
} from "@cell/ai-organ-logic";
import {
  elideDeliveredToolCallPairsFromProviderView,
  loadConversationSessionRawState,
  materializeConversationRuntimePrompt,
  materializeConversationVisibleHistory,
  LocalFileConversationPersistenceRepositoryFactory,
} from "@cell/ai-support";
import type { ChatMessage } from "@shared/composer";

const CREATED_AT = "2026-07-18T10:00:00.000Z";

function makeProjectionFact(params: {
  projectionKey?: string;
  revision?: string;
  content?: string;
  sourceToolCallId?: string;
  deliveredAt?: string | null;
} = {}): LocalConversationProviderProjectionFact {
  return {
    actorKey: "main",
    projectionKey: params.projectionKey ?? "mutable-state",
    revision: params.revision ?? "revision-1",
    content: params.content ?? "current projected state",
    placement: "late",
    sourceToolCalls: [{
      toolCallId: params.sourceToolCallId ?? "call-projected",
      projectionRevision: params.revision ?? "revision-1",
      deliveryState: params.deliveredAt ? "delivered" : "pending",
      deliveredAt: params.deliveredAt ?? null,
    }],
    observedAt: CREATED_AT,
  };
}

function makeProjectionAsset(
  fact: LocalConversationProviderProjectionFact,
  assetId = `projection:${fact.actorKey}:${fact.projectionKey}`,
): LocalConversationContextAssetData {
  return {
    assetId,
    kind: "note",
    source: { kind: "note", ownerId: fact.actorKey },
    projectionFact: fact,
    createdAt: CREATED_AT,
    updatedAt: fact.observedAt,
  };
}

function makeRawState(params: {
  messages: ChatMessage[];
  assets?: LocalConversationContextAssetData[];
}): ConversationActorRawState {
  const generation: ActorHistoryGenerationData = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    generationId: "main__active",
    sessionId: "session-projection",
    actorKey: "main",
    actorId: "actor-main",
    parentGenerationId: null,
    predecessorGenerationIds: [],
    createdReason: "append",
    sealed: false,
    messageCount: params.messages.length,
    messages: params.messages.map((message, index) => ({
      recordId: `record-${index}`,
      actorKey: "main",
      actorId: "actor-main",
      committedAt: index,
      message: {
        role: message.role,
        content: message.content,
        reasoningContent: message.reasoning_content,
        toolCallId: message.toolCallId ?? message.tool_call_id,
        toolCalls: message.toolCalls,
      },
    })),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const contextAssets = params.assets ?? [];

  return {
    session: {
      sessionId: "session-projection",
      activeActorKey: "main",
      actorBindings: {},
      contextAssetRegistry: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        assetIds: contextAssets.map((asset) => asset.assetId),
        updatedAt: CREATED_AT,
      },
      contextAssets,
      historyIndex: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId: "session-projection",
        heads: {},
        generations: {},
        updatedAt: CREATED_AT,
      },
      promptIndex: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId: "session-projection",
        heads: {},
        generations: {},
        updatedAt: CREATED_AT,
      },
      sessionIndex: {} as ConversationSessionIndexSnapshot,
    },
    actorKey: "main",
    actorId: "actor-main",
    historyHeadGenerationId: generation.generationId,
    promptHeadGenerationId: null,
    visibleGenerationIds: [generation.generationId],
    visibleHistoryGenerations: [generation],
    activeHistoryGeneration: generation,
    promptGeneration: null,
    contextAssetIds: contextAssets.map((asset) => asset.assetId),
  };
}

function toolPairMessages(): ChatMessage[] {
  return [
    { role: "user", content: "continue" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-projected", name: "producer_a", input: { value: 1 } }],
    },
    { role: "tool", content: "full mutable state", tool_call_id: "call-projected" },
  ];
}

describe("provider context projections", () => {
  it("keeps an undelivered source pair while materializing its current projection", () => {
    const fact = makeProjectionFact();
    const rawState = makeRawState({
      messages: toolPairMessages(),
      assets: [makeProjectionAsset(fact)],
    });

    const runtime = materializeConversationRuntimePrompt(rawState);

    expect(runtime.some((message) => message.role === "assistant" && message.toolCalls?.[0]?.id === "call-projected")).toBe(true);
    expect(runtime.some((message) => message.role === "tool" && message.tool_call_id === "call-projected")).toBe(true);
    expect(runtime.some((message) => message.role === "system" && message.content === fact.content)).toBe(true);
  });

  it("replaces the current revision at a stable Session asset while retaining source delivery audit", () => {
    const runtime = createConversationDomainRuntime();
    const first = makeProjectionFact({
      revision: "revision-1",
      content: "old state",
      sourceToolCallId: "call-1",
      deliveredAt: "2026-07-18T10:01:00.000Z",
    });
    const second = {
      ...makeProjectionFact({
        revision: "revision-2",
        content: "new state",
        sourceToolCallId: "call-2",
      }),
      observedAt: "2026-07-18T10:02:00.000Z",
    };

    const firstAssetId = upsertProviderProjectionFactToConversationDomainRuntime({
      runtime,
      sessionId: "session-projection",
      projectionFact: first,
    });
    const secondAssetId = upsertProviderProjectionFactToConversationDomainRuntime({
      runtime,
      sessionId: "session-projection",
      projectionFact: second,
    });

    const assets = runtime.sessionStateSignal.get()["session-projection"]?.contextAssets ?? [];
    expect(secondAssetId).toBe(firstAssetId);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.projectionFact).toEqual(expect.objectContaining({
      projectionKey: "mutable-state",
      revision: "revision-2",
      content: "new state",
    }));
    expect(assets[0]?.projectionFact?.sourceToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "call-1",
        projectionRevision: "revision-1",
        deliveryState: "delivered",
        deliveredAt: "2026-07-18T10:01:00.000Z",
      }),
      expect.objectContaining({
        toolCallId: "call-2",
        projectionRevision: "revision-2",
        deliveryState: "pending",
        deliveredAt: null,
      }),
    ]);
  });

  it("does not regress a successfully delivered source record to pending", () => {
    const runtime = createConversationDomainRuntime();
    const delivered = makeProjectionFact({ deliveredAt: "2026-07-18T10:01:00.000Z" });
    const pendingReplay = makeProjectionFact();

    upsertProviderProjectionFactToConversationDomainRuntime({
      runtime,
      sessionId: "session-projection",
      projectionFact: delivered,
    });
    upsertProviderProjectionFactToConversationDomainRuntime({
      runtime,
      sessionId: "session-projection",
      projectionFact: pendingReplay,
    });

    const source = runtime.sessionStateSignal.get()["session-projection"]
      ?.contextAssets?.[0]?.projectionFact?.sourceToolCalls[0];
    expect(source).toEqual(expect.objectContaining({
      deliveryState: "delivered",
      deliveredAt: "2026-07-18T10:01:00.000Z",
    }));
  });

  it("keeps both sides when a selected tool call has no matching result", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-without-result", name: "producer", input: {} }],
      },
      { role: "tool", content: "orphan result", tool_call_id: "result-without-call" },
    ];

    expect(elideDeliveredToolCallPairsFromProviderView(
      messages,
      new Set(["call-without-result", "result-without-call"]),
    )).toEqual(messages);
  });

  it("removes a delivered call from each provider call representation", () => {
    const messages = [
      {
        role: "assistant",
        content: "kept text",
        reasoning_content: "kept reasoning",
        toolCalls: [{ id: "call-projected", name: "producer", input: {} }],
        rawToolCalls: [{ id: "call-projected", name: "producer", input: {} }],
        rawToolCallsStr: JSON.stringify([{ id: "call-projected", name: "producer", input: {} }]),
        tool_calls: [{
          id: "call-projected",
          type: "function",
          function: { name: "producer", arguments: "{}" },
        }],
        content_parts: [
          { type: "reasoning", text: "kept reasoning" },
          { type: "tool_use", id: "call-projected", name: "producer", input: {} },
          { type: "text", text: "kept text" },
        ],
      },
      { role: "tool", content: "projected result", tool_call_id: "call-projected" },
    ] as Array<ChatMessage & { content_parts?: Array<Record<string, unknown>> }>;

    const providerView = elideDeliveredToolCallPairsFromProviderView(
      messages,
      new Set(["call-projected"]),
    );
    const assistant = providerView[0] as ChatMessage & { content_parts?: Array<Record<string, unknown>> };

    expect(assistant.toolCalls).toEqual([]);
    expect(assistant.rawToolCalls).toEqual([]);
    expect(assistant.rawToolCallsStr).toBe("[]");
    expect(assistant.tool_calls).toEqual([]);
    expect(assistant.content_parts).toEqual([
      { type: "reasoning", text: "kept reasoning" },
      { type: "text", text: "kept text" },
    ]);
    expect(providerView).toHaveLength(1);
  });

  it("elides a delivered source call/result atomically from provider view without changing History", () => {
    const rawState = makeRawState({
      messages: toolPairMessages(),
      assets: [makeProjectionAsset(makeProjectionFact({ deliveredAt: "2026-07-18T10:01:00.000Z" }))],
    });
    const historyBefore = materializeConversationVisibleHistory(rawState);

    const runtime = materializeConversationRuntimePrompt(rawState);

    expect(runtime.some((message) => message.toolCalls?.some((call) => call.id === "call-projected"))).toBe(false);
    expect(runtime.some((message) => message.role === "tool" && message.tool_call_id === "call-projected")).toBe(false);
    expect(runtime.some((message) => message.role === "assistant")).toBe(false);
    expect(materializeConversationVisibleHistory(rawState)).toEqual(historyBefore);
    expect(historyBefore.some((message) => message.role === "tool" && message.tool_call_id === "call-projected")).toBe(true);
  });

  it("preserves ordinary calls, results, content, and reasoning in a mixed assistant message", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: "I will update and inspect.",
        reasoning_content: "two independent operations",
        toolCalls: [
          { id: "call-projected", name: "producer_a", input: {} },
          { id: "call-ordinary", name: "producer_b", input: {} },
        ],
      },
      { role: "tool", content: "projected result", tool_call_id: "call-projected" },
      { role: "tool", content: "ordinary result", tool_call_id: "call-ordinary" },
    ];
    const rawState = makeRawState({
      messages,
      assets: [makeProjectionAsset(makeProjectionFact({ deliveredAt: "2026-07-18T10:01:00.000Z" }))],
    });

    const runtime = materializeConversationRuntimePrompt(rawState);
    const assistant = runtime.find((message) => message.role === "assistant");

    expect(assistant).toEqual(expect.objectContaining({
      content: "I will update and inspect.",
      reasoning_content: "two independent operations",
    }));
    expect(assistant?.toolCalls?.map((call) => call.id)).toEqual(["call-ordinary"]);
    expect(runtime.some((message) => message.role === "tool" && message.tool_call_id === "call-ordinary")).toBe(true);
    expect(runtime.some((message) => message.role === "tool" && message.tool_call_id === "call-projected")).toBe(false);
  });

  it("uses only the current revision per logical key at the fixed pre-history boundary", () => {
    const older = makeProjectionAsset(
      makeProjectionFact({
        projectionKey: "z-state",
        revision: "revision-1",
        content: "old state",
        sourceToolCallId: "old-call",
      }),
      "duplicate-old",
    );
    const current = makeProjectionAsset({
      ...makeProjectionFact({
        projectionKey: "z-state",
        revision: "revision-2",
        content: "new state",
        sourceToolCallId: "new-call",
      }),
      observedAt: "2026-07-18T10:02:00.000Z",
    }, "duplicate-current");
    current.updatedAt = "2026-07-18T10:02:00.000Z";
    const alphabeticallyFirst = makeProjectionAsset(
      makeProjectionFact({ projectionKey: "a-state", content: "alphabetically first" }),
      "alphabetically-first",
    );
    const rawState = makeRawState({
      messages: [
        { role: "user", content: "earlier user" },
        { role: "assistant", content: "earlier response" },
        { role: "user", content: "latest user" },
      ],
      assets: [older, current, alphabeticallyFirst],
    });

    const runtime = materializeConversationRuntimePrompt(rawState);

    expect(runtime.map((message) => message.content)).toEqual([
      "alphabetically first",
      "new state",
      "earlier user",
      "earlier response",
      "latest user",
    ]);
  });

  it("does not relocate unchanged projections when a new user message is appended", () => {
    const assets = [makeProjectionAsset(makeProjectionFact({ content: "fixed dynamic state" }))];
    const before = materializeConversationRuntimePrompt(makeRawState({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
      ],
      assets,
    }));
    const after = materializeConversationRuntimePrompt(makeRawState({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
      assets,
    }));

    expect(before.map((message) => message.content)).toEqual([
      "fixed dynamic state",
      "first",
      "reply",
    ]);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)?.content).toBe("second");
  });

  it("round-trips projection delivery facts through conversation Session persistence", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-provider-projection-"));
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    const runtime = createConversationDomainRuntime();
    const writes: Promise<void>[] = [];
    setConversationDomainPersistHooks(runtime, {
      session: () => {
        const session = runtime.sessionStateSignal.get()["session-projection"];
        if (session) writes.push(repository.writeSessionIndex(session.sessionIndex));
      },
    });

    try {
      upsertProviderProjectionFactToConversationDomainRuntime({
        runtime,
        sessionId: "session-projection",
        projectionFact: makeProjectionFact({ deliveredAt: "2026-07-18T10:01:00.000Z" }),
      });
      await Promise.all(writes);

      const recovered = await loadConversationSessionRawState({ sessionDir, repository });
      expect(recovered.contextAssets?.[0]?.projectionFact).toEqual(
        runtime.sessionStateSignal.get()["session-projection"]?.contextAssets?.[0]?.projectionFact,
      );
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
