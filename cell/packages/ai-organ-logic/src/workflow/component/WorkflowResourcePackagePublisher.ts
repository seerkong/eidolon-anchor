import { randomUUID } from "node:crypto"
import { lstat, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"
import { freezeAIWorkflowRunResources } from "ai-workflow-logic/run-freeze"

import type {
  EidolonAppResourceRegistryAdapter,
  EidolonResourceRegistrySnapshot,
  ResourcePackageLayerBinding,
} from "../../resources"
import {
  hashWorkflowBinaryFiles,
  NodeWorkflowAuthoringStore,
  workflowResourcePackagePublicationReceiptId,
  type WorkflowAuthoringBinaryFile,
  type WorkflowAuthoringSessionStore,
  type WorkflowResourcePackagePublicationCandidate,
  type WorkflowResourcePackagePublicationProofSet,
  type WorkflowResourcePackagePublicationReceiptPayload,
  type WorkflowResourcePackagePublicationReceipt,
} from "../authoring"

type PublicationAttemptState = "prepared" | "live-backed-up" | "candidate-live" | "committed"

type WorkflowResourcePackagePublicationJournal = {
  schemaVersion: "workflow.resource-package-publication-journal/v1"
  attemptId: string
  sessionId: string
  sourceRevision: string
  baseArtifactRevision: string
  baseRegistryRevision: string
  targetName: string
  stagingName: string
  backupName: string
  hadLive: boolean
  state: PublicationAttemptState
  startedAt: string
}

type PublicationAttemptTreeFacts = {
  readonly targetRevision?: string
  readonly stagingRevision?: string
  readonly backupRevision?: string
}

const PUBLICATION_JOURNAL_KEYS = Object.freeze([
  "attemptId",
  "backupName",
  "baseArtifactRevision",
  "baseRegistryRevision",
  "hadLive",
  "schemaVersion",
  "sessionId",
  "sourceRevision",
  "stagingName",
  "startedAt",
  "state",
  "targetName",
] as const)

const PUBLICATION_ATTEMPT_STATES: ReadonlySet<string> = new Set<PublicationAttemptState>([
  "prepared",
  "live-backed-up",
  "candidate-live",
  "committed",
])

export type WorkflowResourcePackagePublicationResult = {
  status: "published"
  sessionId: string
  revision: string
  receipt: WorkflowResourcePackagePublicationReceipt
  publicationEffectDispatched: true
  runtimeEffectDispatched: false
}

export type WorkflowResourcePackagePublicationPreview = {
  status: "confirmation_required"
  sessionId: string
  revision: string
  publicationEffectDispatched: false
  runtimeEffectDispatched: false
}

export class WorkflowResourcePackagePublicationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "WorkflowResourcePackagePublicationError"
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits)
}

function isCanonicalUuidV4(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 36) return false
  const hyphens = new Set([8, 13, 18, 23])
  const hex = "0123456789abcdef"
  for (let index = 0; index < value.length; index += 1) {
    if (hyphens.has(index)) {
      if (value[index] !== "-") return false
    } else if (!hex.includes(value[index]!)) {
      return false
    }
  }
  return value[14] === "4" && "89ab".includes(value[19]!)
}

function exactResourceRef(resourceId: string): `resource://${string}` {
  return `resource://${resourceId}`
}

