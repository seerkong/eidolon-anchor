import path from "node:path"
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises"
import { parseXnl, wordToString, type DataElementNode, type XnlNode } from "xnl-core"
import {
  applyResourceAuthoring,
  planResourceAuthoring,
  type ResourceAuthoringCatalogBinding,
  type ResourceAuthoringPreparedWrite,
  type ResourceAuthoringProposal,
  type ResourceAuthoringReceipt,
  type ResourceAuthoringRefreshCandidate,
  type ResourceAuthoringRuntime,
  type ResourceAuthoringTransactionPort,
} from "halfcode-compiler.xnl/authoring-runtime"
import {
  loadResourceTree,
  sha256Digest,
  type AuthoredResourceTree,
  type ResourceNode,
} from "halfcode-compiler.xnl/resource-core"
import { safePathLexicalIssue } from "halfcode-compiler.xnl/resource-mapping"
import type {
  EffectiveEidolonVfsCandidate,
  EffectiveEidolonVfsMaterializationResult,
  EffectiveEidolonVfsView,
  PrepareEffectiveEidolonVfsResult,
} from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"

import {
  EidolonAppResourceRegistryAdapter,
  type EidolonResourceRegistryPublicationCandidate,
  type EidolonResourceRegistryPublicationFence,
  type EidolonResourceRegistrySnapshot,
  type ResourcePackageLayerBinding,
} from "./EidolonAppResourceRegistryAdapter"

export type EidolonAIAgentDefinitionAuthoringInput = Readonly<{
  proposal: ResourceAuthoringProposal
}>

export type EidolonAIAgentDefinitionAuthoringResult = Readonly<{
  receipt: ResourceAuthoringReceipt
  snapshot: EidolonResourceRegistrySnapshot
}>

/**
 * Runtime-owned bridge from one durable workspace overlay intent to the sole
 * Effective VFS authority. The candidate stays unpublished while Halfcode
 * parses and reconciles it.
 */
export type EidolonEffectiveVfsAuthoringPort = Readonly<{
  workspaceResourceRoot: string
  read(): EffectiveEidolonVfsView
  prepare(input: Readonly<{
    expectedCurrentRevision: `sha256:${string}`
    logicalPath: `/.eidolon/resources/${string}`
    authorityText: string
  }>): Promise<PrepareEffectiveEidolonVfsResult>
  admit(candidate: EffectiveEidolonVfsCandidate): Promise<EffectiveEidolonVfsMaterializationResult>
}>

export type EidolonAIAgentDefinitionAuthoringFaultObserver = Readonly<{
  afterEffectiveVfsAdmission?(input: Readonly<{
    transactionId: string
    planDigest: string
    publishedRevision: string
  }>): void | Promise<void>
}>

type PreparedState = Readonly<{
  transactionId: string
  planDigest: string
  documentUri: `vfs://@/${string}`
  authorityDigest: string
  authorityText: string
  registryRevisionBefore: string
  targetPath: string
}>

type DurablePreparedState = Readonly<{
  schemaVersion: "eidolon.resource-authoring-journal/v1"
  transactionId: string
  planDigest: string
  documentUri: `vfs://@/${string}`
  authorityDigest: string
  authorityText: string
  registryRevisionBefore: string
}>

const WORKSPACE_LAYER_ID = "workspace" as const

/**
 * Host effect adapter for the deliberately narrow initial authoring surface:
 * create one single-file AIAgentDefinition in the workspace ResourcePackage.
 * Halfcode remains the proposal/plan/refresh/receipt protocol owner.
 */
export class EidolonAIAgentDefinitionAuthoringAdapter {
  private readonly workspaceLayer: ResourcePackageLayerBinding

  constructor(
    private readonly registry: EidolonAppResourceRegistryAdapter,
    private readonly layers: readonly ResourcePackageLayerBinding[],
    private readonly supportRoot: string,
    private readonly effectiveVfsAuthoring?: EidolonEffectiveVfsAuthoringPort,
    private readonly faultObserver?: EidolonAIAgentDefinitionAuthoringFaultObserver,
  ) {
    const matches = effectiveVfsAuthoring
      ? [{ id: WORKSPACE_LAYER_ID, rootDir: effectiveVfsAuthoring.workspaceResourceRoot } as const]
      : layers.filter(({ id }) => id === WORKSPACE_LAYER_ID)
    if (matches.length !== 1) {
      throw new Error("EIDOLON_AGENT_AUTHORING_WORKSPACE_LAYER_REQUIRED")
    }
    this.workspaceLayer = matches[0]!
  }

