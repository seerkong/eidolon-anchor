import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LocalFileConversationPersistenceRepositoryFactory } from "../src/conversation/local/LocalFileConversationPersistenceRepository";

const roots: string[] = [];

function landingZone(): string {
  // Mirrors the `--ephemeral` shape: a random mkdtemp directory whose basename
  // is NOT the logical session key.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-exec-plan-0-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("conversation identity is not the physical landing zone", () => {
  test("records the explicit logical sessionId instead of the ephemeral directory name", async () => {
    const sessionDir = landingZone();
    const sessionKey = "plan-0";
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir, sessionKey);

    const index = await repository.loadSessionIndex();
    // The conversation identity must be the logical key, so the runtime (which
    // addresses actors by sessionId) and persistence agree on one conversation.
    expect(index.sessionId).toBe(sessionKey);
    expect(index.session.sessionId).toBe(sessionKey);
    // The landing zone remains the physical directory; identity must not leak
    // back into it.
    expect(index.sessionId).not.toBe(path.basename(sessionDir));
  });

  test("keeps the previous behaviour when no separate identity is supplied", async () => {
    const sessionDir = landingZone();
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);

    const index = await repository.loadSessionIndex();
    // Reading an on-disk session with no separate identity still derives from
    // the directory, preserving compatibility for existing callers.
    expect(index.sessionId).toBe(sessionDir);
  });

  test("two repositories over one landing zone share one identity", async () => {
    const sessionDir = landingZone();
    const sessionKey = "plan-0";
    const first = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir, sessionKey);
    const second = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir, sessionKey);
    await first.writeSessionIndex({
      ...(await first.loadSessionIndex()),
    });
    // Same landing zone + same logical identity must address one conversation.
    const a = await first.loadSessionIndex();
    const b = await second.loadSessionIndex();
    expect(a.sessionId).toBe(b.sessionId);
    expect(a.sessionId).toBe(sessionKey);
  });
});
