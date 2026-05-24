import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { LocalFileMessageHistoryEffects } from "@cell/ai-support";
import { StreamTranscript } from "@cell/symbiont-logic/stream/StreamTranscript";

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-msg-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("LocalFileMessageHistoryEffects", () => {
  it("writes primary-actor transcript into actor-scoped directory", () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    effects.appendMessage({
      stream: "content",
      payload: "hello",
      agentKey: "main",
      agentActorId: "actor-main",
      actorType: "primary",
    });

    const target = path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt");
    expect(fs.existsSync(target)).toBe(true);

    const parsed = StreamTranscript.parse(fs.readFileSync(target, "utf-8"));
    expect(parsed.delimiter).toBe("----");
    expect(parsed.records.length).toBe(1);
    expect(parsed.records[0].stream).toBe("content");
    expect(parsed.records[0].payload).toBe("hello");
    expect(parsed.records[0].marker).toBeTruthy();

    const historyIndexPath = path.join(sessionDir, "conversation", "history.index.json");
    const sessionIndexPath = path.join(sessionDir, "conversation", "session.index.json");
    const generationPath = path.join(sessionDir, "conversation", "history-generations", "main__active.json");
    expect(fs.existsSync(historyIndexPath)).toBe(true);
    expect(fs.existsSync(sessionIndexPath)).toBe(true);
    expect(fs.existsSync(generationPath)).toBe(true);

    const historyIndex = JSON.parse(fs.readFileSync(historyIndexPath, "utf-8"));
    const generation = JSON.parse(fs.readFileSync(generationPath, "utf-8"));
    expect(historyIndex.heads.main.activeGenerationId).toBe("main__active");
    expect(generation.messages).toHaveLength(1);
    expect(generation.messages[0].message.role).toBe("assistant");
    expect(generation.messages[0].message.content).toBe("hello");
    expect(generation.messages[0].message.startAt).toBeUndefined();
    expect(generation.messages[0].message.endAt).toBeUndefined();
    expect(generation.messages[0].sourceRecords).toEqual([{ stream: "content", payload: "hello" }]);
  });

  it("persists per-message start/end timestamps into formal history generation files", () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    effects.appendMessage({
      stream: "content",
      payload: "hello world",
      startAt: 100,
      endAt: 130,
      agentKey: "main",
      agentActorId: "actor-main",
      actorType: "primary",
    });

    const generationPath = path.join(sessionDir, "conversation", "history-generations", "main__active.json");
    const generation = JSON.parse(fs.readFileSync(generationPath, "utf-8"));

    expect(generation.messages).toHaveLength(1);
    expect(generation.messages[0].message.startAt).toBe(100);
    expect(generation.messages[0].message.endAt).toBe(130);
    expect(generation.messages[0].committedAt).toBe(130);
    expect(generation.messages[0].sourceRecords).toEqual([
      {
        stream: "content",
        payload: "hello world",
        startAt: 100,
        endAt: 130,
      },
    ]);
  });

  it("writes delegate records into actor-scoped transcript and appends", () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    effects.appendMessage({
      stream: "user_input",
      payload: "p1",
      agentKey: "travel_plan",
      agentActorId: "sub-123",
      actorType: "delegate",
      agentName: "travel_plan",
    });
    effects.appendMessage({
      stream: "confirm_result",
      payload: '{"response":"yes"}',
      agentKey: "travel_plan",
      agentActorId: "sub-123",
      actorType: "delegate",
      agentName: "travel_plan",
    });

    const target = path.join(sessionDir, "actors", "delegate__agent__travel_plan__sub-123", "transcript.txt");
    expect(fs.existsSync(target)).toBe(true);

    const parsed = StreamTranscript.parse(fs.readFileSync(target, "utf-8"));
    expect(parsed.delimiter).toBe("----");
    expect(parsed.records.length).toBe(2);
    expect(parsed.records[0].stream).toBe("user_input");
    expect(parsed.records[0].payload).toBe("p1");
    expect(parsed.records[1].stream).toBe("confirm_result");
    expect(parsed.records[1].payload).toBe('{"response":"yes"}');
  });

  it("writes member records into member-scoped transcript path", () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    effects.appendMessage({
      stream: "content",
      payload: "team hello",
      agentKey: "member:alice",
      agentActorId: "actor-member-1",
      actorType: "delegate",
      memberName: "Alice",
    });

    const target = path.join(sessionDir, "actors", "delegate__member__Alice__actor-member-1", "transcript.txt");
    expect(fs.existsSync(target)).toBe(true);

    const parsed = StreamTranscript.parse(fs.readFileSync(target, "utf-8"));
    expect(parsed.records.length).toBe(1);
    expect(parsed.records[0].payload).toBe("team hello");
  });

  it("can skip formal conversation history persistence while still appending transcript evidence", () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    effects.appendMessage({
      stream: "user_input",
      payload: "<state_snapshot />",
      agentKey: "main",
      agentActorId: "actor-main",
      actorType: "primary",
      persistConversationHistory: false,
    });

    const transcriptPath = path.join(sessionDir, "actors", "primary__actor-main", "transcript.txt");
    const historyIndexPath = path.join(sessionDir, "conversation", "history.index.json");
    const generationPath = path.join(sessionDir, "conversation", "history-generations", "main__active.json");

    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(fs.existsSync(historyIndexPath)).toBe(false);
    expect(fs.existsSync(generationPath)).toBe(false);

    const parsed = StreamTranscript.parse(fs.readFileSync(transcriptPath, "utf-8"));
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].payload).toBe("<state_snapshot />");
  });

  it("backs up member-scoped delegate history into matching backup directory", async () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const sourceDir = path.join(sessionDir, "actors", "delegate__member__Alice__actor-member-1");
    fs.mkdirSync(sourceDir, { recursive: true });
    const source = path.join(sourceDir, "transcript.txt");
    fs.writeFileSync(source, "member history", "utf-8");

    await effects.backupHistory({
      agentKey: "member:alice",
      agentActorId: "actor-member-1",
      actorType: "delegate",
      memberName: "Alice",
    });

    const backupDir = path.join(sessionDir, "backup", "actors", "delegate__member__Alice__actor-member-1");
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.readdirSync(backupDir).length).toBe(1);
  });

  it("backs up main-agent history into backup directory with timestamped name", async () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const sourceDir = path.join(sessionDir, "actors", "primary__actor-main");
    fs.mkdirSync(sourceDir, { recursive: true });
    const source = path.join(sourceDir, "transcript.txt");
    fs.writeFileSync(source, "main history", "utf-8");

    await effects.backupHistory({
      agentKey: "main",
      agentActorId: "actor-main",
      actorType: "primary",
    });

    const backupDir = path.join(sessionDir, "backup", "actors", "primary__actor-main");
    const backupFiles = fs.readdirSync(backupDir);
    expect(backupFiles.length).toBe(1);
    expect(backupFiles[0]).toMatch(/^transcript_\d{8}_\d{6}\.txt$/);
  });

  it("creates backup directory automatically when missing", async () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const sourceDir = path.join(sessionDir, "actors", "delegate__agent__trip__actor-1");
    fs.mkdirSync(sourceDir, { recursive: true });
    const source = path.join(sourceDir, "transcript.txt");
    fs.writeFileSync(source, "sub history", "utf-8");

    const backupDir = path.join(sessionDir, "backup", "actors", "delegate__agent__trip__actor-1");
    expect(fs.existsSync(backupDir)).toBe(false);

    await effects.backupHistory({
      agentKey: "trip",
      agentActorId: "actor-1",
      actorType: "delegate",
      agentName: "trip",
    });

    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.readdirSync(backupDir).length).toBe(1);
  });

  it("recreates an empty source file after backup", async () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const sourceDir = path.join(sessionDir, "actors", "delegate__agent__planner__actor-7");
    fs.mkdirSync(sourceDir, { recursive: true });
    const source = path.join(sourceDir, "transcript.txt");
    fs.writeFileSync(source, "existing content", "utf-8");

    await effects.backupHistory({
      agentKey: "planner",
      agentActorId: "actor-7",
      actorType: "delegate",
      agentName: "planner",
    });

    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readFileSync(source, "utf-8")).toBe("");
  });

  it("does not throw when source file does not exist", async () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    await expect(
      effects.backupHistory({
        agentKey: "missing",
        agentActorId: "none",
      })
    ).resolves.toBeUndefined();
  });

  it("does not throw and logs warning when backup IO fails", async () => {
    const sessionDir = makeTempSessionDir();
    const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
    const effects = new LocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
      log: (level, message, context) => logs.push({ level, message, context }),
    });

    const sourceDir = path.join(sessionDir, "actors", "primary__actor-main");
    fs.mkdirSync(sourceDir, { recursive: true });
    const source = path.join(sourceDir, "transcript.txt");
    fs.writeFileSync(source, "main history", "utf-8");

    const originalRenameSync = fs.renameSync;
    fs.renameSync = (() => {
      throw new Error("mock rename error");
    }) as typeof fs.renameSync;

    try {
        await expect(
        effects.backupHistory({
          agentKey: "main",
          agentActorId: "actor-main",
          actorType: "primary",
        })
      ).resolves.toBeUndefined();
    } finally {
      fs.renameSync = originalRenameSync;
    }

    expect(logs.some((line) => line.level === "warn" && line.message === "message history backup failed")).toBe(true);
  });
});
