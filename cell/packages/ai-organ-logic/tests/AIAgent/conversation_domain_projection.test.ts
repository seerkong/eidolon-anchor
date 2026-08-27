import { describe, expect, it } from "bun:test";

import {
  createEmptyConversationProjection,
  mergeConversationCompactionActorBinding,
  reduceConversationDomainEvents,
} from "@cell/ai-organ-logic";
import type { ConversationDomainEvent } from "@cell/ai-organ-contract";

describe("conversation domain projection", () => {
  it("keeps the live provider epoch while compaction advances durable heads", () => {
    const receipt = {
      schemaVersion: "provider.epoch-receipt/v1" as const,
      sessionId: "session-1",
      actorKey: "main",
      actorId: "actor-1",
      epoch: 3,
      targetProviderId: "siliconflow",
      targetProfileId: "deepseek-compatible-chat@1" as const,
      sourceMessageCount: 0,
      pendingToolCallIds: [] as const,
      sourceFrontierDigest: `sha256:${"1".repeat(64)}` as const,
      handoffDigest: `sha256:${"2".repeat(64)}` as const,
      integrityDigest: `sha256:${"3".repeat(64)}` as const,
      reason: "model_control" as const,
      createdAt: "2026-08-24T18:00:00.000Z",
    };
    const merged = mergeConversationCompactionActorBinding({
      projected: {
        actorKey: "main",
        actorId: "actor-1",
        historyHeadGenerationId: "history-after-compaction",
        promptHeadGenerationId: "prompt-after-compaction",
        contextEpoch: 1,
      },
      live: {
        actorKey: "main",
        actorId: "actor-1",
        contextEpoch: 3,
        providerEpochReceipt: receipt,
      },
    });

    expect(merged).toMatchObject({
      historyHeadGenerationId: "history-after-compaction",
      promptHeadGenerationId: "prompt-after-compaction",
      contextEpoch: 3,
      providerEpochReceipt: receipt,
    });
  });

  it("projects history/prompt/session heads and deferred lineage slots from domain events", () => {
    const sessionId = "ses_projection";
    const events: ConversationDomainEvent[] = [
      { type: "local_conversation_session_created", sessionId, occurredAt: "2026-04-19T00:00:00.000Z" },
      {
        type: "local_conversation_session_actor_bound",
        sessionId,
        actorKey: "main",
        actorId: "actor-main",
        binding: {
          actorKey: "main",
          actorId: "actor-main",
          contextEpoch: 3,
          providerEpochReceipt: {
            schemaVersion: "provider.epoch-receipt/v1",
            sessionId,
            actorKey: "main",
            actorId: "actor-main",
            epoch: 3,
            targetProviderId: "siliconflow",
            targetProfileId: "deepseek-compatible-chat@1",
            sourceMessageCount: 0,
            pendingToolCallIds: [],
            sourceFrontierDigest: `sha256:${"a".repeat(64)}`,
            handoffDigest: `sha256:${"b".repeat(64)}`,
            integrityDigest: `sha256:${"c".repeat(64)}`,
            reason: "model_control",
            createdAt: "2026-04-19T00:00:00.000Z",
          },
        },
        occurredAt: "2026-04-19T00:00:00.000Z",
      },
      { type: "actor_history_generation_created", sessionId, actorKey: "main", generationId: "hist-1", occurredAt: "2026-04-19T00:00:01.000Z" },
      { type: "actor_history_head_moved", sessionId, actorKey: "main", activeGenerationId: "hist-1", occurredAt: "2026-04-19T00:00:02.000Z" },
      { type: "actor_prompt_generation_created", sessionId, actorKey: "main", promptGenerationId: "prompt-1", occurredAt: "2026-04-19T00:00:03.000Z" },
      { type: "actor_prompt_head_moved", sessionId, actorKey: "main", activePromptGenerationId: "prompt-1", occurredAt: "2026-04-19T00:00:04.000Z" },
      {
        type: "actor_history_generation_forked",
        sessionId,
        actorKey: "main",
        sourceGenerationId: "hist-1",
        forkGenerationId: "hist-2",
        branchLabel: "draft",
        occurredAt: "2026-04-19T00:00:05.000Z",
      },
      {
        type: "actor_history_generation_rolled_back",
        sessionId,
        actorKey: "main",
        fromGenerationId: "hist-2",
        toGenerationId: "hist-1",
        occurredAt: "2026-04-19T00:00:06.000Z",
      },
      {
        type: "local_conversation_session_lineage_updated",
        sessionId,
        parentSessionId: "ses_parent",
        forkedFromGenerationId: "hist-1",
        rolledBackFromSessionId: "ses_old",
        occurredAt: "2026-04-19T00:00:07.000Z",
      },
      { type: "local_conversation_context_asset_registered", sessionId, assetId: "asset-1", occurredAt: "2026-04-19T00:00:08.000Z" },
    ];

    const projection = reduceConversationDomainEvents(sessionId, events);

    expect(projection.historyIndex.heads.main?.activeGenerationId).toBe("hist-1");
    expect(projection.promptIndex.heads.main?.activePromptGenerationId).toBe("prompt-1");
    expect(projection.historyIndex.lineages["hist-1"]?.forkGenerationIds).toEqual(["hist-2"]);
    expect(projection.historyIndex.lineages["hist-1"]?.rolledBackFromGenerationId).toBe("hist-2");
    expect(projection.sessionIndex.lineage?.parentSessionId).toBe("ses_parent");
    expect(projection.sessionIndex.lineage?.forkedFromGenerationId).toBe("hist-1");
    expect(projection.sessionIndex.lineage?.rolledBackFromSessionId).toBe("ses_old");
    expect(projection.sessionIndex.session.contextAssetRegistry?.assetIds).toEqual(["asset-1"]);
    expect(projection.sessionIndex.session.actorBindings.main).toMatchObject({
      contextEpoch: 3,
      providerEpochReceipt: { targetProfileId: "deepseek-compatible-chat@1", epoch: 3 },
    });
  });

  it("creates an empty projection with reserved slots", () => {
    const projection = createEmptyConversationProjection("ses_empty");
    expect(projection.sessionIndex.session.contextAssetRegistry).toBeNull();
    expect(projection.sessionIndex.lineage).toBeNull();
  });
});
