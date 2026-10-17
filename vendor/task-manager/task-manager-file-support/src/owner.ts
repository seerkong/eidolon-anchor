import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  TaskArtifactBody,
  TaskArtifactDigest,
  TaskCommandId,
  TaskCommandReceipt,
  TaskHistoryEvent,
  TaskNodeDefinition,
  TaskRecord,
  TaskSpaceCommit,
  TaskSpaceCommitResult,
  TaskSpaceId,
  TaskSpaceOwnerPort,
  TaskSpaceDirectoryPort,
  TaskSpaceSnapshot,
} from 'task-manager-contract';
import { deepFrozenCanonicalOwnDataClone } from 'task-manager-contract';
import {
  TaskManagerError,
  taskArtifactRefsOfSnapshot,
  validateTaskSpaceCommitAdmission,
  validateTaskSpaceCommitCommand,
} from 'task-manager-logic';
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  sameBytes,
  sha256Digest,
  verifyArtifactBody,
} from './canonical.js';
import { FileTaskSpaceError } from './errors.js';
import {
  assertRegularFile,
  diagnosticPaths,
  ensureTaskSpaceLayout,
  fsyncDirectory,
  prepareFileTaskSpaceRoot,
  resolveContainedRelative,
  type FileTaskSpaceDiagnosticPaths,
  type PreparedFileTaskSpaceRoot,
} from './layout.js';
import {
  acquireFileTaskSpaceLock,
  releaseFileTaskSpaceLock,
  type FileTaskSpaceLockOptions,
} from './lock.js';

export type FileTaskSpaceFaultPoint =
  | 'after-journal'
  | 'after-immutable-temp-create'
  | 'after-immutable-temp-write'
  | 'after-immutable-temp-fsync'
  | 'after-immutable-publish'
  | 'after-immutable-files'
  | 'after-head-rename';

export interface FileTaskSpaceOwnerOptions {
  readonly root: string;
  readonly lockTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly malformedLockStaleMs?: number;
  readonly faultInjector?: (point: FileTaskSpaceFaultPoint) => void;
}

interface TaskSpaceHead {
  readonly kind: 'task-space-head';
  readonly schemaVersion: 1;
  readonly taskSpaceId: TaskSpaceId;
  readonly revision: number;
  readonly recordDigest: TaskArtifactDigest;
  readonly treeDigest: TaskArtifactDigest;
  readonly commandId: TaskCommandId;
  readonly commandDigest: `sha256:${string}`;
  readonly receiptId: string;
}

type TaskStateRecord = Omit<TaskRecord, 'definition'>;

interface StoredTaskSpaceRecord {
  readonly kind: 'task-space-record';
  readonly taskSpaceId: TaskSpaceId;
  readonly revision: number;
  readonly treeDigest: TaskArtifactDigest;
  readonly tasks: readonly TaskStateRecord[];
  readonly historyEventIds: readonly string[];
  readonly issuedReceiptIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CommandReceiptIndex {
  readonly kind: 'task-command-receipt-index';
  readonly taskSpaceId: TaskSpaceId;
  readonly commandId: TaskCommandId;
  readonly commandDigest: `sha256:${string}`;
  readonly receiptId: string;
  readonly receiptFile: string;
  readonly receiptDigest: TaskArtifactDigest;
}

interface JournalEntry {
  readonly relativePath: string;
  readonly dataBase64: string;
}

interface TaskSpaceJournal {
  readonly kind: 'task-space-transaction';
  readonly schemaVersion: 1;
  readonly token: string;
  readonly taskSpaceId: TaskSpaceId;
  readonly commandId: TaskCommandId;
  readonly commandDigest: `sha256:${string}`;
  readonly expectedRevision: number | null;
  readonly priorHeadBase64: string | null;
  readonly nextHeadBase64: string;
  readonly entries: readonly JournalEntry[];
}

export class FileTaskSpaceOwner implements TaskSpaceOwnerPort,TaskSpaceDirectoryPort {
  readonly #prepared: PreparedFileTaskSpaceRoot;
  readonly #lockOptions: FileTaskSpaceLockOptions;
  readonly #faultInjector?: (point: FileTaskSpaceFaultPoint) => void;

