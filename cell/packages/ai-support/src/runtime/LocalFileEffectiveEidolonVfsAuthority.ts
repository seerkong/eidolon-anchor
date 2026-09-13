import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { areXnlSnapshotsStructurallyEqual, VirtualFileSystem, type RevisionedVfsAuthority, type RevisionedVfsCompareAndSwapResult, type RevisionedVfsFlushInput, type RevisionedVfsSnapshot } from "xnl-vfs"
import type { DataElementNode } from "xnl-core"
import type { EidolonVfsPublicationRecord, EidolonVfsWorkspaceByteWrite, EidolonVfsWorkspaceWrite } from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"
import { assertEidolonVfsMaterializationReceipt } from "@cell/symbiont-logic/resource/EffectiveEidolonVFS"
import { effectiveEidolonVfsTreeDigest } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"
import { eidolonVfsPublicationKey, type EidolonVfsPublicationContext, type EffectiveEidolonVfsPublicationAuthority } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsPublication"

type Head = RevisionedVfsSnapshot & { publication?: EidolonVfsPublicationRecord }
type PublicationRow = { identity: string; record: string; context: string; record_digest: string }
type VerifiedPublication = { identity: string; record: EidolonVfsPublicationRecord; context: EidolonVfsPublicationContext }
type PendingRow = { publication_key: string; input: string }

export interface LocalFileEffectiveEidolonVfsAuthorityOptions {
  readonly databasePath: string
  readonly workspaceEidolonRoot: string
  readonly builtinSnapshot: DataElementNode
  readonly authorityId?: string
  readonly clock?: () => string
  /** Fault injection observes the durable commit before physical projection. */
  readonly afterCommit?: (record: EidolonVfsPublicationRecord) => void
  readonly beforeCommit?: (record: EidolonVfsPublicationRecord) => void
  /** Called immediately before each individual physical projection. */
  readonly beforeProjection?: (write: EidolonVfsWorkspaceByteWrite, record: EidolonVfsPublicationRecord) => void
}

/** SQLite owns the native revision CAS and publication record in one transaction. */
export class LocalFileEffectiveEidolonVfsAuthority implements EffectiveEidolonVfsPublicationAuthority {
  private readonly db: Database
  private readonly workspaceRoot: string
  private readonly clock: () => string

  constructor(private readonly options: LocalFileEffectiveEidolonVfsAuthorityOptions) {
    this.workspaceRoot = path.resolve(options.workspaceEidolonRoot)
    if (existsSync(this.workspaceRoot) && lstatSync(this.workspaceRoot).isSymbolicLink()) throw new Error("EIDOLON_VFS_WORKSPACE_SYMLINK")
    this.clock = options.clock ?? (() => new Date().toISOString())
    mkdirSync(path.dirname(options.databasePath), { recursive: true })
    if (existsSync(options.databasePath) && lstatSync(options.databasePath).isSymbolicLink()) throw new Error("EIDOLON_VFS_AUTHORITY_SYMLINK")
    this.db = new Database(options.databasePath, { create: true, strict: true })
    try {
      this.db.exec("PRAGMA busy_timeout=100; PRAGMA synchronous=FULL;")
      const columns = this.db.query("PRAGMA table_info(vfs_publications)").all() as { name: string }[]
      // This backend is not yet released. Never attest pre-integrity rows by hashing suspect bytes.
      if (columns.length && ["context", "record_digest"].some(name => !columns.some(column => column.name === name))) throw new Error("EIDOLON_VFS_AUTHORITY_INTEGRITY_UPGRADE_REQUIRED")
      this.db.exec("CREATE TABLE IF NOT EXISTS vfs_head (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS vfs_publications (publication_key TEXT PRIMARY KEY, identity TEXT NOT NULL, record TEXT NOT NULL, context TEXT NOT NULL, record_digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS vfs_pending_projections (publication_key TEXT PRIMARY KEY, input TEXT NOT NULL);")
      const initial: Head = { revision: { authorityId: options.authorityId ?? "eidolon-effective-vfs", value: randomUUID() }, snapshot: structuredClone(options.builtinSnapshot) }
      this.db.query("INSERT OR IGNORE INTO vfs_head(id,data) VALUES (1,?)").run(JSON.stringify(initial))
      if (this.read().revision.authorityId !== initial.revision.authorityId) throw new Error("EIDOLON_VFS_AUTHORITY_ID_MISMATCH")
    } catch (error) { this.db.close(); throw error }
  }

