import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChatMessage, InputContentPart } from "@shared/composer";
import type { ActorHistoryGenerationData } from "@cell/ai-organ-contract";
import {
  fromCommittedConversationMessage,
  toCommittedConversationMessage,
} from "../src/conversation/local/LocalConversationRuntime";
import { LocalFileConversationPersistenceRepositoryFactory } from "../src/conversation/local/LocalFileConversationPersistenceRepository";

describe("structured input conversation persistence", () => {
  it("round-trips ordered text and image snapshots without a local path", () => {
    const content: InputContentPart[] = [
      { type: "text", text: "inspect " },
      {
        type: "image",
        mime: "image/png",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
        filename: "screen.png",
        sourceDigest: "sha256:example",
      },
    ];

    const committed = toCommittedConversationMessage({ role: "user", content });
    const recovered = fromCommittedConversationMessage(committed);

    expect(recovered.content).toEqual(content);
    expect(JSON.stringify(committed)).not.toContain("C:\\\\secret");
  });

  it("keeps legacy string messages unchanged", () => {
    const message: ChatMessage = { role: "user", content: "legacy input" };
    expect(fromCommittedConversationMessage(toCommittedConversationMessage(message)).content).toBe("legacy input");
  });

  it("persists structured content through the XNL history repository", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-structured-history-"));
    const content: InputContentPart[] = [
      { type: "text", text: "inspect " },
      {
        type: "image",
        mime: "image/png",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
        filename: "screen.png",
        sourceDigest: "sha256:example",
        size: 5,
      },
    ];
    const generation: ActorHistoryGenerationData = {
      version: 3,
      generationId: "main__active",
      sessionId: "session-structured-history",
      actorKey: "main",
      actorId: "actor-main",
      parentGenerationId: null,
      predecessorGenerationIds: [],
      createdReason: "append",
      sealed: false,
      messageCount: 1,
      messages: [{
        recordId: "main__active::0",
        actorKey: "main",
        actorId: "actor-main",
        committedAt: 1,
        message: { role: "user", content },
      }],
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };

    try {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
      await repository.writeHistoryGeneration(generation);
      const recovered = await repository.loadHistoryGeneration(generation.generationId);

      expect(recovered?.messages[0]?.message.content).toEqual(content);
      expect(fs.readFileSync(path.join(sessionDir, "conversation", "history.xnl"), "utf8"))
        .toContain("<StructuredContent");
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
