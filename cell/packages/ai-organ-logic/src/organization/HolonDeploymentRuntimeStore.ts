import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import process from "node:process"
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises"

import {
  canonicalHolonDeploymentRuntimeSnapshotBytes,
  normalizeHolonDeploymentRuntimeSnapshot,
  parseHolonDeploymentRuntimeSnapshotBytes,
  type HolonDeploymentRuntimeSnapshot,
} from "holarchy-eidolon-adapter"

import { loadHolonDeploymentDefinition } from "./HolonDeploymentDefinition"
import type { MaterializedHolonDeploymentDefinition } from "./HolonDeploymentDefinition"

export { normalizeHolonDeploymentRuntimeSnapshot } from "holarchy-eidolon-adapter"

export type HolonDeploymentRuntimeFault =
  | "after-record"
  | "after-tree"
  | "after-receipt"
  | "after-transaction-prepared"
  | "after-head"

export interface FileHolonDeploymentRuntimeStoreOptions {
  readonly supportRoot: string
  readonly faultAt?: HolonDeploymentRuntimeFault
  readonly lockTimeoutMs?: number
  readonly now?: () => number
}

export interface HolonDeploymentRuntimeCommit {
  readonly deploymentId: string
  readonly expectedRevision: number
  readonly next: HolonDeploymentRuntimeSnapshot
}

type Digest = `sha256:${string}`

interface RuntimeHead {
  readonly schemaVersion: "eidolon.holon-deployment-runtime-head/v1"
  readonly deploymentId: string
  readonly definitionSemanticFingerprint: Digest
  readonly revision: number
  readonly stateRecordDigest: Digest
  readonly treeDigest: Digest
  readonly receiptDigest: Digest
}

interface RuntimeTree {
  readonly schemaVersion: "eidolon.holon-deployment-runtime-tree/v1"
  readonly deploymentId: string
  readonly revision: number
  readonly stateRecordDigest: Digest
  readonly previousTreeDigest: Digest | null
}

interface RuntimeReceipt {
  readonly schemaVersion: "eidolon.holon-deployment-runtime-receipt/v1"
  readonly deploymentId: string
  readonly revision: number
  readonly stateRecordDigest: Digest
  readonly treeDigest: Digest
  readonly previousReceiptDigest: Digest | null
}

interface RuntimePreparedTransaction {
  readonly schemaVersion: "eidolon.holon-deployment-runtime-transaction/v1"
  readonly transactionId: string
  readonly deploymentId: string
  readonly expectedHeadDigest: Digest | null
  readonly nextHead: RuntimeHead
  readonly nextHeadDigest: Digest
}

interface RuntimeCommittedTransaction {
  readonly schemaVersion: "eidolon.holon-deployment-runtime-transaction-commit/v1"
  readonly transactionId: string
  readonly nextHeadDigest: Digest
}

interface LockOwner {
  readonly schemaVersion: "eidolon.holon-deployment-runtime-lock/v1"
  readonly token: string
  readonly pid: number
  readonly createdAtMs: number
}

interface HeldLock extends LockOwner {
  readonly file: string
  readonly device: number
  readonly inode: number
  readonly handle: Awaited<ReturnType<typeof open>>
}

interface RuntimePaths {
  readonly root: string
  readonly records: string
  readonly trees: string
  readonly receipts: string
  readonly transactions: string
  readonly head: string
  readonly lock: string
}

export class HolonDeploymentRuntimeStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonDeploymentRuntimeStoreError"
  }
}

const SHA256 = /^sha256:[0-9a-f]{64}$/
const compareUtf16 = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const fail = (code: string, message: string): never => {
  throw new HolonDeploymentRuntimeStoreError(code, message)
}

function digest(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false
  return true
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function exactString(value: unknown, location: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value !== value.normalize("NFC")) {
    return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_RECORD_INVALID", `${location} must be one exact string.`)
  }
  return value
}

function exactDigest(value: unknown, location: string): Digest {
  if (typeof value !== "string" || !SHA256.test(value)) {
    return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_RECORD_INVALID", `${location} must be one canonical sha256 digest.`)
  }
  return value as Digest
}

function exactRevision(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_RECORD_INVALID", `${location} must be one non-negative safe integer.`)
  }
  return value as number
}