  constructor(options: FileTaskSpaceOwnerOptions) {
    this.#prepared = prepareFileTaskSpaceRoot(options.root);
    this.#lockOptions = {
      lockTimeoutMs: positive(options.lockTimeoutMs ?? 5_000, 'lockTimeoutMs'),
      retryDelayMs: positive(options.retryDelayMs ?? 5, 'retryDelayMs'),
      malformedLockStaleMs: nonNegative(options.malformedLockStaleMs ?? 30_000, 'malformedLockStaleMs'),
    };
    this.#faultInjector = options.faultInjector;
  }

  diagnosticPaths(taskSpaceId: TaskSpaceId): FileTaskSpaceDiagnosticPaths {
    return diagnosticPaths(this.#prepared, taskSpaceId);
  }

  /** Bounded readonly discovery. Incomplete creations are not public spaces. */
  async listTaskSpaceIds(input:Readonly<{maxEntries?:number}>={}):Promise<readonly TaskSpaceId[]>{
    const maximum=input.maxEntries??1000;
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>10000)throw new FileTaskSpaceError('directory-capacity','directory budget must be within 1..10000');
    const ids:string[]=[];let count=0;
    const directory=fs.opendirSync(this.#prepared.spacesDir);
    try{
      let entry:fs.Dirent|null;
      while((entry=directory.readSync())!==null){
        if(++count>maximum)throw new FileTaskSpaceError('directory-capacity','TaskSpace directory exceeds its budget');
        if(!entry.name.startsWith('space-'))continue;
        if(entry.isSymbolicLink()||!entry.isDirectory())throw new FileTaskSpaceError('path-boundary','TaskSpace directory entry is not a regular directory');
        let id:string;
        try{id=decodeURIComponent(entry.name.slice(6));}catch{throw new FileTaskSpaceError('path-boundary','TaskSpace directory identity is malformed');}
        if(!id||entry.name!=='space-'+encodeURIComponent(id))throw new FileTaskSpaceError('path-boundary','TaskSpace directory identity is not canonical');
        const paths=this.diagnosticPaths(id);
        if(!fs.existsSync(paths.headFile))continue;
        assertRegularFile(paths.headFile);
        const fd=fs.openSync(paths.headFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        try{
          const bytes=Buffer.alloc(16385),length=fs.readSync(fd,bytes,0,bytes.length,0);
          if(length>16384)throw new FileTaskSpaceError('directory-capacity','TaskSpace directory head exceeds its budget');
          const head=parseCanonicalJson<TaskSpaceHead>(bytes.subarray(0,length),'directory head');
          if(head.kind!=='task-space-head'||head.schemaVersion!==1||head.taskSpaceId!==id||!Number.isSafeInteger(head.revision)||head.revision<0)corrupt('directory head identity is invalid');
          ids.push(id);
        }finally{fs.closeSync(fd);}
      }
    }finally{directory.closeSync();}
    return Object.freeze(ids.sort());
  }

  async readSnapshot(taskSpaceId: TaskSpaceId): Promise<TaskSpaceSnapshot | undefined> {
    return this.#withLock(taskSpaceId, (paths) => this.#readSnapshotLocked(paths, taskSpaceId));
  }

  async readReceiptByCommand(
    taskSpaceId: TaskSpaceId,
    commandId: TaskCommandId,
  ): Promise<TaskCommandReceipt | undefined> {
    return this.#withLock(taskSpaceId, (paths) => this.#readReceiptLocked(paths, taskSpaceId, commandId));
  }

  async readHistory(taskSpaceId: TaskSpaceId): Promise<readonly TaskHistoryEvent[]> {
    return this.#withLock(taskSpaceId, (paths) => {
      const snapshot = this.#readSnapshotLocked(paths, taskSpaceId);
      if (!snapshot) return [];
      const events = fs.readdirSync(paths.historyDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const match = /^(\d{12})--(sha256:[a-f0-9]{64})\.json$/.exec(name);
          if (!match) corrupt(`unexpected history file ${name}`);
          const event = readCanonicalFile<TaskHistoryEvent>(path.join(paths.historyDir, name), match[2] as TaskArtifactDigest);
          return event;
        })
        .sort((left, right) => left.sequence - right.sequence);
      if (events.length !== snapshot.historyEventIds.length
        || events.some((event, index) => event.sequence !== index || event.eventId !== snapshot.historyEventIds[index])) {
        corrupt('history files do not match the snapshot append-only prefix');
      }
      return deepFrozenCanonicalOwnDataClone(events);
    });
  }

  async readArtifact(
    taskSpaceId: TaskSpaceId,
    digest: TaskArtifactDigest,
  ): Promise<TaskArtifactBody | undefined> {
    assertDigest(digest);
    return this.#withLock(taskSpaceId, (paths) => {
      const file = path.join(paths.artifactsDir, `${digest}.json`);
      if (!fs.existsSync(file)) return undefined;
      const artifact = readCanonicalFile<TaskArtifactBody>(file);
      if (artifact.digest !== digest) digestMismatch(`artifact file ${file} contains ${artifact.digest}`);
      verifyArtifactBody(artifact);
      return deepFrozenCanonicalOwnDataClone(artifact);
    });
  }

  async compareAndSwap(commit: TaskSpaceCommit): Promise<TaskSpaceCommitResult> {
    commit = deepFrozenCanonicalOwnDataClone(commit);
    const submittedCommandDigest = mapSharedAdmissionError(() => validateTaskSpaceCommitCommand(commit));
    return this.#withLock(commit.taskSpaceId, (paths) => {
      const replay = this.#readReceiptLocked(paths, commit.taskSpaceId, commit.commandId);
      const current = this.#readSnapshotLocked(paths, commit.taskSpaceId);
      if (replay) {
        if (replay.commandDigest !== submittedCommandDigest) {
          throw new FileTaskSpaceError(
            'command-receipt-mismatch',
            `command ${commit.commandId} digest does not match prior admission`,
          );
        }
        if (!current) corrupt(`receipt ${replay.receiptId} exists without a head`);
        return deepFrozenCanonicalOwnDataClone({
          kind: 'command-replayed',
          taskSpaceId: commit.taskSpaceId,
          revision: current.revision,
          snapshot: current,
          receipt: replay,
        });
      }
      const actualRevision = current?.revision ?? null;
      if (actualRevision !== commit.expectedRevision) {
        return deepFrozenCanonicalOwnDataClone({
          kind: 'revision-conflict',
          taskSpaceId: commit.taskSpaceId,
          expectedRevision: commit.expectedRevision,
          actualRevision,
        });
      }

      const receipt = mapSharedAdmissionError(() => validateTaskSpaceCommitAdmission(commit, {
        ...(current === undefined ? {} : { currentSnapshot: current }),
        existingArtifacts: this.#readAdmissionArtifacts(paths, current, commit),
      }));
      const material = buildMaterial(commit, paths, receipt);
      const priorHead = fs.existsSync(paths.headFile) ? readRawFile(paths.headFile) : undefined;
      const journal: TaskSpaceJournal = {
        kind: 'task-space-transaction',
        schemaVersion: 1,
        token: randomUUID(),
        taskSpaceId: commit.taskSpaceId,
        commandId: commit.commandId,
        commandDigest: commit.commandDigest,
        expectedRevision: commit.expectedRevision,
        priorHeadBase64: priorHead === undefined ? null : Buffer.from(priorHead).toString('base64'),
        nextHeadBase64: Buffer.from(material.headBytes).toString('base64'),
        entries: material.entries,
      };
      atomicReplace(paths.journalFile, canonicalJsonBytes(journal), journal.token);
      this.#faultInjector?.('after-journal');
      this.#applyJournal(paths, journal, true);
      return deepFrozenCanonicalOwnDataClone({
        kind: 'commit-accepted',
        taskSpaceId: commit.taskSpaceId,
        revision: commit.snapshot.revision,
        snapshot: commit.snapshot,
        receipt,
      });
    });
  }

  async #withLock<Value>(
    taskSpaceId: TaskSpaceId,
    operation: (paths: FileTaskSpaceDiagnosticPaths) => Value,
  ): Promise<Value> {
    const paths = diagnosticPaths(this.#prepared, taskSpaceId);
    ensureTaskSpaceLayout(this.#prepared, paths);
    const lock = await acquireFileTaskSpaceLock(paths.lockFile, this.#lockOptions);
    try {
      this.#recoverJournal(paths, taskSpaceId);
      return operation(paths);
    } finally {
      releaseFileTaskSpaceLock(lock);
    }
  }

  #recoverJournal(paths: FileTaskSpaceDiagnosticPaths, taskSpaceId: TaskSpaceId): void {
    if (!fs.existsSync(paths.journalFile)) return;
    let journal: TaskSpaceJournal;
    try {
      journal = readCanonicalFile<TaskSpaceJournal>(paths.journalFile);
    } catch (error) {
      throw new FileTaskSpaceError('journal-corrupt', `cannot read ${paths.journalFile}: ${String(error)}`);
    }
    if (journal.kind !== 'task-space-transaction'
      || journal.schemaVersion !== 1
      || journal.taskSpaceId !== taskSpaceId
      || !/^sha256:[a-f0-9]{64}$/.test(journal.commandDigest)
      || typeof journal.token !== 'string'
      || !Array.isArray(journal.entries)) {
      throw new FileTaskSpaceError('journal-corrupt', 'transaction journal identity is invalid');
    }
    this.#applyJournal(paths, journal, false);
  }

  #applyJournal(
    paths: FileTaskSpaceDiagnosticPaths,
    journal: TaskSpaceJournal,
    injectFaults: boolean,
  ): void {
    const currentHead = fs.existsSync(paths.headFile) ? readRawFile(paths.headFile) : undefined;
    const priorHead = journal.priorHeadBase64 === null
      ? undefined
      : Uint8Array.from(Buffer.from(journal.priorHeadBase64, 'base64'));
    const nextHead = Uint8Array.from(Buffer.from(journal.nextHeadBase64, 'base64'));
    const atPrior = currentHead === undefined ? priorHead === undefined : priorHead !== undefined && sameBytes(currentHead, priorHead);
    const atNext = currentHead !== undefined && sameBytes(currentHead, nextHead);
    if (!atPrior && !atNext) {
      throw new FileTaskSpaceError('journal-corrupt', 'head no longer matches either side of the pending transaction');
    }
    for (const entry of journal.entries) {
      const file = resolveContainedRelative(this.#prepared, paths, entry.relativePath);
      publishImmutable(
        file,
        Uint8Array.from(Buffer.from(entry.dataBase64, 'base64')),
        journal.token,
        injectFaults ? this.#faultInjector : undefined,
      );
    }
    if (atPrior) {
      if (injectFaults) this.#faultInjector?.('after-immutable-files');
      atomicReplace(paths.headFile, nextHead, journal.token);
      if (injectFaults) this.#faultInjector?.('after-head-rename');
    }
    durableUnlink(paths.journalFile);
  }

  #readSnapshotLocked(
    paths: FileTaskSpaceDiagnosticPaths,
    taskSpaceId: TaskSpaceId,
  ): TaskSpaceSnapshot | undefined {
    if (!fs.existsSync(paths.headFile)) return undefined;
    const head = readCanonicalFile<TaskSpaceHead>(paths.headFile);
    if (head.kind !== 'task-space-head'
      || head.schemaVersion !== 1
      || head.taskSpaceId !== taskSpaceId
      || !/^sha256:[a-f0-9]{64}$/.test(head.commandDigest)
      || !Number.isSafeInteger(head.revision)) {
      throw new FileTaskSpaceError('corrupt-head', `head for ${taskSpaceId} has invalid identity`);
    }
    assertDigest(head.recordDigest);
    assertDigest(head.treeDigest);
    const definition = readCanonicalFile<TaskSpaceSnapshot['definition']>(
      path.join(paths.treesDir, `${head.treeDigest}.json`),
      head.treeDigest,
    );
    const record = readCanonicalFile<StoredTaskSpaceRecord>(
      path.join(paths.recordsDir, `${head.recordDigest}.json`),
      head.recordDigest,
    );
    if (definition.taskSpaceId !== taskSpaceId
      || record.kind !== 'task-space-record'
      || record.taskSpaceId !== taskSpaceId
      || record.revision !== head.revision
      || record.treeDigest !== head.treeDigest) {
      corrupt('head, tree and record identities disagree');
    }
    const definitions = new Map<TaskIdLike, TaskNodeDefinition>(definition.tasks.map((task) => [task.taskId, task]));
    if (definitions.size !== definition.tasks.length || record.tasks.length !== definition.tasks.length) {
      corrupt('tree and task state cardinality disagree');
    }
    const tasks: TaskRecord[] = record.tasks.map((state) => {
      const taskDefinition = definitions.get(state.taskId);
      if (!taskDefinition || state.taskSpaceId !== taskSpaceId) corrupt(`missing tree definition for task ${state.taskId}`);
      return { ...state, definition: taskDefinition };
    });
    const snapshot: TaskSpaceSnapshot = {
      kind: 'task-space-snapshot',
      taskSpaceId,
      revision: record.revision,
      definition,
      tasks,
      historyEventIds: record.historyEventIds,
      issuedReceiptIds: record.issuedReceiptIds,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    validateSnapshotIdentity(snapshot);
    return deepFrozenCanonicalOwnDataClone(snapshot);
  }

  #readReceiptLocked(
    paths: FileTaskSpaceDiagnosticPaths,
    taskSpaceId: TaskSpaceId,
    commandId: TaskCommandId,
  ): TaskCommandReceipt | undefined {
    const indexFile = path.join(paths.commandsDir, commandIndexName(commandId));
    if (!fs.existsSync(indexFile)) return undefined;
    const index = readCanonicalFile<CommandReceiptIndex>(indexFile);
    if (index.kind !== 'task-command-receipt-index'
      || index.taskSpaceId !== taskSpaceId
      || index.commandId !== commandId
      || !/^sha256:[a-f0-9]{64}$/.test(index.commandDigest)
      || path.basename(index.receiptFile) !== index.receiptFile) {
      corrupt(`command receipt index ${indexFile} has invalid identity`);
    }
    assertDigest(index.receiptDigest);
    const receipt = readCanonicalFile<TaskCommandReceipt>(
      path.join(paths.receiptsDir, index.receiptFile),
      index.receiptDigest,
    );
    if (receipt.taskSpaceId !== taskSpaceId
      || receipt.commandId !== commandId
      || receipt.commandDigest !== index.commandDigest
      || receipt.receiptId !== index.receiptId) {
      corrupt(`receipt for command ${commandId} has invalid identity`);
    }
    return deepFrozenCanonicalOwnDataClone(receipt);
  }

  #readAdmissionArtifacts(
    paths: FileTaskSpaceDiagnosticPaths,
    current: TaskSpaceSnapshot | undefined,
    commit: TaskSpaceCommit,
  ): ReadonlyMap<TaskArtifactDigest, TaskArtifactBody> {
    const digests = new Set<TaskArtifactDigest>([
      ...(current === undefined ? [] : taskArtifactRefsOfSnapshot(current).map(({ digest }) => digest)),
      ...taskArtifactRefsOfSnapshot(commit.snapshot).map(({ digest }) => digest),
      ...commit.artifacts.map(({ digest }) => digest),
    ]);
    const artifacts = new Map<TaskArtifactDigest, TaskArtifactBody>();
    for (const digest of digests) {
      const file = path.join(paths.artifactsDir, `${digest}.json`);
      if (!fs.existsSync(file)) continue;
      const artifact = readCanonicalFile<TaskArtifactBody>(file);
      verifyArtifactBody(artifact);
      if (artifact.digest !== digest) digestMismatch(`artifact file ${file} contains ${artifact.digest}`);
      artifacts.set(digest, artifact);
    }
    return artifacts;
  }
}

