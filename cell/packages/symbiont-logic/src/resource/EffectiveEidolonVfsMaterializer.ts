import { createHash } from "node:crypto"
import { lstat, readdir, readFile } from "node:fs/promises"
import path from "node:path"

import {
  EFFECTIVE_EIDOLON_VFS_ROOT,
  EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA,
  EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA,
  EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA,
  type EffectiveEidolonVfsSnapshot,
  type EidolonVfsDigest,
  type EidolonVfsEntry,
  type EidolonVfsMaterializationDiagnostic,
  type EidolonVfsMaterializationPlan,
  type EidolonVfsMaterializationReceipt,
  type EidolonVfsOverlayDescriptor,
  type EidolonVfsOverlayKind,
  type EidolonVfsPublicationAssociation,
  type EidolonVfsPublicationRecord,
  type EidolonVfsWorkspaceWrite,
  type EidolonVfsReadPort,
  type LegacyResourceVfsProjection,
} from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"
import type { ResourceVfs } from "@cell/symbiont-contract/resource/ResourceVFS"
import type { DataElementNode } from "xnl-core"
import {
  MemoryRevisionedVfsAuthority,
  VirtualFileSystem,
  diffVfsSnapshots,
  folderChildren,
  planVfsOverlays,
  publishRevisionedVfsOverlayPlan,
  readName,
  serializeVfsSnapshotToString,
  toXnlMutations,
  type VfsDirectoryOverlayIntent,
  type VfsMutation,
  type VfsMutationOverlayIntent,
  type VfsOverlayIntent,
  type VfsOverlayPlan,
  type RevisionedVfsSnapshot,
  type RevisionedVfsAuthority,
  type VfsRevision,
} from "xnl-vfs"
import { eidolonVfsPublicationKey, type EffectiveEidolonVfsPublicationAuthority } from "./EffectiveEidolonVfsPublication"

import {
  assertEffectiveEidolonVfsSnapshot,
  assertEidolonVfsMaterializationPlan,
  assertEidolonVfsMaterializationReceipt,
  createLegacyResourceVfsProjection,
} from "./EffectiveEidolonVFS"
import { ResourceVFSOps } from "./ResourceVFS"

export interface EidolonVfsOverlayMaterial {
  readonly descriptor: EidolonVfsOverlayDescriptor
  readonly intent: VfsOverlayIntent
}

export interface LoadPhysicalEidolonDirectoryOverlayInput {
  readonly id: string
  readonly kind: EidolonVfsOverlayKind
  readonly order: number
  readonly rootDir: string
}

export interface CreateMutationEidolonOverlayInput {
  readonly id: string
  readonly kind: EidolonVfsOverlayKind
  readonly order: number
  readonly mutations: readonly VfsMutation[]
}

export interface EidolonVfsCandidateReadPort {
  stat(logicalPath: string): Promise<EidolonVfsEntry | undefined>
  readDirectory(logicalPath: string): Promise<readonly EidolonVfsEntry[] | undefined>
  readBytes(logicalPath: string): Promise<Uint8Array | undefined>
}

export interface EidolonVfsCandidateValidationInput {
  readonly plan: EidolonVfsMaterializationPlan
  readonly readPort: EidolonVfsCandidateReadPort
}

export interface EidolonVfsCandidateValidator {
  readonly id: string
  validate(input: EidolonVfsCandidateValidationInput): Promise<readonly EidolonVfsMaterializationDiagnostic[]> | readonly EidolonVfsMaterializationDiagnostic[]
}

export interface EffectiveEidolonVfsMaterializerOptions {
  readonly builtinSnapshot: DataElementNode
  readonly validators?: readonly EidolonVfsCandidateValidator[]
  readonly clock?: () => string
  readonly authority?: EffectiveEidolonVfsPublicationAuthority
}

export interface EffectiveEidolonVfsView {
  readonly snapshot: EffectiveEidolonVfsSnapshot
  readonly readPort: EidolonVfsReadPort
}