function exactRecord(value: unknown, keys: readonly string[], location: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_RECORD_INVALID", `${location} must be one plain object.`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_RECORD_INVALID", `${location} has missing or unsupported fields.`)
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_RECORD_INVALID", `${location}.${key} must be enumerable own data.`)
    }
    result[key] = descriptor.value
  }
  return result
}

function exactLiteral<T extends string>(value: unknown, expected: T, location: string): T {
  if (value !== expected) fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_RECORD_INVALID", `${location} must equal '${expected}'.`)
  return expected
}

function normalizeHead(value: unknown): RuntimeHead {
  const record = exactRecord(value, [
    "schemaVersion",
    "deploymentId",
    "definitionSemanticFingerprint",
    "revision",
    "stateRecordDigest",
    "treeDigest",
    "receiptDigest",
  ], "head")
  return Object.freeze({
    schemaVersion: exactLiteral(record.schemaVersion, "eidolon.holon-deployment-runtime-head/v1", "head.schemaVersion"),
    deploymentId: exactString(record.deploymentId, "head.deploymentId"),
    definitionSemanticFingerprint: exactDigest(record.definitionSemanticFingerprint, "head.definitionSemanticFingerprint"),
    revision: exactRevision(record.revision, "head.revision"),
    stateRecordDigest: exactDigest(record.stateRecordDigest, "head.stateRecordDigest"),
    treeDigest: exactDigest(record.treeDigest, "head.treeDigest"),
    receiptDigest: exactDigest(record.receiptDigest, "head.receiptDigest"),
  })
}

function normalizeTree(value: unknown): RuntimeTree {
  const record = exactRecord(value, [
    "schemaVersion", "deploymentId", "revision", "stateRecordDigest", "previousTreeDigest",
  ], "tree")
  return Object.freeze({
    schemaVersion: exactLiteral(record.schemaVersion, "eidolon.holon-deployment-runtime-tree/v1", "tree.schemaVersion"),
    deploymentId: exactString(record.deploymentId, "tree.deploymentId"),
    revision: exactRevision(record.revision, "tree.revision"),
    stateRecordDigest: exactDigest(record.stateRecordDigest, "tree.stateRecordDigest"),
    previousTreeDigest: record.previousTreeDigest === null
      ? null
      : exactDigest(record.previousTreeDigest, "tree.previousTreeDigest"),
  })
}

function normalizeReceipt(value: unknown): RuntimeReceipt {
  const record = exactRecord(value, [
    "schemaVersion", "deploymentId", "revision", "stateRecordDigest", "treeDigest", "previousReceiptDigest",
  ], "receipt")
  return Object.freeze({
    schemaVersion: exactLiteral(record.schemaVersion, "eidolon.holon-deployment-runtime-receipt/v1", "receipt.schemaVersion"),
    deploymentId: exactString(record.deploymentId, "receipt.deploymentId"),
    revision: exactRevision(record.revision, "receipt.revision"),
    stateRecordDigest: exactDigest(record.stateRecordDigest, "receipt.stateRecordDigest"),
    treeDigest: exactDigest(record.treeDigest, "receipt.treeDigest"),
    previousReceiptDigest: record.previousReceiptDigest === null
      ? null
      : exactDigest(record.previousReceiptDigest, "receipt.previousReceiptDigest"),
  })
}

function normalizeTransaction(value: unknown): RuntimePreparedTransaction {
  const record = exactRecord(value, [
    "schemaVersion", "transactionId", "deploymentId", "expectedHeadDigest", "nextHead", "nextHeadDigest",
  ], "transaction")
  const nextHead = normalizeHead(record.nextHead)
  return Object.freeze({
    schemaVersion: exactLiteral(record.schemaVersion, "eidolon.holon-deployment-runtime-transaction/v1", "transaction.schemaVersion"),
    transactionId: exactString(record.transactionId, "transaction.transactionId"),
    deploymentId: exactString(record.deploymentId, "transaction.deploymentId"),
    expectedHeadDigest: record.expectedHeadDigest === null
      ? null
      : exactDigest(record.expectedHeadDigest, "transaction.expectedHeadDigest"),
    nextHead,
    nextHeadDigest: exactDigest(record.nextHeadDigest, "transaction.nextHeadDigest"),
  })
}

function normalizeCommit(value: unknown): RuntimeCommittedTransaction {
  const record = exactRecord(value, ["schemaVersion", "transactionId", "nextHeadDigest"], "transactionCommit")
  return Object.freeze({
    schemaVersion: exactLiteral(record.schemaVersion, "eidolon.holon-deployment-runtime-transaction-commit/v1", "transactionCommit.schemaVersion"),
    transactionId: exactString(record.transactionId, "transactionCommit.transactionId"),
    nextHeadDigest: exactDigest(record.nextHeadDigest, "transactionCommit.nextHeadDigest"),
  })
}