type TaskIdLike = string;

function validateSnapshotIdentity(snapshot: TaskSpaceSnapshot): void {
  const definitions = new Map(snapshot.definition.tasks.map((task) => [task.taskId, task]));
  if (snapshot.kind !== 'task-space-snapshot'
    || definitions.size !== snapshot.definition.tasks.length
    || snapshot.tasks.length !== definitions.size) corrupt('snapshot tree/task identity is invalid');
  const seen = new Set<string>();
  for (const task of snapshot.tasks) {
    const definition = definitions.get(task.taskId);
    if (task.taskSpaceId !== snapshot.taskSpaceId
      || !definition
      || seen.has(task.taskId)
      || !sameBytes(canonicalJsonBytes(definition), canonicalJsonBytes(task.definition))) {
      corrupt(`snapshot task ${task.taskId} disagrees with its tree definition`);
    }
    seen.add(task.taskId);
  }
}

function buildMaterial(
  commit: TaskSpaceCommit,
  paths: FileTaskSpaceDiagnosticPaths,
  receipt: TaskCommandReceipt,
): { readonly headBytes: Uint8Array; readonly entries: readonly JournalEntry[] } {
  const treeBytes = canonicalJsonBytes(commit.snapshot.definition);
  const treeDigest = sha256Digest(treeBytes);
  const record: StoredTaskSpaceRecord = {
    kind: 'task-space-record',
    taskSpaceId: commit.snapshot.taskSpaceId,
    revision: commit.snapshot.revision,
    treeDigest,
    tasks: commit.snapshot.tasks.map(({ definition: _definition, ...state }) => state),
    historyEventIds: commit.snapshot.historyEventIds,
    issuedReceiptIds: commit.snapshot.issuedReceiptIds,
    createdAt: commit.snapshot.createdAt,
    updatedAt: commit.snapshot.updatedAt,
  };
  const recordBytes = canonicalJsonBytes(record);
  const recordDigest = sha256Digest(recordBytes);
  const receiptBytes = canonicalJsonBytes(receipt);
  const receiptDigest = sha256Digest(receiptBytes);
  const receiptFile = `${receiptName(receipt.receiptId)}--${receiptDigest}.json`;
  const index: CommandReceiptIndex = {
    kind: 'task-command-receipt-index',
    taskSpaceId: commit.taskSpaceId,
    commandId: commit.commandId,
    commandDigest: commit.commandDigest,
    receiptId: receipt.receiptId,
    receiptFile,
    receiptDigest,
  };
  const entries: JournalEntry[] = [
    entry(paths, path.join(paths.treesDir, `${treeDigest}.json`), treeBytes),
    entry(paths, path.join(paths.recordsDir, `${recordDigest}.json`), recordBytes),
    entry(paths, path.join(paths.receiptsDir, receiptFile), receiptBytes),
    entry(paths, path.join(paths.commandsDir, commandIndexName(commit.commandId)), canonicalJsonBytes(index)),
  ];
  for (const event of commit.events) {
    const bytes = canonicalJsonBytes(event);
    const digest = sha256Digest(bytes);
    entries.push(entry(paths, path.join(paths.historyDir, `${String(event.sequence).padStart(12, '0')}--${digest}.json`), bytes));
  }
  for (const artifact of commit.artifacts) {
    verifyArtifactBody(artifact);
    entries.push(entry(paths, path.join(paths.artifactsDir, `${artifact.digest}.json`), canonicalJsonBytes(artifact)));
  }
  const deduplicated = new Map<string, JournalEntry>();
  for (const candidate of entries) {
    const prior = deduplicated.get(candidate.relativePath);
    if (prior && prior.dataBase64 !== candidate.dataBase64) {
      throw new FileTaskSpaceError('immutable-conflict', `${candidate.relativePath} has conflicting transaction bytes`);
    }
    deduplicated.set(candidate.relativePath, candidate);
  }
  const head: TaskSpaceHead = {
    kind: 'task-space-head',
    schemaVersion: 1,
    taskSpaceId: commit.taskSpaceId,
    revision: commit.snapshot.revision,
    recordDigest,
    treeDigest,
    commandId: commit.commandId,
    commandDigest: commit.commandDigest,
    receiptId: receipt.receiptId,
  };
  return { headBytes: canonicalJsonBytes(head), entries: [...deduplicated.values()] };
}