export type EffectiveEidolonVfsMaterializationResult =
  | {
      readonly status: "admitted"
      readonly plan: EidolonVfsMaterializationPlan
      readonly receipt: Extract<EidolonVfsMaterializationReceipt, { status: "admitted" }>
      readonly effective: EffectiveEidolonVfsView
    }
  | {
      readonly status: "rejected"
      readonly plan: EidolonVfsMaterializationPlan
      readonly receipt: Extract<EidolonVfsMaterializationReceipt, { status: "rejected" }>
    }
  | {
      readonly status: "planning_rejected"
      readonly currentRevision: EidolonVfsDigest
      readonly diagnostics: readonly EidolonVfsMaterializationDiagnostic[]
    }

export interface EffectiveEidolonVfsCandidate {
  readonly plan: EidolonVfsMaterializationPlan
  readonly effective: EffectiveEidolonVfsView
}

export type PrepareEffectiveEidolonVfsResult =
  | {
      readonly status: "prepared"
      readonly plan: EidolonVfsMaterializationPlan
      readonly candidate: EffectiveEidolonVfsCandidate
    }
  | Extract<EffectiveEidolonVfsMaterializationResult, { status: "rejected" | "planning_rejected" }>

export interface MaterializeEffectiveEidolonVfsInput {
  readonly expectedCurrentRevision: EidolonVfsDigest
  readonly overlays: readonly EidolonVfsOverlayMaterial[]
}

function digest(value: string | Uint8Array): EidolonVfsDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]))
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function effectiveEidolonVfsTreeDigest(snapshot: DataElementNode): EidolonVfsDigest {
  const canonical = structuredClone(snapshot)
  const visit = (node: DataElementNode): void => {
    if (node.tag !== "folder") return
    const children = folderChildren(node)
    for (const child of children) visit(child)
    node.body = [...(node.body ?? [])].sort((left, right) => {
      if (typeof left !== "object" || left === null || (left as DataElementNode).kind !== "DataElement") return -1
      if (typeof right !== "object" || right === null || (right as DataElementNode).kind !== "DataElement") return 1
      return readName(left as DataElementNode).localeCompare(readName(right as DataElementNode))
    })
  }
  visit(canonical)
  return digest(serializeVfsSnapshotToString(canonical, { mode: "full" }))
}
const snapshotDigest = effectiveEidolonVfsTreeDigest

export function stableEidolonOverlayNodeId(overlayId: string, kind: "file" | "directory", logicalPath: string): string {
  return `eidolon_${createHash("sha256").update(`${overlayId}\0${kind}\0${logicalPath}`).digest("hex").slice(0, 24)}`
}

function assignStableOverlayIds(snapshot: DataElementNode, overlayId: string): void {
  const visit = (node: DataElementNode, logicalPath: string): void => {
    const kind = node.tag === "folder" ? "directory" : "file"
    node.metadata = {
      ...(node.metadata ?? {}),
      id: stableEidolonOverlayNodeId(overlayId, kind, logicalPath),
    }
    if (kind !== "directory") return
    for (const child of folderChildren(node)) {
      const name = readName(child)
      visit(child, logicalPath === "/" ? `/${name}` : `${logicalPath}/${name}`)
    }
  }
  visit(snapshot, "/")
}

