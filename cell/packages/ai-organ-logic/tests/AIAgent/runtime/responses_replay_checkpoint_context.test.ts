import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createConversationDomainRuntime,
  setConversationDomainPersistHooks,
  upsertResponsesReplayCheckpointToConversationDomainRuntime,
} from "@cell/ai-organ-logic";
import {
  createResponsesContextDigest,
  createResponsesMessageFrontier,
  createResponsesProviderOutputSnapshot,
  createResponsesReplayCheckpoint,
} from "@cell/ai-organ-logic/llm";
import {
  loadConversationActorRawState,
  loadConversationSessionRawState,
  LocalFileConversationPersistenceRepositoryFactory,
  materializeConversationRuntimePrompt,
  materializeConversationVisibleHistory,
} from "@cell/ai-support";

const occurredAt = "2026-07-18T18:00:00.000Z";

function checkpoint(responseId: string) {
  const messages = [{ role: "user", content: "archive it" }];
  return createResponsesReplayCheckpoint({
    actorId: "actor-main",
    providerId: "openai",
    model: "gpt-5.5",
    baselineEpoch: 4,
    contextDigest: createResponsesContextDigest({
      providerId: "openai",
      model: "gpt-5.5",
      instructions: ["stable system"],
      tools: [],
      dynamicContext: [],
    }),
    messageFrontier: createResponsesMessageFrontier(messages),
    requestKind: "stateless_replay",
    requestInput: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "archive it" }],
    }],
    output: createResponsesProviderOutputSnapshot({
      responseId,
      items: [{
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "done" }],
      }],
    }),
  });
}

describe("Conversation-owned Responses replay checkpoint", () => {
  it("round-trips a replaceable non-authoritative checkpoint without materializing it as History", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-responses-checkpoint-"));
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
    const runtime = createConversationDomainRuntime();
    const writes: Promise<void>[] = [];
    setConversationDomainPersistHooks(runtime, {
      session: () => {
        const session = runtime.sessionStateSignal.get()[path.basename(sessionDir)];
        if (session) writes.push(repository.writeSessionIndex(session.sessionIndex));
      },
    });

    try {
      const sessionId = path.basename(sessionDir);
      const firstAssetId = upsertResponsesReplayCheckpointToConversationDomainRuntime({
        runtime,
        sessionId,
        actorKey: "main",
        checkpoint: checkpoint("resp-1"),
        occurredAt,
      });
      const secondAssetId = upsertResponsesReplayCheckpointToConversationDomainRuntime({
        runtime,
        sessionId,
        actorKey: "main",
        checkpoint: checkpoint("resp-2"),
        occurredAt: "2026-07-18T18:01:00.000Z",
      });
      await Promise.all(writes);

      expect(secondAssetId).toBe(firstAssetId);
      expect(runtime.sessionStateSignal.get()[sessionId]?.contextAssets).toHaveLength(1);

      const recovered = await loadConversationSessionRawState({ sessionDir, repository });
      expect(recovered.contextAssets).toHaveLength(1);
      expect(recovered.contextAssets?.[0]?.replayCheckpoint).toEqual(checkpoint("resp-2"));

      const actorState = await loadConversationActorRawState({
        sessionDir,
        actorKey: "main",
        repository,
      });
      if (actorState) {
        expect(materializeConversationRuntimePrompt(actorState)).toEqual([]);
        expect(materializeConversationVisibleHistory(actorState)).toEqual([]);
      }
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