function proofReceiptIds(proof: WorkflowResourcePackagePublicationProofSet): string[] {
  return [
    proof.packageLoadReceipt.receiptId,
    proof.registryProjectionReceipt.receiptId,
    proof.appProjectionReceipt.receiptId,
    proof.agentMaterialProjectionReceipt.receiptId,
    ...proof.holonExecutionBindingReceipts.map((item) => item.receiptId),
    ...proof.workflowProfileReceipts.map((item) => item.receiptId),
    ...proof.runResourceReceipts.map((item) => item.receiptId),
    proof.buildReceipt.receiptId,
  ]
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

function cloneFiles(files: readonly WorkflowAuthoringBinaryFile[]): WorkflowAuthoringBinaryFile[] {
  return files.map((file) => ({ path: file.path, bytes: Uint8Array.from(file.bytes) }))
}

async function binaryTree(rootDir: string): Promise<WorkflowAuthoringBinaryFile[]> {
  const store = new NodeWorkflowAuthoringStore(rootDir)
  const paths = await store.tree()
  return Promise.all(paths.map(async (filePath) => ({
    path: filePath,
    bytes: await store.readBytes(filePath),
  })))
}

function workspaceResourceIds(snapshot: EidolonResourceRegistrySnapshot): ReadonlySet<string> {
  return new Set(
    [...snapshot.registry.byId.values()]
      .filter((entry) => entry.resource && entry.effectiveOrigin?.layerId === "workspace")
      .map((entry) => entry.resource!.resourceId),
  )
}

function exactProjection(snapshot: EidolonResourceRegistrySnapshot): {
  appRefs: string[]
  workflowRefs: string[]
  entrypointWorkflowRefs: string[]
  agentRefs: string[]
  materialRefs: string[]
} {
  const workspaceIds = workspaceResourceIds(snapshot)
  const apps = snapshot.appBundles.filter((app) => workspaceIds.has(app.resource.resourceId))
  return {
    appRefs: sortedUnique(apps.map((app) => exactResourceRef(app.resource.resourceId))),
    workflowRefs: sortedUnique(apps.flatMap((app) => app.workflowBindings.map((binding) => binding.ref))),
    entrypointWorkflowRefs: sortedUnique(apps.flatMap((app) => app.entrypoints.map((binding) => binding.ref))),
    agentRefs: sortedUnique(snapshot.agentResources.agentDefinitions
      .filter((agent) => workspaceIds.has(agent.resource.resourceId))
      .map((agent) => exactResourceRef(agent.resource.resourceId))),
    materialRefs: sortedUnique(snapshot.agentResources.materialBindings
      .filter((binding) => workspaceIds.has(binding.material.resource.resourceId))
      .map((binding) => exactResourceRef(binding.material.resource.resourceId))),
  }
}

async function assertExactProofSnapshot(
  proof: WorkflowResourcePackagePublicationProofSet,
  snapshot: EidolonResourceRegistrySnapshot,
  registry: EidolonAppResourceRegistryAdapter,
): Promise<ReturnType<typeof exactProjection>> {
  if (
    snapshot.registry.compositionRevision !== proof.registryProjectionReceipt.compositionRevision
    || snapshot.registryRevision !== proof.registryProjectionReceipt.registryRevision
  ) {
    throw new WorkflowResourcePackagePublicationError(
      "WORKFLOW_RESOURCE_PACKAGE_REGISTRY_PROOF_MISMATCH",
      "Effective registry content changed after publication preparation.",
    )
  }
  const projection = exactProjection(snapshot)
  const expected = {
    appRefs: proof.appProjectionReceipt.appRefs,
    workflowRefs: proof.appProjectionReceipt.workflowRefs,
    entrypointWorkflowRefs: proof.appProjectionReceipt.entrypointWorkflowRefs,
    agentRefs: proof.agentMaterialProjectionReceipt.agentRefs,
    materialRefs: proof.agentMaterialProjectionReceipt.materialRefs,
  }
  for (const field of Object.keys(expected) as Array<keyof typeof expected>) {
    if (JSON.stringify(projection[field]) !== JSON.stringify(expected[field])) {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_READBACK_MISMATCH",
        `Registry readback changed exact ${field}.`,
      )
    }
  }
  for (const receipt of proof.runResourceReceipts) {
    const frozen = freezeAIWorkflowRunResources({
      registry: snapshot.registry,
      projection: snapshot.agentResources,
      task: receipt.task,
      contentIdentities: snapshot.contentIdentities,
    })
    const observed = {
      bindingResourceIds: [...frozen.bindingResourceIds],
      closureResourceRefs: frozen.dependencySnapshot.closure.map((item) => exactResourceRef(item.resourceId)),
      dependencySnapshotRevision: frozen.dependencySnapshot.snapshotRevision,
      semanticFingerprint: frozen.semanticFingerprint,
    }
    const expected = {
      bindingResourceIds: receipt.bindingResourceIds,
      closureResourceRefs: receipt.closureResourceRefs,
      dependencySnapshotRevision: receipt.dependencySnapshotRevision,
      semanticFingerprint: receipt.semanticFingerprint,
    }
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_CLOSURE_PROOF_MISMATCH",
        `Effective dependency closure changed for ${receipt.task.workflowRef}#${receipt.task.nodeId}.`,
      )
    }
  }
  const projectedBindingRefs = sortedUnique(snapshot.holonExecutionBindings
    .filter(({ resource }) => snapshot.registry.byId.get(resource.resourceId)?.effectiveOrigin?.layerId === "workspace")
    .map(({ binding }) => binding.bindingRef))
  const provedBindingRefs = proof.holonExecutionBindingReceipts.map(({ bindingRef }) => bindingRef)
  if (JSON.stringify(projectedBindingRefs) !== JSON.stringify(provedBindingRefs)) {
    throw new WorkflowResourcePackagePublicationError(
      "WORKFLOW_RESOURCE_PACKAGE_HOLON_BINDING_PROJECTION_MISMATCH",
      "Effective HolonExecutionBinding projection changed after publication preparation.",
    )
  }
  for (const receipt of proof.holonExecutionBindingReceipts) {
    const frozen = await registry.freezeHolonExecutionBinding(receipt.bindingRef, snapshot)
    const observed = {
      snapshotRef: frozen.snapshotRef,
      snapshotTreeDigest: frozen.snapshotTreeDigest,
      snapshotReceiptDigest: frozen.snapshotReceiptDigest,
      bindingBytesDigest: frozen.bindingBytesDigest,
      closureResourceRefs: frozen.closure.map(({ resourceId }) => exactResourceRef(resourceId)),
      agentProofs: frozen.agentProofs.map((agent) => ({
        agentDefinitionRef: agent.agentDefinitionRef,
        agentContentDigest: agent.agentContentDigest,
        closureResourceRefs: agent.closureResourceIds.map(exactResourceRef),
        snapshotRevision: agent.snapshotRevision,
      })),
      semanticFingerprint: frozen.semanticFingerprint,
    }
    const expected = {
      snapshotRef: receipt.snapshotRef,
      snapshotTreeDigest: receipt.snapshotTreeDigest,
      snapshotReceiptDigest: receipt.snapshotReceiptDigest,
      bindingBytesDigest: receipt.bindingBytesDigest,
      closureResourceRefs: receipt.closureResourceRefs,
      agentProofs: receipt.agentProofs,
      semanticFingerprint: receipt.semanticFingerprint,
    }
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_HOLON_BINDING_CLOSURE_PROOF_MISMATCH",
        `Effective Holon execution closure changed for ${receipt.bindingRef}.`,
      )
    }
  }
  return projection
}