async function physicalRootStatus(rootDir: string) {
  try {
    return await lstat(rootDir)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

const PHYSICAL_OVERLAY_EXCLUDED_ROOTS = new Set([
  // Mutable runtime state. These trees can be large and may change while the
  // configuration/resource overlay is being projected.
  "projects",
  "sessions",
  // Legacy resource surfaces owned by their existing loaders.
  "commands",
  "skills",
])

function isExcludedPhysicalOverlayEntry(relativeDirectory: string, name: string): boolean {
  if (!relativeDirectory && PHYSICAL_OVERLAY_EXCLUDED_ROOTS.has(name)) return true
  return name.startsWith(".tmp-")
    || (name.startsWith(".") && name.endsWith(".tmp"))
}

function fileTypeFor(relativePath: string, bytes: Uint8Array): { fileType: "xnl" | "text" | "binary"; content: string } {
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return { fileType: relativePath.toLowerCase().endsWith(".xnl") ? "xnl" : "text", content }
  } catch {
    if (relativePath.toLowerCase().endsWith(".xnl")) {
      throw new TypeError(`XNL overlay file is not valid UTF-8: ${relativePath}`)
    }
    return { fileType: "binary", content: Buffer.from(bytes).toString("base64") }
  }
}

export async function loadPhysicalEidolonDirectoryOverlay(
  input: LoadPhysicalEidolonDirectoryOverlayInput,
): Promise<EidolonVfsOverlayMaterial & { readonly intent: VfsDirectoryOverlayIntent }> {
  const rootDir = path.resolve(input.rootDir)
  const status = await physicalRootStatus(rootDir)
  if (status?.isSymbolicLink()) throw new TypeError(`Eidolon overlay root must not be a symlink: ${rootDir}`)
  if (status && !status.isDirectory()) throw new TypeError(`Eidolon overlay root must be a directory: ${rootDir}`)

  const vfs = new VirtualFileSystem()
  vfs.mkdir("vfs:///.eidolon", { recursive: true })

  const visit = async (physicalDirectory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(physicalDirectory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (isExcludedPhysicalOverlayEntry(relativeDirectory, entry.name)) continue
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const physicalPath = path.join(physicalDirectory, entry.name)
      const logicalPath = `vfs:///.eidolon/${relativePath}`
      try {
        if (entry.isSymbolicLink()) throw new TypeError(`Eidolon overlay symlink is not supported: ${relativePath}`)
        if (entry.isDirectory()) {
          vfs.mkdir(logicalPath, { recursive: true })
          await visit(physicalPath, relativePath)
          continue
        }
        if (!entry.isFile()) throw new TypeError(`Unsupported Eidolon overlay entry: ${relativePath}`)
        const decoded = fileTypeFor(relativePath, new Uint8Array(await readFile(physicalPath)))
        vfs.writeFile(logicalPath, decoded.content, { fileType: decoded.fileType })
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
        throw error
      }
    }
  }
  if (status) await visit(rootDir, "")

  const snapshot = vfs.getSnapshot()
  assignStableOverlayIds(snapshot, input.id)
  const intentDigest = snapshotDigest(snapshot)
  const descriptor = Object.freeze({
    id: input.id,
    kind: input.kind,
    order: input.order,
    intentRevision: intentDigest,
    intentDigest,
  }) satisfies EidolonVfsOverlayDescriptor
  const intent: VfsDirectoryOverlayIntent = Object.freeze({
    id: input.id,
    order: input.order,
    kind: "directory",
    snapshot,
  })
  return Object.freeze({ descriptor, intent })
}

export function createMutationEidolonOverlay(
  input: CreateMutationEidolonOverlayInput,
): EidolonVfsOverlayMaterial & { readonly intent: VfsMutationOverlayIntent } {
  const mutations = structuredClone([...input.mutations])
  const intentDigest = digest(canonicalJson(mutations))
  const descriptor = Object.freeze({
    id: input.id,
    kind: input.kind,
    order: input.order,
    intentRevision: intentDigest,
    intentDigest,
  }) satisfies EidolonVfsOverlayDescriptor
  const intent: VfsMutationOverlayIntent = Object.freeze({
    id: input.id,
    order: input.order,
    kind: "mutations",
    mutations,
  })
  return Object.freeze({ descriptor, intent })
}

function canonicalLogicalPath(logicalPath: string): string {
  if (logicalPath !== EFFECTIVE_EIDOLON_VFS_ROOT && !logicalPath.startsWith(`${EFFECTIVE_EIDOLON_VFS_ROOT}/`)) {
    throw new TypeError(`Effective Eidolon VFS path is outside ${EFFECTIVE_EIDOLON_VFS_ROOT}: ${logicalPath}`)
  }
  if (logicalPath.includes("\\") || logicalPath.endsWith("/") || logicalPath.split("/").some((segment, index) => index > 0 && (!segment || segment === "." || segment === ".."))) {
    throw new TypeError(`Effective Eidolon VFS path is not canonical: ${logicalPath}`)
  }
  return logicalPath
}

function toVfsPath(logicalPath: string): string {
  return `vfs://${canonicalLogicalPath(logicalPath)}`
}

function vfsMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR")
}

