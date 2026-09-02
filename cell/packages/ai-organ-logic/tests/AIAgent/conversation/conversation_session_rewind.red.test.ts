import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ActorHistoryGenerationData,
  ActorPromptGenerationData,
  ConversationForkAuthoritySnapshot,
  ConversationSessionRewindCommand,
} from "@cell/ai-organ-contract";
import {
  createProviderEpochReceiptV2,
  digestProviderContextClosedValue,
  digestProviderContextHistoryFrontier,
  createConversationSessionRewindPort,
  planConversationSessionRewind,
} from "@cell/ai-organ-logic";
import {
  LocalFileConversationPersistenceRepository,
  LocalFileConversationPersistenceRepositoryFactory,
  loadConversationActorRawState,
} from "@cell/ai-support";

const occurredAt = "2026-09-02T00:00:00.000Z";

function committed(recordId: string, messageId: string, role: string, content: string, extra = {}) {
  return {
    recordId,
    actorKey: "main",
    actorId: "actor-main",
    committedAt: 1,
    message: { messageId, role, content, ...extra },
  };
}

function snapshot(messages = [
  committed("record-a", "message-a", "user", "A"),
  committed("record-b", "message-b", "assistant", "B"),
  committed("record-c", "message-c", "user", "C"),
]): ConversationForkAuthoritySnapshot {
  const history: ActorHistoryGenerationData = {
    version: 1,
    generationId: "history-current",
    sessionId: "session",
    actorKey: "main",
    actorId: "actor-main",
    parentGenerationId: null,
    predecessorGenerationIds: [],
    createdReason: "append",
    sealed: false,
    messageCount: messages.length,
    messages,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const prompt: ActorPromptGenerationData = {
    version: 1,
    promptGenerationId: "prompt-current",
    sessionId: "session",
    actorKey: "main",
    actorId: "actor-main",
    basedOnPromptGenerationId: null,
    basis: {
      version: 1,
      basisHistoryGenerationIds: [history.generationId],
      basisMessageRecordIds: [],
      basisRefs: [{ refKind: "history_generation", refId: history.generationId }],
    },
    transforms: [],
    createdReason: "request_build",
    materializedContext: "stable prefix",
    sealed: false,
    createdAt: occurredAt,
    sealedAt: null,
    updatedAt: occurredAt,
  };
  const empty = digestProviderContextClosedValue([]);
  const receipt = createProviderEpochReceiptV2({
    sessionId: "session",
    actorKey: "main",
    actorId: "actor-main",
    epoch: 4,
    previousReceiptDigest: empty,
    targetProviderId: "deepseek-iqingwa",
    targetModelId: "deepseek-v4-pro",
    targetProfileId: "deepseek-chat@1",
    baselineHeads: {
      historyHeadGenerationId: history.generationId,
      promptHeadGenerationId: prompt.promptGenerationId,
      factHeadDigest: null,
    },
    sourceHistoryMessageCount: messages.length,
    sourceFrontierDigest: digestProviderContextHistoryFrontier(messages),
    pendingDeliveryDigest: empty,
    handoffDigest: empty,
    frozenResourceDigest: empty,
    providerSurfaceDigest: empty,
    retentionPolicy: { maxRevisionsPerNamespace: 8, maxCanonicalFactBytesPerEpoch: 262_144 },
    reason: "initial_projection",
    compactionProofDigest: null,
    createdAt: occurredAt,
  });
  return {
    historyIndex: {
      version: 1,
      sessionId: "session",
      heads: { main: { version: 1, sessionId: "session", actorKey: "main", actorId: "actor-main", activeGenerationId: history.generationId, visibleGenerationIds: [history.generationId], updatedAt: occurredAt } },
      lineages: { [history.generationId]: { version: 1, sessionId: "session", actorKey: "main", actorId: "actor-main", generationId: history.generationId, parentGenerationId: null, rolledBackFromGenerationId: null, predecessorGenerationIds: [], successorGenerationIds: [], forkGenerationIds: [], branchLabel: null, updatedAt: occurredAt } },
      generations: { [history.generationId]: { generationId: history.generationId, actorKey: "main", actorId: "actor-main", sealed: false, createdAt: occurredAt, updatedAt: occurredAt } },
      updatedAt: occurredAt,
    },
    promptIndex: {
      version: 1,
      sessionId: "session",
      heads: { main: { version: 1, sessionId: "session", actorKey: "main", actorId: "actor-main", activePromptGenerationId: prompt.promptGenerationId, updatedAt: occurredAt } },
      generations: { [prompt.promptGenerationId]: { promptGenerationId: prompt.promptGenerationId, actorKey: "main", actorId: "actor-main", sealed: false, createdAt: occurredAt, updatedAt: occurredAt } },
      updatedAt: occurredAt,
    },
    sessionIndex: {
      version: 1,
      sessionId: "session",
      session: {
        version: 1,
        sessionId: "session",
        activeActorKey: "main",
        actorBindings: { main: { actorKey: "main", actorId: "actor-main", historyHeadGenerationId: history.generationId, promptHeadGenerationId: prompt.promptGenerationId, contextEpoch: receipt.epoch, providerEpochReceiptV2: receipt, providerRequestAdmissions: [] } },
        contextAssetRegistry: null,
        contextAssets: [],
        activeSelection: { sessionId: "session", activeActorKey: "main", historyHeadGenerationId: history.generationId, promptHeadGenerationId: prompt.promptGenerationId, selectedAt: occurredAt },
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
      lineage: null,
      updatedAt: occurredAt,
    },
    artifactRefs: { version: 1, sessionId: "session", refs: [], updatedAt: occurredAt },
    historyGenerations: [history],
    promptGenerations: [prompt],
  };
}

function command(messageId: string): ConversationSessionRewindCommand {
  return {
    schemaVersion: "conversation.session-rewind-command/v1",
    sessionId: "session",
    actorKey: "main",
    selector: { kind: "through_committed_message", messageId },
    expectedSourceAuthorityDigest: null,
    occurredAt: "2026-09-02T00:01:00.000Z",
  };
}

describe("Conversation-native session rewind", () => {
  it("plans an atomic rollback frontier and provider epoch successor", () => {
    const result = planConversationSessionRewind({ command: command("message-a"), source: snapshot() });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    const binding = result.transition.sessionIndex.session.actorBindings.main!;
    expect(result.transition.historyGenerations.at(-1)).toMatchObject({
      createdReason: "rollback",
      messageCount: 1,
      messages: [{ recordId: "record-a" }],
    });
    expect(result.transition.historyIndex.lineages[result.receipt.nextHeads.historyHeadGenerationId])
      .toMatchObject({ rolledBackFromGenerationId: "history-current", branchLabel: "rewind" });
    expect(binding.providerEpochReceiptV2).toMatchObject({
      epoch: 5,
      previousReceiptDigest: result.receipt.previousProviderEpochReceiptDigest,
      reason: "history_rewind_or_fork",
    });
    expect(binding.providerRequestAdmissions).toEqual([]);
  });

  it("clears actor-owned provider facts, delivery state and replay checkpoints", () => {
    const source = snapshot();
    source.sessionIndex.session.contextAssets = [{
      assetId: "stable-workspace-resource",
      kind: "workspace_file",
      source: { kind: "workspace_file", path: "/workspace/AGENTS.md" },
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }, {
      assetId: "main-provider-fact",
      kind: "note",
      source: { kind: "note", ownerId: "main" },
      providerContextFact: { actorKey: "main" } as never,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }, {
      assetId: "main-pending-tool-delivery",
      kind: "note",
      source: { kind: "note", ownerId: "main" },
      toolResultDeliveryFact: { actorKey: "main" } as never,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }, {
      assetId: "main-replay-checkpoint",
      kind: "note",
      source: { kind: "note", ownerId: "main" },
      replayCheckpoint: { baselineEpoch: 4 } as never,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }, {
      assetId: "other-actor-replay-checkpoint",
      kind: "note",
      source: { kind: "note", ownerId: "reviewer" },
      replayCheckpoint: { baselineEpoch: 2 } as never,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }];
    source.sessionIndex.session.contextAssetRegistry = {
      version: 1,
      assetIds: source.sessionIndex.session.contextAssets.map((asset) => asset.assetId),
      updatedAt: occurredAt,
    };

    const result = planConversationSessionRewind({ command: command("message-a"), source });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    const assetIds = result.transition.sessionIndex.session.contextAssets?.map((asset) => asset.assetId);
    expect(assetIds).toEqual(["stable-workspace-resource", "other-actor-replay-checkpoint"]);
    expect(result.transition.sessionIndex.session.contextAssetRegistry?.assetIds).toEqual(assetIds);
  });

  it("rejects an unknown message without producing a transition", () => {
    expect(planConversationSessionRewind({ command: command("missing"), source: snapshot() }))
      .toMatchObject({ status: "rejected", rejection: { code: "MESSAGE_NOT_FOUND" } });
  });

  it("rejects a cutoff that leaves an assistant tool call open", () => {
    const source = snapshot([
      committed("record-a", "message-a", "user", "A"),
      committed("record-call", "message-call", "assistant", "", { toolCalls: [{ id: "call-1", name: "Read", input: {} }] }),
      committed("record-result", "message-result", "tool", "ok", { toolCallId: "call-1" }),
    ]);
    expect(planConversationSessionRewind({ command: command("message-call"), source }))
      .toMatchObject({ status: "rejected", rejection: { code: "TOOL_PAIR_BOUNDARY_OPEN" } });
  });

  it("rebases active-tail Prompt message provenance without retaining future History", () => {
    const source = snapshot();
    source.promptGenerations[0]!.basis.basisMessageRecordIds = ["record-c"];
    const result = planConversationSessionRewind({ command: command("message-a"), source });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.receipt.proof.promptProofMode).toBe("active_tail_rebase");
    expect(result.transition.promptGenerations[0]?.basis.basisMessageRecordIds).toEqual([]);
  });

  it("rejects a Prompt transform that depends on unreachable future authority", () => {
    const source = snapshot();
    source.promptGenerations[0]!.transforms = [{
      transformId: "future-transform",
      kind: "micro_compact",
      payload: { sourceHistoryGenerationId: "future-history", targetHistoryGenerationId: "history-current" },
      appliedAt: occurredAt,
    }];
    expect(planConversationSessionRewind({ command: command("message-a"), source }))
      .toMatchObject({ status: "rejected", rejection: { code: "PROMPT_STATE_UNPROVABLE" } });
  });

  it("commits through the existing transition transaction and is fresh-restart visible", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-rewind-"));
    const sessionDir = path.join(root, "session");
    const source = snapshot();
    const repository = new LocalFileConversationPersistenceRepository(sessionDir);
    try {
      for (const generation of source.historyGenerations) await repository.writeHistoryGeneration(generation);
      for (const generation of source.promptGenerations) await repository.writePromptGeneration(generation);
      await repository.writeHistoryIndex(source.historyIndex);
      await repository.writePromptIndex(source.promptIndex);
      await repository.writeArtifactRefs(source.artifactRefs);
      await repository.writeSessionIndex(source.sessionIndex);

      const port = createConversationSessionRewindPort({
        owner: { sessionId: "session", actorKey: "main", actorId: "actor-main" },
        repositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
        resolveSessionDir: () => sessionDir,
        runExclusive: async (_sessionId, action) => await action(),
      });
      const result = await port.rewind(command("message-a"));
      expect(result.status).toBe("committed");

      const freshRepository = new LocalFileConversationPersistenceRepository(sessionDir);
      const fresh = await loadConversationActorRawState({
        sessionDir,
        actorKey: "main",
        repository: freshRepository,
      });
      expect(fresh?.activeHistoryGeneration?.createdReason).toBe("rollback");
      expect(fresh?.activeHistoryGeneration?.messages.map((entry) => entry.message.content)).toEqual(["A"]);
      expect(fresh?.session.actorBindings.main?.providerEpochReceiptV2?.reason).toBe("history_rewind_or_fork");
      expect(fresh?.session.actorBindings.main?.providerRequestAdmissions).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