function assertRecoveredReceiptReadback(
  receipt: WorkflowResourcePackagePublicationReceipt,
  snapshot: EidolonResourceRegistrySnapshot,
): void {
  if (
    receipt.registryRevision !== snapshot.registryRevision
    || receipt.compositionRevision !== snapshot.registry.compositionRevision
  ) {
    throw new WorkflowResourcePackagePublicationError(
      "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_READBACK_MISMATCH",
      "Durable receipt registry facts do not match the admitted snapshot.",
    )
  }
  const projection = exactProjection(snapshot)
  for (const field of [
    "appRefs",
    "workflowRefs",
    "entrypointWorkflowRefs",
    "agentRefs",
    "materialRefs",
  ] as const) {
    if (JSON.stringify(receipt[field]) !== JSON.stringify(projection[field])) {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_READBACK_MISMATCH",
        `Durable receipt ${field} do not match the admitted snapshot.`,
      )
    }
  }
  const packageIds = sortedUnique(
    [...snapshot.registry.byId.values()]
      .filter((entry) => entry.resource && entry.effectiveOrigin?.layerId === "workspace")
      .map((entry) => entry.effectiveOrigin!.packageId),
  )
  if (packageIds.length !== 1 || packageIds[0] !== receipt.packageId) {
    throw new WorkflowResourcePackagePublicationError(
      "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_READBACK_MISMATCH",
      "Durable receipt package identity does not match the admitted workspace package.",
    )
  }
}

export class WorkflowResourcePackagePublisher {
  private readonly workspaceLayer: ResourcePackageLayerBinding & { id: "workspace" }
  private readonly parentStore: NodeWorkflowAuthoringStore
  private readonly targetName: string
  private readonly journalName: string
  private readonly lockName: string