function createReadPort(snapshot: EffectiveEidolonVfsSnapshot, vfsSnapshot: DataElementNode): EidolonVfsReadPort {
  const vfs = new VirtualFileSystem(vfsSnapshot)
  const port: EidolonVfsReadPort = {
    snapshot,
    async stat(logicalPath: string) {
      try {
        const stat = vfs.stat(toVfsPath(logicalPath))
        if (stat.kind === "folder") {
          return Object.freeze({ kind: "directory", logicalPath, nodeId: stat.metadataId })
        }
        const bytes = fileBytes(vfs, logicalPath)
        return Object.freeze({
          kind: "file",
          logicalPath,
          nodeId: stat.metadataId,
          size: bytes.byteLength,
          fileType: stat.fileType,
          contentDigest: digest(bytes),
        })
      } catch (error) {
        if (vfsMissing(error)) return undefined
        throw error
      }
    },
    async readDirectory(logicalPath: string) {
      try {
        return Object.freeze(vfs.readdir(toVfsPath(logicalPath)).map((entry): EidolonVfsEntry => {
          const childLogicalPath = entry.path.slice("vfs://".length)
          if (entry.kind === "folder") {
            return Object.freeze({ kind: "directory", logicalPath: childLogicalPath, nodeId: entry.metadataId })
          }
          const bytes = fileBytes(vfs, childLogicalPath)
          return Object.freeze({
            kind: "file",
            logicalPath: childLogicalPath,
            nodeId: entry.metadataId,
            size: bytes.byteLength,
            fileType: entry.fileType,
            contentDigest: digest(bytes),
          })
        }))
      } catch (error) {
        if (vfsMissing(error)) return undefined
        throw error
      }
    },
    async readBytes(logicalPath: string) {
      try {
        return new Uint8Array(fileBytes(vfs, logicalPath))
      } catch (error) {
        if (vfsMissing(error)) return undefined
        throw error
      }
    },
  }
  return Object.freeze(port)
}

function fileBytes(vfs: VirtualFileSystem, logicalPath: string): Uint8Array {
  const vfsPath = toVfsPath(logicalPath)
  const content = vfs.readFile(vfsPath)
  return vfs.readFileType(vfsPath) === "binary"
    ? new Uint8Array(Buffer.from(content, "base64"))
    : new TextEncoder().encode(content)
}

function exactPersistenceMutations(
  base: DataElementNode,
  candidate: DataElementNode,
): VfsMutation[] {
  const candidateVfs = new VirtualFileSystem(candidate)
  return diffVfsSnapshots(base, candidate).map((mutation) => {
    if (mutation.type !== "CONTENT_UPDATE") return mutation
    return {
      ...mutation,
      payload: {
        content: candidateVfs.readFile(mutation.path),
        fileType: candidateVfs.readFileType(mutation.path),
      },
    }
  })
}

function effectiveSnapshot(input: {
  revision: EidolonVfsDigest
  baseRevision: EidolonVfsDigest
  overlays: readonly EidolonVfsOverlayDescriptor[]
  receiptId: string
  admittedAt: string
}): EffectiveEidolonVfsSnapshot {
  return Object.freeze(assertEffectiveEidolonVfsSnapshot({
    schemaVersion: EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA,
    revision: input.revision,
    baseRevision: input.baseRevision,
    rootPath: EFFECTIVE_EIDOLON_VFS_ROOT,
    treeDigest: input.revision,
    overlays: Object.freeze(input.overlays.map((overlay) => Object.freeze({ ...overlay }))),
    materializationReceiptId: input.receiptId,
    admittedAt: input.admittedAt,
  }))
}