function entry(paths: FileTaskSpaceDiagnosticPaths, file: string, bytes: Uint8Array): JournalEntry {
  return {
    relativePath: path.relative(paths.spaceDir, file).split(path.sep).join('/'),
    dataBase64: Buffer.from(bytes).toString('base64'),
  };
}

function readCanonicalFile<Value>(file: string, expectedDigest?: TaskArtifactDigest): Value {
  const bytes = readRawFile(file);
  if (expectedDigest && sha256Digest(bytes) !== expectedDigest) digestMismatch(`${file} does not match ${expectedDigest}`);
  return parseCanonicalJson<Value>(bytes, file);
}

function readRawFile(file: string): Uint8Array {
  assertRegularFile(file);
  return Uint8Array.from(fs.readFileSync(file));
}

function writeImmutable(file: string, bytes: Uint8Array): void {
  if (fs.existsSync(file)) {
    const prior = readRawFile(file);
    if (!sameBytes(prior, bytes)) {
      throw new FileTaskSpaceError('immutable-conflict', `${file} already exists with different bytes`);
    }
    return;
  }
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(file));
}

function publishImmutable(
  file: string,
  bytes: Uint8Array,
  token: string,
  faultInjector?: (point: FileTaskSpaceFaultPoint) => void,
): void {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.txn-${token}`);
  if (fs.existsSync(file)) {
    if (!sameBytes(readRawFile(file), bytes)) {
      throw new FileTaskSpaceError('immutable-conflict', `${file} already exists with different bytes`);
    }
    durableUnlink(temporary);
    return;
  }
  if (fs.existsSync(temporary) && !sameBytes(readRawFile(temporary), bytes)) durableUnlink(temporary);
  if (!fs.existsSync(temporary)) {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      faultInjector?.('after-immutable-temp-create');
      fs.writeFileSync(fd, bytes);
      faultInjector?.('after-immutable-temp-write');
      fs.fsyncSync(fd);
      faultInjector?.('after-immutable-temp-fsync');
    } finally {
      fs.closeSync(fd);
    }
  } else {
    const fd = fs.openSync(temporary, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  try {
    fs.linkSync(temporary, file);
    faultInjector?.('after-immutable-publish');
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error;
    if (!sameBytes(readRawFile(file), bytes)) {
      throw new FileTaskSpaceError('immutable-conflict', `${file} already exists with different bytes`);
    }
  }
  fsyncDirectory(directory);
  durableUnlink(temporary);
}

function atomicReplace(file: string, bytes: Uint8Array, token: string): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.next-${token}`);
  if (fs.existsSync(temporary)) {
    const prior = readRawFile(temporary);
    if (!sameBytes(prior, bytes)) durableUnlink(temporary);
  }
  writeImmutable(temporary, bytes);
  fs.renameSync(temporary, file);
  fsyncDirectory(path.dirname(file));
}