  close(): void { this.db.close() }
  read(): RevisionedVfsSnapshot { const { revision, snapshot } = this.readHead(); return { revision, snapshot } }
  readHead(): Head {
    const row = this.db.query("SELECT data FROM vfs_head WHERE id=1").get() as { data: string }
    const head = JSON.parse(row.data) as Head
    if (!head.revision?.authorityId || !head.revision.value || !head.snapshot) throw new Error("EIDOLON_VFS_HEAD_INVALID")
    if (head.publication) {
      const stored = this.readPublication(head.publication.publicationKey)
      if (!stored || canonical(stored.record) !== canonical(head.publication)) throw new Error("EIDOLON_VFS_HEAD_PUBLICATION_INTEGRITY_MISMATCH")
      if (effectiveEidolonVfsTreeDigest(head.snapshot) !== head.publication.receipt.publishedRevision) throw new Error("EIDOLON_VFS_HEAD_DIGEST_MISMATCH")
    }
    return head
  }

  lookupPublication(key: string): EidolonVfsPublicationRecord | undefined {
    return this.readPublication(key)?.record
  }

  private readPublication(key: string): VerifiedPublication | undefined {
    const row = this.db.query("SELECT identity,record,context,record_digest FROM vfs_publications WHERE publication_key=?").get(key) as PublicationRow | null
    if (!row) return undefined
    if (!row.identity || !row.context || !row.record_digest) throw new Error("EIDOLON_VFS_PUBLICATION_INTEGRITY_MISSING")
    let record: EidolonVfsPublicationRecord
    let context: EidolonVfsPublicationContext
    try {
      record = JSON.parse(row.record)
      context = JSON.parse(row.context)
      // Corruption detection only: this is not authentication against a DB owner who can rehash.
      if (hash(canonical(record)) !== row.record_digest || publicationIdentity(context) !== row.identity
        || eidolonVfsPublicationKey(context) !== key || canonical(context.plan) !== canonical(record.plan)
        || canonical(context.association) !== canonical(record.association)
        || canonical(context.validators) !== canonical(record.receipt.validation.validators)) throw new Error("mismatch")
    } catch { throw new Error("EIDOLON_VFS_PUBLICATION_INTEGRITY_MISMATCH") }
    verifyRecord(record)
    if (record.publicationKey !== key) throw new Error("EIDOLON_VFS_PUBLICATION_KEY_MISMATCH")
    return { identity: row.identity, record, context }
  }

  scopePublication(context: EidolonVfsPublicationContext): RevisionedVfsAuthority {
    const frozenInput = structuredClone(context)
    return { read: () => this.read(), compareAndSwap: input => this.commit(input, frozenInput) }
  }

  compareAndSwap(input: RevisionedVfsFlushInput): RevisionedVfsCompareAndSwapResult { return this.commit(input) }

  recoverProjections(): void { this.immediate(() => this.projectPending()) }