  async author(
    input: EidolonAIAgentDefinitionAuthoringInput,
  ): Promise<EidolonAIAgentDefinitionAuthoringResult> {
    if (input.proposal.operation !== "create" || input.proposal.kind !== "AIAgentDefinition") {
      throw new Error("EIDOLON_AGENT_AUTHORING_CREATE_ONLY")
    }
    const publication = await this.registry.withPublicationFence(async (fence) => {
      const transaction = await this.createTransaction(fence)
      const plan = planResourceAuthoring(transaction.runtime, input.proposal, {})
      const receipt = await applyResourceAuthoring(transaction.runtime, plan, {})
      const candidate = transaction.publicationCandidate()
        ?? await fence.loadCandidateSnapshot()
      return Object.freeze({ candidate, value: Object.freeze({ receipt }) })
    })
    return Object.freeze({ receipt: publication.value.receipt, snapshot: publication.snapshot })
  }

  async loadReceipt(planDigest: string): Promise<ResourceAuthoringReceipt | undefined> {
    const committed = await this.readReceipt(receiptPath(this.supportRoot, planDigest))
    if (committed) return committed
    const pending = await this.readReceipt(pendingReceiptPath(this.supportRoot, planDigest))
    if (!pending) return undefined
    const snapshot = await this.registry.refresh()
    const identity = snapshot.contentIdentities.get(pending.resourceId)
    if (!identity || identity.authorityDigest !== pending.authorityDigestAfter) return undefined
    const recovered = await this.writeReceipt(pending)
    await this.removeJournal(planDigest).catch(() => undefined)
    await unlink(pendingReceiptPath(this.supportRoot, planDigest)).catch(() => undefined)
    return recovered
  }

