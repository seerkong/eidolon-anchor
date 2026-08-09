import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RUNTIME_SNAPSHOT_SCHEMA_VERSION } from "../cell/packages/ai-core-logic/src/runtime/snapshot";
import { LocalFileRuntimeSnapshotRepository } from "../cell/packages/ai-support/src/runtime/LocalFileRuntimeSnapshotRepository";
import {
  CHECKPOINT_BENCHMARK_PHASES,
  benchmarkSessionCheckpoint,
  formatCheckpointBenchmark,
} from "./benchmark-session-checkpoint";

const tempDirs: string[] = [];

async function createSessionFixture(): Promise<string> {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "eidolon-checkpoint-benchmark-test-"));
  tempDirs.push(fixtureDir);
  const sessionDir = path.join(fixtureDir, "session");
  await mkdir(path.join(sessionDir, "logs"), { recursive: true });
  await mkdir(path.join(sessionDir, "runtime-control"), { recursive: true });
  await mkdir(path.join(sessionDir, "conversation"), { recursive: true });
  await writeFile(
    path.join(sessionDir, "logs", "ingress.xnl"),
    "<IngressEvent sequence=1 observedAt=1786158887785 [  ]>\n",
    "utf8",
  );
  await writeFile(
    path.join(sessionDir, "logs", "diagnostics.xnl"),
    "<DiagnosticEvent sequence=1 emittedAt=1786158887900 [  ]>\n",
    "utf8",
  );
  await writeFile(path.join(sessionDir, "runtime-control", "effects.xnl"), "", "utf8");
  await writeFile(
    path.join(sessionDir, "conversation", "history.index.json"),
    JSON.stringify({ updatedAt: "2026-08-08T00:00:00.000Z" }),
    "utf8",
  );

  const repository = new LocalFileRuntimeSnapshotRepository(path.join(sessionDir, "runtime_state"));
  await repository.writeSnapshot({
    vm: {
      version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      controlActorKey: "main",
      sessionState: { controlSignals: { pending: {}, consumedTombstones: {} } },
    } as any,
    actors: {},
    questionnaires: [],
    fibers: {},
  });
  return sessionDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("session checkpoint benchmark", () => {
  it("reports all checkpoint phases in milliseconds without mutating the source session", async () => {
    const sessionDir = await createSessionFixture();
    const journalPaths = [
      path.join(sessionDir, "logs", "ingress.xnl"),
      path.join(sessionDir, "logs", "diagnostics.xnl"),
      path.join(sessionDir, "runtime-control", "effects.xnl"),
    ];
    const journalsBefore = await Promise.all(journalPaths.map(async (filePath) => ({
      content: await readFile(filePath),
      stats: await stat(filePath),
    })));
    const headsDir = path.join(sessionDir, "runtime-control", "heads");
    expect(existsSync(headsDir)).toBe(false);

    const result = await benchmarkSessionCheckpoint({ sessionDir });
    const output = formatCheckpointBenchmark(result);

    expect(Object.keys(result.phases)).toEqual(CHECKPOINT_BENCHMARK_PHASES);
    for (const phase of CHECKPOINT_BENCHMARK_PHASES) {
      expect(result.phases[phase]).toHaveLength(1);
      expect(result.phases[phase][0]?.durationMs).toBeGreaterThanOrEqual(0);
      expect(output).toContain(`${phase}\t1\t`);
    }
    expect(output).toContain(" ms");
    expect(result.phases.runFileStoreAiRuntimeConcreteCheckpoint[0]?.status).toBe("committed");
    expect(existsSync(headsDir)).toBe(false);
    for (const [index, filePath] of journalPaths.entries()) {
      const before = journalsBefore[index]!;
      const after = await stat(filePath);
      expect(await readFile(filePath)).toEqual(before.content);
      expect(after.size).toBe(before.stats.size);
      expect(after.mtimeMs).toBe(before.stats.mtimeMs);
    }
    expect(await readdir(path.dirname(sessionDir))).toEqual(["session"]);
  });
});
