import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ConversationSessionIndexSnapshot,
  type LocalConversationContextAssetData,
  type LocalConversationContextResourceFact,
} from "@cell/ai-organ-contract";
import {
  createConversationDomainRuntime,
  upsertContextResourceFactToConversationDomainRuntime,
} from "@cell/ai-organ-logic";
import { LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support";

function makeResourceFact(): LocalConversationContextResourceFact {
  return {
    canonicalResourceId: "file:///workspace/docs/guide.md",
    revision: {
      algorithm: "sha256",
      digest: "a".repeat(64),
    },
    fragments: [
      {
        fragmentId: "lines-1-20",
        revisionDigest: "a".repeat(64),
        selection: {
          kind: "line_range",
          startLine: 1,
          endLine: 20,
        },
        contentDigest: {
          algorithm: "sha256",
          digest: "b".repeat(64),
        },
        observedAt: "2026-07-17T18:30:00.000Z",
      },
    ],
    deliveries: [
      {
        toolCallId: "tool-call-1",
        revisionDigest: "a".repeat(64),
        fragmentId: "lines-1-20",
        deliveredAt: "2026-07-17T18:31:00.000Z",
      },
    ],
    observedAt: "2026-07-17T18:30:00.000Z",
  };
}

function makeAsset(resourceFact?: LocalConversationContextResourceFact): LocalConversationContextAssetData {
  return {
    assetId: "asset-guide",
    kind: "workspace_file",
    label: "guide.md",
    source: {
      kind: "workspace_file",
      path: "/workspace/docs/guide.md",
    },
    ...(resourceFact ? { resourceFact } : {}),
    createdAt: "2026-07-17T18:30:00.000Z",
    updatedAt: "2026-07-17T18:31:00.000Z",
  };
}

function makeSessionIndex(asset: LocalConversationContextAssetData): ConversationSessionIndexSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId: "session-resource-facts",
    session: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "session-resource-facts",
      activeActorKey: "main",
      actorBindings: {},
      contextAssetRegistry: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        assetIds: [asset.assetId],
        updatedAt: asset.updatedAt,
      },
      contextAssets: [asset],
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    },
    lineage: null,
    updatedAt: asset.updatedAt,
  };
}

describe("conversation context resource facts", () => {
  it("upserts a tool-independent resource fact into the Session context asset owner", () => {
    const runtime = createConversationDomainRuntime();
    const resourceFact = makeResourceFact();
    const asset = makeAsset(resourceFact);

    upsertContextResourceFactToConversationDomainRuntime({
      runtime,
      sessionId: "session-resource-facts",
      asset,
      occurredAt: asset.updatedAt,
    });

    const stored = runtime.sessionStateSignal.get()["session-resource-facts"]?.contextAssets?.[0];
    expect(stored).toEqual(asset);
    expect(stored?.resourceFact).toEqual(resourceFact);
    expect(JSON.stringify(stored?.resourceFact)).not.toContain("Skill");
    expect(JSON.stringify(stored?.resourceFact)).not.toContain("toolName");
    expect(runtime.sessionEvents.at(-1)).toEqual(expect.objectContaining({
      type: "local_conversation_context_asset_registered",
      sessionId: "session-resource-facts",
      assetId: "asset-guide",
      asset,
    }));
  });

  it("round-trips resource facts through existing conversation session persistence", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-context-resource-facts-"));
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    const sessionIndex = makeSessionIndex(makeAsset(makeResourceFact()));

    await repository.writeSessionIndex(sessionIndex);

    expect(await repository.loadSessionIndex()).toEqual(sessionIndex);
  });

  it("loads legacy context assets that omit resource facts", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-legacy-context-asset-"));
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    const legacySessionIndex = makeSessionIndex(makeAsset());

    await repository.writeSessionIndex(legacySessionIndex);

    const restoredAsset = (await repository.loadSessionIndex()).session.contextAssets?.[0];
    expect(restoredAsset).toEqual(makeAsset());
    expect(restoredAsset?.resourceFact).toBeUndefined();
  });
});