  private async createTransaction(fence: EidolonResourceRegistryPublicationFence): Promise<{
    runtime: ResourceAuthoringRuntime
    publicationCandidate(): EidolonResourceRegistryPublicationCandidate | undefined
  }> {
    const workspaceTree = fence.currentSnapshot.effectiveVfs
      ? fence.currentSnapshot.contentIdentityLayers[0]?.tree
      : await loadResourceTree({ rootDir: this.workspaceLayer.rootDir })
    if (!workspaceTree) throw new Error("EIDOLON_AGENT_AUTHORING_EFFECTIVE_TREE_MISSING")
    const planningAuthority = projectPlanningAuthority(fence.currentSnapshot, workspaceTree)
    const catalog = planningAuthority.catalogs.find(({ resourceKind }) => resourceKind === "AIAgentDefinition")
    if (!catalog) throw new Error("EIDOLON_AGENT_AUTHORING_CATALOG_MISSING")
    const prepared = new Map<string, PreparedState>()
    const effectiveCandidates = new Map<string, EffectiveEidolonVfsCandidate>()
    const admittedTransactions = new Set<string>()
    const effectiveVfsAuthoring = this.effectiveVfsAuthoring
    let publicationCandidate: EidolonResourceRegistryPublicationCandidate | undefined

    const transaction: ResourceAuthoringTransactionPort = {
      loadReceipt: (planDigest) => this.readReceipt(receiptPath(this.supportRoot, planDigest)),
      prepare: async (input) => {
        if (input.operation !== "create" || input.expected.state !== "absent") {
          throw new Error("EIDOLON_AGENT_AUTHORING_CREATE_ONLY")
        }
        if (input.expected.registryRevision !== fence.currentSnapshot.registryRevision) {
          throw new Error("EIDOLON_AGENT_AUTHORING_REGISTRY_CAS_CONFLICT")
        }
        const targetPath = await this.resolveTarget(catalog, input.documentUri)
        const transactionId = transactionIdFor(input.planDigest)
        const state = Object.freeze({
          transactionId,
          planDigest: input.planDigest,
          documentUri: input.documentUri,
          authorityDigest: input.authorityDigest,
          authorityText: input.authorityText,
          registryRevisionBefore: input.expected.registryRevision,
          targetPath,
        }) satisfies PreparedState
        const journal = await this.readJournal(input.planDigest)
        if (journal) {
          assertJournal(journal, state)
          const observedDigest = await fileDigest(targetPath)
          if ((!effectiveVfsAuthoring && observedDigest !== input.authorityDigest)
            || (effectiveVfsAuthoring && observedDigest !== undefined && observedDigest !== input.authorityDigest)) {
            throw new Error("EIDOLON_AGENT_AUTHORING_PREPARED_BYTES_MISMATCH")
          }
        } else {
          if (await exists(targetPath)) {
            throw new Error("EIDOLON_AGENT_AUTHORING_RESOURCE_CAS_CONFLICT")
          }
          await this.writeJournal(state)
          if (!effectiveVfsAuthoring) {
            try {
              await writeFileNoReplace(targetPath, input.authorityText)
            } catch (error) {
              await this.removeJournal(input.planDigest).catch(() => undefined)
              throw error
            }
          }
        }
        prepared.set(transactionId, state)
        return Object.freeze({
          transactionId,
          planDigest: input.planDigest,
          authorityDigestBefore: null,
          registryRevisionBefore: input.expected.registryRevision,
        }) satisfies ResourceAuthoringPreparedWrite
      },
      refreshCandidate: async (input) => {
        const state = prepared.get(input.transactionId)
          ?? await this.restorePrepared(input.transactionId, input.planDigest, catalog)
        if (!state || state.planDigest !== input.planDigest) {
          throw new Error("EIDOLON_AGENT_AUTHORING_TRANSACTION_UNKNOWN")
        }
        const candidateSnapshot = effectiveVfsAuthoring
          ? await (async () => {
              const currentRevision = fence.currentSnapshot.effectiveVfs?.revision
              if (!currentRevision) throw new Error("EIDOLON_AGENT_AUTHORING_EFFECTIVE_REVISION_MISSING")
              const relativePath = state.documentUri.slice("vfs://@/".length)
              const result = await effectiveVfsAuthoring.prepare({
                expectedCurrentRevision: currentRevision as `sha256:${string}`,
                logicalPath: `/.eidolon/resources/${relativePath}`,
                authorityText: state.authorityText,
              })
              if (result.status !== "prepared") {
                const diagnostics = result.status === "planning_rejected"
                  ? result.diagnostics
                  : result.receipt.diagnostics
                throw new Error(`EIDOLON_AGENT_AUTHORING_VFS_CANDIDATE_REJECTED: ${diagnostics.map(({ code, message }) => `${code}: ${message}`).join("; ")}`)
              }
              effectiveCandidates.set(state.transactionId, result.candidate)
              return this.registry.loadIsolatedEffectiveVfsSnapshot(result.candidate.effective.readPort)
            })()
          : await (async () => {
              publicationCandidate = await fence.loadCandidateSnapshot()
              return publicationCandidate.snapshot
            })()
        const layers = candidateSnapshot.contentIdentityLayers
        const targetLayerId = this.effectiveVfsAuthoring ? "effective-vfs" : WORKSPACE_LAYER_ID
        const target = layers.find(({ id }) => id === targetLayerId)
        if (!target) throw new Error("EIDOLON_AGENT_AUTHORING_WORKSPACE_LAYER_REQUIRED")
        return Object.freeze({
          transactionId: state.transactionId,
          candidateId: `candidate:${state.planDigest}`,
          targetLayerId,
          tree: target.tree,
          registry: candidateSnapshot.contentIdentityRegistry,
          layers,
        }) satisfies ResourceAuthoringRefreshCandidate
      },
      commit: async (input) => {
        const state = prepared.get(input.transactionId)
          ?? await this.restorePrepared(input.transactionId, input.receipt.planDigest, catalog)
        if (!state
          || input.candidateId !== `candidate:${state.planDigest}`
          || input.receipt.planDigest !== state.planDigest) {
          throw new Error("EIDOLON_AGENT_AUTHORING_COMMIT_IDENTITY_MISMATCH")
        }
        const effectiveCandidate = effectiveCandidates.get(input.transactionId)
        if (effectiveVfsAuthoring) {
          if (!effectiveCandidate) throw new Error("EIDOLON_AGENT_AUTHORING_VFS_CANDIDATE_MISSING")
          await writeJsonImmutable(
            pendingReceiptPath(this.supportRoot, state.planDigest),
            input.receipt,
          )
          if (await fileDigest(state.targetPath) === undefined) {
            await writeFileNoReplace(state.targetPath, state.authorityText)
          }
          const admission = await effectiveVfsAuthoring.admit(effectiveCandidate)
          if (admission.status !== "admitted") {
            const diagnostics = admission.status === "planning_rejected"
              ? admission.diagnostics
              : admission.receipt.diagnostics
            throw new Error(`EIDOLON_AGENT_AUTHORING_VFS_ADMISSION_REJECTED: ${diagnostics.map(({ code, message }) => `${code}: ${message}`).join("; ")}`)
          }
          admittedTransactions.add(input.transactionId)
          await this.faultObserver?.afterEffectiveVfsAdmission?.({
            transactionId: input.transactionId,
            planDigest: state.planDigest,
            publishedRevision: admission.effective.snapshot.revision,
          })
          publicationCandidate = await fence.loadCandidateSnapshot({ effectiveVfs: admission.effective.readPort })
          if (publicationCandidate.snapshot.registryRevision !== input.receipt.registryRevisionAfter) {
            throw new Error("EIDOLON_AGENT_AUTHORING_REGISTRY_READBACK_MISMATCH")
          }
        }
        const committed = await this.writeReceipt(input.receipt)
        await this.removeJournal(state.planDigest).catch(() => undefined)
        await unlink(pendingReceiptPath(this.supportRoot, state.planDigest)).catch(() => undefined)
        prepared.delete(input.transactionId)
        effectiveCandidates.delete(input.transactionId)
        admittedTransactions.delete(input.transactionId)
        return committed
      },
      rollback: async (input) => {
        const state = prepared.get(input.transactionId)
          ?? await this.restorePrepared(input.transactionId, input.planDigest, catalog)
        if (!state) return
        if (admittedTransactions.has(input.transactionId)) return
        if (await fileDigest(state.targetPath) === state.authorityDigest) {
          await unlink(state.targetPath)
        }
        await unlink(pendingReceiptPath(this.supportRoot, state.planDigest)).catch(() => undefined)
        await this.removeJournal(state.planDigest).catch(() => undefined)
        prepared.delete(input.transactionId)
        effectiveCandidates.delete(input.transactionId)
      },
    }

    const runtime: ResourceAuthoringRuntime = Object.freeze({
      planningAuthority,
      inspectAuthority: inspectAIAgentDefinitionAuthority,
      transaction,
    })
    return Object.freeze({
      runtime,
      publicationCandidate: () => publicationCandidate,
    })
  }