  constructor(
    private readonly sessions: WorkflowAuthoringSessionStore,
    private readonly registry: EidolonAppResourceRegistryAdapter,
    private readonly layers: readonly ResourcePackageLayerBinding[],
  ) {
    const workspace = layers.find((layer) => layer.id === "workspace")
    if (!workspace) {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_WORKSPACE_LAYER_MISSING",
        "ResourcePackage publication requires one injected workspace layer.",
      )
    }
    if (!path.isAbsolute(workspace.rootDir)) {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_WORKSPACE_ROOT_INVALID",
        "ResourcePackage publication requires an absolute workspace layer root.",
      )
    }
    this.workspaceLayer = workspace as ResourcePackageLayerBinding & { id: "workspace" }
    const targetRoot = path.resolve(workspace.rootDir)
    this.parentStore = new NodeWorkflowAuthoringStore(path.dirname(targetRoot))
    this.targetName = path.basename(targetRoot)
    this.journalName = `.${this.targetName}.publication-journal.json`
    this.lockName = `.${this.targetName}.publication.lock`
  }

  async publish(input: {
    sessionId: string
    expectedRevision: string
    confirmed: boolean
  }): Promise<WorkflowResourcePackagePublicationPreview | WorkflowResourcePackagePublicationResult> {
    if (!input.confirmed) {
      return {
        status: "confirmation_required",
        sessionId: input.sessionId,
        revision: input.expectedRevision,
        publicationEffectDispatched: false,
        runtimeEffectDispatched: false,
      }
    }
    await this.readJournal()
    return this.parentStore.withExclusiveLock(this.lockName, async () => {
      const journal = await this.readJournal()
      let recoveryAuthority: object | undefined
      let recovered: WorkflowResourcePackagePublicationReceipt | undefined
      try {
        recovered = await this.sessions.findResourcePackagePublicationReceipt(
          input.sessionId,
          input.expectedRevision,
        )
      } catch (error) {
        if (errorCode(error) !== "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_ISSUANCE_MISMATCH"
          || !journal
          || journal.sessionId !== input.sessionId
          || journal.sourceRevision !== input.expectedRevision) {
          throw error
        }
        const recovery = await this.sessions.findRecoverableResourcePackagePublicationReceipt({
          sessionId: input.sessionId,
          sourceRevision: input.expectedRevision,
          baseArtifactRevision: journal.baseArtifactRevision,
          baseRegistryRevision: journal.baseRegistryRevision,
          createdAt: journal.startedAt,
        })
        if (!recovery) throw error
        recovered = recovery.receipt
        recoveryAuthority = recovery.authority
      }
      if (recovered) {
        const cleanupJournal = await this.recoveredReceiptCleanupJournal(recovered)
        const liveFiles = await binaryTree(this.workspaceLayer.rootDir)
        const liveRevision = hashWorkflowBinaryFiles(liveFiles)
        if (liveRevision !== recovered.artifactDigest) {
          throw new WorkflowResourcePackagePublicationError(
            "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_LIVE_MISMATCH",
            `Published receipt expects ${recovered.artifactDigest}, current live root is ${liveRevision}.`,
          )
        }
        const snapshot = await this.registry.snapshot()
        assertRecoveredReceiptReadback(recovered, snapshot)
        const finalized = await this.sessions.recordResourcePackagePublication({
          sessionId: recovered.sessionId,
          expectedRevision: recovered.sourceRevision,
          receipt: recovered,
          files: liveFiles,
          recoveryAuthority,
        })
        await this.cleanupRecoveredReceipt(cleanupJournal)
        return this.result(finalized)
      }
      const candidate = await this.sessions.resourcePackagePublicationCandidate({
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
      })
      if (path.resolve(candidate.session.target.rootDir) !== path.resolve(this.workspaceLayer.rootDir)) {
        throw new WorkflowResourcePackagePublicationError(
          "WORKFLOW_RESOURCE_PACKAGE_TARGET_MISMATCH",
          "Authoring target does not match the injected workspace ResourcePackage layer.",
        )
      }
      return this.publishLocked(candidate)
    }, { orphanRecoveryEvidencePath: this.journalName })
  }

  private async recoveredReceiptCleanupJournal(
    receipt: WorkflowResourcePackagePublicationReceipt,
  ): Promise<WorkflowResourcePackagePublicationJournal | undefined> {
    const journal = await this.readJournal()
    if (!journal) return undefined
    if (
      journal.sessionId !== receipt.sessionId
      || journal.sourceRevision !== receipt.sourceRevision
      || journal.baseArtifactRevision !== receipt.baseArtifactRevision
      || journal.baseRegistryRevision !== receipt.baseRegistryRevision
    ) {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_CONFLICT",
        `Workspace ResourcePackage has an unfinished publication attempt ${journal.attemptId}.`,
      )
    }
    await this.assertAttemptStateCoherent(journal, receipt)
    return journal
  }

  private async cleanupRecoveredReceipt(
    journal: WorkflowResourcePackagePublicationJournal | undefined,
  ): Promise<void> {
    if (!journal) return
    await rm(path.join(this.parentStore.rootPath, journal.stagingName), { recursive: true, force: true })
    await rm(path.join(this.parentStore.rootPath, journal.backupName), { recursive: true, force: true })
    await this.parentStore.delete(this.journalName)
  }

  private result(receipt: WorkflowResourcePackagePublicationReceipt): WorkflowResourcePackagePublicationResult {
    return {
      status: "published",
      sessionId: receipt.sessionId,
      revision: receipt.sourceRevision,
      receipt,
      publicationEffectDispatched: true,
      runtimeEffectDispatched: false,
    }
  }

  private async readJournal(): Promise<WorkflowResourcePackagePublicationJournal | undefined> {
    let source: string
    try {
      source = await this.parentStore.read(this.journalName)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      throw this.invalidJournal("Publication journal must contain valid JSON.")
    }
    return this.validateJournal(value)
  }

  private async writeJournal(journal: WorkflowResourcePackagePublicationJournal): Promise<void> {
    const validated = this.validateJournal(journal)
    await this.parentStore.writeAtomic(this.journalName, `${JSON.stringify(validated, null, 2)}\n`)
  }

  private validateJournal(value: unknown): WorkflowResourcePackagePublicationJournal {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw this.invalidJournal("Publication journal must be one object.")
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort(compareCodeUnits)
    if (keys.length !== PUBLICATION_JOURNAL_KEYS.length
      || keys.some((key, index) => key !== PUBLICATION_JOURNAL_KEYS[index])) {
      throw this.invalidJournal("Publication journal fields do not match the closed v1 schema.")
    }
    if (record.schemaVersion !== "workflow.resource-package-publication-journal/v1") {
      throw this.invalidJournal("Publication journal schemaVersion is not supported.")
    }
    for (const field of [
      "attemptId",
      "sessionId",
      "sourceRevision",
      "baseArtifactRevision",
      "baseRegistryRevision",
      "targetName",
      "stagingName",
      "backupName",
      "startedAt",
    ] as const) {
      const fieldValue = record[field]
      if (typeof fieldValue !== "string" || !fieldValue || fieldValue !== fieldValue.trim() || fieldValue.includes("\0")) {
        throw this.invalidJournal(`Publication journal ${field} must be one exact non-empty string.`)
      }
    }
    if (typeof record.hadLive !== "boolean") {
      throw this.invalidJournal("Publication journal hadLive must be boolean.")
    }
    if (typeof record.state !== "string" || !PUBLICATION_ATTEMPT_STATES.has(record.state)) {
      throw this.invalidJournal("Publication journal state is not supported.")
    }
    const attemptId = record.attemptId
    if (!isCanonicalUuidV4(attemptId)) {
      throw this.invalidJournal("Publication journal attemptId must be one canonical UUID v4 identity.")
    }
    if (record.targetName !== this.targetName) {
      throw this.invalidJournal("Publication journal target does not match the fixed workspace layer.")
    }
    this.assertJournalSibling(
      record.stagingName as string,
      `.${this.targetName}.publication-${attemptId}.staging`,
      "stagingName",
    )
    this.assertJournalSibling(
      record.backupName as string,
      `.${this.targetName}.publication-${attemptId}.backup`,
      "backupName",
    )
    try {
      if (new Date(record.startedAt as string).toISOString() !== record.startedAt) {
        throw this.invalidJournal("Publication journal startedAt must be one canonical timestamp.")
      }
    } catch (error) {
      if (error instanceof WorkflowResourcePackagePublicationError) throw error
      throw this.invalidJournal("Publication journal startedAt must be one canonical timestamp.")
    }
    return Object.freeze({
      schemaVersion: "workflow.resource-package-publication-journal/v1",
      attemptId,
      sessionId: record.sessionId as string,
      sourceRevision: record.sourceRevision as string,
      baseArtifactRevision: record.baseArtifactRevision as string,
      baseRegistryRevision: record.baseRegistryRevision as string,
      targetName: record.targetName as string,
      stagingName: record.stagingName as string,
      backupName: record.backupName as string,
      hadLive: record.hadLive,
      state: record.state as PublicationAttemptState,
      startedAt: record.startedAt as string,
    })
  }

  private assertJournalSibling(value: string, expected: string, field: string): void {
    const resolved = path.resolve(this.parentStore.rootPath, value)
    if (value !== expected
      || path.dirname(resolved) !== this.parentStore.rootPath
      || path.basename(resolved) !== value) {
      throw this.invalidJournal(`Publication journal ${field} is not the exact same-parent sibling.`)
    }
  }

  private invalidJournal(message: string): WorkflowResourcePackagePublicationError {
    return new WorkflowResourcePackagePublicationError(
      "WORKFLOW_RESOURCE_PACKAGE_JOURNAL_INVALID",
      message,
    )
  }

  private candidateLayers(candidateRoot: string): readonly ResourcePackageLayerBinding[] {
    return Object.freeze(this.layers.map((layer) => Object.freeze(
      layer.id === "workspace" ? { id: "workspace" as const, rootDir: candidateRoot } : layer,
    )))
  }

  private async materializeAttempt(
    candidate: WorkflowResourcePackagePublicationCandidate,
  ): Promise<WorkflowResourcePackagePublicationJournal> {
    const existing = await this.readJournal()
    if (existing) {
      if (existing.sessionId !== candidate.session.sessionId || existing.sourceRevision !== candidate.revision) {
        throw new WorkflowResourcePackagePublicationError(
          "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_CONFLICT",
          `Workspace ResourcePackage has an unfinished publication attempt ${existing.attemptId}.`,
        )
      }
      return existing
    }
    const attemptId = randomUUID()
    const stagingName = `.${this.targetName}.publication-${attemptId}.staging`
    const backupName = `.${this.targetName}.publication-${attemptId}.backup`
    const stagingRoot = path.join(this.parentStore.rootPath, stagingName)
    try {
      await this.parentStore.replaceTreeBytesAtomic(stagingName, candidate.files)
      const stagedSnapshot = await this.registry.loadIsolatedSnapshot({
        layers: this.candidateLayers(stagingRoot),
      })
      await assertExactProofSnapshot(candidate.proofSet, stagedSnapshot, this.registry)
      if (hashWorkflowBinaryFiles(await binaryTree(stagingRoot)) !== candidate.revision) {
        throw new WorkflowResourcePackagePublicationError(
          "WORKFLOW_RESOURCE_PACKAGE_STAGING_DIGEST_MISMATCH",
          "Staged ResourcePackage bytes changed before publication.",
        )
      }
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true })
      throw error
    }
    const journal: WorkflowResourcePackagePublicationJournal = {
      schemaVersion: "workflow.resource-package-publication-journal/v1",
      attemptId,
      sessionId: candidate.session.sessionId,
      sourceRevision: candidate.revision,
      baseArtifactRevision: candidate.session.target.baseArtifactRevision,
      baseRegistryRevision: candidate.session.target.baseRegistryRevision,
      targetName: this.targetName,
      stagingName,
      backupName,
      hadLive: await exists(path.join(this.parentStore.rootPath, this.targetName)),
      state: "prepared",
      startedAt: new Date().toISOString(),
    }
    await this.writeJournal(journal)
    return journal
  }

  private async publishLocked(
    candidate: WorkflowResourcePackagePublicationCandidate,
  ): Promise<WorkflowResourcePackagePublicationResult> {
    let admittedJournal: WorkflowResourcePackagePublicationJournal | undefined
    const publication = await this.registry.withPublicationFence(async (fence) => {
      if (!await this.readJournal()) {
        const observedBaseRevision = hashWorkflowBinaryFiles(await binaryTree(this.workspaceLayer.rootDir))
        if (observedBaseRevision !== candidate.session.target.baseArtifactRevision) {
          throw new WorkflowResourcePackagePublicationError(
            "WORKFLOW_RESOURCE_PACKAGE_BASE_REVISION_CONFLICT",
            `Workspace ResourcePackage base revision conflict: expected ${candidate.session.target.baseArtifactRevision}, current ${observedBaseRevision}.`,
          )
        }
      }
      let journal = await this.materializeAttempt(candidate)
      const targetRoot = path.join(this.parentStore.rootPath, journal.targetName)
      const stagingRoot = path.join(this.parentStore.rootPath, journal.stagingName)
      const backupRoot = path.join(this.parentStore.rootPath, journal.backupName)
      await this.assertAttemptStateCoherent(journal)
      try {
        journal = await this.restoreAttemptToPrepared(journal, targetRoot, stagingRoot, backupRoot)
        if (fence.currentSnapshot.registryRevision !== journal.baseRegistryRevision) {
          throw new WorkflowResourcePackagePublicationError(
            "WORKFLOW_RESOURCE_PACKAGE_BASE_REGISTRY_CONFLICT",
            `Workspace registry base revision conflict: expected ${journal.baseRegistryRevision}, current ${fence.currentSnapshot.registryRevision}.`,
          )
        }
        const currentFiles = await binaryTree(targetRoot)
        const currentRevision = hashWorkflowBinaryFiles(currentFiles)
        if (journal.state === "prepared" && currentRevision !== journal.baseArtifactRevision) {
          throw new WorkflowResourcePackagePublicationError(
            "WORKFLOW_RESOURCE_PACKAGE_BASE_REVISION_CONFLICT",
            `Workspace ResourcePackage base revision conflict: expected ${journal.baseArtifactRevision}, current ${currentRevision}.`,
          )
        }
        if (journal.state === "prepared") {
          if (journal.hadLive) await rename(targetRoot, backupRoot)
          journal = { ...journal, state: "live-backed-up" }
          await this.writeJournal(journal)
        }
        if (journal.state === "live-backed-up") {
          await rename(stagingRoot, targetRoot)
          journal = { ...journal, state: "candidate-live" }
          await this.writeJournal(journal)
        }
        if (journal.state !== "candidate-live") {
          throw new WorkflowResourcePackagePublicationError(
            "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_STATE_INVALID",
            `Publication attempt ${journal.attemptId} cannot resume from ${journal.state}.`,
          )
        }
        const liveRevision = hashWorkflowBinaryFiles(await binaryTree(targetRoot))
        if (liveRevision !== candidate.revision) {
          throw new WorkflowResourcePackagePublicationError(
            "WORKFLOW_RESOURCE_PACKAGE_LIVE_DIGEST_MISMATCH",
            `Published ResourcePackage digest mismatch: expected ${candidate.revision}, current ${liveRevision}.`,
          )
        }
        const loaded = await fence.loadCandidateSnapshot()
        const projection = await assertExactProofSnapshot(candidate.proofSet, loaded.snapshot, this.registry)
        const receiptPayload: WorkflowResourcePackagePublicationReceiptPayload = {
          kind: "workflow.resourcePackagePublicationReceipt",
          schemaVersion: "workflow.resource-package-publication-receipt/v1",
          sessionId: candidate.session.sessionId,
          sourceRevision: candidate.revision,
          baseArtifactRevision: journal.baseArtifactRevision,
          baseRegistryRevision: journal.baseRegistryRevision,
          packageId: candidate.session.target.packageId,
          packageVersion: candidate.session.target.packageVersion,
          artifactDigest: liveRevision,
          compositionRevision: loaded.snapshot.registry.compositionRevision,
          registryRevision: loaded.snapshot.registryRevision,
          ...projection,
          proofReceiptIds: proofReceiptIds(candidate.proofSet),
          createdAt: journal.startedAt,
          publicationEffectDispatched: true,
          runtimeEffectDispatched: false,
        }
        const receipt: WorkflowResourcePackagePublicationReceipt = {
          ...receiptPayload,
          receiptId: workflowResourcePackagePublicationReceiptId(receiptPayload),
        }
        const stored = await this.sessions.recordResourcePackagePublication({
          sessionId: candidate.session.sessionId,
          expectedRevision: candidate.revision,
          receipt,
          files: cloneFiles(candidate.files),
        })
        admittedJournal = journal
        return { candidate: loaded, value: stored }
      } catch (error) {
        await this.rollback(journal, targetRoot, stagingRoot, backupRoot)
        throw error
      }
    })
    if (!admittedJournal) {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_STATE_INVALID",
        "Publication fence completed without one admitted journal state.",
      )
    }
    const committedJournal: WorkflowResourcePackagePublicationJournal = {
      ...admittedJournal,
      state: "committed",
    }
    await this.writeJournal(committedJournal)
    await rm(path.join(this.parentStore.rootPath, committedJournal.backupName), { recursive: true, force: true })
    await this.parentStore.delete(this.journalName)
    return this.result(publication.value)
  }

  private async assertAttemptStateCoherent(
    journal: WorkflowResourcePackagePublicationJournal,
    receipt?: WorkflowResourcePackagePublicationReceipt,
  ): Promise<void> {
    const facts = await this.inspectAttemptTree(journal)
    const signatures = this.attemptSignatures(facts, journal)
    const incoherent = (): never => {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_STATE_INCOHERENT",
        `Publication attempt ${journal.attemptId} has an unreachable ${journal.state}/${journal.hadLive ? "with-live" : "without-live"} state.`,
      )
    }

    if (receipt) {
      const allowed = journal.hadLive
        ? new Set(["source/missing/base", "source/missing/missing"])
        : new Set(["source/missing/missing"])
      if (
        (journal.state !== "candidate-live" && journal.state !== "committed")
        || !signatures.some((signature) => allowed.has(signature))
      ) incoherent()
      return
    }
    if (journal.state === "committed") incoherent()
    const activeState = journal.state as Exclude<PublicationAttemptState, "committed">
    const allowed = journal.hadLive
      ? {
          prepared: new Set(["base/source/missing", "missing/source/base"]),
          "live-backed-up": new Set(["missing/source/base", "source/missing/base", "base/source/missing"]),
          "candidate-live": new Set(["source/missing/base", "missing/source/base", "base/source/missing"]),
        }[activeState]
      : {
          prepared: new Set(["missing/source/missing"]),
          "live-backed-up": new Set(["missing/source/missing", "source/missing/missing"]),
          "candidate-live": new Set(["source/missing/missing", "missing/source/missing"]),
        }[activeState]
    if (!allowed || !signatures.some((signature) => allowed.has(signature))) incoherent()
  }

  private async inspectAttemptTree(
    journal: WorkflowResourcePackagePublicationJournal,
  ): Promise<PublicationAttemptTreeFacts> {
    await this.assertAttemptDirectoryBoundary(journal.targetName)
    await this.assertAttemptDirectoryBoundary(journal.stagingName)
    await this.assertAttemptDirectoryBoundary(journal.backupName)
    const revision = async (name: string): Promise<string | undefined> => {
      const root = path.join(this.parentStore.rootPath, name)
      return await exists(root) ? hashWorkflowBinaryFiles(await binaryTree(root)) : undefined
    }
    return {
      targetRevision: await revision(journal.targetName),
      stagingRevision: await revision(journal.stagingName),
      backupRevision: await revision(journal.backupName),
    }
  }

  private attemptSignatures(
    facts: PublicationAttemptTreeFacts,
    journal: WorkflowResourcePackagePublicationJournal,
  ): string[] {
    const roles = (revision: string | undefined): Array<"missing" | "base" | "source"> => {
      if (revision === undefined) return ["missing"]
      const matches: Array<"base" | "source"> = []
      if (revision === journal.baseArtifactRevision) matches.push("base")
      if (revision === journal.sourceRevision) matches.push("source")
      if (matches.length > 0) return matches
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_STATE_INCOHERENT",
        `Publication attempt ${journal.attemptId} contains an unrecognized tree revision ${revision}.`,
      )
    }
    const signatures: string[] = []
    for (const target of roles(facts.targetRevision)) {
      for (const staging of roles(facts.stagingRevision)) {
        for (const backup of roles(facts.backupRevision)) {
          signatures.push(`${target}/${staging}/${backup}`)
        }
      }
    }
    return signatures
  }

  private async assertAttemptDirectoryBoundary(siblingName: string): Promise<void> {
    const parent = this.parentStore.rootPath
    const target = path.resolve(parent, siblingName)
    if (path.dirname(target) !== parent || path.basename(target) !== siblingName) {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_PATH_INVALID",
        `Publication attempt path '${siblingName}' is not one exact same-parent sibling.`,
      )
    }
    let info
    try {
      info = await lstat(target)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_PATH_INVALID",
        `Publication attempt path '${siblingName}' must be one ordinary directory when present.`,
      )
    }
    try {
      const [canonicalParent, canonicalTarget] = await Promise.all([
        realpath(parent),
        realpath(target),
      ])
      if (path.dirname(canonicalTarget) !== canonicalParent) {
        throw new WorkflowResourcePackagePublicationError(
          "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_PATH_INVALID",
          `Publication attempt path '${siblingName}' is outside the canonical target parent.`,
        )
      }
      await binaryTree(target)
    } catch (error) {
      if (error instanceof WorkflowResourcePackagePublicationError) throw error
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_ATTEMPT_PATH_INVALID",
        `Publication attempt path '${siblingName}' failed physical containment validation.`,
      )
    }
  }

  private async restoreAttemptToPrepared(
    journal: WorkflowResourcePackagePublicationJournal,
    targetRoot: string,
    stagingRoot: string,
    backupRoot: string,
  ): Promise<WorkflowResourcePackagePublicationJournal> {
    if (journal.state === "committed") {
      throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_COMMITTED_RECEIPT_MISSING",
        `Committed publication attempt ${journal.attemptId} has no matching durable receipt.`,
      )
    }
    const backupPresent = await exists(backupRoot)
    const targetPresent = await exists(targetRoot)
    const stagingPresent = await exists(stagingRoot)
    if (backupPresent) {
      const backupRevision = hashWorkflowBinaryFiles(await binaryTree(backupRoot))
      if (backupRevision !== journal.baseArtifactRevision) {
        throw new WorkflowResourcePackagePublicationError(
          "WORKFLOW_RESOURCE_PACKAGE_BACKUP_DIGEST_MISMATCH",
          `Publication backup changed: expected ${journal.baseArtifactRevision}, current ${backupRevision}.`,
        )
      }
      if (targetPresent) {
        const targetRevision = hashWorkflowBinaryFiles(await binaryTree(targetRoot))
        if (targetRevision === journal.sourceRevision && !stagingPresent) {
          await rename(targetRoot, stagingRoot)
        } else if (targetRevision !== journal.baseArtifactRevision) {
          throw new WorkflowResourcePackagePublicationError(
            "WORKFLOW_RESOURCE_PACKAGE_RECOVERY_STATE_INVALID",
            `Publication recovery found unexpected live revision ${targetRevision}.`,
          )
        }
      }
      if (!await exists(targetRoot)) await rename(backupRoot, targetRoot)
      else await rm(backupRoot, { recursive: true, force: true })
    } else if (!journal.hadLive && targetPresent && !stagingPresent) {
      const targetRevision = hashWorkflowBinaryFiles(await binaryTree(targetRoot))
      if (targetRevision !== journal.sourceRevision) {
        throw new WorkflowResourcePackagePublicationError(
          "WORKFLOW_RESOURCE_PACKAGE_RECOVERY_STATE_INVALID",
          `Publication recovery found unexpected live revision ${targetRevision}.`,
        )
      }
      await rename(targetRoot, stagingRoot)
    }
    const normalized: WorkflowResourcePackagePublicationJournal = { ...journal, state: "prepared" }
    if (journal.state !== "prepared" || backupPresent) await this.writeJournal(normalized)
    return normalized
  }

  private async rollback(
    journal: WorkflowResourcePackagePublicationJournal,
    targetRoot: string,
    stagingRoot: string,
    backupRoot: string,
  ): Promise<void> {
    const backupPresent = await exists(backupRoot)
    const targetPresent = await exists(targetRoot)
    if (backupPresent) {
      if (targetPresent) {
        const targetRevision = hashWorkflowBinaryFiles(await binaryTree(targetRoot))
        if (targetRevision === journal.sourceRevision) {
          await rm(targetRoot, { recursive: true, force: true })
        } else if (targetRevision !== journal.baseArtifactRevision) {
          throw new WorkflowResourcePackagePublicationError(
            "WORKFLOW_RESOURCE_PACKAGE_ROLLBACK_STATE_INVALID",
            `Publication rollback found unexpected live revision ${targetRevision}; backup retained at ${backupRoot}.`,
          )
        }
      }
      if (!await exists(targetRoot)) await rename(backupRoot, targetRoot)
      else await rm(backupRoot, { recursive: true, force: true })
    } else if (!journal.hadLive && targetPresent) {
      const targetRevision = hashWorkflowBinaryFiles(await binaryTree(targetRoot))
      if (targetRevision === journal.sourceRevision) await rm(targetRoot, { recursive: true, force: true })
    }
    await rm(stagingRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
    await this.parentStore.delete(this.journalName)
  }
}
