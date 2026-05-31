import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorHistoryGenerationData,
  type ActorPromptGenerationData,
} from "@cell/ai-organ-contract";
import {
  chatMessagesToCommittedHistoryRefs,
  committedHistoryRefsToMessages,
  loadConversationActorRawState,
  loadConversationHistoryMessages,
  loadConversationRuntimeMessages,
  loadConversationSessionRawState,
  LocalFileConversationPersistenceRepositoryFactory,
  materializeConversationRuntimePrompt,
} from "@cell/ai-support";

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-conversation-raw-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("conversation raw state views", () => {
  it("normalizes tool call ids across OpenAI wire and committed history message shapes", () => {
    const committedMessages = chatMessagesToCommittedHistoryRefs({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", input: { path: "README.md" } }],
        },
        { role: "tool", content: "ok", tool_call_id: "call_1" },
      ],
      actorKey: "main",
      actorId: "actor-main",
      recordIdPrefix: "hist-tool",
      transcriptPath: null,
    });

    expect(committedMessages[1].message.toolCallId).toBe("call_1");
    expect(committedMessages[1].sourceRecords?.[0]).toEqual({
      stream: "tool_call_result",
      payload: JSON.stringify({ toolCallId: "call_1", result: "ok", isError: false }),
    });

    const restored = committedHistoryRefsToMessages(committedMessages);
    expect(restored[1]).toMatchObject({
      role: "tool",
      content: "ok",
      toolCallId: "call_1",
      tool_call_id: "call_1",
    });
  });

  it("restores work-context overlays at a late legal boundary without splitting tool calls", () => {
    const historyGeneration: ActorHistoryGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      generationId: "hist-tool",
      sessionId: "ses_raw",
      actorKey: "main",
      actorId: "actor-main",
      parentGenerationIds: [],
      messages: chatMessagesToCommittedHistoryRefs({
        messages: [
          {
            role: "assistant",
            content: "",
            reasoning_content: "thinking",
            tool_calls: [{ id: "tc-1", type: "function", function: { name: "bash", arguments: "{}" } }],
          } as any,
          { role: "tool", tool_call_id: "tc-1", content: "tool result" } as any,
        ],
        actorKey: "main",
        actorId: "actor-main",
        recordIdPrefix: "hist-tool",
        transcriptPath: null,
      }),
      sealed: false,
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(2).toISOString(),
    };
    const promptGeneration: ActorPromptGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      promptGenerationId: "prompt-tool",
      sessionId: "ses_raw",
      actorKey: "main",
      actorId: "actor-main",
      basedOnPromptGenerationId: null,
      basis: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        basisHistoryGenerationIds: ["hist-tool"],
        basisMessageRecordIds: historyGeneration.messages.map((message) => message.recordId),
      },
      transforms: [
        {
          transformId: "work-context",
          kind: "overlay",
          payload: {
            overlayKind: "work_context",
            insertPlacement: "late_status",
            content: "<runtime_work_context>\nwork_mode: general_execution\n</runtime_work_context>",
          },
          appliedAt: new Date(3).toISOString(),
        },
      ],
      materializedContext: null,
      sealed: false,
      createdAt: new Date(3).toISOString(),
      sealedAt: null,
      updatedAt: new Date(3).toISOString(),
    };

    const messages = materializeConversationRuntimePrompt({
      session: { sessionId: "ses_raw" },
      actorKey: "main",
      actorId: "actor-main",
      historyHeadGenerationId: "hist-tool",
      promptHeadGenerationId: "prompt-tool",
      visibleGenerationIds: ["hist-tool"],
      visibleHistoryGenerations: [historyGeneration],
      activeHistoryGeneration: historyGeneration,
      promptGeneration,
      contextAssetIds: [],
    } as any);

    expect(messages.map((message) => message.role)).toEqual(["system", "assistant", "tool"]);
    expect(messages[0]?.content).toContain("<runtime_work_context>");
    expect((messages[1] as any).reasoning_content).toBe("thinking");
    expect((messages[2] as any).tool_call_id).toBe("tc-1");
  });

  it("recovers tool call ids from source records when older committed messages dropped them", () => {
    const restored = committedHistoryRefsToMessages([
      {
        recordId: "hist-tool::0",
        actorKey: "main",
        actorId: "actor-main",
        committedAt: 1,
        message: { role: "tool", content: "ok" },
        sourceRecords: [
          {
            stream: "tool_call_result",
            payload: JSON.stringify({ toolCallId: "call_legacy", result: "ok", isError: false }),
          },
        ],
        transcriptPath: null,
      },
    ]);

    expect(restored[0]).toMatchObject({
      role: "tool",
      content: "ok",
      toolCallId: "call_legacy",
      tool_call_id: "call_legacy",
    });
  });

  it("derives history/runtime/session views from a shared raw state and interprets prompt transforms generically", async () => {
    const sessionDir = makeTempSessionDir();
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);

    const historyGeneration: ActorHistoryGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      generationId: "hist-1",
      sessionId: "ses_raw",
      actorKey: "main",
      actorId: "actor-main",
      parentGenerationId: null,
      predecessorGenerationIds: [],
      createdReason: "append",
      sealed: false,
      messageCount: 1,
      messages: chatMessagesToCommittedHistoryRefs({
        messages: [{ role: "assistant", content: "tail message" } as any],
        actorKey: "main",
        actorId: "actor-main",
        recordIdPrefix: "hist-1",
        transcriptPath: null,
      }),
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(2).toISOString(),
    };

    const promptGeneration: ActorPromptGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      promptGenerationId: "prompt-1",
      sessionId: "ses_raw",
      actorKey: "main",
      actorId: "actor-main",
      basedOnPromptGenerationId: null,
      basis: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        basisHistoryGenerationIds: ["hist-1"],
        basisMessageRecordIds: historyGeneration.messages.map((message) => message.recordId),
      },
      transforms: [
        {
          transformId: "overlay-1",
          kind: "overlay",
          payload: { content: "Follow the house style." },
          appliedAt: new Date(3).toISOString(),
        },
        {
          transformId: "asset-1",
          kind: "context_asset_attach",
          payload: { assetId: "asset-1", text: "Attached excerpt from workspace file." },
          appliedAt: new Date(4).toISOString(),
        },
        {
          transformId: "micro-1",
          kind: "micro_compact",
          payload: { summary: "Micro compact summary", acknowledgedSummary: "Micro compact ack" },
          appliedAt: new Date(5).toISOString(),
        },
      ],
      materializedContext: null,
      sealed: false,
      createdAt: new Date(3).toISOString(),
      updatedAt: new Date(5).toISOString(),
    };

    const historyIndex = await repository.loadHistoryIndex();
    historyIndex.heads.main = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "ses_raw",
      actorKey: "main",
      actorId: "actor-main",
      activeGenerationId: "hist-1",
      visibleGenerationIds: ["hist-1"],
      updatedAt: new Date(6).toISOString(),
    };
    historyIndex.generations["hist-1"] = {
      generationId: "hist-1",
      actorKey: "main",
      actorId: "actor-main",
      sealed: false,
      createdAt: historyGeneration.createdAt,
      updatedAt: historyGeneration.updatedAt,
    };

    const promptIndex = await repository.loadPromptIndex();
    promptIndex.heads.main = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "ses_raw",
      actorKey: "main",
      actorId: "actor-main",
      activePromptGenerationId: "prompt-1",
      updatedAt: new Date(6).toISOString(),
    };
    promptIndex.generations["prompt-1"] = {
      promptGenerationId: "prompt-1",
      actorKey: "main",
      actorId: "actor-main",
      sealed: false,
      createdAt: promptGeneration.createdAt,
      updatedAt: promptGeneration.updatedAt,
    };

    const sessionIndex = await repository.loadSessionIndex();
    sessionIndex.session.activeActorKey = "main";
    sessionIndex.session.actorBindings.main = {
      actorKey: "main",
      actorId: "actor-main",
      historyHeadGenerationId: "hist-1",
      promptHeadGenerationId: "prompt-1",
    };
    sessionIndex.session.contextAssetRegistry = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      assetIds: ["asset-1"],
      updatedAt: new Date(7).toISOString(),
    };

    await repository.writeHistoryGeneration(historyGeneration);
    await repository.writePromptGeneration(promptGeneration);
    await repository.writeHistoryIndex(historyIndex);
    await repository.writePromptIndex(promptIndex);
    await repository.writeSessionIndex(sessionIndex);

    const sessionRawState = await loadConversationSessionRawState({ sessionDir, repository });
    expect(sessionRawState.activeActorKey).toBe("main");
    expect(sessionRawState.contextAssetRegistry?.assetIds).toEqual(["asset-1"]);

    const actorRawState = await loadConversationActorRawState({ sessionDir, actorKey: "main", repository });
    expect(actorRawState?.historyHeadGenerationId).toBe("hist-1");
    expect(actorRawState?.promptHeadGenerationId).toBe("prompt-1");
    expect(actorRawState?.visibleGenerationIds).toEqual(["hist-1"]);
    expect(actorRawState?.contextAssetIds).toEqual(["asset-1"]);

    const historyView = await loadConversationHistoryMessages({ sessionDir, actorKey: "main", repository });
    expect(historyView.messages.map((message) => message.content)).toEqual(["tail message"]);

    const runtimeView = await loadConversationRuntimeMessages({ sessionDir, actorKey: "main", repository });
    expect(runtimeView.messages).toEqual([
      { role: "system", content: "Follow the house style." },
      { role: "system", content: "Attached excerpt from workspace file." },
      { role: "user", content: "Micro compact summary" },
      { role: "assistant", content: "Micro compact ack" },
      expect.objectContaining({ role: "assistant", content: "tail message" }),
    ]);
  });
});