  private async resolveTarget(
    catalog: ResourceAuthoringCatalogBinding,
    documentUri: `vfs://@/${string}`,
  ): Promise<string> {
    const relativePath = documentUri.slice("vfs://@/".length)
    const issue = safePathLexicalIssue(relativePath, "relative-path")
    if (issue) throw new Error(`EIDOLON_AGENT_AUTHORING_PATH_INVALID: ${issue}`)
    const catalogRoot = catalog.rootUri.slice("vfs://@/".length)
    if (!relativePath.startsWith(catalogRoot) || relativePath === catalogRoot) {
      throw new Error("EIDOLON_AGENT_AUTHORING_PATH_OUTSIDE_CATALOG")
    }
    const canonicalRoot = await realpath(this.workspaceLayer.rootDir)
    const target = path.resolve(canonicalRoot, ...relativePath.split("/"))
    const parent = path.dirname(target)
    const canonicalParent = await realpath(parent)
    if (!isContained(canonicalRoot, canonicalParent)) {
      throw new Error("EIDOLON_AGENT_AUTHORING_PATH_OUTSIDE_WORKSPACE")
    }
    const metadata = await lstat(canonicalParent)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("EIDOLON_AGENT_AUTHORING_PARENT_INVALID")
    }
    return target
  }

  private async restorePrepared(
    transactionId: string,
    planDigest: string,
    catalog: ResourceAuthoringCatalogBinding,
  ): Promise<PreparedState | undefined> {
    const journal = await this.readJournal(planDigest)
    if (!journal || journal.transactionId !== transactionId) return undefined
    return Object.freeze({
      ...journal,
      targetPath: await this.resolveTarget(catalog, journal.documentUri),
    })
  }

  private async readJournal(planDigest: string): Promise<DurablePreparedState | undefined> {
    const value = await readJson(journalPath(this.supportRoot, planDigest))
    if (value === undefined) return undefined
    const journal = value as DurablePreparedState
    if (journal.schemaVersion !== "eidolon.resource-authoring-journal/v1"
      || journal.planDigest !== planDigest
      || journal.transactionId !== transactionIdFor(planDigest)
      || !journal.documentUri?.startsWith("vfs://@/")
      || sha256Digest(journal.authorityText) !== journal.authorityDigest) {
      throw new Error("EIDOLON_AGENT_AUTHORING_JOURNAL_INVALID")
    }
    return Object.freeze(journal)
  }

  private async writeJournal(state: PreparedState): Promise<void> {
    const journal = Object.freeze({
      schemaVersion: "eidolon.resource-authoring-journal/v1" as const,
      transactionId: state.transactionId,
      planDigest: state.planDigest,
      documentUri: state.documentUri,
      authorityDigest: state.authorityDigest,
      authorityText: state.authorityText,
      registryRevisionBefore: state.registryRevisionBefore,
    })
    await writeJsonImmutable(journalPath(this.supportRoot, state.planDigest), journal)
  }

  private removeJournal(planDigest: string): Promise<void> {
    return unlink(journalPath(this.supportRoot, planDigest))
  }

  private async readReceipt(filePath: string): Promise<ResourceAuthoringReceipt | undefined> {
    const value = await readJson(filePath)
    return value === undefined ? undefined : Object.freeze(value as ResourceAuthoringReceipt)
  }

  private async writeReceipt(receipt: ResourceAuthoringReceipt): Promise<ResourceAuthoringReceipt> {
    const filePath = receiptPath(this.supportRoot, receipt.planDigest)
    await writeJsonImmutable(filePath, receipt)
    const committed = await this.readReceipt(filePath)
    if (!committed || canonicalJson(committed) !== canonicalJson(receipt)) {
      throw new Error("EIDOLON_AGENT_AUTHORING_RECEIPT_READBACK_MISMATCH")
    }
    return committed
  }
}