function receiptId(status: "admitted" | "rejected", planId: string, at: string): string {
  return `${status}:${digest(`${planId}\0${at}`).slice("sha256:".length, "sha256:".length + 24)}`
}

function planningDiagnostic(input: {
  code: string
  message: string
  overlayId?: string
  path?: string
  mutationIndex?: number
}): EidolonVfsMaterializationDiagnostic {
  const identity = input.code === "IDENTITY_CONFLICT" || input.message.includes("Expected node id")
  return Object.freeze({
    code: identity ? "identity_mismatch" : input.code === "MUTATION_REJECTED" ? "mutation_rejected" : "validation_failed",
    message: input.message,
    ...(input.overlayId ? { overlayId: input.overlayId } : {}),
    ...(input.path ? { logicalPath: input.path.replace(/^vfs:\/\//, "") } : {}),
    ...(input.mutationIndex === undefined ? {} : { mutationIndex: input.mutationIndex }),
  })
}

export class EffectiveEidolonVfsMaterializer {
  readonly #builtinSnapshot: DataElementNode
  readonly #baseRevision: EidolonVfsDigest
  readonly #validators: readonly EidolonVfsCandidateValidator[]
  readonly #clock: () => string
  readonly #authority: RevisionedVfsAuthority
  readonly #publicationAuthority?: EffectiveEidolonVfsPublicationAuthority
  readonly #publications = new Map<string, EidolonVfsPublicationRecord>()
  #currentNativeRevision?: VfsRevision
  readonly #preparedCandidates = new WeakMap<EffectiveEidolonVfsCandidate, {
    readonly currentAtStart: EffectiveEidolonVfsView
    readonly authorityBase: RevisionedVfsSnapshot
    readonly overlayPlan: VfsOverlayPlan
    readonly descriptors: readonly EidolonVfsOverlayDescriptor[]
    readonly evidence: readonly { readonly id: string; readonly evidenceDigest: EidolonVfsDigest }[]
  }>()
  #current: EffectiveEidolonVfsView

  constructor(options: EffectiveEidolonVfsMaterializerOptions) {
    this.#builtinSnapshot = structuredClone(options.builtinSnapshot)
    const builtinVfs = new VirtualFileSystem(this.#builtinSnapshot)
    if (!builtinVfs.exists("vfs:///.eidolon")) throw new TypeError("Builtin snapshot must contain /.eidolon")
    this.#baseRevision = snapshotDigest(this.#builtinSnapshot)
    this.#validators = Object.freeze([...(options.validators ?? [])])
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#publicationAuthority = options.authority
    if (options.authority) this.#authority = options.authority
    else {
      const memory = new MemoryRevisionedVfsAuthority(this.#builtinSnapshot, { authorityId: "eidolon-effective-vfs" })
      this.#authority = memory
      this.#currentNativeRevision = memory.read().revision
    }
    const admittedAt = this.#clock()
    const snapshot = effectiveSnapshot({
      revision: this.#baseRevision,
      baseRevision: this.#baseRevision,
      overlays: [],
      receiptId: `builtin:${this.#baseRevision.slice("sha256:".length, "sha256:".length + 24)}`,
      admittedAt,
    })
    this.#current = Object.freeze({ snapshot, readPort: createReadPort(snapshot, this.#builtinSnapshot) })
  }

  read(): EffectiveEidolonVfsView {
    return this.#current
  }

  async lookupPublication(key: string): Promise<EidolonVfsPublicationRecord | undefined> {
    return this.#publicationAuthority ? this.#publicationAuthority.lookupPublication(key) : this.#publications.get(key)
  }

  /** Restore the original owner before consumers read physical overlay inputs. */
  async restore(): Promise<EffectiveEidolonVfsView> {
    if (!this.#publicationAuthority) return this.#current
    await this.#publicationAuthority.recoverProjections()
    const head = await this.#publicationAuthority.readHead()
    const treeDigest = snapshotDigest(head.snapshot)
    const publication = head.publication
    if (publication && publication.receipt.publishedRevision !== treeDigest) throw new Error("EIDOLON_VFS_RESTORE_DIGEST_MISMATCH")
    if (!publication && treeDigest !== this.#baseRevision) throw new Error("EIDOLON_VFS_RESTORE_PUBLICATION_MISSING")
    const snapshot = publication ? effectiveSnapshot({
      revision: treeDigest, baseRevision: publication.plan.baseRevision, overlays: publication.plan.overlays,
      receiptId: publication.receipt.receiptId, admittedAt: publication.receipt.publishedAt,
    }) : this.#current.snapshot
    this.#current = Object.freeze({ snapshot, readPort: createReadPort(snapshot, head.snapshot) })
    this.#currentNativeRevision = head.revision
    return this.#current
  }

  async prepare(input: MaterializeEffectiveEidolonVfsInput): Promise<PrepareEffectiveEidolonVfsResult> {
    const currentAtStart = this.#current
    const authorityBase = await this.#authority.read()
    const orderedMaterials = [...input.overlays].sort((left, right) => left.descriptor.order - right.descriptor.order)
    const descriptors = orderedMaterials.map((material) => material.descriptor)

    if (input.expectedCurrentRevision !== currentAtStart.snapshot.revision
      || !this.#currentNativeRevision
      || this.#currentNativeRevision.authorityId !== authorityBase.revision.authorityId
      || this.#currentNativeRevision.value !== authorityBase.revision.value
      || snapshotDigest(authorityBase.snapshot) !== currentAtStart.snapshot.revision) {
      const candidateDigest = snapshotDigest(this.#builtinSnapshot)
      const plan = this.#plan(input.expectedCurrentRevision, descriptors, candidateDigest)
      return this.#rejected(plan, [{
        code: "publish_conflict",
        message: `Expected Effective VFS revision ${input.expectedCurrentRevision} but current is ${currentAtStart.snapshot.revision}`,
      }], currentAtStart.snapshot.revision)
    }

    const planning = planVfsOverlays(this.#builtinSnapshot, orderedMaterials.map((material) => material.intent))
    if (planning.status === "rejected") {
      return Object.freeze({
        status: "planning_rejected" as const,
        currentRevision: currentAtStart.snapshot.revision,
        diagnostics: Object.freeze(planning.diagnostics.map(planningDiagnostic)),
      })
    }

    const candidateDigest = snapshotDigest(planning.plan.candidate)
    const plan = this.#plan(input.expectedCurrentRevision, descriptors, candidateDigest)
    const candidateSnapshot = effectiveSnapshot({
      revision: candidateDigest,
      baseRevision: this.#baseRevision,
      overlays: descriptors,
      receiptId: `candidate:${plan.planId}`,
      admittedAt: plan.createdAt,
    })
    const candidatePort = createReadPort(candidateSnapshot, planning.plan.candidate)
    const validationDiagnostics: EidolonVfsMaterializationDiagnostic[] = []
    const evidence = [{ id: "eidolon-vfs-structure", evidenceDigest: digest(`structure\0${candidateDigest}`) }]

    for (const validator of this.#validators) {
      try {
        const diagnostics = await validator.validate({ plan, readPort: candidatePort })
        validationDiagnostics.push(...diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })))
        if (diagnostics.length === 0) {
          evidence.push({ id: validator.id, evidenceDigest: digest(`${validator.id}\0${candidateDigest}`) })
        }
      } catch (error) {
        validationDiagnostics.push({
          code: "validation_failed",
          message: `Candidate validator '${validator.id}' failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    if (validationDiagnostics.length > 0) {
      return this.#rejected(plan, validationDiagnostics, this.#current.snapshot.revision)
    }

    const candidate = Object.freeze({
      plan,
      effective: Object.freeze({ snapshot: candidateSnapshot, readPort: candidatePort }),
    }) satisfies EffectiveEidolonVfsCandidate
    this.#preparedCandidates.set(candidate, {
      currentAtStart,
      authorityBase,
      overlayPlan: structuredClone(planning.plan),
      descriptors,
      evidence: Object.freeze(evidence.map((item) => Object.freeze(item))),
    })
    return Object.freeze({ status: "prepared" as const, plan, candidate })
  }

  async admit(candidate: EffectiveEidolonVfsCandidate, association?: EidolonVfsPublicationAssociation, workspaceWrite?: EidolonVfsWorkspaceWrite): Promise<EffectiveEidolonVfsMaterializationResult> {
    const prepared = this.#preparedCandidates.get(candidate)
    if (!prepared) {
      return this.#rejected(candidate.plan, [{
        code: "candidate_handle_invalid",
        message: "Effective VFS candidate was not issued by this materializer or has already been consumed",
      }], this.#current.snapshot.revision)
    }
    this.#preparedCandidates.delete(candidate)

    const { plan } = candidate
    const { currentAtStart, authorityBase, overlayPlan, descriptors, evidence } = prepared
    if (this.#current.snapshot.revision !== currentAtStart.snapshot.revision) {
      return this.#rejected(plan, [{
        code: "publish_conflict",
        message: `Effective VFS changed after candidate preparation: expected ${currentAtStart.snapshot.revision} but current is ${this.#current.snapshot.revision}`,
      }], this.#current.snapshot.revision)
    }

    // The persistence fence must reproduce exact source bytes. An XNL semantic
    // diff may validly preserve an old root identity when an overlay replaces a
    // whole document, so materialization deliberately persists exact content.
    const mutations = exactPersistenceMutations(authorityBase.snapshot, overlayPlan.candidate)
    if (workspaceWrite && !this.#publicationAuthority) throw new Error("EIDOLON_VFS_DURABLE_WORKSPACE_AUTHORITY_REQUIRED")
    const publicationContext = { plan, validators: evidence, ...(association ? { association } : {}), ...(workspaceWrite ? { workspaceWrite } : {}) }
    const publicationKey = eidolonVfsPublicationKey(publicationContext)
    const publish = await publishRevisionedVfsOverlayPlan(this.#publicationAuthority?.scopePublication(publicationContext) ?? this.#authority, {
      base: authorityBase,
      plan: {
        ...overlayPlan,
        mutations,
        xnlMutations: toXnlMutations(authorityBase.snapshot, mutations),
      },
    })
    if (publish.status !== "applied" && publish.status !== "unchanged") {
      const diagnostics: EidolonVfsMaterializationDiagnostic[] = publish.status === "conflict"
        ? [{ code: "publish_conflict", message: `Effective VFS CAS conflict at ${publish.actualRevision.authorityId}:${publish.actualRevision.value}` }]
        : publish.status === "rejected"
          ? publish.diagnostics.map((item) => ({ code: "precondition_failed", message: item.message }))
          : publish.diagnostics.map((item) => ({ code: "validation_failed", message: item.message }))
      return this.#rejected(plan, diagnostics, this.#current.snapshot.revision)
    }

    const readbackDigest = snapshotDigest(publish.snapshot)
    if (readbackDigest !== plan.candidateTreeDigest) {
      const residual = diffVfsSnapshots(publish.snapshot, overlayPlan.candidate)
        .slice(0, 8)
        .map(({ type, path: mutationPath, expectedId }) => `${type}:${mutationPath}:${expectedId ?? ""}`)
        .join(",")
      throw new Error(`Effective VFS authority readback ${readbackDigest} did not match the admitted candidate digest ${plan.candidateTreeDigest}; residual=${residual}`)
    }
    const publishedAt = publish.status === "applied" ? publish.receipt.persistedAt : this.#clock()
    const committedRecord = await this.lookupPublication(publicationKey)
    if (this.#publicationAuthority && !committedRecord) throw new Error("EIDOLON_VFS_DURABLE_PUBLICATION_MISSING")
    const receipt = committedRecord?.receipt ?? Object.freeze(assertEidolonVfsMaterializationReceipt(plan, {
      schemaVersion: EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA,
      status: "admitted",
      receiptId: receiptId("admitted", plan.planId, publishedAt),
      planId: plan.planId,
      previousRevision: currentAtStart.snapshot.revision,
      publishedRevision: plan.candidateTreeDigest,
      candidateTreeDigest: plan.candidateTreeDigest,
      validation: Object.freeze({
        validatedAt: publishedAt,
        validators: evidence,
      }),
      publishedAt,
    })) as Extract<EidolonVfsMaterializationReceipt, { status: "admitted" }>
    this.#publications.set(publicationKey, committedRecord ?? Object.freeze({ publicationKey, ...(association ? { association } : {}), plan, receipt }))
    const snapshot = effectiveSnapshot({
      revision: plan.candidateTreeDigest,
      baseRevision: this.#baseRevision,
      overlays: descriptors,
      receiptId: receipt.receiptId,
      admittedAt: publishedAt,
    })
    const effective = Object.freeze({ snapshot, readPort: createReadPort(snapshot, publish.snapshot) })
    if (this.#current === currentAtStart) {
      this.#current = effective
      this.#currentNativeRevision = publish.status === "applied" ? publish.receipt.revision : publish.revision
    }
    return Object.freeze({ status: "admitted" as const, plan, receipt, effective })
  }

  async materialize(input: MaterializeEffectiveEidolonVfsInput): Promise<EffectiveEidolonVfsMaterializationResult> {
    const prepared = await this.prepare(input)
    if (prepared.status !== "prepared") return prepared
    return this.admit(prepared.candidate)
  }

  #plan(expectedCurrentRevision: EidolonVfsDigest, overlays: readonly EidolonVfsOverlayDescriptor[], candidateTreeDigest: EidolonVfsDigest): EidolonVfsMaterializationPlan {
    const createdAt = this.#clock()
    const planId = `plan:${digest(canonicalJson({ expectedCurrentRevision, baseRevision: this.#baseRevision, overlays, candidateTreeDigest })).slice("sha256:".length, "sha256:".length + 24)}`
    return Object.freeze(assertEidolonVfsMaterializationPlan({
      schemaVersion: EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA,
      planId,
      expectedCurrentRevision,
      baseRevision: this.#baseRevision,
      overlays: Object.freeze(overlays.map((overlay) => Object.freeze({ ...overlay }))),
      candidateTreeDigest,
      createdAt,
    }))
  }

  #rejected(plan: EidolonVfsMaterializationPlan, diagnostics: readonly EidolonVfsMaterializationDiagnostic[], currentRevision: EidolonVfsDigest): Extract<EffectiveEidolonVfsMaterializationResult, { status: "rejected" }> {
    const rejectedAt = this.#clock()
    const receipt = Object.freeze(assertEidolonVfsMaterializationReceipt(plan, {
      schemaVersion: EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA,
      status: "rejected",
      receiptId: receiptId("rejected", plan.planId, rejectedAt),
      planId: plan.planId,
      currentRevision,
      candidateTreeDigest: plan.candidateTreeDigest,
      diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
      rejectedAt,
    })) as Extract<EidolonVfsMaterializationReceipt, { status: "rejected" }>
    return Object.freeze({ status: "rejected" as const, plan, receipt })
  }
}

export async function createLegacyResourceVfsProjectionFromReadPort(
  readPort: EidolonVfsReadPort,
): Promise<LegacyResourceVfsProjection<ResourceVfs>> {
  let vfs = ResourceVFSOps.empty()
  const visit = async (logicalPath: string): Promise<void> => {
    const entries = await readPort.readDirectory(logicalPath)
    for (const entry of entries ?? []) {
      if (entry.kind === "directory") {
        await visit(entry.logicalPath)
        continue
      }
      if (entry.fileType === "binary") continue
      const bytes = await readPort.readBytes(entry.logicalPath)
      if (!bytes) continue
      let content: string
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        continue
      }
      vfs = ResourceVFSOps.withFile(vfs, {
        path: entry.logicalPath,
        content,
        source: `effective-vfs:${readPort.snapshot.revision}`,
      })
    }
  }
  await visit(EFFECTIVE_EIDOLON_VFS_ROOT)
  return createLegacyResourceVfsProjection(readPort.snapshot, vfs)
}
