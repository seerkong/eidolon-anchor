import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { LocalFileOrchestrationHistoryEffects } from "@cell/ai-support";

function makeTempSessionDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `eidolon-orch-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("LocalFileOrchestrationHistoryEffects", () => {
  it("writes orchestration history into logs/orchestration_history.jsonl", () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    effects.appendEvent({
      stream: "detached_actor",
      kind: "detached_actor_done",
      payload: { task_id: "task-1", status: "completed" },
    });

    const target = path.join(sessionDir, "logs", "orchestration_history.jsonl");
    expect(fs.existsSync(target)).toBe(true);

    const lines = fs.readFileSync(target, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const payload = JSON.parse(lines[0]);
    expect(typeof payload.ts).toBe("string");
    expect(payload.stream).toBe("detached_actor");
    expect(payload.kind).toBe("detached_actor_done");
    expect(payload.task_id).toBe("task-1");
  });

  it("backs up orchestration_history.jsonl into backup/logs and recreates an empty file", async () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const sourceDir = path.join(sessionDir, "logs");
    fs.mkdirSync(sourceDir, { recursive: true });
    const source = path.join(sourceDir, "orchestration_history.jsonl");
    fs.writeFileSync(source, "existing", "utf-8");

    await effects.backupHistory();

    const backupDir = path.join(sessionDir, "backup", "logs");
    expect(fs.existsSync(backupDir)).toBe(true);
    const backupFiles = fs.readdirSync(backupDir);
    expect(backupFiles.length).toBe(1);
    expect(backupFiles[0]).toMatch(/^orchestration_history_\d{8}_\d{6}\.jsonl$/);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readFileSync(source, "utf-8")).toBe("");
  });

  it("does not read removed root orchestration_history.txt on next write", () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const removedPath = path.join(sessionDir, "orchestration_history.txt");
    fs.writeFileSync(removedPath, "removed", "utf-8");

    effects.appendEvent({
      stream: "detached_actor",
      kind: "detached_actor_done",
      payload: { task_id: "task-1", status: "completed" },
    });

    const target = path.join(sessionDir, "logs", "orchestration_history.jsonl");
    expect(fs.existsSync(removedPath)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("is best-effort: append/backup do not throw when session path is unavailable", async () => {
    const effects = new LocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => null,
    });

    expect(() => {
      effects.appendEvent({
        stream: "detached_actor",
        kind: "detached_actor_done",
        payload: { task_id: "task-1", status: "completed" },
      });
    }).not.toThrow();

    await expect(effects.backupHistory()).resolves.toBeUndefined();
  });
});
