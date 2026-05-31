import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SceneStore } from "../SceneStore";
import type { SceneManifest, SceneMessage } from "../SceneTypes";

const testRoot = path.join(tmpdir(), "scene-store-test-" + Date.now());

describe("SceneStore", () => {
  beforeAll(async () => {
    await fsp.mkdir(testRoot, { recursive: true });
  });

  afterAll(async () => {
    await fsp.rm(testRoot, { recursive: true, force: true });
  });

  // ── manifest ─────────────────────────

  it("saves and loads a manifest", async () => {
    const store = new SceneStore(testRoot);
    const manifest: SceneManifest = {
      sessionId: "ses_test",
      createdAt: 1705000000,
      systemPrompt: "You are a helpful assistant.",
      toolDefs: [
        { name: "read", description: "Read a file" },
        { name: "bash", description: "Run a command" },
      ],
    };

    await store.saveManifest("ses_test", manifest);
    const loaded = await store.loadManifest("ses_test");

    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe("ses_test");
    expect(loaded!.systemPrompt).toBe("You are a helpful assistant.");
    expect(loaded!.toolDefs).toHaveLength(2);
    expect(loaded!.toolDefs[0].name).toBe("read");
  });

  it("returns null for missing manifest", async () => {
    const store = new SceneStore(testRoot);
    const loaded = await store.loadManifest("nonexistent");
    expect(loaded).toBeNull();
  });

  // ── events append ────────────────────

  it("appends and loads messages", async () => {
    const store = new SceneStore(testRoot);
    const sid = "ses_append_test";

    const msg1: SceneMessage = { id: "msg_1", role: "user", textParts: ["hello"] };
    const msg2: SceneMessage = { id: "msg_2", role: "assistant", textParts: ["hi there!"] };

    await store.appendMessage(sid, msg1);
    await store.appendMessage(sid, msg2);

    const loaded = await store.loadMessages(sid);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].role).toBe("user");
    expect(loaded[0].textParts).toEqual(["hello"]);
    expect(loaded[1].role).toBe("assistant");
    expect(loaded[1].textParts).toEqual(["hi there!"]);
  });

  it("loadEvents returns empty array for non-existent file", async () => {
    const store = new SceneStore(testRoot);
    const nodes = await store.loadEvents("ses_no_events");
    expect(nodes).toEqual([]);
  });

  // ── full scene ───────────────────────

  it("loadScene returns manifest and messages", async () => {
    const store = new SceneStore(testRoot);
    const sid = "ses_full";

    await store.saveManifest(sid, {
      sessionId: sid,
      createdAt: 1,
      systemPrompt: "sp",
      toolDefs: [],
    });
    await store.appendMessage(sid, { id: "a", role: "user", textParts: ["q"] });
    await store.appendMessage(sid, { id: "b", role: "assistant", textParts: ["a"] });

    const scene = await store.loadScene(sid);
    expect(scene.manifest).not.toBeNull();
    expect(scene.messages).toHaveLength(2);
  });

  // ── list sessions ────────────────────

  it("lists session directories", async () => {
    const store = new SceneStore(testRoot);
    await store.saveManifest("ses_a", {
      sessionId: "ses_a",
      createdAt: 1,
      systemPrompt: "",
      toolDefs: [],
    });
    await store.saveManifest("ses_b", {
      sessionId: "ses_b",
      createdAt: 1,
      systemPrompt: "",
      toolDefs: [],
    });

    const sessions = await store.listSessions();
    expect(sessions).toContain("ses_a");
    expect(sessions).toContain("ses_b");
  });

  // ── xnl roundtrip ────────────────────

  it("manifest file is valid xnl parseable", async () => {
    const store = new SceneStore(testRoot);
    const sid = "ses_roundtrip";

    await store.saveManifest(sid, {
      sessionId: sid,
      createdAt: 99,
      systemPrompt: "test prompt",
      toolDefs: [{ name: "t1", description: "desc1" }],
    });

    // Verify the file exists and parse it directly
    const filePath = path.join(testRoot, "scenes", sid, "manifest.xnl");
    const raw = await fsp.readFile(filePath, "utf8");
    expect(raw).toContain("<SceneManifest");
    expect(raw).toContain("sessionId=");
    expect(raw).toContain("test prompt");
  });

  it("events file is valid xnl parseable", async () => {
    const store = new SceneStore(testRoot);
    const sid = "ses_events_roundtrip";

    await store.appendMessage(sid, { id: "x1", role: "user", textParts: ["hi"] });
    await store.appendMessage(sid, { id: "x2", role: "assistant", textParts: ["hello"] });

    const filePath = path.join(testRoot, "scenes", sid, "events.xnl");
    const raw = await fsp.readFile(filePath, "utf8");
    expect(raw).toContain("<Message");
    expect(raw).toContain(`role="user"`);
    expect(raw).toContain("hi");
  });
});
