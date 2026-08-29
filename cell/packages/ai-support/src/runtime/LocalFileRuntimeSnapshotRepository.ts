import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildActorDirName } from "@cell/ai-core-contract/runtime/ActorDirectory";
import type { RuntimeSnapshotRepositoryFactory } from "@cell/ai-core-contract/runtime/RuntimeSnapshotStore";
import type { RuntimeSnapshotImporter } from "@cell/ai-core-contract/runtime/RuntimeSnapshotStore";
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
import { normalizeActorDurableMaterialIndex } from "@cell/ai-core-logic/runtime/ActorDurableMaterial";
import { normalizeActorRuntimeFacetIndex } from "@cell/ai-core-logic/runtime/ActorRuntimeFacet";
import {
  parseQuestionnaireRowsXnl,
  serializeQuestionnaireRowsXnl,
} from "./QuestionnaireXnlStore";

const MANIFEST_FILE = "manifest.json";
const VM_FILE = "vm.json";
const QUESTIONNAIRES_FILE = "questionnaires.xnl";
const ACTORS_DIR = path.posix.join("..", "actors");
const FIBERS_DIR = "fibers";
const INDEXES_DIR = "indexes";
const GENERATIONS_DIR = "generations";
const CHECKPOINTS_DIR = "checkpoints";
const GENERATION_MANIFEST_FILE = "generation-manifest.json";
const MIGRATION_RECEIPT_FILE = "migration-attempt.json";
const REDACTED_PROVIDER_SECRET = "[REDACTED]";

export type RuntimeSnapshotWriteSelection = {
  dirtyActorKeys?: readonly string[];
  dirtyFiberIds?: readonly string[];
};

export type RuntimeSnapshotMigrationFaultPoint =
  | "after-staging-create"
  | "after-staging-write"
  | "after-staging-fsync"
  | "after-generation-publish"
  | "before-head-swap"
  | "after-head-swap";

export type LocalFileRuntimeSnapshotRepositoryOptions = Readonly<{
  importers?: readonly RuntimeSnapshotImporter[];
  migrationFaultInjector?: (point: RuntimeSnapshotMigrationFaultPoint) => void | Promise<void>;
}>;

type RuntimeSnapshotWriteInput = RuntimeSnapshotPersistedState & RuntimeSnapshotWriteSelection;

function isProviderSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.endsWith("apikey")
    || normalized === "authorization"
    || normalized === "proxyauthorization"
    || normalized === "auth"
    || normalized === "bearer"
    || normalized === "credential"
    || normalized === "cookie"
    || normalized === "password"
    || normalized === "passwd"
    || normalized === "privatekey"
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("secretkey");
}

function redactProviderSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProviderSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    isProviderSecretKey(key) ? REDACTED_PROVIDER_SECRET : redactProviderSecrets(child),
  ]));
}

function removePersistedProviderSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removePersistedProviderSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    isProviderSecretKey(key) ? [] : [[key, removePersistedProviderSecrets(child)]],
  ));
}

const INDEX_FILE_NAMES: Record<RuntimeSnapshotIndexName, string> = {
  actors_by_key: "actors_by_key.json",
  actors_by_id: "actors_by_id.json",
  fibers_by_id: "fibers_by_id.json",
};

function encodeFileSegment(value: string): string {
  return encodeURIComponent(value);
}