function normalizeLock(value: unknown): LockOwner {
  const record = exactRecord(value, ["schemaVersion", "token", "pid", "createdAtMs"], "lock")
  const pid = exactRevision(record.pid, "lock.pid")
  const createdAtMs = exactRevision(record.createdAtMs, "lock.createdAtMs")
  if (pid === 0) fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_LOCK_INVALID", "lock.pid must be positive.")
  return Object.freeze({
    schemaVersion: exactLiteral(record.schemaVersion, "eidolon.holon-deployment-runtime-lock/v1", "lock.schemaVersion"),
    token: exactString(record.token, "lock.token"),
    pid,
    createdAtMs,
  })
}

function parseJsonBytes<T>(bytes: Uint8Array, normalize: (value: unknown) => T, location: string): T {
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_RECORD_INVALID", `${location} is not UTF-8.`)
  }
  let value: unknown
  try {
    value = JSON.parse(decoded)
  } catch {
    return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_RECORD_INVALID", `${location} is not JSON.`)
  }
  const normalized = normalize(value)
  if (!sameBytes(bytes, canonicalBytes(normalized))) {
    return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_RECORD_INVALID", `${location} is not canonical.`)
  }
  return normalized
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function physicalDirectory(directory: string, parentRoot: string, create: boolean): Promise<string> {
  if (create) {
    try {
      await mkdir(directory)
      await syncDirectory(parentRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  const facts = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_MISSING", `Runtime directory '${directory}' is missing.`)
    throw error
  })
  if (!facts.isDirectory() || facts.isSymbolicLink()) {
    return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_BOUNDARY_INVALID", `Runtime directory '${directory}' must be physical.`)
  }
  const canonical = await realpath(directory)
  if (!contained(parentRoot, canonical)) {
    return fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_BOUNDARY_INVALID", `Runtime directory '${directory}' escapes its deployment.`)
  }
  return canonical
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function runtimePaths(definitionDir: string, create: boolean): Promise<RuntimePaths> {
  const deploymentRoot = await realpath(path.dirname(definitionDir))
  const runtimeRoot = await physicalDirectory(path.join(deploymentRoot, "runtime"), deploymentRoot, create)
  const directories: Record<"records" | "trees" | "receipts" | "transactions", string> = {
    records: path.join(runtimeRoot, "records"),
    trees: path.join(runtimeRoot, "trees"),
    receipts: path.join(runtimeRoot, "receipts"),
    transactions: path.join(runtimeRoot, "transactions"),
  }
  for (const directory of Object.values(directories)) await physicalDirectory(directory, runtimeRoot, create)
  return Object.freeze({
    root: runtimeRoot,
    ...directories,
    head: path.join(runtimeRoot, "head.json"),
    lock: path.join(runtimeRoot, "runtime.lock"),
  })
}

async function readPhysicalFile(root: string, target: string): Promise<Uint8Array> {
  const lexical = path.resolve(target)
  if (!contained(root, lexical)) fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_BOUNDARY_INVALID", "Runtime file escapes its root.")
  const facts = await lstat(lexical)
  if (!facts.isFile() || facts.isSymbolicLink()) {
    fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_BOUNDARY_INVALID", `Runtime file '${path.basename(target)}' must be physical.`)
  }
  const canonical = await realpath(lexical)
  if (!contained(root, canonical)) fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_BOUNDARY_INVALID", "Runtime file escapes its root.")
  return readFile(canonical)
}

async function writeFileSynced(target: string, bytes: Uint8Array, flag: "wx" | "w" = "wx"): Promise<void> {
  const handle = await open(target, flag, 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeImmutable(directory: string, target: string, bytes: Uint8Array): Promise<void> {
  if (await exists(target)) {
    if (!sameBytes(await readPhysicalFile(directory, target), bytes)) {
      fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_IMMUTABLE_CONFLICT", `Immutable file '${path.basename(target)}' conflicts.`)
    }
    return
  }
  const candidate = path.join(directory, `.${path.basename(target)}.candidate-${randomUUID()}`)
  await writeFileSynced(candidate, bytes)
  try {
    await link(candidate, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (!sameBytes(await readPhysicalFile(directory, target), bytes)) {
      fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_IMMUTABLE_CONFLICT", `Immutable file '${path.basename(target)}' conflicts.`)
    }
  } finally {
    await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
  await syncDirectory(directory)
}

async function writeHead(paths: RuntimePaths, head: RuntimeHead): Promise<void> {
  const candidate = path.join(paths.root, `.head-candidate-${randomUUID()}`)
  await writeFileSynced(candidate, canonicalBytes(head))
  await rename(candidate, paths.head)
  await syncDirectory(paths.root)
}

function materialPath(directory: string, value: Digest): string {
  return path.join(directory, `${value.slice("sha256:".length)}.json`)
}

function transition(current: HolonDeploymentRuntimeSnapshot, next: HolonDeploymentRuntimeSnapshot): void {
  if (next.deploymentId !== current.deploymentId
    || next.definitionSemanticFingerprint !== current.definitionSemanticFingerprint) {
    fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_IDENTITY_CONFLICT", "Deployment runtime identity is immutable.")
  }
  if (next.revision !== current.revision + 1) {
    fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_REVISION_CONFLICT", "Deployment runtime revision must advance by exactly one.")
  }
  const compareRetained = <T extends object>(
    before: readonly T[],
    after: readonly T[],
    identity: (value: T) => string,
    stable: (value: T) => unknown,
    status: (value: T) => string,
  ): void => {
    const byIdentity = new Map<string, T>()
    for (const entry of after) byIdentity.set(identity(entry), entry)
    for (const previous of before) {
      const candidate = byIdentity.get(identity(previous))
      if (!candidate) fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_FACT_REMOVED", `Runtime fact '${identity(previous)}' cannot disappear.`)
      const retained = candidate as T
      if (JSON.stringify(stable(previous)) !== JSON.stringify(stable(retained))) {
        fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_FACT_IDENTITY_CONFLICT", `Runtime fact '${identity(previous)}' changed owner identity.`)
      }
      if (status(previous) === "stopped" && status(retained) !== "stopped") {
        fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_FACT_REOPENED", `Stopped fact '${identity(previous)}' cannot reopen.`)
      }
    }
  }
  compareRetained(
    current.coordinators,
    next.coordinators,
    (entry) => entry.holonRef,
    (entry) => ({ holonRef: entry.holonRef, actorRef: entry.actorRef, registrationReceipt: entry.registrationReceipt }),
    (entry) => entry.status,
  )
  compareRetained(
    current.members,
    next.members,
    (entry) => entry.runtimeRef,
    (entry) => ({
      runtimeRef: entry.runtimeRef,
      holonRef: entry.holonRef,
      memberRef: entry.memberRef,
      isolation: entry.isolation,
      actorRef: entry.actorRef,
      registrationReceipt: entry.registrationReceipt,
    }),
    (entry) => entry.status,
  )
  for (const previous of current.members) {
    const candidate = next.members.find((entry) => entry.runtimeRef === previous.runtimeRef)!
    if (candidate.sessions.length < previous.sessions.length
      || previous.sessions.some((session) => !candidate.sessions.some(
        (nextSession) => JSON.stringify(session) === JSON.stringify(nextSession),
      ))) {
      fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_SESSION_CONFLICT", `Member '${previous.runtimeRef}' session facts must be retained exactly.`)
    }
  }
  compareRetained(
    current.subscriptions,
    next.subscriptions,
    (entry) => entry.taskSpaceId,
    (entry) => ({ taskSpaceId: entry.taskSpaceId, holonRef: entry.holonRef }),
    (entry) => entry.status === "closed" ? "stopped" : entry.status,
  )
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

export class FileHolonDeploymentRuntimeStore {
  private readonly supportRoot: string
  private readonly faultAt?: HolonDeploymentRuntimeFault
  private readonly lockTimeoutMs: number
  private readonly now: () => number

  constructor(options: FileHolonDeploymentRuntimeStoreOptions) {
    this.supportRoot = options.supportRoot
    this.faultAt = options.faultAt
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000
    this.now = options.now ?? Date.now
  }

  async open(deploymentId: string): Promise<HolonDeploymentRuntimeSnapshot> {
    const definition = await loadHolonDeploymentDefinition(
      { supportRoot: this.supportRoot },
      { deploymentId },
      {},
    )
    const paths = await runtimePaths(definition.definitionDir, true)
    return this.withLock(paths, async () => {
      await this.recover(paths)
      const existing = await this.readCurrent(paths)
      if (existing) return existing.snapshot
      const initial = normalizeHolonDeploymentRuntimeSnapshot({
        schemaVersion: "eidolon.holon-deployment-runtime/v1",
        deploymentId,
        definitionSemanticFingerprint: definition.definition.bindingSemanticFingerprint,
        revision: 0,
        coordinators: [],
        members: [],
        subscriptions: [],
      })
      await this.commitLocked(paths, undefined, initial, false)
      return initial
    })
  }

  loadDefinition(deploymentId: string): Promise<MaterializedHolonDeploymentDefinition> {
    return loadHolonDeploymentDefinition(
      { supportRoot: this.supportRoot },
      { deploymentId },
      {},
    )
  }

  async load(deploymentId: string): Promise<HolonDeploymentRuntimeSnapshot> {
    const definition = await loadHolonDeploymentDefinition(
      { supportRoot: this.supportRoot },
      { deploymentId },
      {},
    )
    const paths = await runtimePaths(definition.definitionDir, false)
    return this.withLock(paths, async () => {
      await this.recover(paths)
      const current = await this.readCurrent(paths)
        ?? fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_HEAD_MISSING", "Deployment runtime head is missing.")
      if (current.snapshot.definitionSemanticFingerprint !== definition.definition.bindingSemanticFingerprint) {
        fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_DEFINITION_MISMATCH", "Runtime head does not belong to the frozen deployment definition.")
      }
      return current.snapshot
    })
  }

  async commit(input: HolonDeploymentRuntimeCommit): Promise<HolonDeploymentRuntimeSnapshot> {
    const definition = await loadHolonDeploymentDefinition(
      { supportRoot: this.supportRoot },
      { deploymentId: input.deploymentId },
      {},
    )
    const paths = await runtimePaths(definition.definitionDir, false)
    return this.withLock(paths, async () => {
      await this.recover(paths)
      const current = await this.readCurrent(paths)
      if (!current || current.snapshot.revision !== input.expectedRevision) {
        fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_CAS_CONFLICT", `Expected revision ${input.expectedRevision} is not current.`)
      }
      const accepted = current
        ?? fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_CAS_CONFLICT", "Deployment runtime head is missing.")
      const next = normalizeHolonDeploymentRuntimeSnapshot(input.next)
      transition(accepted.snapshot, next)
      await this.commitLocked(paths, accepted.head, next, true)
      return next
    })
  }

  private async commitLocked(
    paths: RuntimePaths,
    previous: RuntimeHead | undefined,
    snapshot: HolonDeploymentRuntimeSnapshot,
    allowFault: boolean,
  ): Promise<void> {
    const recordBytes = canonicalHolonDeploymentRuntimeSnapshotBytes(snapshot)
    const stateRecordDigest = digest(recordBytes)
    const tree = normalizeTree({
      schemaVersion: "eidolon.holon-deployment-runtime-tree/v1",
      deploymentId: snapshot.deploymentId,
      revision: snapshot.revision,
      stateRecordDigest,
      previousTreeDigest: previous?.treeDigest ?? null,
    })
    const treeBytes = canonicalBytes(tree)
    const treeDigest = digest(treeBytes)
    const receipt = normalizeReceipt({
      schemaVersion: "eidolon.holon-deployment-runtime-receipt/v1",
      deploymentId: snapshot.deploymentId,
      revision: snapshot.revision,
      stateRecordDigest,
      treeDigest,
      previousReceiptDigest: previous?.receiptDigest ?? null,
    })
    const receiptBytes = canonicalBytes(receipt)
    const receiptDigest = digest(receiptBytes)
    const head = normalizeHead({
      schemaVersion: "eidolon.holon-deployment-runtime-head/v1",
      deploymentId: snapshot.deploymentId,
      definitionSemanticFingerprint: snapshot.definitionSemanticFingerprint,
      revision: snapshot.revision,
      stateRecordDigest,
      treeDigest,
      receiptDigest,
    })
    const headBytes = canonicalBytes(head)
    const transactionId = `tx-${snapshot.revision}-${randomUUID()}`
    const prepared = normalizeTransaction({
      schemaVersion: "eidolon.holon-deployment-runtime-transaction/v1",
      transactionId,
      deploymentId: snapshot.deploymentId,
      expectedHeadDigest: previous ? digest(canonicalBytes(previous)) : null,
      nextHead: head,
      nextHeadDigest: digest(headBytes),
    })

    await writeImmutable(paths.records, materialPath(paths.records, stateRecordDigest), recordBytes)
    this.inject("after-record", allowFault)
    await writeImmutable(paths.trees, materialPath(paths.trees, treeDigest), treeBytes)
    this.inject("after-tree", allowFault)
    await writeImmutable(paths.receipts, materialPath(paths.receipts, receiptDigest), receiptBytes)
    this.inject("after-receipt", allowFault)
    const preparedFile = path.join(paths.transactions, `${transactionId}.prepared.json`)
    await writeImmutable(paths.transactions, preparedFile, canonicalBytes(prepared))
    this.inject("after-transaction-prepared", allowFault)
    await writeHead(paths, head)
    this.inject("after-head", allowFault)
    await this.commitTransaction(paths, prepared)
  }

  private inject(stage: HolonDeploymentRuntimeFault, enabled: boolean): void {
    if (enabled && this.faultAt === stage) throw new Error(`Injected ${stage}`)
  }

  private async readCurrent(paths: RuntimePaths): Promise<{ readonly head: RuntimeHead; readonly snapshot: HolonDeploymentRuntimeSnapshot } | undefined> {
    if (!(await exists(paths.head))) return undefined
    const head = parseJsonBytes(await readPhysicalFile(paths.root, paths.head), normalizeHead, "head")
    const recordFile = materialPath(paths.records, head.stateRecordDigest)
    const recordBytes = await readPhysicalFile(paths.records, recordFile)
    if (digest(recordBytes) !== head.stateRecordDigest) fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_DIGEST_MISMATCH", "State record digest mismatch.")
    const snapshot = parseHolonDeploymentRuntimeSnapshotBytes(recordBytes)
    const treeBytes = await readPhysicalFile(paths.trees, materialPath(paths.trees, head.treeDigest))
    const receiptBytes = await readPhysicalFile(paths.receipts, materialPath(paths.receipts, head.receiptDigest))
    if (digest(treeBytes) !== head.treeDigest || digest(receiptBytes) !== head.receiptDigest) {
      fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_DIGEST_MISMATCH", "Tree or receipt digest mismatch.")
    }
    const tree = parseJsonBytes(treeBytes, normalizeTree, "tree")
    const receipt = parseJsonBytes(receiptBytes, normalizeReceipt, "receipt")
    if (snapshot.deploymentId !== head.deploymentId || snapshot.revision !== head.revision
      || snapshot.definitionSemanticFingerprint !== head.definitionSemanticFingerprint
      || tree.deploymentId !== head.deploymentId || tree.revision !== head.revision
      || tree.stateRecordDigest !== head.stateRecordDigest
      || receipt.deploymentId !== head.deploymentId || receipt.revision !== head.revision
      || receipt.stateRecordDigest !== head.stateRecordDigest || receipt.treeDigest !== head.treeDigest) {
      fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_PROJECTION_MISMATCH", "Head, tree, receipt and state record disagree.")
    }
    return Object.freeze({ head, snapshot })
  }

  private async recover(paths: RuntimePaths): Promise<void> {
    const names = (await readdir(paths.transactions)).filter((name) => name.endsWith(".prepared.json")).sort(compareUtf16)
    for (const name of names) {
      const prepared = parseJsonBytes(
        await readPhysicalFile(paths.transactions, path.join(paths.transactions, name)),
        normalizeTransaction,
        name,
      )
      const committedFile = path.join(paths.transactions, `${prepared.transactionId}.committed.json`)
      if (await exists(committedFile)) {
        const committed = parseJsonBytes(
          await readPhysicalFile(paths.transactions, committedFile),
          normalizeCommit,
          path.basename(committedFile),
        )
        if (committed.transactionId !== prepared.transactionId
          || committed.nextHeadDigest !== prepared.nextHeadDigest) {
          fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_TRANSACTION_CONFLICT", "Committed transaction does not match its prepared fact.")
        }
        continue
      }
      await this.verifyTransactionMaterials(paths, prepared)
      const currentBytes = await exists(paths.head) ? await readPhysicalFile(paths.root, paths.head) : undefined
      const currentDigest = currentBytes ? digest(currentBytes) : null
      if (currentDigest !== prepared.nextHeadDigest) {
        if (currentDigest !== prepared.expectedHeadDigest) {
          fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_TRANSACTION_AMBIGUOUS", `Transaction '${prepared.transactionId}' cannot be rolled forward from the current head.`)
        }
        await writeHead(paths, prepared.nextHead)
      }
      await this.commitTransaction(paths, prepared)
    }
  }

  private async verifyTransactionMaterials(paths: RuntimePaths, transaction: RuntimePreparedTransaction): Promise<void> {
    const head = transaction.nextHead
    const record = await readPhysicalFile(paths.records, materialPath(paths.records, head.stateRecordDigest))
    const tree = await readPhysicalFile(paths.trees, materialPath(paths.trees, head.treeDigest))
    const receipt = await readPhysicalFile(paths.receipts, materialPath(paths.receipts, head.receiptDigest))
    if (digest(record) !== head.stateRecordDigest || digest(tree) !== head.treeDigest || digest(receipt) !== head.receiptDigest
      || digest(canonicalBytes(head)) !== transaction.nextHeadDigest) {
      fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_TRANSACTION_MATERIAL_INVALID", `Transaction '${transaction.transactionId}' material failed readback.`)
    }
    parseHolonDeploymentRuntimeSnapshotBytes(record)
    parseJsonBytes(tree, normalizeTree, "transaction.tree")
    parseJsonBytes(receipt, normalizeReceipt, "transaction.receipt")
  }

  private async commitTransaction(paths: RuntimePaths, prepared: RuntimePreparedTransaction): Promise<void> {
    const committed = normalizeCommit({
      schemaVersion: "eidolon.holon-deployment-runtime-transaction-commit/v1",
      transactionId: prepared.transactionId,
      nextHeadDigest: prepared.nextHeadDigest,
    })
    await writeImmutable(
      paths.transactions,
      path.join(paths.transactions, `${prepared.transactionId}.committed.json`),
      canonicalBytes(committed),
    )
  }

  private async withLock<T>(paths: RuntimePaths, operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquireLock(paths)
    try {
      return await operation()
    } finally {
      await this.releaseLock(paths, lock)
    }
  }

  private async acquireLock(paths: RuntimePaths): Promise<HeldLock> {
    const deadline = this.now() + this.lockTimeoutMs
    while (true) {
      const owner: LockOwner = Object.freeze({
        schemaVersion: "eidolon.holon-deployment-runtime-lock/v1",
        token: randomUUID(),
        pid: process.pid,
        createdAtMs: this.now(),
      })
      try {
        const handle = await open(paths.lock, "wx", 0o600)
        try {
          await handle.writeFile(canonicalBytes(owner))
          await handle.sync()
          const facts = await handle.stat()
          await syncDirectory(paths.root)
          return Object.freeze({ ...owner, file: paths.lock, device: facts.dev, inode: facts.ino, handle })
        } catch (error) {
          await handle.close()
          throw error
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      const currentBytes = await readPhysicalFile(paths.root, paths.lock)
      const current = parseJsonBytes(currentBytes, normalizeLock, "runtime.lock")
      if (!pidAlive(current.pid)) {
        const claim = `${paths.lock}.claim-${randomUUID()}`
        try {
          await link(paths.lock, claim)
          const [lockFacts, claimFacts] = await Promise.all([lstat(paths.lock), lstat(claim)])
          if (lockFacts.dev !== claimFacts.dev || lockFacts.ino !== claimFacts.ino) continue
          if (!sameBytes(await readPhysicalFile(paths.root, claim), currentBytes)) continue
          await unlink(paths.lock)
          await syncDirectory(paths.root)
        } catch (error) {
          if (!new Set(["ENOENT", "EEXIST"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error
        } finally {
          await unlink(claim).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
          })
        }
        continue
      }
      if (this.now() >= deadline) {
        fail("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_LOCK_TIMEOUT", "Timed out waiting for the deployment runtime lock.")
      }
      await pause(5)
    }
  }

  private async releaseLock(paths: RuntimePaths, lock: HeldLock): Promise<void> {
    await lock.handle.close()
    if (!(await exists(lock.file))) return
    const facts = await lstat(lock.file)
    if (!facts.isFile() || facts.isSymbolicLink() || facts.dev !== lock.device || facts.ino !== lock.inode) return
    const owner = parseJsonBytes(await readPhysicalFile(paths.root, lock.file), normalizeLock, "runtime.lock")
    if (owner.token !== lock.token) return
    await unlink(lock.file)
    await syncDirectory(paths.root)
  }
}
