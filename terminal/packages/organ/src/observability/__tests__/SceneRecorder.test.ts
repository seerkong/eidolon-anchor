import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { SceneStore } from "../SceneStore";
import { SceneRecorder } from "../SceneRecorder";
import type { SceneManifest } from "../SceneTypes";

const testRoot = tmpdir() + "/scene-recorder-test-" + Date.now();

describe("SceneRecorder", () => {
  beforeAll(async () => {
    await fsp.mkdir(testRoot, { recursive: true });
  });

  afterAll(async () => {
    await fsp.rm(testRoot, { recursive: true, force: true });
  });

  it("startSession writes manifest", async () => {
    const store = new SceneStore(testRoot);
    const recorder = new SceneRecorder({ store, sessionId: "rec_ses_1" });

    const manifest: SceneManifest = {
      sessionId: "rec_ses_1",
      createdAt: 1705000000,
      systemPrompt: "You are a recorder test.",
      toolDefs: [],
    };

    await recorder.startSession(manifest);
    const loaded = await store.loadManifest("rec_ses_1");
    expect(loaded).not.toBeNull();
    expect(loaded!.systemPrompt).toBe("You are a recorder test.");
  });

  it("recordUserMessage appends a user message", async () => {
    const store = new SceneStore(testRoot);
    const recorder = new SceneRecorder({ store, sessionId: "rec_ses_2" });

    await recorder.recordUserMessage("Hello, agent!");
    const msgs = await store.loadMessages("rec_ses_2");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].textParts).toEqual(["Hello, agent!"]);
  });

  it("recordAssistantMessage appends with tool calls", async () => {
    const store = new SceneStore(testRoot);
    const recorder = new SceneRecorder({ store, sessionId: "rec_ses_3" });

    await recorder.recordAssistantMessage("Done.", [
      { id: "tc_1", name: "bash", args: { command: "ls" } },
    ]);
    const msgs = await store.loadMessages("rec_ses_3");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].toolCalls).toBeDefined();
    expect(msgs[0].toolCalls![0].name).toBe("bash");
  });

  it("multiple turns form a sequence", async () => {
    const store = new SceneStore(testRoot);
    const recorder = new SceneRecorder({ store, sessionId: "rec_ses_4" });

    await recorder.recordUserMessage("q1");
    await recorder.recordAssistantMessage("a1");
    await recorder.recordUserMessage("q2");
    await recorder.recordAssistantMessage("a2");

    const msgs = await store.loadMessages("rec_ses_4");
    expect(msgs).toHaveLength(4);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].role).toBe("user");
    expect(msgs[3].role).toBe("assistant");
  });
});