function buildActorFile(actor: Pick<RuntimeSnapshotActor, "key" | "id" | "type" | "identity">): string {
  return path.posix.join(ACTORS_DIR, buildActorDirName({
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

function sha256Bytes(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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

async function writeTextAtomically(filePath: string, data: string): Promise<void> {
  await ensureParentDir(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function assertManifestShape(manifest: RuntimeSnapshotManifest, expectedVersion: number): void {
  if (manifest.version !== expectedVersion) {
    failUnsupportedSnapshot(`${MANIFEST_FILE} must use version=${expectedVersion}`);
  }
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

function assertCurrentManifestShape(manifest: RuntimeSnapshotManifest): void {
  assertManifestShape(manifest, RUNTIME_SNAPSHOT_SCHEMA_VERSION);
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
  readonly options: LocalFileRuntimeSnapshotRepositoryOptions;

  constructor(rootDir: string, options: LocalFileRuntimeSnapshotRepositoryOptions = {}) {
    this.rootDir = rootDir;
    this.options = options;
  }

  get manifestPath(): string {
    return toAbsolute(this.rootDir, MANIFEST_FILE);
  }

  get vmPath(): string {
    return toAbsolute(this.rootDir, VM_FILE);
  }

  get questionnairesPath(): string {
    return toAbsolute(this.rootDir, QUESTIONNAIRES_FILE);
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

  async writeQuestionnaires(rows: RuntimeSnapshotPersistedState["questionnaires"] = []): Promise<void> {
    await writeTextAtomically(this.questionnairesPath, serializeQuestionnaireRowsXnl(rows));
  }

  async readQuestionnaires(): Promise<RuntimeSnapshotLoadResult["questionnaires"]> {
    try {
      return parseQuestionnaireRowsXnl(await readFile(this.questionnairesPath, "utf8"));
    } catch {
      return [];
    }
  }

  private splitActorSnapshot(actor: RuntimeSnapshotActor): {
    actorMeta: Record<string, unknown>;
    actorState: Record<string, unknown>;
    actorMailboxes: Record<string, unknown>;
  } {
    const runtimeFacets = normalizeActorRuntimeFacetIndex(actor.runtimeFacets);
    return {
      actorMeta: {
        version: actor.version,
        key: actor.key,
        id: actor.id,
        type: actor.type,
        parentKey: actor.parentKey,
        systemPrompts: actor.systemPrompts,
        profileSystemPromptProvenance: actor.profileSystemPromptProvenance,
        identity: actor.identity,
        agentName: actor.agentName,
        toolPolicy: actor.toolPolicy,
        contextPolicy: actor.contextPolicy,
        executionContract: actor.executionContract,
        contextPipeline: actor.contextPipeline,
        origin: actor.origin,
        modelConfig: redactProviderSecrets(actor.modelConfig),
        ctrlOptions: actor.ctrlOptions,
      },
      actorState: {
        version: actor.version,
        planApproval: actor.planApproval,
        shutdownCoordination: actor.shutdownCoordination,
        taskTree: actor.taskTree,
        toolCallStreamState: actor.toolCallStreamState,
        continuationBaseline: actor.continuationBaseline,
        lastMemberResultNotifiedAt: actor.lastMemberResultNotifiedAt,
        detachedTask: actor.detachedTask,
        runtimeFacets,
        durableMaterials: normalizeActorDurableMaterialIndex(actor.durableMaterials),
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

  private async readActorSnapshotFromPath(
    relativeFile: string,
    corruptions: RuntimeSnapshotCorruption[],
    expectedVersion = RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  ): Promise<RuntimeSnapshotActor | null> {
    const actorPath = toAbsolute(this.rootDir, relativeFile);
    const actorJson = await readJsonFileBestEffort<Record<string, any>>(actorPath, corruptions);
    if (!actorJson) return null;

    if (actorJson.mailboxes || actorJson.taskTree || actorJson.messages) {
      failUnsupportedSnapshot(`invalid actor metadata shape at ${relativeFile}`);
    }
    if (actorJson.version !== expectedVersion) failUnsupportedSnapshot(`${relativeFile} must use version=${expectedVersion}`);

    const statePath = toAbsolute(this.rootDir, buildActorSiblingFile(relativeFile, "state.json"));
    const mailboxesPath = toAbsolute(this.rootDir, buildActorSiblingFile(relativeFile, "mailboxes.json"));
    const stateJson = await readJsonFileBestEffort<Record<string, any>>(statePath, corruptions);
    const mailboxesJson = await readJsonFileBestEffort<Record<string, any>>(mailboxesPath, corruptions);
    if (!stateJson || !mailboxesJson) return null;
    if (stateJson.version !== expectedVersion) failUnsupportedSnapshot(`${buildActorSiblingFile(relativeFile, "state.json")} must use version=${expectedVersion}`);
    if (mailboxesJson.version !== expectedVersion) failUnsupportedSnapshot(`${buildActorSiblingFile(relativeFile, "mailboxes.json")} must use version=${expectedVersion}`);
    const snapshot: RuntimeSnapshotActor = {
      version: expectedVersion,
      key: String(actorJson.key ?? ""),
      id: String(actorJson.id ?? ""),
      type: actorJson.type,
      parentKey: actorJson.parentKey,
      systemPrompts: Array.isArray(actorJson.systemPrompts) ? actorJson.systemPrompts : [],
      profileSystemPromptProvenance: actorJson.profileSystemPromptProvenance,
      identity: actorJson.identity,
      agentName: typeof actorJson.agentName === "string" ? actorJson.agentName : undefined,
      planApproval: stateJson.planApproval,
      shutdownCoordination: stateJson.shutdownCoordination,
      toolPolicy: actorJson.toolPolicy ?? {
        allowedToolsMode: "all",
        allowedTools: [],
        enabledToolKeys: [],
        disabledToolKeys: [],
        computedDisabledTools: [],
      },
      contextPolicy: actorJson.contextPolicy ?? { historyCompaction: "auto" },
      executionContract: actorJson.executionContract,
      contextPipeline: actorJson.contextPipeline,
      origin: actorJson.origin,
      modelConfig: removePersistedProviderSecrets(actorJson.modelConfig ?? {}) as RuntimeSnapshotActor["modelConfig"],
      ctrlOptions: actorJson.ctrlOptions ?? {
        stopAfterFirstTool: false,
        stopAfterTools: [],
        exitAfterToolResult: false,
      },
      taskTree: stateJson.taskTree,
      mailboxes: mailboxesJson.mailboxes ?? {
        control: [],
        toolResult: [],
        asyncCompletion: [],
        childDone: [],
        memberCoordination: [],
        humanInput: [],
        memberChatInbox: [],
        heartbeat: [],
      },
      toolCallStreamState: stateJson.toolCallStreamState ?? { toolCalls: [] },
      continuationBaseline: stateJson.continuationBaseline,
      lastMemberResultNotifiedAt: stateJson.lastMemberResultNotifiedAt,
      detachedTask: stateJson.detachedTask,
      runtimeFacets: normalizeActorRuntimeFacetIndex(stateJson.runtimeFacets),
      durableMaterials: normalizeActorDurableMaterialIndex(stateJson.durableMaterials),
      holonState: stateJson.holonState,
      updatedAt:
        typeof stateJson.updatedAt === "string"
          ? stateJson.updatedAt
          : typeof mailboxesJson.updatedAt === "string"
            ? mailboxesJson.updatedAt
            : undefined,
      recovery: stateJson.recovery,
    };
    if (expectedVersion === 3) {
      const knownStateFields = new Set([
        "version", "planApproval", "shutdownCoordination", "taskTree", "toolCallStreamState",
        "continuationBaseline", "lastMemberResultNotifiedAt", "detachedTask", "runtimeFacets", "durableMaterials",
        "holonState", "updatedAt", "recovery",
      ]);
      const migrationView = snapshot as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(stateJson)) {
        if (!knownStateFields.has(key)) migrationView[key] = value;
      }
    }
    return snapshot;
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

  async writeSnapshot(input: RuntimeSnapshotWriteInput): Promise<RuntimeSnapshotManifest> {
    // Validate every durable facet envelope before the first file write. A
    // later invalid Actor must not leave a partially updated snapshot tree.
    for (const actor of Object.values(input.actors)) {
      normalizeActorRuntimeFacetIndex(actor.runtimeFacets);
      normalizeActorDurableMaterialIndex(actor.durableMaterials);
    }
    const currentManifest = await this.readManifest();
    const generationsStat = await lstat(path.join(this.rootDir, GENERATIONS_DIR)).catch(() => null);
    if (generationsStat?.isSymbolicLink()) {
      failUnsupportedSnapshot("migration generations authority is a symlink");
    }
    if (currentManifest?.generation || currentManifest?.legacyRootReadOnly || generationsStat?.isDirectory()) {
      return this.writeContainedV4Checkpoint(input);
    }
    await mkdir(this.rootDir, { recursive: true });

    const fibers = { ...(input.fibers ?? {}) };
    const indexes = { ...buildIndexes({ actors: input.actors, fibers }), ...(input.indexes ?? {}) };
    const dirtyActorKeys = input.dirtyActorKeys ? new Set(input.dirtyActorKeys) : null;
    const dirtyFiberIds = input.dirtyFiberIds ? new Set(input.dirtyFiberIds) : null;
    const nowIso = new Date().toISOString();

    const actorFiles: Record<string, string> = {};
    for (const [actorKey, actor] of Object.entries(input.actors)) {
      const relativeFile = buildActorFile(actor);
      actorFiles[actorKey] = relativeFile;
      if (!dirtyActorKeys || dirtyActorKeys.has(actorKey)) {
        await this.writeActor(actor);
      }
    }

    const fiberFiles: Record<string, string> = {};
    for (const [fiberId, fiber] of Object.entries(fibers)) {
      const relativeFile = buildFiberFile(fiberId);
      fiberFiles[fiberId] = relativeFile;
      if (!dirtyFiberIds || dirtyFiberIds.has(fiberId)) {
        await this.writeFiber(fiber);
      }
    }

    for (const [name, indexValue] of Object.entries(indexes) as Array<[RuntimeSnapshotIndexName, RuntimeSnapshotIndex]>) {
      await this.writeIndex({ ...indexValue, kind: name } as RuntimeSnapshotIndex);
    }

    await this.writeVm(input.vm);
    await this.writeQuestionnaires(input.questionnaires ?? []);

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

  private async writeContainedV4Checkpoint(input: RuntimeSnapshotWriteInput): Promise<RuntimeSnapshotManifest> {
    const checkpointId = `v4-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const checkpointPrefix = path.posix.join(CHECKPOINTS_DIR, checkpointId);
    const checkpointsRoot = path.join(this.rootDir, CHECKPOINTS_DIR);
    const stagingDir = path.join(checkpointsRoot, `${checkpointId}.staging`);
    const checkpointDir = path.join(checkpointsRoot, checkpointId);
    const files = new Map<string, string>();
    const actorFiles: Record<string, string> = {};
    for (const [actorKey, actor] of Object.entries(input.actors)) {
      const internal = this.generationActorFile(actor);
      actorFiles[actorKey] = path.posix.join(checkpointPrefix, internal);
      const { actorMeta, actorState, actorMailboxes } = this.splitActorSnapshot(actor);
      files.set(internal, stableJson(actorMeta));
      files.set(buildActorSiblingFile(internal, "state.json"), stableJson(actorState));
      files.set(buildActorSiblingFile(internal, "mailboxes.json"), stableJson(actorMailboxes));
    }
    const fibers = { ...(input.fibers ?? {}) };
    const fiberFiles: Record<string, string> = {};
    for (const [fiberId, fiber] of Object.entries(fibers)) {
      const internal = buildFiberFile(fiberId);
      fiberFiles[fiberId] = path.posix.join(checkpointPrefix, internal);
      files.set(internal, stableJson(fiber));
    }
    const indexes = buildIndexes({ actors: input.actors, fibers });
    for (const [name, index] of Object.entries(indexes) as Array<[RuntimeSnapshotIndexName, RuntimeSnapshotIndex]>) {
      const internal = buildIndexFile(name);
      const entries = Object.fromEntries(Object.entries(index.entries).map(([key, relative]) => [
        key,
        relative.startsWith(ACTORS_DIR)
          ? actorFiles[key] ?? path.posix.join(checkpointPrefix, relative.replace(/^\.\.\//, ""))
          : fiberFiles[key] ?? path.posix.join(checkpointPrefix, relative),
      ]));
      files.set(internal, stableJson({ ...index, entries }));
    }
    files.set(VM_FILE, stableJson(input.vm));
    files.set(QUESTIONNAIRES_FILE, serializeQuestionnaireRowsXnl(input.questionnaires ?? []));

    await mkdir(checkpointsRoot, { recursive: true });
    await mkdir(stagingDir, { recursive: false });
    await this.writeAndFsyncGeneration(stagingDir, files);
    await rename(stagingDir, checkpointDir);
    await fsyncDirectory(checkpointsRoot);
    const nowIso = new Date().toISOString();
    const manifest: RuntimeSnapshotManifest = {
      version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      controlActorKey: input.vm.controlActorKey,
      createdAt: nowIso,
      updatedAt: nowIso,
      actorKeys: Object.keys(actorFiles),
      fiberIds: Object.keys(fiberFiles),
      indexFiles: Object.keys(INDEX_FILE_NAMES).map((name) => path.posix.join(checkpointPrefix, buildIndexFile(name as RuntimeSnapshotIndexName))),
      questionnairesFile: path.posix.join(checkpointPrefix, QUESTIONNAIRES_FILE),
      legacyRootReadOnly: true,
      vmFile: path.posix.join(checkpointPrefix, VM_FILE),
      actorFiles,
      fiberFiles,
      savedAt: Date.now(),
    };
    const tempHead = `${this.manifestPath}.checkpoint-${process.pid}-${checkpointId}`;
    await writeFile(tempHead, stableJson(manifest), "utf8");
    await fsyncFile(tempHead);
    await rename(tempHead, this.manifestPath);
    await fsyncDirectory(this.rootDir);
    return manifest;
  }

  private async invokeMigrationFault(point: RuntimeSnapshotMigrationFaultPoint): Promise<void> {
    await this.options.migrationFaultInjector?.(point);
  }

  private referencedSnapshotFiles(manifest: RuntimeSnapshotManifest): string[] {
    const files = new Set<string>([
      manifest.vmFile,
      ...manifest.indexFiles,
      ...(manifest.derivedIndexFiles ?? []),
      ...Object.values(manifest.fiberFiles ?? {}),
    ]);
    files.add(manifest.questionnairesFile ?? QUESTIONNAIRES_FILE);
    for (const actorFile of Object.values(manifest.actorFiles)) {
      files.add(actorFile);
      files.add(buildActorSiblingFile(actorFile, "state.json"));
      files.add(buildActorSiblingFile(actorFile, "mailboxes.json"));
    }
    return [...files].sort();
  }

  private async readTrustedSnapshotFile(relativeFile: string, allowedRoot: string): Promise<Uint8Array> {
    if (!relativeFile || path.isAbsolute(relativeFile) || relativeFile.includes("\0")) {
      failUnsupportedSnapshot(`unsafe snapshot path ${JSON.stringify(relativeFile)}`);
    }
    const absolute = path.resolve(this.rootDir, relativeFile);
    const normalizedAllowed = path.resolve(allowedRoot);
    const allowedRootStat = await lstat(normalizedAllowed).catch(() => null);
    if (!allowedRootStat?.isDirectory() || allowedRootStat.isSymbolicLink()) {
      failUnsupportedSnapshot(`snapshot authority root is not a no-symlink directory: ${allowedRoot}`);
    }
    if (absolute !== normalizedAllowed && !absolute.startsWith(`${normalizedAllowed}${path.sep}`)) {
      failUnsupportedSnapshot(`snapshot path escapes authority root: ${relativeFile}`);
    }
    const fileStat = await lstat(absolute).catch(() => null);
    if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
      failUnsupportedSnapshot(`snapshot path is not a regular no-symlink file: ${relativeFile}`);
    }
    let cursor = normalizedAllowed;
    for (const segment of path.relative(normalizedAllowed, absolute).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      const segmentStat = await lstat(cursor).catch(() => null);
      if (!segmentStat || segmentStat.isSymbolicLink()) {
        failUnsupportedSnapshot(`snapshot path traverses a symlink: ${relativeFile}`);
      }
    }
    const resolved = await realpath(absolute);
    const resolvedAllowed = await realpath(normalizedAllowed);
    if (resolved !== resolvedAllowed && !resolved.startsWith(`${resolvedAllowed}${path.sep}`)) {
      failUnsupportedSnapshot(`snapshot path traverses a symlink: ${relativeFile}`);
    }
    return new Uint8Array(await readFile(absolute));
  }

  private async computeTreeDigest(
    manifest: RuntimeSnapshotManifest,
    allowedRoot: string,
  ): Promise<string> {
    const facts: string[] = [];
    for (const relativeFile of this.referencedSnapshotFiles(manifest)) {
      const bytes = await this.readTrustedSnapshotFile(relativeFile, allowedRoot);
      facts.push(`${relativeFile}\0${sha256Bytes(bytes)}`);
    }
    return sha256Bytes(facts.join("\n"));
  }

  private async loadSnapshotAtManifest(
    manifest: RuntimeSnapshotManifest,
    expectedVersion: number,
  ): Promise<RuntimeSnapshotLoadResult | null> {
    assertManifestShape(manifest, expectedVersion);
    const corruptions: RuntimeSnapshotCorruption[] = [];
    const vm = await readJsonFileBestEffort<RuntimeSnapshotVm>(toAbsolute(this.rootDir, manifest.vmFile), corruptions);
    if (!vm) return null;
    if (vm.version !== expectedVersion) failUnsupportedSnapshot(`${manifest.vmFile} must use version=${expectedVersion}`);

    let questionnaires: RuntimeSnapshotLoadResult["questionnaires"] = [];
    const questionnairesFile = manifest.questionnairesFile ?? QUESTIONNAIRES_FILE;
    try {
      questionnaires = parseQuestionnaireRowsXnl(await readFile(toAbsolute(this.rootDir, questionnairesFile), "utf8"));
    } catch {
      questionnaires = [];
    }

    const indexes = {} as Partial<RuntimeSnapshotIndexes>;
    for (const relativeFile of manifest.indexFiles) {
      const fileName = path.posix.basename(relativeFile) as typeof INDEX_FILE_NAMES[RuntimeSnapshotIndexName];
      const name = (Object.entries(INDEX_FILE_NAMES).find(([, value]) => value === fileName)?.[0] ?? null) as RuntimeSnapshotIndexName | null;
      if (!name) continue;
      const indexValue = await readJsonFileBestEffort<RuntimeSnapshotIndex>(toAbsolute(this.rootDir, relativeFile), corruptions);
      if (indexValue) {
        if ((indexValue as { schemaVersion?: unknown }).schemaVersion !== expectedVersion) {
          failUnsupportedSnapshot(`${relativeFile} must use version=${expectedVersion}`);
        }
        (indexes as Record<string, RuntimeSnapshotIndex>)[name] = indexValue as RuntimeSnapshotIndexes[typeof name];
      }
    }

    const actors: Record<string, RuntimeSnapshotActor> = {};
    for (const [actorKey, relativeFile] of Object.entries(manifest.actorFiles)) {
      const actor = await this.readActorSnapshotFromPath(relativeFile, corruptions, expectedVersion);
      if (actor) actors[actorKey] = actor;
    }

    const fibers: Record<string, RuntimeSnapshotFiber> = {};
    for (const [fiberId, relativeFile] of Object.entries(manifest.fiberFiles ?? {})) {
      const fiber = await readJsonFileBestEffort<RuntimeSnapshotFiber>(toAbsolute(this.rootDir, relativeFile), corruptions);
      if (fiber) {
        if (fiber.version !== expectedVersion) failUnsupportedSnapshot(`${relativeFile} must use version=${expectedVersion}`);
        fibers[fiberId] = { ...fiber, version: expectedVersion };
      }
    }

    return { manifest, vm, actors, questionnaires, fibers, indexes, corruptions };
  }

  private generationActorFile(actor: Pick<RuntimeSnapshotActor, "key" | "id" | "type" | "identity">): string {
    return path.posix.join("actors", buildActorDirName({
      agentKey: actor.key,
      actorId: actor.id,
      actorType: actor.type,
      identity: actor.identity,
    }), "actor.json");
  }

  private async writeAndFsyncGeneration(
    stagingDir: string,
    files: ReadonlyMap<string, string>,
  ): Promise<void> {
    const directories = new Set<string>([stagingDir]);
    for (const [relativeFile, bytes] of files) {
      const absolute = path.join(stagingDir, relativeFile);
      const parent = path.dirname(absolute);
      await mkdir(parent, { recursive: true });
      directories.add(parent);
      await writeFile(absolute, bytes, "utf8");
      await fsyncFile(absolute);
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      await fsyncDirectory(directory);
    }
  }

  private async validateExistingGeneration(
    generationDir: string,
    files: ReadonlyMap<string, string>,
  ): Promise<void> {
    const directoryStat = await lstat(generationDir).catch(() => null);
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
      failUnsupportedSnapshot("published migration generation is not an immutable no-symlink directory");
    }
    for (const [relativeFile, expected] of files) {
      const absolute = path.join(generationDir, relativeFile);
      const fileStat = await lstat(absolute).catch(() => null);
      if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
        failUnsupportedSnapshot(`published migration generation is incomplete: ${relativeFile}`);
      }
      if (await readFile(absolute, "utf8") !== expected) {
        failUnsupportedSnapshot(`published migration generation conflicts: ${relativeFile}`);
      }
    }
  }

  private async validateAdmittedGeneration(manifest: RuntimeSnapshotManifest): Promise<void> {
    const generation = manifest.generation;
    if (!generation) return;
    if (
      typeof generation.id !== "string"
      || generation.id.length === 0
      || generation.id === "."
      || generation.id === ".."
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(generation.id)
      || path.posix.basename(generation.id) !== generation.id
      || path.win32.basename(generation.id) !== generation.id
    ) {
      failUnsupportedSnapshot("generation id must be one canonical single-segment direct child");
    }
    const generationPrefix = path.posix.join(GENERATIONS_DIR, generation.id);
    if (generation.manifestFile !== path.posix.join(generationPrefix, GENERATION_MANIFEST_FILE)
      || generation.receiptFile !== path.posix.join(generationPrefix, MIGRATION_RECEIPT_FILE)) {
      failUnsupportedSnapshot("generation manifest/receipt paths must be exact canonical direct-child paths");
    }
    const allowedRoot = path.join(this.rootDir, generationPrefix);
    if (path.dirname(allowedRoot) !== path.join(this.rootDir, GENERATIONS_DIR)) {
      failUnsupportedSnapshot("generation authority must be an exact direct child of generations");
    }
    const manifestBytes = await this.readTrustedSnapshotFile(generation.manifestFile, allowedRoot);
    const receiptBytes = await this.readTrustedSnapshotFile(generation.receiptFile, allowedRoot);
    if (sha256Bytes(manifestBytes) !== generation.manifestDigest) failUnsupportedSnapshot("generation manifest digest mismatch");
    if (sha256Bytes(receiptBytes) !== generation.receiptDigest) failUnsupportedSnapshot("migration receipt digest mismatch");
    const generationManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as RuntimeSnapshotManifest;
    if (generationManifest.version !== RUNTIME_SNAPSHOT_SCHEMA_VERSION) failUnsupportedSnapshot("generation manifest schema mismatch");
    const { generation: _headGeneration, legacyRootReadOnly: _headLegacyRootReadOnly, ...headSnapshotAuthority } = manifest;
    if (manifest.legacyRootReadOnly !== true
      || stableJson(headSnapshotAuthority) !== stableJson(generationManifest)) {
      failUnsupportedSnapshot("manifest head does not bind the admitted generation manifest");
    }
    if (await this.computeTreeDigest(generationManifest, allowedRoot) !== generation.treeDigest) {
      failUnsupportedSnapshot("generation tree digest mismatch");
    }
    const receipt = JSON.parse(new TextDecoder().decode(receiptBytes)) as Record<string, any>;
    if (receipt.schemaVersion !== "runtime-snapshot-migration-receipt/v1"
      || receipt.target?.generationId !== generation.id
      || receipt.target?.manifestDigest !== generation.manifestDigest
      || receipt.target?.treeDigest !== generation.treeDigest) {
      failUnsupportedSnapshot("migration receipt does not bind the admitted target");
    }
  }

  private async migrateLegacyV3(
    sourceManifest: RuntimeSnapshotManifest,
    sourceManifestBytes: string,
  ): Promise<RuntimeSnapshotLoadResult> {
    assertManifestShape(sourceManifest, 3);
    const sourceAllowedRoot = path.dirname(this.rootDir);
    const sourceManifestDigest = sha256Bytes(sourceManifestBytes);
    const sourceTreeDigest = await this.computeTreeDigest(sourceManifest, sourceAllowedRoot);
    const sourceSnapshot = await this.loadSnapshotAtManifest(sourceManifest, 3);
    if (!sourceSnapshot || sourceSnapshot.corruptions.length > 0) {
      failUnsupportedSnapshot("schema-v3 source is incomplete or corrupt");
    }
    const importers = (this.options.importers ?? []).filter((entry) =>
      entry.sourceVersion === 3 && entry.targetVersion === RUNTIME_SNAPSHOT_SCHEMA_VERSION);
    if (importers.length !== 1) {
      failUnsupportedSnapshot(`schema-v3 import requires exactly one runtime-supplied importer, found ${importers.length}`);
    }
    const importer = importers[0]!;
    const migrated = importer.importSnapshot({
      sourceVersion: 3,
      manifestDigest: sourceManifestDigest,
      treeDigest: sourceTreeDigest,
      snapshot: sourceSnapshot,
    });
    for (const actor of Object.values(migrated.actors)) normalizeActorRuntimeFacetIndex(actor.runtimeFacets);

    const generationId = `v4-${sourceTreeDigest.slice("sha256:".length, "sha256:".length + 24)}`;
    const generationPrefix = path.posix.join(GENERATIONS_DIR, generationId);
    const files = new Map<string, string>();
    const actorFiles: Record<string, string> = {};
    for (const [actorKey, actor] of Object.entries(migrated.actors)) {
      const internalActorFile = this.generationActorFile(actor);
      actorFiles[actorKey] = path.posix.join(generationPrefix, internalActorFile);
      const { actorMeta, actorState, actorMailboxes } = this.splitActorSnapshot({ ...actor, version: RUNTIME_SNAPSHOT_SCHEMA_VERSION });
      files.set(internalActorFile, stableJson({ ...actorMeta, version: RUNTIME_SNAPSHOT_SCHEMA_VERSION }));
      files.set(buildActorSiblingFile(internalActorFile, "state.json"), stableJson({ ...actorState, version: RUNTIME_SNAPSHOT_SCHEMA_VERSION }));
      files.set(buildActorSiblingFile(internalActorFile, "mailboxes.json"), stableJson({ ...actorMailboxes, version: RUNTIME_SNAPSHOT_SCHEMA_VERSION }));
    }
    const fiberFiles: Record<string, string> = {};
    for (const [fiberId, fiber] of Object.entries(migrated.fibers ?? {})) {
      const internal = buildFiberFile(fiberId);
      fiberFiles[fiberId] = path.posix.join(generationPrefix, internal);
      files.set(internal, stableJson({ ...fiber, version: RUNTIME_SNAPSHOT_SCHEMA_VERSION }));
    }
    const indexes = buildIndexes({ actors: migrated.actors, fibers: migrated.fibers ?? {} });
    for (const [name, index] of Object.entries(indexes) as Array<[RuntimeSnapshotIndexName, RuntimeSnapshotIndex]>) {
      const internal = buildIndexFile(name);
      const entries = Object.fromEntries(Object.entries(index.entries).map(([key, relative]) => [
        key,
        relative.startsWith(ACTORS_DIR)
          ? actorFiles[key] ?? path.posix.join(generationPrefix, relative.replace(/^\.\.\//, ""))
          : fiberFiles[key] ?? path.posix.join(generationPrefix, relative),
      ]));
      files.set(internal, stableJson({ ...index, schemaVersion: RUNTIME_SNAPSHOT_SCHEMA_VERSION, entries }));
    }
    files.set(VM_FILE, stableJson({ ...migrated.vm, version: RUNTIME_SNAPSHOT_SCHEMA_VERSION }));
    files.set(QUESTIONNAIRES_FILE, serializeQuestionnaireRowsXnl(migrated.questionnaires ?? []));

    const nowIso = sourceManifest.updatedAt || sourceManifest.createdAt;
    const generationManifest: RuntimeSnapshotManifest = {
      version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      controlActorKey: migrated.vm.controlActorKey,
      createdAt: sourceManifest.createdAt,
      updatedAt: nowIso,
      actorKeys: Object.keys(actorFiles),
      fiberIds: Object.keys(fiberFiles),
      indexFiles: Object.keys(INDEX_FILE_NAMES).map((name) => path.posix.join(generationPrefix, buildIndexFile(name as RuntimeSnapshotIndexName))),
      questionnairesFile: path.posix.join(generationPrefix, QUESTIONNAIRES_FILE),
      vmFile: path.posix.join(generationPrefix, VM_FILE),
      actorFiles,
      fiberFiles,
      savedAt: sourceManifest.savedAt,
    };
    const treeFacts = [...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([relative, bytes]) => `${path.posix.join(generationPrefix, relative)}\0${sha256Bytes(bytes)}`);
    const targetTreeDigest = sha256Bytes(treeFacts.join("\n"));
    const generationManifestBytes = stableJson(generationManifest);
    const targetManifestDigest = sha256Bytes(generationManifestBytes);
    const receipt = {
      schemaVersion: "runtime-snapshot-migration-receipt/v1",
      migrationId: importer.migrationId,
      source: { schemaVersion: 3, manifestDigest: sourceManifestDigest, treeDigest: sourceTreeDigest },
      target: {
        schemaVersion: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
        generationId,
        manifestDigest: targetManifestDigest,
        treeDigest: targetTreeDigest,
      },
      createdAt: nowIso,
    };
    const receiptBytes = stableJson(receipt);
    const receiptDigest = sha256Bytes(receiptBytes);
    files.set(GENERATION_MANIFEST_FILE, generationManifestBytes);
    files.set(MIGRATION_RECEIPT_FILE, receiptBytes);

    const generationsRoot = path.join(this.rootDir, GENERATIONS_DIR);
    const stagingDir = path.join(generationsRoot, `${generationId}.staging`);
    const generationDir = path.join(generationsRoot, generationId);
    await mkdir(generationsRoot, { recursive: true });
    const stagingStat = await lstat(stagingDir).catch(() => null);
    if (stagingStat?.isSymbolicLink()) failUnsupportedSnapshot("migration staging path is a symlink");
    if (stagingStat) await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: false });
    await this.invokeMigrationFault("after-staging-create");
    await this.writeAndFsyncGeneration(stagingDir, files);
    await this.invokeMigrationFault("after-staging-write");
    await fsyncDirectory(stagingDir);
    await fsyncDirectory(generationsRoot);
    await this.invokeMigrationFault("after-staging-fsync");

    const published = await lstat(generationDir).catch(() => null);
    if (published) {
      await this.validateExistingGeneration(generationDir, files);
      await rm(stagingDir, { recursive: true, force: true });
    } else {
      await rename(stagingDir, generationDir);
      await fsyncDirectory(generationsRoot);
    }
    await this.invokeMigrationFault("after-generation-publish");

    const head: RuntimeSnapshotManifest = {
      ...generationManifest,
      legacyRootReadOnly: true,
      generation: {
        id: generationId,
        manifestFile: path.posix.join(generationPrefix, GENERATION_MANIFEST_FILE),
        manifestDigest: targetManifestDigest,
        treeDigest: targetTreeDigest,
        receiptFile: path.posix.join(generationPrefix, MIGRATION_RECEIPT_FILE),
        receiptDigest,
      },
    };
    const tempHead = `${this.manifestPath}.migration-${process.pid}-${generationId}`;
    await writeFile(tempHead, stableJson(head), "utf8");
    await fsyncFile(tempHead);
    await this.invokeMigrationFault("before-head-swap");
    const liveHeadBytes = await readFile(this.manifestPath, "utf8");
    if (sha256Bytes(liveHeadBytes) !== sourceManifestDigest) {
      await rm(tempHead, { force: true });
      failUnsupportedSnapshot("migration manifest-head CAS conflict");
    }
    await rename(tempHead, this.manifestPath);
    await fsyncDirectory(this.rootDir);
    await this.invokeMigrationFault("after-head-swap");
    const loaded = await this.loadSnapshotAtManifest(head, RUNTIME_SNAPSHOT_SCHEMA_VERSION);
    if (!loaded) failUnsupportedSnapshot("admitted v4 generation cannot be loaded");
    return loaded;
  }

  async loadSnapshot(): Promise<RuntimeSnapshotLoadResult | null> {
    let manifestBytes: string;
    try {
      manifestBytes = await readFile(this.manifestPath, "utf8");
    } catch {
      return null;
    }
    const manifest = JSON.parse(manifestBytes) as RuntimeSnapshotManifest;
    if (manifest.version === 3) return this.migrateLegacyV3(manifest, manifestBytes);
    assertCurrentManifestShape(manifest);
    await this.validateAdmittedGeneration(manifest);
    return this.loadSnapshotAtManifest(manifest, RUNTIME_SNAPSHOT_SCHEMA_VERSION);
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