  private commit(input: RevisionedVfsFlushInput, context?: EidolonVfsPublicationContext): RevisionedVfsCompareAndSwapResult {
    const submitted = structuredClone(input)
    let committedRecord: EidolonVfsPublicationRecord | undefined
    const result = this.immediate((): RevisionedVfsCompareAndSwapResult => {
      this.projectPending()
      const current = this.readHead()
      if (current.revision.authorityId !== submitted.expectedRevision.authorityId || current.revision.value !== submitted.expectedRevision.value) return { status: "conflict", actualRevision: current.revision }
      const unchanged = areXnlSnapshotsStructurallyEqual(current.snapshot, submitted.snapshot)
      const persistedAt = this.clock()
      const revision = unchanged ? current.revision : { authorityId: current.revision.authorityId, value: randomUUID() }
      let publication: EidolonVfsPublicationRecord | undefined
      if (context) {
        const key = eidolonVfsPublicationKey(context)
        if (!key || effectiveEidolonVfsTreeDigest(submitted.snapshot) !== context.plan.candidateTreeDigest) throw new Error("EIDOLON_VFS_PUBLICATION_CANDIDATE_MISMATCH")
        if (context.plan.expectedCurrentRevision !== effectiveEidolonVfsTreeDigest(current.snapshot)) throw new Error("EIDOLON_VFS_PUBLICATION_BASE_MISMATCH")
        const identity = publicationIdentity(context)
        const existing = this.readPublication(key)
        if (existing && existing.identity !== identity) throw new Error("EIDOLON_VFS_PUBLICATION_IDENTITY_CONFLICT")
        this.preflightWrites(context, submitted.snapshot)
        publication = existing ? existing.record : {
          publicationKey: key,
          ...(context.association ? { association: context.association } : {}),
          plan: context.plan,
          receipt: {
            schemaVersion: "eidolon.vfs-materialization-receipt/v1", status: "admitted",
            receiptId: `admitted:${hash(`${context.plan.planId}\0${persistedAt}`).slice(0, 24)}`,
            planId: context.plan.planId, previousRevision: context.plan.expectedCurrentRevision,
            publishedRevision: context.plan.candidateTreeDigest, candidateTreeDigest: context.plan.candidateTreeDigest,
            validation: { validatedAt: persistedAt, validators: context.validators }, publishedAt: persistedAt,
          },
        }
        verifyRecord(publication!)
        if (!existing) this.db.query("INSERT INTO vfs_publications(publication_key,identity,record,context,record_digest) VALUES (?,?,?,?,?)").run(key, identity, JSON.stringify(publication), JSON.stringify(context), hash(canonical(publication)))
        const projectionInput = projectionInputFor(context)
        if (projectionInput) this.db.query("INSERT OR IGNORE INTO vfs_pending_projections(publication_key,input) VALUES (?,?)").run(key, JSON.stringify(projectionInput))
        committedRecord = publication
      }
      if (!unchanged || publication) this.db.query("UPDATE vfs_head SET data=? WHERE id=1").run(JSON.stringify({ revision, snapshot: submitted.snapshot, ...(publication ? { publication } : {}) }))
      if (publication) this.options.beforeCommit?.(publication)
      return unchanged ? { status: "unchanged", revision } : { status: "applied", receipt: { previousRevision: current.revision, revision, persistedAt, durability: "workspace" } }
    })
    // A failure here is an uncertain caller outcome, never a failed/uncommitted CAS.
    if (committedRecord) this.options.afterCommit?.(committedRecord)
    this.recoverProjections()
    return result
  }