function projectPlanningAuthority(
  snapshot: EidolonResourceRegistrySnapshot,
  workspaceTree: AuthoredResourceTree,
): ResourceAuthoringRuntime["planningAuthority"] {
  const kind = snapshot.contentIdentityRegistry.kindDefinitions.get("AIAgentDefinition")?.definition
  if (!kind) throw new Error("EIDOLON_AGENT_AUTHORING_KIND_DEFINITION_MISSING")
  if (!kind.sourceShapes.includes("single-file")) {
    throw new Error("EIDOLON_AGENT_AUTHORING_SINGLE_FILE_KIND_REQUIRED")
  }
  const catalogs = (workspaceTree.manifest.node.subdomains.Catalogs?.body ?? [])
    .filter(isResourceNode)
    .filter((node) => node.tag === "Catalog"
      && node.properties.kind === "AIAgentDefinition"
      && node.properties.shape === "single-file")
    .map((node): ResourceAuthoringCatalogBinding => Object.freeze({
      catalogId: exactString(node.resourceId, "catalog id"),
      resourceKind: "AIAgentDefinition",
      sourceShape: "single-file",
      rootUri: normalizeCatalogRoot(exactString(node.properties.root, "catalog root")),
      ...(node.properties.entry === undefined
        ? {}
        : { entry: exactString(node.properties.entry, "catalog entry") }),
    }))
  if (catalogs.length !== 1) throw new Error("EIDOLON_AGENT_AUTHORING_CATALOG_AMBIGUOUS")
  return Object.freeze({
    registryRevision: snapshot.registryRevision,
    kindDefinitions: Object.freeze([Object.freeze({
      kind: kind.resourceKind,
      specRevisions: Object.freeze([...kind.specRevisions]),
      sourceShapes: Object.freeze(["single-file"] as const),
      documentCardinality: kind.documentCardinality,
    })]),
    catalogs: Object.freeze(catalogs),
  })
}

