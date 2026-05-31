import { describe, expect, it } from "bun:test";

import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  createConversationDomainRuntime,
  emitConversationDomainEvent,
  recordConversationTranscriptEvidenceInRuntime,
  subscribeConversationHistory,
  teeConversationHistoryStream,
  setConversationDomainPersistHooks,
  materializeConversationHistoryMessagesFromVm,
  materializeConversationRuntimeMessagesFromVm,
  recordPromptOverlayToConversationDomainRuntime,
  registerContextBlockToConversationDomainRuntime,
  clearContextBlocksInConversationDomainRuntime,
  forkConversationSessionInConversationDomainRuntime,
  closeConversationSessionInConversationDomainRuntime,
} from "@cell/ai-organ-logic";
import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION } from "@cell/ai-organ-contract";

describe("conversation domain runtime", () => {
  it("provides stream hooks, assembly state, prompt runtime ops, and session lifecycle entrypoints", () => {
    const runtime = createConversationDomainRuntime();
    const historyEvents: string[] = [];
    const teeEvents: string[] = [];
    const persistedEvents: string[] = [];

    subscribeConversationHistory(runtime, (event) => {
      historyEvents.push(event.type);
    });
    teeConversationHistoryStream(runtime).subscribe((event) => {
      teeEvents.push(event.type);
    });
    setConversationDomainPersistHooks(runtime, {
      history: (event) => {
        persistedEvents.push(event.type);
      },
    });

    emitConversationDomainEvent(runtime, {
      type: "actor_history_generation_created",
      sessionId: "ses-1",
      actorKey: "main",
      generationId: "main__active",
      generation: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        generationId: "main__active",
        sessionId: "ses-1",
        actorKey: "main",
        actorId: "actor-main",
        parentGenerationId: null,
        predecessorGenerationIds: [],
        createdReason: "append",
        sealed: false,
        messageCount: 0,
        messages: [],
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(1).toISOString(),
      },
      occurredAt: new Date(1).toISOString(),
    });

    expect(historyEvents).toEqual(["actor_history_generation_created"]);
    expect(teeEvents).toEqual(["actor_history_generation_created"]);
    expect(persistedEvents).toEqual(["actor_history_generation_created"]);

    const vm = {
      runtimeContext: {
        conversationDomainRuntime: runtime,
      },
      outerCtx: {
        metadata: {
          sessionId: "ses-1",
        },
      },
    } as any;

    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: "main",
      actorId: "actor-main",
      message: {
        role: "user",
        content: "hello",
        startAt: 10,
        endAt: 10,
      },
      occurredAt: new Date(10).toISOString(),
    });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: "main",
      actorId: "actor-main",
      message: {
        role: "assistant",
        content: "world",
        startAt: 20,
        endAt: 30,
      },
      occurredAt: new Date(30).toISOString(),
    });

    const assemblyState = runtime.messageAssemblySignal.get()["ses-1::main"];
    expect(assemblyState.reducedMessages.map((message) => String(message.content))).toEqual([
      "hello",
      "world",
    ]);
    expect(assemblyState.emittedMessageCount).toBe(2);
    expect(materializeConversationHistoryMessagesFromVm({ vm, actorKey: "main" }).map((message) => String(message.content))).toEqual([
      "hello",
      "world",
    ]);
    expect(materializeConversationHistoryMessagesFromVm({ vm, actorKey: "main" })).toEqual([
      expect.objectContaining({ role: "user", content: "hello", startAt: 10, endAt: 10 }),
      expect.objectContaining({ role: "assistant", content: "world", startAt: 20, endAt: 30 }),
    ]);

    const promptGenerationId = recordPromptOverlayToConversationDomainRuntime({
      runtime,
      sessionId: "ses-1",
      actorKey: "main",
      actorId: "actor-main",
      content: "Follow the house style.",
    });
    expect(promptGenerationId).toContain("main__prompt");

    const assetId = registerContextBlockToConversationDomainRuntime({
      runtime,
      sessionId: "ses-1",
      actorKey: "main",
      actorId: "actor-main",
      title: "workspace excerpt",
      content: "Attached excerpt from workspace file.",
    });
    expect(assetId).toContain("main__asset");

    let runtimeMessages = materializeConversationRuntimeMessagesFromVm({ vm, actorKey: "main" });
    expect(runtimeMessages.map((message) => String(message.content))).toEqual([
      "Follow the house style.",
      "Attached excerpt from workspace file.",
      "hello",
      "world",
    ]);

    clearContextBlocksInConversationDomainRuntime({
      runtime,
      sessionId: "ses-1",
      actorKey: "main",
      actorId: "actor-main",
    });

    runtimeMessages = materializeConversationRuntimeMessagesFromVm({ vm, actorKey: "main" });
    expect(runtimeMessages.map((message) => String(message.content))).toEqual([
      "Follow the house style.",
      "hello",
      "world",
    ]);

    forkConversationSessionInConversationDomainRuntime({
      runtime,
      sessionId: "ses-2",
      parentSessionId: "ses-1",
      forkedFromGenerationId: "main__active",
    });
    closeConversationSessionInConversationDomainRuntime({
      runtime,
      sessionId: "ses-2",
      reason: "done",
    });

    expect(runtime.sessionStateSignal.get()["ses-2"]?.lineage?.parentSessionId).toBe("ses-1");
  });

  it("bounds append-only domain and assembly buffers in memory", () => {
    const runtime = createConversationDomainRuntime();
    const vm = {
      runtimeContext: {
        conversationDomainRuntime: runtime,
      },
      outerCtx: {
        metadata: {
          sessionId: "ses-bounded",
        },
      },
    } as any;

    for (let index = 0; index < 650; index += 1) {
      emitConversationDomainEvent(runtime, {
        type: "actor_history_generation_created",
        sessionId: "ses-bounded",
        actorKey: "main",
        generationId: "main__active",
        occurredAt: new Date(index).toISOString(),
      });
      appendLiveHistoryMessageToConversationDomainRuntime({
        vm,
        actorKey: "main",
        actorId: "actor-main",
        message: {
          role: "assistant",
          content: `message ${index}`,
          startAt: index,
          endAt: index,
        },
        occurredAt: new Date(index).toISOString(),
      });
      recordConversationTranscriptEvidenceInRuntime({
        vm,
        actorKey: "main",
        actorId: "actor-main",
        transcriptRecord: {
          stream: "content",
          payload: `chunk ${index}`,
          startAt: index,
          endAt: index,
        },
      });
    }

    const assemblyState = runtime.messageAssemblySignal.get()["ses-bounded::main"];

    expect(runtime.historyEvents).toHaveLength(500);
    expect(runtime.historyEvents[0]?.type).toBe("actor_history_generation_created");
    expect(runtime.historyEvents[0]?.occurredAt).toBe(new Date(400).toISOString());
    expect(assemblyState.reducedMessages).toHaveLength(300);
    expect(assemblyState.reducedMessages[0]?.content).toBe("message 350");
    expect(assemblyState.transcriptRecords).toHaveLength(400);
    expect(assemblyState.transcriptRecords[0]?.payload).toBe("chunk 250");
    expect(assemblyState.emittedMessageCount).toBe(650);
  });

  it("keeps teammate live history actor-scoped without moving the primary session selection", () => {
    const runtime = createConversationDomainRuntime();
    const vm = {
      runtimeContext: {
        conversationDomainRuntime: runtime,
      },
      outerCtx: {
        metadata: {
          sessionId: "ses-team",
        },
      },
    } as any;

    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: "main",
      actorId: "actor-main",
      message: {
        role: "user",
        content: "primary prompt",
        startAt: 10,
        endAt: 10,
      },
      occurredAt: new Date(10).toISOString(),
    });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: "main",
      actorId: "actor-main",
      message: {
        role: "assistant",
        content: "primary answer",
        startAt: 20,
        endAt: 20,
      },
      occurredAt: new Date(20).toISOString(),
    });

    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: "member:alice",
      actorId: "actor-alice",
      message: {
        role: "assistant",
        content: "teammate answer",
        startAt: 30,
        endAt: 30,
      },
      occurredAt: new Date(30).toISOString(),
    });

    const session = runtime.sessionStateSignal.get()["ses-team"];
    expect(session?.activeActorKey).toBe("main");
    expect(session?.sessionIndex.session.activeActorKey).toBe("main");
    expect(session?.sessionIndex.session.activeSelection?.activeActorKey).toBe("main");
    expect(session?.actorBindings["member:alice"]?.historyHeadGenerationId).toBe("member:alice__active");

    expect(materializeConversationHistoryMessagesFromVm({ vm, actorKey: "main" }).map((message) => String(message.content))).toEqual([
      "primary prompt",
      "primary answer",
    ]);
    expect(materializeConversationHistoryMessagesFromVm({ vm, actorKey: "member:alice" }).map((message) => String(message.content))).toEqual([
      "teammate answer",
    ]);
  });

  it("updates runtime state from thick history events without fallback inference", () => {
    const runtime = createConversationDomainRuntime();

    emitConversationDomainEvent(runtime, {
      type: "actor_history_generation_created",
      sessionId: "ses-2",
      actorKey: "main",
      generationId: "main__active",
      generation: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        generationId: "main__active",
        sessionId: "ses-2",
        actorKey: "main",
        actorId: "actor-main",
        parentGenerationId: null,
        predecessorGenerationIds: [],
        createdReason: "append",
        sealed: false,
        messageCount: 0,
        messages: [],
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(1).toISOString(),
      },
      occurredAt: new Date(1).toISOString(),
    });
    emitConversationDomainEvent(runtime, {
      type: "actor_history_head_moved",
      sessionId: "ses-2",
      actorKey: "main",
      activeGenerationId: "main__active",
      head: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId: "ses-2",
        actorKey: "main",
        actorId: "actor-main",
        activeGenerationId: "main__active",
        visibleGenerationIds: ["main__active"],
        updatedAt: new Date(1).toISOString(),
      },
      occurredAt: new Date(1).toISOString(),
    });
    emitConversationDomainEvent(runtime, {
      type: "actor_history_appended",
      sessionId: "ses-2",
      actorKey: "main",
      generationId: "main__active",
      messageRecordId: "msg-1",
      message: {
        recordId: "msg-1",
        role: "assistant",
        content: "thick event",
        reasoningContent: null,
        toolCalls: [],
        startAt: 11,
        endAt: 12,
        metadata: null,
      },
      generation: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        generationId: "main__active",
        sessionId: "ses-2",
        actorKey: "main",
        actorId: "actor-main",
        parentGenerationId: null,
        predecessorGenerationIds: [],
        createdReason: "append",
        sealed: false,
        messageCount: 0,
        messages: [],
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(1).toISOString(),
      },
      head: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId: "ses-2",
        actorKey: "main",
        actorId: "actor-main",
        activeGenerationId: "main__active",
        visibleGenerationIds: ["main__active"],
        updatedAt: new Date(12).toISOString(),
      },
      occurredAt: new Date(12).toISOString(),
    });

    expect(runtime.historyStateSignal.get()["ses-2::main"]?.generations[0]?.messages).toEqual([
      expect.objectContaining({
        actorId: "actor-main",
        actorKey: "main",
        message: expect.objectContaining({
          recordId: "msg-1",
          content: "thick event",
        }),
      }),
    ]);
  });
});
