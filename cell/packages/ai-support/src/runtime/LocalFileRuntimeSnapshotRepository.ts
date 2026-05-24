import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildActorTranscriptDirName } from "@cell/ai-core-contract/runtime/ActorTranscript";
import type { RuntimeSnapshotRepositoryFactory } from "@cell/ai-core-contract/runtime/RuntimeSnapshotStore";
import {
  RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  type RuntimeSnapshotActor,
  type RuntimeSnapshotCorruption,
  type RuntimeSnapshotFiber,
  type RuntimeSnapshotIndex,
  type RuntimeSnapshotIndexName,
  type RuntimeSnapshotIndexes,
  type RuntimeSnapshotLoadResult,
  type RuntimeSnapshotManifest,
  type RuntimeSnapshotPersistedState,
  type RuntimeSnapshotVm,
} from "@cell/ai-core-logic/runtime/snapshot";

const MANIFEST_FILE = "manifest.json";
const VM_FILE = "vm.json";
const ACTORS_DIR = path.posix.join("..", "actors");
const FIBERS_DIR = "fibers";
const INDEXES_DIR = "indexes";

const INDEX_FILE_NAMES: Record<RuntimeSnapshotIndexName, string> = {
  actors_by_key: "actors_by_key.json",
  actors_by_id: "actors_by_id.json",
  fibers_by_id: "fibers_by_id.json",
};

function encodeFileSegment(value: string): string {
  return encodeURIComponent(value);
}

function buildActorFile(actor: Pick<RuntimeSnapshotActor, "key" | "id" | "type" | "identity">): string {
  return path.posix.join(ACTORS_DIR, buildActorTranscriptDirName({
    agentKey: actor.key,
    actorId: actor.id,
    actorType: actor.type,
    identity: actor.identity,
  }), "actor.json");
}

function buildActorSiblingFile(actorFile: string, name: "state.json" | "mailboxes.json"): string {
  return path.posix.join(path.posix.dirname(actorFile), name);
}

function buildFiberFile(fiberId: string): string {
  return path.posix.join(FIBERS_DIR, `${encodeFileSegment(fiberId)}.json`);
}

function buildIndexFile(name: RuntimeSnapshotIndexName): string {
  return path.posix.join(INDEXES_DIR, INDEX_FILE_NAMES[name]);
}