  private immediate<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try { const result = operation(); this.db.exec("COMMIT"); return result }
    catch (error) { if (this.db.inTransaction) this.db.exec("ROLLBACK"); throw error }
  }

  private target(write: Pick<EidolonVfsWorkspaceByteWrite, "logicalPath">): string {
    if (!write.logicalPath.startsWith("/.eidolon/resources/")) throw new Error("EIDOLON_VFS_WORKSPACE_PATH_INVALID")
    const relative = write.logicalPath.slice("/.eidolon/".length)
    if (relative.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) throw new Error("EIDOLON_VFS_WORKSPACE_PATH_INVALID")
    const target = path.join(this.workspaceRoot, relative)
    let cursor = this.workspaceRoot
    for (const segment of ["", ...relative.split("/")]) {
      if (segment) cursor = path.join(cursor, segment)
      try { if (lstatSync(cursor).isSymbolicLink()) throw new Error("EIDOLON_VFS_WORKSPACE_SYMLINK") }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    return target
  }

  private preflightWrites(context: EidolonVfsPublicationContext, snapshot: DataElementNode): void {
    const writes = projectionWrites(context)
    if (!writes.length) return
    validateBatch(writes)
    const vfs = new VirtualFileSystem(snapshot)
    for (const write of writes) {
      const target = this.target(write)
      const candidate = vfsBytes(vfs, write.logicalPath)
      if (!matchesAfter(write, candidate)) throw new Error("EIDOLON_VFS_PROJECTION_CANDIDATE_MISMATCH")
      if (!matchesBefore(write, readOptional(target))) throw new Error("EIDOLON_VFS_WORKSPACE_CAS_CONFLICT")
    }
  }

  private projectPending(): void {
    const rows = this.db.query("SELECT publication_key,input FROM vfs_pending_projections ORDER BY rowid").all() as PendingRow[]
    for (const row of rows) {
      const publication = this.readPublication(row.publication_key)
      if (!publication) throw new Error("EIDOLON_VFS_PROJECTION_PUBLICATION_MISSING")
      let writes: readonly EidolonVfsWorkspaceByteWrite[]
      try {
        const input = JSON.parse(row.input)
        if (canonical(input) !== canonical(projectionInputFor(publication.context))) throw new Error("mismatch")
        writes = projectionWrites(publication.context)
        validateBatch(writes)
      } catch { throw new Error("EIDOLON_VFS_PROJECTION_INPUT_INTEGRITY_MISMATCH") }
      const current = new VirtualFileSystem(this.read().snapshot)
      for (const write of writes) {
        // A successor owns this target: never allow an old journal to overwrite it.
        if (!matchesAfter(write, vfsBytes(current, write.logicalPath))) continue
        const target = this.target(write)
        const observed = readOptional(target)
        if (matchesAfter(write, observed)) {
          if (write.after.state === "absent") this.pruneDeletedParents(write.logicalPath, current)
          continue
        }
        if (!matchesBefore(write, observed)) throw new Error("EIDOLON_VFS_PROJECTION_EXTERNAL_CHANGE")
        this.options.beforeProjection?.(write, publication.record)
        if (write.after.state === "absent") {
          try { unlinkSync(target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
          this.pruneDeletedParents(write.logicalPath, current)
        } else {
          mkdirSync(path.dirname(target), { recursive: true })
          this.target(write)
          atomicWrite(target, decodeBytes(write.after.bytesBase64))
        }
      }
      this.db.query("DELETE FROM vfs_pending_projections WHERE publication_key=?").run(row.publication_key)
    }
  }

  private pruneDeletedParents(logicalPath: string, current: VirtualFileSystem): void {
    let directory = path.posix.dirname(logicalPath)
    while (directory !== "/.eidolon/resources" && directory.startsWith("/.eidolon/resources/")) {
      if (current.exists(`vfs://${directory}`)) break
      const physical = path.join(this.workspaceRoot, directory.slice("/.eidolon/".length))
      try { rmdirSync(physical) } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOTEMPTY" || code === "EEXIST") break
        if (code !== "ENOENT") throw error
      }
      directory = path.posix.dirname(directory)
    }
    const surviving = path.join(this.workspaceRoot, directory.slice("/.eidolon/".length))
    if (existsSync(surviving)) {
      const fd = openSync(surviving, "r")
      try { fsyncSync(fd) } finally { closeSync(fd) }
    }
  }
}

function projectionInputFor(context: EidolonVfsPublicationContext): EidolonVfsWorkspaceWrite | { readonly workspaceWrites: readonly EidolonVfsWorkspaceByteWrite[] } | undefined {
  if (context.workspaceWrite && context.workspaceWrites) throw new Error("EIDOLON_VFS_WORKSPACE_WRITE_FORM_CONFLICT")
  return context.workspaceWrite ?? (context.workspaceWrites ? { workspaceWrites: context.workspaceWrites } : undefined)
}
function projectionWrites(context: EidolonVfsPublicationContext): readonly EidolonVfsWorkspaceByteWrite[] {
  if (context.workspaceWrite && context.workspaceWrites) throw new Error("EIDOLON_VFS_WORKSPACE_WRITE_FORM_CONFLICT")
  if (context.workspaceWrite) {
    const legacy = context.workspaceWrite
    if (!legacy || typeof legacy.authorityText !== "string" || typeof legacy.logicalPath !== "string" || !legacy.before
      || (legacy.before.state !== "absent" && legacy.before.state !== "present")
      || (legacy.before.state === "present" && (typeof legacy.before.text !== "string" || legacy.before.digest !== `sha256:${hash(legacy.before.text)}`))) throw new Error("EIDOLON_VFS_BEFORE_IMAGE_INVALID")
    return [{ logicalPath: legacy.logicalPath, before: legacy.before.state === "absent" ? { state: "absent" } : bytesImage(legacy.before.text, legacy.before.digest), after: bytesImage(legacy.authorityText) }]
  }
  return context.workspaceWrites ?? []
}
function bytesImage(value: string, expectedDigest?: string): { readonly state: "present"; readonly bytesBase64: string; readonly digest: `sha256:${string}` } {
  const bytes = new TextEncoder().encode(value); const digest = digestBytes(bytes)
  if (expectedDigest && expectedDigest !== digest) throw new Error("EIDOLON_VFS_BEFORE_IMAGE_INVALID")
  return { state: "present", bytesBase64: Buffer.from(bytes).toString("base64"), digest }
}
function validateBatch(writes: readonly EidolonVfsWorkspaceByteWrite[]): void {
  if (!Array.isArray(writes) || writes.length === 0) throw new Error("EIDOLON_VFS_WORKSPACE_WRITES_INVALID")
  const paths = new Set<string>()
  for (const write of writes) {
    if (!write || typeof write.logicalPath !== "string" || !write.logicalPath.startsWith("/.eidolon/resources/")) throw new Error("EIDOLON_VFS_WORKSPACE_PATH_INVALID")
    const relative = write.logicalPath.slice("/.eidolon/".length)
    if (!relative || relative.split("/").some((part: string) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) throw new Error("EIDOLON_VFS_WORKSPACE_PATH_INVALID")
    if (paths.has(write.logicalPath)) throw new Error("EIDOLON_VFS_WORKSPACE_WRITE_DUPLICATE")
    paths.add(write.logicalPath); validateImage(write.before); validateImage(write.after)
  }
  const ordered = [...paths].sort()
  for (let index = 0; index < ordered.length; index++) for (let other = index + 1; other < ordered.length; other++) {
    if (ordered[other]!.startsWith(`${ordered[index]}/`)) throw new Error("EIDOLON_VFS_WORKSPACE_WRITE_PATH_CONFLICT")
  }
}
function validateImage(image: EidolonVfsWorkspaceByteWrite["before"] | EidolonVfsWorkspaceByteWrite["after"]): void {
  if (!image || (image.state !== "absent" && image.state !== "present")) throw new Error("EIDOLON_VFS_BYTE_IMAGE_INVALID")
  if (image.state === "present") {
    if (typeof image.bytesBase64 !== "string" || typeof image.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(image.digest)) throw new Error("EIDOLON_VFS_BYTE_IMAGE_INVALID")
    const bytes = decodeBytes(image.bytesBase64)
    if (digestBytes(bytes) !== image.digest) throw new Error("EIDOLON_VFS_BYTE_IMAGE_INVALID")
  }
}
function decodeBytes(base64: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error("EIDOLON_VFS_BYTE_IMAGE_INVALID")
  const bytes = new Uint8Array(Buffer.from(base64, "base64"))
  if (Buffer.from(bytes).toString("base64") !== base64) throw new Error("EIDOLON_VFS_BYTE_IMAGE_INVALID")
  return bytes
}
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex") }
function digestBytes(bytes: Uint8Array): `sha256:${string}` { return `sha256:${hash(bytes)}` }
function readOptional(file: string): Uint8Array | undefined {
  try { return new Uint8Array(readFileSync(file)) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
}
function matchesImage(image: EidolonVfsWorkspaceByteWrite["before"] | EidolonVfsWorkspaceByteWrite["after"], actual: Uint8Array | undefined): boolean {
  return image.state === "absent" ? actual === undefined : actual !== undefined && digestBytes(actual) === image.digest && Buffer.from(actual).toString("base64") === image.bytesBase64
}
function matchesBefore(write: EidolonVfsWorkspaceByteWrite, actual: Uint8Array | undefined): boolean { return matchesImage(write.before, actual) }
function matchesAfter(write: EidolonVfsWorkspaceByteWrite, actual: Uint8Array | undefined): boolean { return matchesImage(write.after, actual) }
function vfsBytes(vfs: VirtualFileSystem, logicalPath: string): Uint8Array | undefined {
  try { const content = vfs.readFile(`vfs://${logicalPath}`); return vfs.readFileType(`vfs://${logicalPath}`) === "binary" ? new Uint8Array(Buffer.from(content, "base64")) : new TextEncoder().encode(content) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
}
function atomicWrite(target: string, bytes: Uint8Array): void {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  const fd = openSync(temporary, "wx", 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  try {
    renameSync(temporary, target)
    const directory = openSync(path.dirname(target), "r")
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally { try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error } }
}
function publicationIdentity(context: EidolonVfsPublicationContext): string {
  const { createdAt: _, ...plan } = context.plan
  return hash(canonical({ ...context, plan }))
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(",")}}`
  return JSON.stringify(value)
}
function verifyRecord(record: EidolonVfsPublicationRecord): void {
  assertEidolonVfsMaterializationReceipt(record.plan, record.receipt)
  if (record.receipt.status !== "admitted" || record.publicationKey !== (record.association?.transactionId ?? record.plan.planId)) throw new Error("EIDOLON_VFS_PUBLICATION_INVALID")
}
