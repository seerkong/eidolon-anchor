import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  CoordinationRecordsIndexSnapshot,
  DetachedActorsIndexSnapshot,
  MemberRosterIndexSnapshot,
  RuntimeDerivedIndexes,
  RuntimeDerivedIndexesStore,
} from "@cell/ai-organ-contract/persistence/RuntimeDerivedIndexes";
import { RUNTIME_SNAPSHOT_SCHEMA_VERSION } from "@cell/ai-core-logic/runtime/snapshot";

const INDEX_DIR = "indexes";
const MEMBER_ROSTER_FILE = path.posix.join(INDEX_DIR, "memberRoster.json");
const DETACHED_ACTORS_FILE = path.posix.join(INDEX_DIR, "detachedActors.json");
const COORDINATION_RECORDS_FILE = path.posix.join(INDEX_DIR, "coordinationRecords.json");

function getSnapshotRootDir(sessionDir: string): string {
  return path.join(sessionDir, "runtime_state");
}

function getDerivedIndexPaths(sessionDir: string): Record<keyof RuntimeDerivedIndexes, string> {
  const rootDir = getSnapshotRootDir(sessionDir);
  return {
    memberRoster: path.join(rootDir, MEMBER_ROSTER_FILE),
    detachedActors: path.join(rootDir, DETACHED_ACTORS_FILE),
    coordinationRecords: path.join(rootDir, COORDINATION_RECORDS_FILE),
  };
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJsonBestEffort<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const LocalFileRuntimeDerivedIndexesStore: RuntimeDerivedIndexesStore = {
  async load(params) {
    const paths = getDerivedIndexPaths(params.sessionDir);
    return {
      memberRoster: await (async () => {
        const fallback: MemberRosterIndexSnapshot = {
          version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          members: [],
          updatedAt: new Date(0).toISOString(),
        };
        return await readJsonBestEffort<MemberRosterIndexSnapshot>(paths.memberRoster, fallback);
      })(),
      detachedActors: await (async () => {
        const fallback: DetachedActorsIndexSnapshot = {
          version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          tasks: [],
          updatedAt: new Date(0).toISOString(),
        };
        return await readJsonBestEffort<DetachedActorsIndexSnapshot>(paths.detachedActors, fallback);
      })(),
      coordinationRecords: await readJsonBestEffort<CoordinationRecordsIndexSnapshot>(paths.coordinationRecords, {
        version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
        records: [],
        updatedAt: new Date(0).toISOString(),
      }),
    };
  },

  async write(params) {
    const paths = getDerivedIndexPaths(params.sessionDir);
    await writeJsonAtomically(paths.memberRoster, params.indexes.memberRoster);
    await writeJsonAtomically(paths.detachedActors, params.indexes.detachedActors);
    await writeJsonAtomically(paths.coordinationRecords, params.indexes.coordinationRecords);
  },
};
