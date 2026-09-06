import path from "node:path"
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises"
import { parseXnl, wordToString, type DataElementNode, type XnlNode } from "xnl-core"
import {
  applyResourceAuthoring,
  planResourceAuthoring,
  type ResourceAuthoringCatalogBinding,
  type ResourceAuthoringPlan,
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
import type {
  EidolonVfsPublicationAssociation,
  EidolonVfsWorkspaceWrite,
  EidolonVfsPublicationRecord,
} from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"

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
  admit(candidate: EffectiveEidolonVfsCandidate, association?: EidolonVfsPublicationAssociation,
    workspaceWrite?: EidolonVfsWorkspaceWrite): Promise<EffectiveEidolonVfsMaterializationResult>
  lookupPublication?(transactionId: string): Promise<EidolonVfsPublicationRecord | undefined>
  restore?(): Promise<EffectiveEidolonVfsView>
}>

export type EidolonAIAgentDefinitionAuthoringFaultObserver = Readonly<{
  afterPrepared?(input: Readonly<{ transactionId: string; planDigest: string }>): void | Promise<void>
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
  proposal: ResourceAuthoringProposal
  planningAuthority: ResourceAuthoringRuntime["planningAuthority"]
  workspaceBefore: WorkspaceBefore
  effectiveBefore: Readonly<{ authorityDigest: string; kind: string; documentUri: string; origin: unknown }> | null
  expectedEffectiveRevision: string | null
}>

type LegacyPreparedState = Readonly<{
  schemaVersion: "eidolon.resource-authoring-journal/v1"
  transactionId: string
  planDigest: string
  documentUri: `vfs://@/${string}`
  authorityDigest: string
  authorityText: string
  registryRevisionBefore: string
}>

type WorkspaceBefore = Readonly<{ state: "absent" }> | Readonly<{ state: "present"; text: string; digest: `sha256:${string}` }>
type DurablePreparedState = LegacyPreparedState | Readonly<Omit<PreparedState, "targetPath"> & {
  schemaVersion: "eidolon.resource-authoring-journal/v2"
  phase: "prepared"
}>
type PlanningPins = Readonly<{
  schemaVersion: "eidolon.resource-authoring-planning-pins/v1"
  planningAuthority: ResourceAuthoringRuntime["planningAuthority"]
  plan: ResourceAuthoringPlan
}>
type CandidateEvidence = Readonly<{
  schemaVersion: "eidolon.resource-authoring-candidate/v1"
  phase: "validated"
  planDigest: string
  transactionId: string
  candidatePlanId: string
  candidateTreeDigest: string
  registryRevisionAfter: string
}>

const WORKSPACE_LAYER_ID = "workspace" as const
const AUTHORING_KINDS = new Set(["AIAgentDefinition", "AgentContextPipeline", "AgentMessageSource"])