function toAbsolute(rootDir: string, relativeFile: string): string {
  return path.join(rootDir, relativeFile);
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await ensureParentDir(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(tempPath, data, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function readJsonFileBestEffort<T>(
  filePath: string,
  corruptions: RuntimeSnapshotCorruption[],
): Promise<T | null> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (error) {
    corruptions.push({
      path: filePath,
      reason: error instanceof Error ? error.message : "unknown read error",
    });
    return null;
  }
}

function failUnsupportedSnapshot(reason: string): never {
  throw new Error(`unsupported_runtime_snapshot: ${reason}`);
}

function assertCurrentSnapshotVersion(value: unknown, pathLabel: string): void {
  if (value !== RUNTIME_SNAPSHOT_SCHEMA_VERSION) {
    failUnsupportedSnapshot(`${pathLabel} must use version=${RUNTIME_SNAPSHOT_SCHEMA_VERSION}`);
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string" && entry.length > 0);
}

function assertCurrentManifestShape(manifest: RuntimeSnapshotManifest): void {
  assertCurrentSnapshotVersion(manifest.version, MANIFEST_FILE);
  if (typeof manifest.vmFile !== "string" || manifest.vmFile.length === 0) {
    failUnsupportedSnapshot("manifest.vmFile is required");
  }
  if (!isStringRecord(manifest.actorFiles)) {
    failUnsupportedSnapshot("manifest.actorFiles is required");
  }
  if (!isStringRecord(manifest.fiberFiles ?? {})) {
    failUnsupportedSnapshot("manifest.fiberFiles must be an object map");
  }
  if (!Array.isArray(manifest.indexFiles) || !manifest.indexFiles.every((entry) => typeof entry === "string" && entry.length > 0)) {
    failUnsupportedSnapshot("manifest.indexFiles must be a string array");
  }
}

function buildIndexes(input: {
  actors: Record<string, RuntimeSnapshotActor>;
  fibers: Record<string, RuntimeSnapshotFiber>;
}): RuntimeSnapshotIndexes {
  const actorsByKey: Record<string, string> = {};
  const actorsById: Record<string, string> = {};
  const fibersById: Record<string, string> = {};

  for (const [actorKey, actor] of Object.entries(input.actors)) {
    const relativeFile = buildActorFile(actor);
    actorsByKey[actorKey] = relativeFile;
    actorsById[actor.id] = relativeFile;
  }

  for (const fiberId of Object.keys(input.fibers)) {
    fibersById[fiberId] = buildFiberFile(fiberId);
  }

  return {
    actors_by_key: {
      schemaVersion: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      kind: "actors_by_key",
      entries: actorsByKey,
    },
    actors_by_id: {
      schemaVersion: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      kind: "actors_by_id",
      entries: actorsById,
    },
    fibers_by_id: {
      schemaVersion: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      kind: "fibers_by_id",
      entries: fibersById,
    },
  };
}

export class LocalFileRuntimeSnapshotRepository {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  get manifestPath(): string {
    return toAbsolute(this.rootDir, MANIFEST_FILE);
  }

  get vmPath(): string {
    return toAbsolute(this.rootDir, VM_FILE);
  }

  actorPath(actor: Pick<RuntimeSnapshotActor, "key" | "id" | "type" | "identity">): string {
    return toAbsolute(this.rootDir, buildActorFile(actor));
  }

  fiberPath(fiberId: string): string {
    return toAbsolute(this.rootDir, buildFiberFile(fiberId));
  }

  indexPath(name: RuntimeSnapshotIndexName): string {
    return toAbsolute(this.rootDir, buildIndexFile(name));
  }

  async writeManifest(manifest: RuntimeSnapshotManifest): Promise<void> {
    await writeJsonAtomically(this.manifestPath, manifest);
  }

  async readManifest(): Promise<RuntimeSnapshotManifest | null> {
    try {
      return await readJsonFile<RuntimeSnapshotManifest>(this.manifestPath);
    } catch {
      return null;
    }
  }

  async writeVm(vm: RuntimeSnapshotVm): Promise<void> {
    await writeJsonAtomically(this.vmPath, vm);
  }

  async readVm(): Promise<RuntimeSnapshotVm | null> {
    try {
      return await readJsonFile<RuntimeSnapshotVm>(this.vmPath);
    } catch {
      return null;
    }
  }

  private splitActorSnapshot(actor: RuntimeSnapshotActor): {
    actorMeta: Record<string, unknown>;
    actorState: Record<string, unknown>;
    actorMailboxes: Record<string, unknown>;
  } {
    return {
      actorMeta: {
        version: actor.version,
        key: actor.key,
        id: actor.id,
        type: actor.type,
        parentKey: actor.parentKey,
        systemPrompts: actor.systemPrompts,
        identity: actor.identity,
        toolPolicy: actor.toolPolicy,
        modelConfig: actor.modelConfig,
        ctrlOptions: actor.ctrlOptions,
      },
      actorState: {
        version: actor.version,
        planApproval: actor.planApproval,
        shutdownCoordination: actor.shutdownCoordination,
        taskTree: actor.taskTree,
        toolCallStreamState: actor.toolCallStreamState,
        pendingQuestionnaires: actor.pendingQuestionnaires,
        lastMemberResultNotifiedAt: actor.lastMemberResultNotifiedAt,
        detachedTask: actor.detachedTask,
        holonState: actor.holonState,
        updatedAt: actor.updatedAt,
        recovery: actor.recovery,
      },
      actorMailboxes: {
        version: actor.version,
        mailboxes: actor.mailboxes,
        updatedAt: actor.updatedAt,
      },
    };
  }

  private async readActorSnapshotFromPath(relativeFile: string, corruptions: RuntimeSnapshotCorruption[]): Promise<RuntimeSnapshotActor | null> {
    const actorPath = toAbsolute(this.rootDir, relativeFile);
    const actorJson = await readJsonFileBestEffort<Record<string, any>>(actorPath, corruptions);
    if (!actorJson) return null;

    if (actorJson.mailboxes || actorJson.taskTree || actorJson.messages) {
      failUnsupportedSnapshot(`invalid actor metadata shape at ${relativeFile}`);
    }
    assertCurrentSnapshotVersion(actorJson.version, relativeFile);

    const statePath = toAbsolute(this.rootDir, buildActorSiblingFile(relativeFile, "state.json"));
    const mailboxesPath = toAbsolute(this.rootDir, buildActorSiblingFile(relativeFile, "mailboxes.json"));
    const stateJson = await readJsonFileBestEffort<Record<string, any>>(statePath, corruptions);
    const mailboxesJson = await readJsonFileBestEffort<Record<string, any>>(mailboxesPath, corruptions);
    if (!stateJson || !mailboxesJson) return null;
    assertCurrentSnapshotVersion(stateJson.version, buildActorSiblingFile(relativeFile, "state.json"));
    assertCurrentSnapshotVersion(mailboxesJson.version, buildActorSiblingFile(relativeFile, "mailboxes.json"));
    return {
      version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      key: String(actorJson.key ?? ""),
      id: String(actorJson.id ?? ""),
      type: actorJson.type,
      parentKey: actorJson.parentKey,
      systemPrompts: Array.isArray(actorJson.systemPrompts) ? actorJson.systemPrompts : [],
      identity: actorJson.identity,
      planApproval: stateJson.planApproval,
      shutdownCoordination: stateJson.shutdownCoordination,
      toolPolicy: actorJson.toolPolicy ?? {
        allowedTools: [],
        enabledToolKeys: [],
        disabledToolKeys: [],
        computedDisabledTools: [],
      },
      modelConfig: actorJson.modelConfig ?? {},
      ctrlOptions: actorJson.ctrlOptions ?? {
        stopAfterFirstTool: false,
        stopAfterTools: [],
        exitAfterToolResult: false,
      },
      taskTree: stateJson.taskTree,
      mailboxes: mailboxesJson.mailboxes ?? {
        control: [],
        childDone: [],
        coordination: [],
        memberInbox: [],
        humanInput: [],
        toolResult: [],
        aiGenerated: [],
      },
      toolCallStreamState: stateJson.toolCallStreamState ?? { toolCalls: [] },
      pendingQuestionnaires: stateJson.pendingQuestionnaires ?? {},
      lastMemberResultNotifiedAt: stateJson.lastMemberResultNotifiedAt,
      detachedTask: stateJson.detachedTask,
      holonState: stateJson.holonState,
      updatedAt:
        typeof stateJson.updatedAt === "string"
          ? stateJson.updatedAt
          : typeof mailboxesJson.updatedAt === "string"
            ? mailboxesJson.updatedAt
            : undefined,
      recovery: stateJson.recovery,
    };
  }

  async writeActor(actor: RuntimeSnapshotActor): Promise<void> {
    const relativeFile = buildActorFile(actor);
    const actorPath = toAbsolute(this.rootDir, relativeFile);
    const statePath = toAbsolute(this.rootDir, buildActorSiblingFile(relativeFile, "state.json"));
    const mailboxesPath = toAbsolute(this.rootDir, buildActorSiblingFile(relativeFile, "mailboxes.json"));
    const { actorMeta, actorState, actorMailboxes } = this.splitActorSnapshot(actor);
    await writeJsonAtomically(actorPath, actorMeta);
    await writeJsonAtomically(statePath, actorState);
    await writeJsonAtomically(mailboxesPath, actorMailboxes);
  }

  async writeFiber(fiber: RuntimeSnapshotFiber): Promise<void> {
    await writeJsonAtomically(this.fiberPath(fiber.fiberId), fiber);
  }

  async readFiber(fiberId: string): Promise<RuntimeSnapshotFiber | null> {
    try {
      return await readJsonFile<RuntimeSnapshotFiber>(this.fiberPath(fiberId));
    } catch {
      return null;
    }
  }

  async writeIndex(indexValue: RuntimeSnapshotIndex): Promise<void> {
    await writeJsonAtomically(this.indexPath(indexValue.kind), indexValue);
  }

  async readIndex(name: RuntimeSnapshotIndexName): Promise<RuntimeSnapshotIndex | null> {
    try {
      return await readJsonFile<RuntimeSnapshotIndex>(this.indexPath(name));
    } catch {
      return null;
    }
  }

  async writeSnapshot(input: RuntimeSnapshotPersistedState): Promise<RuntimeSnapshotManifest> {
    await mkdir(this.rootDir, { recursive: true });

    const fibers = { ...(input.fibers ?? {}) };
    const indexes = { ...buildIndexes({ actors: input.actors, fibers }), ...(input.indexes ?? {}) };
    const nowIso = new Date().toISOString();

    const actorFiles: Record<string, string> = {};
    for (const [actorKey, actor] of Object.entries(input.actors)) {
      const relativeFile = buildActorFile(actor);
      actorFiles[actorKey] = relativeFile;
      await this.writeActor(actor);
    }

    const fiberFiles: Record<string, string> = {};
    for (const [fiberId, fiber] of Object.entries(fibers)) {
      const relativeFile = buildFiberFile(fiberId);
      fiberFiles[fiberId] = relativeFile;
      await this.writeFiber(fiber);
    }

    for (const [name, indexValue] of Object.entries(indexes) as Array<[RuntimeSnapshotIndexName, RuntimeSnapshotIndex]>) {
      await this.writeIndex({ ...indexValue, kind: name } as RuntimeSnapshotIndex);
    }

    await this.writeVm(input.vm);

    const manifest: RuntimeSnapshotManifest = {
      version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      controlActorKey: input.vm.controlActorKey,
      createdAt: nowIso,
      updatedAt: nowIso,
      actorKeys: Object.keys(actorFiles),
      fiberIds: Object.keys(fiberFiles),
      indexFiles: [buildIndexFile("actors_by_key"), buildIndexFile("actors_by_id"), buildIndexFile("fibers_by_id")],
      vmFile: VM_FILE,
      actorFiles,
      fiberFiles,
      savedAt: Date.now(),
    };

    await this.writeManifest(manifest);
    return manifest;
  }

  async loadSnapshot(): Promise<RuntimeSnapshotLoadResult | null> {
    const corruptions: RuntimeSnapshotCorruption[] = [];
    const manifest = await this.readManifest();
    if (!manifest) {
      return null;
    }
    assertCurrentManifestShape(manifest);

    const vm = await readJsonFileBestEffort<RuntimeSnapshotVm>(toAbsolute(this.rootDir, manifest.vmFile), corruptions);
    if (!vm) {
      return null;
    }
    assertCurrentSnapshotVersion(vm.version, manifest.vmFile);

    const indexes = {} as Partial<RuntimeSnapshotIndexes>;
    for (const relativeFile of manifest.indexFiles) {
      const fileName = path.posix.basename(relativeFile) as typeof INDEX_FILE_NAMES[RuntimeSnapshotIndexName];
      const name = (Object.entries(INDEX_FILE_NAMES).find(([, value]) => value === fileName)?.[0] ?? null) as RuntimeSnapshotIndexName | null;
      if (!name) continue;
      const indexValue = await readJsonFileBestEffort<RuntimeSnapshotIndex>(toAbsolute(this.rootDir, relativeFile), corruptions);
      if (indexValue) {
        assertCurrentSnapshotVersion((indexValue as { schemaVersion?: unknown }).schemaVersion, relativeFile);
        (indexes as Record<string, RuntimeSnapshotIndex>)[name] = indexValue as RuntimeSnapshotIndexes[typeof name];
      }
    }

    const actors: Record<string, RuntimeSnapshotActor> = {};
    for (const [actorKey, relativeFile] of Object.entries(manifest.actorFiles)) {
      const actor = await this.readActorSnapshotFromPath(relativeFile, corruptions);
      if (actor) {
        actors[actorKey] = actor;
      }
    }

    const fibers: Record<string, RuntimeSnapshotFiber> = {};
    for (const [fiberId, relativeFile] of Object.entries(manifest.fiberFiles ?? {})) {
      const fiber = await readJsonFileBestEffort<RuntimeSnapshotFiber>(toAbsolute(this.rootDir, relativeFile), corruptions);
      if (fiber) {
        assertCurrentSnapshotVersion(fiber.version, relativeFile);
        fiber.version = RUNTIME_SNAPSHOT_SCHEMA_VERSION;
        fibers[fiberId] = fiber;
      }
    }

    return {
      manifest,
      vm,
      actors,
      fibers,
      indexes,
      corruptions,
    };
  }
}

function getSnapshotRootDir(sessionDir: string): string {
  return path.join(sessionDir, "runtime_state");
}

export const LocalFileRuntimeSnapshotRepositoryFactory: RuntimeSnapshotRepositoryFactory<
  RuntimeSnapshotPersistedState,
  RuntimeSnapshotManifest,
  RuntimeSnapshotLoadResult
> = {
  createRuntimeSnapshotRepository(sessionDir) {
    return new LocalFileRuntimeSnapshotRepository(getSnapshotRootDir(sessionDir));
  },
};