function inspectAIAgentDefinitionAuthority(input: Readonly<{
  documentUri: `vfs://@/${string}`
  sourceShape: "single-file"
  authorityText: string
}>) {
  const document = parseXnl(input.authorityText)
  if (document.warnings?.length || document.nodes.length !== 1 || !isDataElement(document.nodes[0])) {
    throw new Error("EIDOLON_AGENT_AUTHORING_AUTHORITY_INVALID")
  }
  const root = document.nodes[0]
  const resourceId = wordToString(root.id)
  const envelopeVersion = root.metadata.envelopeVersion
  const writerSpecVersion = root.metadata.specVersion
  if (root.tag !== "AIAgentDefinition"
    || typeof resourceId !== "string"
    || typeof envelopeVersion !== "string"
    || envelopeVersion !== "halfcode.resource-envelope/v1"
    || typeof writerSpecVersion !== "number"
    || !Number.isSafeInteger(writerSpecVersion)
    || writerSpecVersion < 1) {
    throw new Error("EIDOLON_AGENT_AUTHORING_ROOT_INVALID")
  }
  return Object.freeze({
    documentUri: input.documentUri,
    resources: Object.freeze([Object.freeze({
      resourceId,
      kind: root.tag,
      envelopeVersion,
      writerSpecVersion,
    })]),
  })
}

function normalizeCatalogRoot(value: string): `vfs://@/${string}` {
  if (!value.startsWith("vfs://./") || !value.endsWith("/")) {
    throw new Error("EIDOLON_AGENT_AUTHORING_CATALOG_ROOT_INVALID")
  }
  const relative = value.slice("vfs://./".length)
  if (safePathLexicalIssue(relative, "relative-directory")) {
    throw new Error("EIDOLON_AGENT_AUTHORING_CATALOG_ROOT_INVALID")
  }
  return `vfs://@/${relative}`
}

function isResourceNode(value: unknown): value is ResourceNode {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as ResourceNode).tag === "string"
}

function isDataElement(value: XnlNode): value is DataElementNode {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as DataElementNode).kind === "DataElement"
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`EIDOLON_AGENT_AUTHORING_VALUE_INVALID: ${label}`)
  }
  return value
}

function transactionIdFor(planDigest: string): string {
  return `eidolon-agent-authoring:${digestKey(planDigest)}`
}

function digestKey(planDigest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(planDigest)) {
    throw new Error("EIDOLON_AGENT_AUTHORING_PLAN_DIGEST_INVALID")
  }
  return planDigest.slice("sha256:".length)
}

function journalPath(supportRoot: string, planDigest: string): string {
  return path.join(supportRoot, "journals", `${digestKey(planDigest)}.json`)
}

function receiptPath(supportRoot: string, planDigest: string): string {
  return path.join(supportRoot, "receipts", `${digestKey(planDigest)}.json`)
}

function pendingReceiptPath(supportRoot: string, planDigest: string): string {
  return path.join(supportRoot, "pending-receipts", `${digestKey(planDigest)}.json`)
}

function assertJournal(journal: DurablePreparedState, state: PreparedState): void {
  const expected = {
    schemaVersion: journal.schemaVersion,
    transactionId: state.transactionId,
    planDigest: state.planDigest,
    documentUri: state.documentUri,
    authorityDigest: state.authorityDigest,
    authorityText: state.authorityText,
    registryRevisionBefore: state.registryRevisionBefore,
  }
  if (canonicalJson(journal) !== canonicalJson(expected)) {
    throw new Error("EIDOLON_AGENT_AUTHORING_JOURNAL_CONFLICT")
  }
}

async function writeFileNoReplace(target: string, content: string): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  const handle = await open(temp, "wx", 0o600)
  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temp, target)
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

async function writeJsonImmutable(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const content = `${canonicalJson(value)}\n`
  try {
    await writeFileNoReplace(filePath, content)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const existing = await readFile(filePath, "utf8")
    if (existing !== content) throw new Error("EIDOLON_AGENT_AUTHORING_IMMUTABLE_FACT_CONFLICT")
  }
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function fileDigest(filePath: string): Promise<string | undefined> {
  try {
    return sha256Digest(await readFile(filePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("EIDOLON_AGENT_AUTHORING_CANONICAL_VALUE_INVALID")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object" || value === null) {
    throw new Error("EIDOLON_AGENT_AUTHORING_CANONICAL_VALUE_INVALID")
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => {
    const item = record[key]
    if (item === undefined) throw new Error("EIDOLON_AGENT_AUTHORING_CANONICAL_VALUE_INVALID")
    return `${JSON.stringify(key)}:${canonicalJson(item)}`
  }).join(",")}}`
}