/**
 * Host effect adapter for single-file Agent recipe authority revisions.
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
    if (!AUTHORING_KINDS.has(input.proposal.kind)) throw new Error("EIDOLON_AGENT_AUTHORING_KIND_UNSUPPORTED")
    const publication = await this.registry.withPublicationFence(async (fence) => {
      const pins = await this.readPlanningPins(proposalPinsPath(this.supportRoot, input.proposal))
      if (pins && canonicalJson(pins.plan.proposal) !== canonicalJson(input.proposal)) {
        throw new Error("EIDOLON_AGENT_AUTHORING_PLANNING_PINS_CONFLICT")
      }
      const transaction = await this.createTransaction(fence, input.proposal, pins?.planningAuthority)
      const plan = planResourceAuthoring(transaction.runtime, input.proposal, {})
      const trustedPins = { schemaVersion: "eidolon.resource-authoring-planning-pins/v1", planningAuthority: transaction.runtime.planningAuthority, plan }
      await writeJsonImmutable(planningPinsPath(this.supportRoot, plan.planDigest), trustedPins)
      await writeJsonImmutable(proposalPinsPath(this.supportRoot, input.proposal), trustedPins)
      const receipt = await applyResourceAuthoring(transaction.runtime, plan, {})
      const candidate = transaction.publicationCandidate()
        ?? await fence.loadCandidateSnapshot(this.effectiveVfsAuthoring ? {
          effectiveVfs: (await this.effectiveVfsAuthoring.restore?.() ?? this.effectiveVfsAuthoring.read()).readPort,
        } : undefined)
      return Object.freeze({ candidate, value: Object.freeze({ receipt }) })
    })
    return Object.freeze({ receipt: publication.value.receipt, snapshot: publication.snapshot })
  }

  async loadReceipt(planDigest: string): Promise<ResourceAuthoringReceipt | undefined> {
    const committed = await this.readReceipt(receiptPath(this.supportRoot, planDigest))
    if (committed) {
      if (committed.planDigest !== planDigest || committed.transactionId !== transactionIdFor(planDigest)) throw new Error("EIDOLON_AGENT_AUTHORING_RECEIPT_IDENTITY_MISMATCH")
      return this.verifyStoredReceipt(committed)
    }
    const pending = await this.readReceipt(pendingReceiptPath(this.supportRoot, planDigest))
    if (!pending) return undefined
    if (pending.planDigest !== planDigest || pending.transactionId !== transactionIdFor(planDigest)) throw new Error("EIDOLON_AGENT_AUTHORING_RECEIPT_IDENTITY_MISMATCH")
    const proof = await this.effectiveVfsAuthoring?.lookupPublication?.(pending.transactionId)
    if (!proof) return undefined
    if (proof.association?.planDigest !== planDigest
      || proof.association?.transactionId !== pending.transactionId
      || proof.association?.receiptDigest !== pending.receiptDigest) {
      throw new Error("EIDOLON_AGENT_AUTHORING_PUBLICATION_PROOF_MISMATCH")
    }
    const journal = await this.readJournal(planDigest)
    const evidence = await readJson(candidateEvidencePath(this.supportRoot, planDigest)) as CandidateEvidence | undefined
    if (!journal || journal.schemaVersion !== "eidolon.resource-authoring-journal/v2"
      || journal.transactionId !== pending.transactionId
      || journal.authorityDigest !== pending.authorityDigestAfter
      || !evidence || evidence.schemaVersion !== "eidolon.resource-authoring-candidate/v1"
      || evidence.phase !== "validated" || evidence.planDigest !== planDigest
      || evidence.transactionId !== pending.transactionId
      || evidence.registryRevisionAfter !== pending.registryRevisionAfter
      || evidence.candidatePlanId !== proof.plan.planId
      || evidence.candidateTreeDigest !== proof.receipt.candidateTreeDigest
      || proof.plan.expectedCurrentRevision !== journal.expectedEffectiveRevision) {
      throw new Error("EIDOLON_AGENT_AUTHORING_PUBLICATION_PROOF_MISMATCH")
    }
    await this.verifyStoredReceipt(pending)
    const recovered = await this.writeReceipt(pending)
    await this.removeJournal(planDigest).catch(() => undefined)
    await unlink(pendingReceiptPath(this.supportRoot, planDigest)).catch(() => undefined)
    return recovered
  }

  private async createTransaction(
    fence: EidolonResourceRegistryPublicationFence,
    proposal: ResourceAuthoringProposal,
    trustedPlanningAuthority?: ResourceAuthoringRuntime["planningAuthority"],
  ): Promise<{
    runtime: ResourceAuthoringRuntime
    publicationCandidate(): EidolonResourceRegistryPublicationCandidate | undefined
  }> {
    const workspaceTree = fence.currentSnapshot.effectiveVfs
      ? fence.currentSnapshot.contentIdentityLayers[0]?.tree
      : await loadResourceTree({ rootDir: this.workspaceLayer.rootDir })
    if (!workspaceTree) throw new Error("EIDOLON_AGENT_AUTHORING_EFFECTIVE_TREE_MISSING")
    const planningAuthority = trustedPlanningAuthority ?? projectPlanningAuthority(fence.currentSnapshot, workspaceTree, proposal.kind)
    const catalog = planningAuthority.catalogs.find(({ catalogId }) => catalogId === proposal.catalogId)
    if (!catalog) throw new Error("EIDOLON_AGENT_AUTHORING_CATALOG_MISSING")
    const prepared = new Map<string, PreparedState>()
    const effectiveCandidates = new Map<string, EffectiveEidolonVfsCandidate>()
    const legacyCandidates = new Map<string, string>()
    const legacyWrites = new Set<string>()
    const effectiveVfsAuthoring = this.effectiveVfsAuthoring
    let publicationCandidate: EidolonResourceRegistryPublicationCandidate | undefined

    const transaction: ResourceAuthoringTransactionPort = {
      loadReceipt: (planDigest) => this.loadReceipt(planDigest),
      prepare: async (input) => {
        if (input.expected.registryRevision !== fence.currentSnapshot.registryRevision) {
          throw new Error("EIDOLON_AGENT_AUTHORING_REGISTRY_CAS_CONFLICT")
        }
        const targetPath = await this.resolveTarget(catalog, input.documentUri)
        const transactionId = transactionIdFor(input.planDigest)
        const selected = fence.currentSnapshot.contentIdentityRegistry.byId.get(proposal.resourceId)
        const selectedResource = selected?.resource
        const identity = fence.currentSnapshot.contentIdentities.get(proposal.resourceId)
        if (input.expected.state === "present"
          ? !selected || !selectedResource || !identity || identity.authorityDigest !== input.expected.authorityDigest
            || selected.kind !== proposal.kind || selectedResource.documentUri !== input.documentUri
          : selected !== undefined || identity !== undefined) {
          throw new Error("EIDOLON_AGENT_AUTHORING_RESOURCE_CAS_CONFLICT")
        }
        const workspaceBefore = await readWorkspaceBefore(targetPath)
        if (input.expected.state === "absent" && workspaceBefore.state !== "absent") {
          throw new Error("EIDOLON_AGENT_AUTHORING_RESOURCE_CAS_CONFLICT")
        }
        const state = Object.freeze({
          transactionId,
          planDigest: input.planDigest,
          documentUri: input.documentUri,
          authorityDigest: input.authorityDigest,
          authorityText: input.authorityText,
          registryRevisionBefore: input.expected.registryRevision,
          targetPath,
          proposal,
          planningAuthority,
          workspaceBefore,
          effectiveBefore: selected && selectedResource && identity ? {
            authorityDigest: identity.authorityDigest, kind: selected.kind,
            documentUri: selectedResource.documentUri, origin: selected.effectiveOrigin,
          } : null,
          expectedEffectiveRevision: fence.currentSnapshot.effectiveVfs?.revision ?? null,
        }) satisfies PreparedState
        const journal = await this.readJournal(input.planDigest)
        if (journal) {
          assertJournal(journal, state)
        } else {
          await this.writeJournal(state)
        }
        prepared.set(transactionId, state)
        await this.faultObserver?.afterPrepared?.({ transactionId, planDigest: input.planDigest })
        return Object.freeze({
          transactionId,
          planDigest: input.planDigest,
          authorityDigestBefore: input.expected.state === "present" ? input.expected.authorityDigest : null,
          registryRevisionBefore: input.expected.registryRevision,
        }) satisfies ResourceAuthoringPreparedWrite
      },
      refreshCandidate: async (input) => {
        const state = prepared.get(input.transactionId)
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
              const candidateDirectory = path.join(this.supportRoot, "candidates")
              await mkdir(candidateDirectory, { recursive: true })
              const isolatedRoot = await mkdtemp(path.join(candidateDirectory, `${digestKey(state.planDigest)}-`))
              legacyCandidates.set(state.transactionId, isolatedRoot)
              await cp(this.workspaceLayer.rootDir, isolatedRoot, { recursive: true, errorOnExist: true, force: false })
              const target = path.join(isolatedRoot, state.documentUri.slice("vfs://@/".length))
              await replaceWorkspaceFile(target, await readWorkspaceBefore(target), state.authorityText)
              return this.registry.loadIsolatedSnapshot({ layers: this.layers.map((layer) => layer.id === WORKSPACE_LAYER_ID
                ? { ...layer, rootDir: isolatedRoot } : layer) })
            })()
        await this.registry.preflightAuthoringCandidate(candidateSnapshot, { resourceId: proposal.resourceId, kind: proposal.kind })
        const effectiveCandidate = effectiveCandidates.get(state.transactionId)
        if (effectiveCandidate) await writeJsonImmutable(candidateEvidencePath(this.supportRoot, state.planDigest), {
          schemaVersion: "eidolon.resource-authoring-candidate/v1", phase: "validated",
          planDigest: state.planDigest, transactionId: state.transactionId,
          candidatePlanId: effectiveCandidate.plan.planId,
          candidateTreeDigest: effectiveCandidate.plan.candidateTreeDigest,
          registryRevisionAfter: candidateSnapshot.registryRevision,
        } satisfies CandidateEvidence)
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
          const admission = await effectiveVfsAuthoring.admit(effectiveCandidate, {
            transactionId: state.transactionId, planDigest: state.planDigest, receiptDigest: input.receipt.receiptDigest,
          }, {
            logicalPath: `/.eidolon/resources/${state.documentUri.slice("vfs://@/".length)}`,
            before: state.workspaceBefore, authorityText: state.authorityText,
          })
          if (admission.status !== "admitted") {
            const diagnostics = admission.status === "planning_rejected"
              ? admission.diagnostics
              : admission.receipt.diagnostics
            throw new Error(`EIDOLON_AGENT_AUTHORING_VFS_ADMISSION_REJECTED: ${diagnostics.map(({ code, message }) => `${code}: ${message}`).join("; ")}`)
          }
          await this.faultObserver?.afterEffectiveVfsAdmission?.({
            transactionId: input.transactionId,
            planDigest: state.planDigest,
            publishedRevision: admission.effective.snapshot.revision,
          })
          const admittedSnapshot = await this.registry.loadIsolatedEffectiveVfsSnapshot(admission.effective.readPort)
          if (admittedSnapshot.registryRevision !== input.receipt.registryRevisionAfter) {
            throw new Error("EIDOLON_AGENT_AUTHORING_REGISTRY_READBACK_MISMATCH")
          }
          const current = await effectiveVfsAuthoring.restore?.() ?? effectiveVfsAuthoring.read()
          publicationCandidate = await fence.loadCandidateSnapshot({ effectiveVfs: current.readPort })
        } else {
          await replaceWorkspaceFile(state.targetPath, state.workspaceBefore, state.authorityText, () => legacyWrites.add(state.transactionId))
          publicationCandidate = await fence.loadCandidateSnapshot()
          if (publicationCandidate.snapshot.registryRevision !== input.receipt.registryRevisionAfter) {
            throw new Error("EIDOLON_AGENT_AUTHORING_REGISTRY_READBACK_MISMATCH")
          }
        }
        const committed = await this.writeReceipt(input.receipt)
        await this.removeJournal(state.planDigest).catch(() => undefined)
        await unlink(pendingReceiptPath(this.supportRoot, state.planDigest)).catch(() => undefined)
        prepared.delete(input.transactionId)
        effectiveCandidates.delete(input.transactionId)
        const isolatedRoot = legacyCandidates.get(input.transactionId)
        if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true })
        return committed
      },
      rollback: async (input) => {
        const state = prepared.get(input.transactionId)
        if (!state) return
        // The VFS owner commits before it projects workspace bytes. An uncertain
        // owner response cannot authorize compensation by this adapter.
        if (effectiveVfsAuthoring && await this.readReceipt(pendingReceiptPath(this.supportRoot, state.planDigest))) {
          if (!effectiveVfsAuthoring.lookupPublication || await effectiveVfsAuthoring.lookupPublication(state.transactionId)) return
        }
        if (!effectiveVfsAuthoring && legacyWrites.has(state.transactionId) && await fileDigest(state.targetPath) === state.authorityDigest) {
          if (state.workspaceBefore.state === "absent") await unlink(state.targetPath)
          else await replaceWorkspaceFile(state.targetPath, { state: "present", text: state.authorityText, digest: state.authorityDigest as `sha256:${string}` }, state.workspaceBefore.text)
        }
        const isolatedRoot = legacyCandidates.get(input.transactionId)
        if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true })
        await unlink(pendingReceiptPath(this.supportRoot, state.planDigest)).catch(() => undefined)
        await this.removeJournal(state.planDigest).catch(() => undefined)
        prepared.delete(input.transactionId)
        effectiveCandidates.delete(input.transactionId)
      },
    }

    const runtime: ResourceAuthoringRuntime = Object.freeze({
      planningAuthority,
      inspectAuthority: inspectAgentResourceAuthority,
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
    await mkdir(this.workspaceLayer.rootDir, { recursive: true })
    const canonicalRoot = await realpath(this.workspaceLayer.rootDir)
    const target = path.resolve(canonicalRoot, ...relativePath.split("/"))
    const parent = path.dirname(target)
    if (!isContained(canonicalRoot, parent)) {
      throw new Error("EIDOLON_AGENT_AUTHORING_PATH_OUTSIDE_WORKSPACE")
    }
    let directory = canonicalRoot
    for (const component of path.relative(canonicalRoot, parent).split(path.sep).filter(Boolean)) {
      directory = path.join(directory, component)
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
      const metadata = await lstat(directory)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("EIDOLON_AGENT_AUTHORING_PARENT_INVALID")
    }
    await readWorkspaceBefore(target)
    return target
  }

  private async readJournal(planDigest: string): Promise<DurablePreparedState | undefined> {
    const value = await readJson(journalPath(this.supportRoot, planDigest))
    if (value === undefined) return undefined
    const journal = value as DurablePreparedState
    if (!["eidolon.resource-authoring-journal/v1", "eidolon.resource-authoring-journal/v2"].includes(journal.schemaVersion)
      || journal.planDigest !== planDigest
      || journal.transactionId !== transactionIdFor(planDigest)
      || !journal.documentUri?.startsWith("vfs://@/")
      || sha256Digest(journal.authorityText) !== journal.authorityDigest) {
      throw new Error("EIDOLON_AGENT_AUTHORING_JOURNAL_INVALID")
    }
    if (journal.schemaVersion === "eidolon.resource-authoring-journal/v2") {
      if (journal.phase !== "prepared"
        || journal.proposal.authorityText !== journal.authorityText
        || journal.proposal.documentUri !== journal.documentUri
        || journal.proposal.expected.registryRevision !== journal.registryRevisionBefore
        || !["absent", "present"].includes(journal.workspaceBefore?.state)
        || journal.workspaceBefore.state === "present" && sha256Digest(journal.workspaceBefore.text) !== journal.workspaceBefore.digest) {
        throw new Error("EIDOLON_AGENT_AUTHORING_JOURNAL_INVALID")
      }
      const plan = planResourceAuthoring({ planningAuthority: journal.planningAuthority, inspectAuthority: inspectAgentResourceAuthority }, journal.proposal, {})
      if (plan.planDigest !== planDigest) throw new Error("EIDOLON_AGENT_AUTHORING_JOURNAL_INVALID")
    }
    return Object.freeze(journal)
  }

  private async writeJournal(state: PreparedState): Promise<void> {
    const { targetPath: _targetPath, ...durable } = state
    const journal = Object.freeze({ ...durable, schemaVersion: "eidolon.resource-authoring-journal/v2" as const, phase: "prepared" as const })
    await writeJsonImmutable(journalPath(this.supportRoot, state.planDigest), journal)
  }

  private async removeJournal(planDigest: string): Promise<void> {
    await unlink(journalPath(this.supportRoot, planDigest))
    await unlink(candidateEvidencePath(this.supportRoot, planDigest)).catch(() => undefined)
  }

  private async readReceipt(filePath: string): Promise<ResourceAuthoringReceipt | undefined> {
    const value = await readJson(filePath)
    return value === undefined ? undefined : Object.freeze(value as ResourceAuthoringReceipt)
  }

  private async readPlanningPins(filePath: string): Promise<PlanningPins | undefined> {
    const value = await readJson(filePath) as PlanningPins | undefined
    if (value === undefined) return undefined
    if (value.schemaVersion !== "eidolon.resource-authoring-planning-pins/v1") {
      throw new Error("EIDOLON_AGENT_AUTHORING_PLANNING_PINS_INVALID")
    }
    const plan = planResourceAuthoring({ planningAuthority: value.planningAuthority, inspectAuthority: inspectAgentResourceAuthority }, value.plan.proposal, {})
    if (canonicalJson(plan) !== canonicalJson(value.plan)) throw new Error("EIDOLON_AGENT_AUTHORING_PLANNING_PINS_INVALID")
    return Object.freeze(value)
  }

  private async verifyStoredReceipt(receipt: ResourceAuthoringReceipt): Promise<ResourceAuthoringReceipt> {
    const pins = await this.readPlanningPins(planningPinsPath(this.supportRoot, receipt.planDigest))
    // A legacy committed receipt remains readable. Pending legacy material is
    // never promoted without an owner proof and authentic planning pins.
    if (!pins) {
      if (await this.readReceipt(receiptPath(this.supportRoot, receipt.planDigest))) return receipt
      throw new Error("EIDOLON_AGENT_AUTHORING_PLANNING_PINS_MISSING")
    }
    const unexpected = async (): Promise<never> => { throw new Error("EIDOLON_AGENT_AUTHORING_REPLAY_WRITE_FORBIDDEN") }
    return applyResourceAuthoring({
      planningAuthority: pins.planningAuthority,
      inspectAuthority: inspectAgentResourceAuthority,
      transaction: { loadReceipt: async () => receipt, prepare: unexpected, refreshCandidate: unexpected, commit: unexpected, rollback: unexpected },
    }, pins.plan, {})
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
  resourceKind: string,
): ResourceAuthoringRuntime["planningAuthority"] {
  const kind = snapshot.contentIdentityRegistry.kindDefinitions.get(resourceKind)?.definition
  if (!kind) throw new Error("EIDOLON_AGENT_AUTHORING_KIND_DEFINITION_MISSING")
  if (!kind.sourceShapes.includes("single-file")) {
    throw new Error("EIDOLON_AGENT_AUTHORING_SINGLE_FILE_KIND_REQUIRED")
  }
  const catalogs = (workspaceTree.manifest.node.subdomains.Catalogs?.body ?? [])
    .filter(isResourceNode)
    .filter((node) => node.tag === "Catalog"
      && node.properties.kind === resourceKind
      && node.properties.shape === "single-file")
    .map((node): ResourceAuthoringCatalogBinding => Object.freeze({
      catalogId: exactString(node.resourceId, "catalog id"),
      resourceKind,
      sourceShape: "single-file",
      rootUri: normalizeCatalogRoot(exactString(node.properties.root, "catalog root")),
      ...(node.properties.entry === undefined
        ? {}
        : { entry: exactString(node.properties.entry, "catalog entry") }),
    }))
  if (catalogs.length === 0) throw new Error("EIDOLON_AGENT_AUTHORING_CATALOG_MISSING")
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

function inspectAgentResourceAuthority(input: Readonly<{
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
  if (!AUTHORING_KINDS.has(root.tag)
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

function planningPinsPath(supportRoot: string, planDigest: string): string {
  return path.join(supportRoot, "planning-pins", `${digestKey(planDigest)}.json`)
}

function candidateEvidencePath(supportRoot: string, planDigest: string): string {
  return path.join(supportRoot, "candidate-evidence", `${digestKey(planDigest)}.json`)
}

function proposalPinsPath(supportRoot: string, proposal: ResourceAuthoringProposal): string {
  return path.join(supportRoot, "proposal-pins", `${digestKey(sha256Digest(canonicalJson(proposal)))}.json`)
}

function assertJournal(journal: DurablePreparedState, state: PreparedState): void {
  if (journal.schemaVersion === "eidolon.resource-authoring-journal/v2") {
    const { targetPath: _targetPath, ...durable } = state
    if (canonicalJson(journal) !== canonicalJson({ ...durable, schemaVersion: journal.schemaVersion, phase: "prepared" })) {
      throw new Error("EIDOLON_AGENT_AUTHORING_JOURNAL_CONFLICT")
    }
    return
  }
  if (state.proposal.operation !== "create") throw new Error("EIDOLON_AGENT_AUTHORING_JOURNAL_CONFLICT")
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
  // Old v1 material predates durable publication association; its existence
  // cannot establish whether an after-image was admitted in another process.
  throw new Error("EIDOLON_AGENT_AUTHORING_LEGACY_JOURNAL_UNCERTAIN")
}

async function readWorkspaceBefore(target: string): Promise<WorkspaceBefore> {
  try {
    const metadata = await lstat(target)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("EIDOLON_AGENT_AUTHORING_TARGET_INVALID")
    const text = await readFile(target, "utf8")
    return Object.freeze({ state: "present", text, digest: sha256Digest(text) })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ state: "absent" })
    throw error
  }
}

/** Legacy layer effects are serialized by that registry's publication fence. */
async function replaceWorkspaceFile(target: string, before: WorkspaceBefore, text: string, onReplaced?: () => void): Promise<void> {
  if (canonicalJson(await readWorkspaceBefore(target)) !== canonicalJson(before)) {
    throw new Error("EIDOLON_AGENT_AUTHORING_WORKSPACE_CAS_CONFLICT")
  }
  if (before.state === "absent") return writeFileNoReplace(target, text, onReplaced)
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`)
  const handle = await open(temp, "wx", 0o600)
  try {
    await handle.writeFile(text, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (canonicalJson(await readWorkspaceBefore(target)) !== canonicalJson(before)) throw new Error("EIDOLON_AGENT_AUTHORING_WORKSPACE_CAS_CONFLICT")
    await rename(temp, target)
    onReplaced?.()
    await syncDirectory(path.dirname(target))
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r")
  try { await handle.sync() } finally { await handle.close() }
}

async function writeFileNoReplace(target: string, content: string, onReplaced?: () => void): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`)
  const handle = await open(temp, "wx", 0o600)
  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temp, target)
    onReplaced?.()
    await syncDirectory(path.dirname(target))
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
