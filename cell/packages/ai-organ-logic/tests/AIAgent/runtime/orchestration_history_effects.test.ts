import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { getXnlDataUniqueChild, readXnlRecords } from "@cell/ai-file-store-logic";
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
  it("writes orchestration history into logs/orchestration_history.xnl", async () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    effects.appendEvent({
      stream: "detached_actor",
      kind: "detached_actor_done",
      payload: { task_id: "task-1", status: "completed" },
    });
    effects.appendEvent({
      stream: "runtime_hook_event",
      kind: "hook_dispatch_report",
      payload: {
        artifactId: "artifact-hook-report",
        mime: "application/json",
        bytes: 2048,
        sha256: "abc123",
      },
    });

    const target = path.join(sessionDir, "logs", "orchestration_history.xnl");
    expect(fs.existsSync(target)).toBe(true);
    const raw = fs.readFileSync(target, "utf8");

    const records = await readXnlRecords({ filePath: target, tag: "OrchestrationEvent" });
    expect(raw).not.toContain("<orchestration-history-event");
    expect(records).toHaveLength(2);
    expect(records.map((record) => [record.metadata.version, record.metadata.sequence, record.extend?.order])).toEqual([
      [1, 1, ["Payload"]],
      [1, 2, ["PayloadRef"]],
    ]);
    expect(typeof records[0].metadata.observedAt).toBe("number");
    expect(records[0].metadata.stream).toBe("detached_actor");
    expect(records[0].metadata.kind).toBe("detached_actor_done");
    expect(getXnlDataUniqueChild(records[0], "Payload")).toEqual(expect.objectContaining({
      kind: "data",
      tag: "Payload",
      attributes: {
        task_id: "task-1",
        status: "completed",
      },
    }));
    expect(getXnlDataUniqueChild(records[1], "PayloadRef")).toEqual(expect.objectContaining({
      kind: "data",
      tag: "PayloadRef",
      metadata: {
        artifactId: "artifact-hook-report",
        mime: "application/json",
        bytes: 2048,
        sha256: "abc123",
      },
      attributes: {},
    }));
    expect(fs.existsSync(path.join(sessionDir, "logs", "orchestration_history.jsonl"))).toBe(false);
  });

  it("backs up orchestration_history.xnl into backup/logs without recreating an empty stream", async () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const sourceDir = path.join(sessionDir, "logs");
    fs.mkdirSync(sourceDir, { recursive: true });
    const source = path.join(sourceDir, "orchestration_history.xnl");
    fs.writeFileSync(source, "existing", "utf-8");

    await effects.backupHistory();

    const backupDir = path.join(sessionDir, "backup", "logs");
    expect(fs.existsSync(backupDir)).toBe(true);
    const backupFiles = fs.readdirSync(backupDir);
    expect(backupFiles.length).toBe(1);
    expect(backupFiles[0]).toMatch(/^orchestration_history_\d{8}_\d{6}\.xnl$/);
    expect(fs.existsSync(source)).toBe(false);
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

    const target = path.join(sessionDir, "logs", "orchestration_history.xnl");
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

  it("serves the next sequence from an in-memory counter (no full-file reparse per append)", () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const target = path.join(sessionDir, "logs", "orchestration_history.xnl");

    // Seed the journal with a meaningful first event (this one-time seed may read the file).
    effects.appendEvent({
      stream: "detached_actor",
      kind: "detached_actor_done",
      payload: { task_id: "seed", status: "completed" },
    });

    // After seeding, instrument readFileSync: subsequent appends must NOT re-read the whole journal file.
    const originalReadFileSync = fs.readFileSync;
    const journalReads: string[] = [];
    (fs as any).readFileSync = ((p: any, ...rest: any[]) => {
      if (typeof p === "string" && p === target) {
        journalReads.push(p);
      }
      return (originalReadFileSync as any)(p, ...rest);
    }) as typeof fs.readFileSync;

    try {
      for (let i = 0; i < 5; i++) {
        effects.appendEvent({
          stream: "detached_actor",
          kind: "detached_actor_done",
          payload: { task_id: `t-${i}`, status: "completed" },
        });
      }
    } finally {
      (fs as any).readFileSync = originalReadFileSync;
    }

    expect(journalReads).toHaveLength(0);

    const raw = fs.readFileSync(target, "utf8");
    // Sequences must remain monotonic and gap-free across all appended events (1..6).
    const sequences = [...raw.matchAll(/sequence=["']?(\d+)/g)].map((m) => Number(m[1]));
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rotates the journal when it exceeds the size cap and retains only the most recent N segments", () => {
    const sessionDir = makeTempSessionDir();
    let clock = 0;
    const effects = new LocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
      maxJournalBytes: 256,
      maxJournalSegments: 2,
      now: () => new Date(2026, 0, 1, 0, 0, clock++),
    });

    const logsDir = path.join(sessionDir, "logs");
    const target = path.join(logsDir, "orchestration_history.xnl");

    // Append enough meaningful events to blow past the small cap several times.
    for (let i = 0; i < 60; i++) {
      effects.appendEvent({
        stream: "detached_actor",
        kind: "detached_actor_done",
        payload: { task_id: `task-${i}`, status: "completed", note: "padding-to-grow-the-journal" },
      });
    }

    // Active journal stays bounded under (roughly) the cap — it never grows unbounded.
    expect(fs.statSync(target).size).toBeLessThanOrEqual(256 * 4);

    // Rotated segments are kept to at most N (most recent).
    const segments = fs
      .readdirSync(logsDir)
      .filter((name) => /^orchestration_history_.*\.xnl$/.test(name) && name !== "orchestration_history.xnl");
    expect(segments.length).toBeLessThanOrEqual(2);
    expect(segments.length).toBeGreaterThan(0);
  });

  it("drops idle no-op hook_dispatch_report events while retaining meaningful events", () => {
    const sessionDir = makeTempSessionDir();
    const effects = new LocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    // Idle no-op: finalAction continue + elapsedMs 0 + no effects → dropped.
    effects.appendEvent({
      stream: "runtime_hook_event",
      kind: "hook_dispatch_report",
      payload: {
        eventType: "hook_dispatch_report",
        point: "actor.idle.before",
        finalAction: "continue",
        elapsedMs: 0,
        steps: [{ hookName: "noop", status: "matched", action: "continue" }],
      },
    });

    // Meaningful hook_dispatch_report: did real work (elapsedMs > 0) → retained.
    effects.appendEvent({
      stream: "runtime_hook_event",
      kind: "hook_dispatch_report",
      payload: {
        eventType: "hook_dispatch_report",
        point: "actor.idle.before",
        finalAction: "continue",
        elapsedMs: 12,
        steps: [{ hookName: "real", status: "matched", action: "continue" }],
      },
    });

    // Meaningful hook_dispatch_report: produced an effect → retained even with elapsedMs 0.
    effects.appendEvent({
      stream: "runtime_hook_event",
      kind: "hook_dispatch_report",
      payload: {
        eventType: "hook_dispatch_report",
        point: "actor.idle.before",
        finalAction: "continue",
        elapsedMs: 0,
        effects: [{ type: "resume_fiber" }],
      },
    });

    // Non-idle meaningful event → always retained.
    effects.appendEvent({
      stream: "detached_actor",
      kind: "detached_actor_done",
      payload: { task_id: "task-1", status: "completed" },
    });

    const target = path.join(sessionDir, "logs", "orchestration_history.xnl");
    const raw = fs.readFileSync(target, "utf8");
    const records = raw.split("\n").filter((line) => line.includes("OrchestrationEvent"));
    expect(records.length).toBe(3);
    expect(raw).toContain("detached_actor_done");
  });
});
