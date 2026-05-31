import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { SceneStore } from "../SceneStore";
import { SceneReplay } from "../SceneReplay";
import type { SceneManifest } from "../SceneTypes";

const testRoot = tmpdir() + "/scene-replay-test-" + Date.now();

describe("SceneReplay", () => {
  beforeAll(async () => {
    await fsp.mkdir(testRoot, { recursive: true });
  });

  afterAll(async () => {
    await fsp.rm(testRoot, { recursive: true, force: true });
  });

  it("loadTurns pairs user→assistant messages", async () => {
    const store = new SceneStore(testRoot);
    const sid = "rep_ses_1";

    const manifest: SceneManifest = {
      sessionId: sid,
      createdAt: 1,
      systemPrompt: "sp",
      toolDefs: [],
    };
    await store.saveManifest(sid, manifest);
    await store.appendMessage(sid, { id: "m1", role: "user", textParts: ["hello"] });
    await store.appendMessage(sid, { id: "m2", role: "assistant", textParts: ["hi"] });
    await store.appendMessage(sid, { id: "m3", role: "user", textParts: ["how are you"] });
    await store.appendMessage(sid, { id: "m4", role: "assistant", textParts: ["good"] });

    const replay = new SceneReplay({ store });
    const { manifest: loadedManifest, turns } = await replay.loadTurns(sid);

    expect(loadedManifest).not.toBeNull();
    expect(loadedManifest!.sessionId).toBe(sid);
    expect(turns).toHaveLength(2);
    expect(turns[0].userMessage.textParts).toEqual(["hello"]);
    expect(turns[0].recordedAssistant!.textParts).toEqual(["hi"]);
    expect(turns[1].userMessage.textParts).toEqual(["how are you"]);
  });

  it("loadTurns handles user message without assistant reply", async () => {
    const store = new SceneStore(testRoot);
    const sid = "rep_ses_2";

    await store.saveManifest(sid, { sessionId: sid, createdAt: 1, systemPrompt: "", toolDefs: [] });
    await store.appendMessage(sid, { id: "m1", role: "user", textParts: ["unanswered"] });

    const replay = new SceneReplay({ store });
    const { turns } = await replay.loadTurns(sid);

    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage.textParts).toEqual(["unanswered"]);
    expect(turns[0].recordedAssistant).toBeNull();
  });

  it("diff detects match and mismatch", () => {
    const replay = new SceneReplay({ store: null as any });

    const match = replay.diff("hello", "hello");
    expect(match.match).toBe(true);

    const mismatch = replay.diff("hello", "world");
    expect(mismatch.match).toBe(false);
    expect(mismatch.recordedText).toBe("hello");
    expect(mismatch.replayedText).toBe("world");
  });

  it("empty session produces empty turns", async () => {
    const store = new SceneStore(testRoot);
    const sid = "rep_ses_empty";

    const replay = new SceneReplay({ store });
    const { turns } = await replay.loadTurns(sid);
    expect(turns).toEqual([]);
  });
});
