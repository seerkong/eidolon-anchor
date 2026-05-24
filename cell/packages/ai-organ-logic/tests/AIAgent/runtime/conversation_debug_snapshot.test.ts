import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorPromptGenerationData,
} from "@cell/ai-organ-contract";
import {
  loadConversationDebugSnapshot,
} from "@cell/ai-organ-logic";
import { LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support";

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-conversation-debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("conversation debug snapshot", () => {
  it("loads actor heads, lineage slots, prompt transforms, and context asset ids from persistence", async () => {
    const sessionDir = makeTempSessionDir();
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);

    const historyIndex = await repository.loadHistoryIndex();
    historyIndex.heads.main = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      activeGenerationId: "hist-1",
      visibleGenerationIds: ["hist-1", "hist-0"],
      updatedAt: new Date(2).toISOString(),
    };
    historyIndex.lineages["hist-1"] = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      generationId: "hist-1",
      parentGenerationId: "hist-0",
      rolledBackFromGenerationId: null,
      predecessorGenerationIds: ["hist-0"],
      successorGenerationIds: ["hist-2"],
      forkGenerationIds: ["hist-branch-1"],
      branchLabel: "main",
      updatedAt: new Date(2).toISOString(),
    };
    await repository.writeHistoryIndex(historyIndex);

    const promptGeneration: ActorPromptGenerationData = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      promptGenerationId: "prompt-1",
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      basedOnPromptGenerationId: null,
      basis: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        basisHistoryGenerationIds: ["hist-1"],
        basisMessageRecordIds: [],
      },
      transforms: [
        {
          transformId: "transform-1",
          kind: "history_compaction_summary",
          payload: { summary: "<state_snapshot />" },
          appliedAt: new Date(3).toISOString(),
        },
        {
          transformId: "transform-2",
          kind: "context_asset_attach",
          payload: { assetId: "asset-1" },
          appliedAt: new Date(4).toISOString(),
        },
      ],
      materializedContext: "<state_snapshot />",
      sealed: false,
      createdAt: new Date(3).toISOString(),
      updatedAt: new Date(4).toISOString(),
    };
    await repository.writePromptGeneration(promptGeneration);

    const promptIndex = await repository.loadPromptIndex();
    promptIndex.heads.main = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "ses_1",
      actorKey: "main",
      actorId: "actor-main",
      activePromptGenerationId: "prompt-1",
      updatedAt: new Date(4).toISOString(),
    };
    promptIndex.generations["prompt-1"] = {
      promptGenerationId: "prompt-1",
      actorKey: "main",
      actorId: "actor-main",
      sealed: false,
      createdAt: promptGeneration.createdAt,
      updatedAt: promptGeneration.updatedAt,
    };
    await repository.writePromptIndex(promptIndex);

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
      updatedAt: new Date(5).toISOString(),
    };
    sessionIndex.lineage = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "ses_1",
      parentSessionId: "ses-parent",
      forkedFromGenerationId: "hist-0",
      rolledBackFromSessionId: null,
      predecessorSessionIds: ["ses-parent"],
      forkSessionIds: ["ses-branch"],
      updatedAt: new Date(5).toISOString(),
    };
    await repository.writeSessionIndex(sessionIndex);

    const debug = await loadConversationDebugSnapshot(repository);
    expect(debug.activeActorKey).toBe("main");
    expect(debug.actors.main?.activeHistoryGenerationId).toBe("hist-1");
    expect(debug.actors.main?.activePromptGenerationId).toBe("prompt-1");
    expect(debug.actors.main?.forkGenerationIds).toEqual(["hist-branch-1"]);
    expect(debug.actors.main?.promptTransformKinds).toEqual(["history_compaction_summary", "context_asset_attach"]);
    expect(debug.actors.main?.contextAssetIds).toEqual(["asset-1"]);
    expect(debug.forkSessionIds).toEqual(["ses-branch"]);
  });
});