function durableUnlink(file: string): void {
  if (!fs.existsSync(file)) return;
  assertRegularFile(file);
  fs.unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === code;
}

function commandIndexName(commandId: string): string {
  return `command-${encodeURIComponent(commandId)}.json`;
}

function receiptName(receiptId: string): string {
  return `receipt-${encodeURIComponent(receiptId)}`;
}

function assertDigest(digest: string): asserts digest is TaskArtifactDigest {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) digestMismatch(`invalid digest ${digest}`);
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${field} must be a positive safe integer`);
  return value;
}

function nonNegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative safe integer`);
  return value;
}

function corrupt(message: string): never {
  throw new FileTaskSpaceError('corrupt-head', message);
}

function digestMismatch(message: string): never {
  throw new FileTaskSpaceError('digest-mismatch', message);
}

function mapSharedAdmissionError<Value>(operation: () => Value): Value {
  try {
    return operation();
  } catch (error) {
    if (error instanceof TaskManagerError) {
      if (error.code === 'artifact-conflict'
        || error.code === 'artifact-not-found'
        || error.code === 'command-receipt-mismatch'
        || error.code === 'invalid-commit') {
        throw new FileTaskSpaceError(error.code, error.message.replace(/^\[[^\]]+\]\s*/, ''));
      }
    }
    throw error;
  }
}
