import { link, mkdir, mkdtemp, copyFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { readRealSessionDurableHeads } from "../cell/packages/ai-file-store-logic/src/index";
import { runFileStoreAiRuntimeConcreteCheckpoint } from "../cell/packages/ai-runtime-control-composer/src/index";
import { LocalFileRuntimeSnapshotRepository } from "../cell/packages/ai-support/src/runtime/LocalFileRuntimeSnapshotRepository";
import type { RuntimeSnapshotPersistedState } from "../cell/packages/ai-core-contract/src/runtime/RuntimeSnapshotTypes";

export const CHECKPOINT_BENCHMARK_PHASES = [
  "readRealSessionDurableHeads",
  "writeSnapshot",
  "runFileStoreAiRuntimeConcreteCheckpoint",
] as const;

export type CheckpointBenchmarkPhase = typeof CHECKPOINT_BENCHMARK_PHASES[number];

export type CheckpointBenchmarkSample = {
  iteration: number;
  durationMs: number;
  status?: string;
};

export type CheckpointBenchmarkResult = {
  sessionDir: string;
  iterations: number;
  phases: Record<CheckpointBenchmarkPhase, CheckpointBenchmarkSample[]>;
};

type LoadedSnapshot = Awaited<ReturnType<LocalFileRuntimeSnapshotRepository["loadSnapshot"]>>;

function toPersistedState(loaded: NonNullable<LoadedSnapshot>): RuntimeSnapshotPersistedState {
  return {
    vm: loaded.vm,
    actors: loaded.actors,
    questionnaires: loaded.questionnaires,
    fibers: loaded.fibers,
    indexes: loaded.indexes,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfPresent(source: string, target: string): Promise<void> {
  if (!await pathExists(source)) return;
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function linkIfPresent(source: string, target: string): Promise<void> {
  if (!await pathExists(source)) return;
  await mkdir(path.dirname(target), { recursive: true });
  await link(source, target);
}

const SMALL_SESSION_METADATA_PATHS = [
  ["runtime_state", "manifest.json"],
  ["runtime_state", "vm.json"],
  ["snapshot", "manifest.json"],
  ["snapshot", "vm.json"],
  ["conversation", "history.index.json"],
  ["runtime-control", "effects.xnl"],
  ["runtime-control", "heads", "ingress_log.json"],
  ["runtime-control", "heads", "diagnostics_log.json"],
  ["runtime-control", "heads", "effect_evidence.json"],
] as const;

async function createSessionBenchmarkSandbox(sessionDir: string, prefix: string): Promise<string> {
  const sandboxDir = await mkdtemp(path.join(path.dirname(sessionDir), prefix));
  try {
    await Promise.all([
      linkIfPresent(path.join(sessionDir, "logs", "ingress.xnl"), path.join(sandboxDir, "logs", "ingress.xnl")),
      linkIfPresent(path.join(sessionDir, "logs", "diagnostics.xnl"), path.join(sandboxDir, "logs", "diagnostics.xnl")),
      ...SMALL_SESSION_METADATA_PATHS.map((segments) => copyIfPresent(
        path.join(sessionDir, ...segments),
        path.join(sandboxDir, ...segments),
      )),
    ]);
    return sandboxDir;
  } catch (error) {
    await rm(sandboxDir, { recursive: true, force: true });
    throw error;
  }
}

async function measure<T>(operation: () => Promise<T>): Promise<{ durationMs: number; value: T }> {
  const startedAt = performance.now();
  const value = await operation();
  return { durationMs: performance.now() - startedAt, value };
}

function emptyPhases(): CheckpointBenchmarkResult["phases"] {
  return {
    readRealSessionDurableHeads: [],
    writeSnapshot: [],
    runFileStoreAiRuntimeConcreteCheckpoint: [],
  };
}

export async function benchmarkSessionCheckpoint(input: {
  sessionDir: string;
  iterations?: number;
}): Promise<CheckpointBenchmarkResult> {
  const sessionDir = path.resolve(input.sessionDir);
  const iterations = input.iterations ?? 1;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("iterations must be a positive integer");
  }
  if (!await pathExists(sessionDir)) {
    throw new Error(`session directory does not exist: ${sessionDir}`);
  }

  const sourceRepository = new LocalFileRuntimeSnapshotRepository(path.join(sessionDir, "runtime_state"));
  const loaded = await sourceRepository.loadSnapshot();
  if (!loaded) {
    throw new Error(`runtime snapshot is missing or unreadable: ${path.join(sessionDir, "runtime_state")}`);
  }
  if (loaded.corruptions.length > 0) {
    throw new Error(`runtime snapshot has corruptions: ${loaded.corruptions.map((item) => item.path).join(", ")}`);
  }
  const persistedState = toPersistedState(loaded);
  const phases = emptyPhases();

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const headSandboxDir = await createSessionBenchmarkSandbox(sessionDir, ".eidolon-head-benchmark-");
    try {
      const headSample = await measure(() => readRealSessionDurableHeads(headSandboxDir));
      phases.readRealSessionDurableHeads.push({ iteration, durationMs: headSample.durationMs });
    } finally {
      await rm(headSandboxDir, { recursive: true, force: true });
    }

    const writeSandboxDir = await mkdtemp(path.join(path.dirname(sessionDir), ".eidolon-snapshot-benchmark-"));
    try {
      const writeRepository = new LocalFileRuntimeSnapshotRepository(path.join(writeSandboxDir, "runtime_state"));
      const writeSample = await measure(() => writeRepository.writeSnapshot(persistedState));
      phases.writeSnapshot.push({ iteration, durationMs: writeSample.durationMs });
    } finally {
      await rm(writeSandboxDir, { recursive: true, force: true });
    }

    const checkpointSandboxDir = await createSessionBenchmarkSandbox(
      sessionDir,
      ".eidolon-checkpoint-benchmark-",
    );
    try {
      const checkpointRepository = new LocalFileRuntimeSnapshotRepository(path.join(checkpointSandboxDir, "runtime_state"));
      const checkpointSample = await measure(() => runFileStoreAiRuntimeConcreteCheckpoint({
        sessionDir: checkpointSandboxDir,
        effectId: `checkpoint-benchmark-${process.pid}-${iteration}`,
        commandId: `checkpoint-benchmark-command-${process.pid}-${iteration}`,
        idempotencyKey: `checkpoint-benchmark:${process.pid}:${iteration}`,
        writeConcreteCheckpoint: async () => {
          const manifest = await checkpointRepository.writeSnapshot(persistedState);
          return { manifestVersion: manifest.version };
        },
      }));
      phases.runFileStoreAiRuntimeConcreteCheckpoint.push({
        iteration,
        durationMs: checkpointSample.durationMs,
        status: checkpointSample.value.status,
      });
    } finally {
      await rm(checkpointSandboxDir, { recursive: true, force: true });
    }
  }

  return { sessionDir, iterations, phases };
}

function mean(samples: CheckpointBenchmarkSample[]): number {
  return samples.reduce((total, sample) => total + sample.durationMs, 0) / samples.length;
}

export function formatCheckpointBenchmark(result: CheckpointBenchmarkResult): string {
  const lines = [
    `session: ${result.sessionDir}`,
    `iterations: ${result.iterations}`,
    "phase\titeration\tduration_ms\tstatus",
  ];
  for (const phase of CHECKPOINT_BENCHMARK_PHASES) {
    for (const sample of result.phases[phase]) {
      lines.push(`${phase}\t${sample.iteration}\t${sample.durationMs.toFixed(3)} ms\t${sample.status ?? "-"}`);
    }
    lines.push(`${phase}.mean\t-\t${mean(result.phases[phase]).toFixed(3)} ms\t-`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      session: { type: "string", short: "s" },
      iterations: { type: "string", short: "n", default: "1" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const sessionDir = parsed.values.session ?? parsed.positionals[0];
  if (!sessionDir) {
    throw new Error("usage: bun run benchmark:session-checkpoint -- --session <session-dir> [--iterations <n>] [--json]");
  }
  const iterations = Number(parsed.values.iterations);
  const result = await benchmarkSessionCheckpoint({ sessionDir, iterations });
  console.log(parsed.values.json ? JSON.stringify(result, null, 2) : formatCheckpointBenchmark(result));
}

if (import.meta.main) {
  await main();
}
