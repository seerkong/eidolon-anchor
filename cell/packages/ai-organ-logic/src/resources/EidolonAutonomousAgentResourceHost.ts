import type {
  AIAgentDefinitionCandidateSet,
  AIAgentDefinitionSelectionDecision,
  AIAgentTaskRequirement,
  AIAgentTaskRequirementProjection,
  AIWorkflowDefinitionResourceKind,
  FrozenAIAgentTaskBinding,
  RejectedAIAgentDefinitionAdmission,
  SelectedAIAgentDefinitionAdmission,
  CompiledAIAgentCodeExecution,
} from "ai-workflow-contract"
import {
  admitAIAgentDefinitionSelection,
  createAIAgentDefinitionSelectionOwner,
  type AIAgentDefinitionSelectionOwner,
  freezeSelectedAIAgentTaskBinding,
  normalizeAIAgentTaskRequirement,
  projectAIWorkflowAgentResources,
  projectAIAgentDefinitionCandidates,
  reconcileAuthoredAIAgentDefinition,
} from "ai-workflow-logic"
import type { ResourceAuthoringReceipt } from "halfcode-compiler.xnl/authoring-runtime"
import {
  deriveResourceAuthoringRegistryRevision,
} from "halfcode-compiler.xnl/authoring-runtime"
import type {
  EffectiveResourceRegistry,
  ResourceLayerContentIdentityInput,
  ResourceNode,
} from "halfcode-compiler.xnl/resource-core"
import { sha256Digest } from "halfcode-compiler.xnl/resource-core"

import {
  EidolonAIAgentDefinitionAuthoringAdapter,
  type EidolonEffectiveVfsAuthoringPort,
} from "./EidolonAIAgentDefinitionAuthoringAdapter"
import {
  EidolonAppResourceRegistryAdapter,
  type EidolonResourceRegistrySnapshot,
  type EidolonFrozenAgentExecutionBundle,
  type ResourcePackageLayerBinding,
  type EidolonAgentResourceObservationClosure,
  type EidolonFrozenAgentResourceRegistry,
} from "./EidolonAppResourceRegistryAdapter"

export type EidolonAIAgentDefinitionSelectionObservation = Readonly<{
  schemaVersion: "eidolon.agent-definition-selection-observation/v1"
  requirement: AIAgentTaskRequirementProjection
  candidateSet: AIAgentDefinitionCandidateSet
}>

export type EidolonAgentPreparationObservationMaterial = Readonly<{
  schemaVersion: "eidolon.agent-preparation-observation/v1"
  requirement: AIAgentTaskRequirement
  requirementDigest: string
  candidateSetDigest: string
  registryRevision: string
  closure: EidolonAgentResourceObservationClosure
  closureDigest: string
  effectiveVfsRevision?: string
}>

export type EidolonAgentObservationDescription = Readonly<{
  schemaVersion: "eidolon.agent-observation-description/v1"
  registryRevision: string
  candidates: readonly Readonly<{
    agentDefinitionRef: `resource://${string}`
    resourceId: string
    catalogId: string
    documentUri: `vfs://@/${string}`
    authorityDigest: string
    authorityText: string
    envelopeVersion: "halfcode.resource-envelope/v1"
    writerSpecVersion: number
    kind: "AIAgentDefinition"
    sourceShape: "single-file"
  }>[]
}>

export type EidolonAIAgentDefinitionTaskTarget = Readonly<{
  workflowKind: AIWorkflowDefinitionResourceKind
  workflowRef: `resource://${string}`
  nodeId: string
}>

export type EidolonPreparedAIAgentDefinition = Readonly<{
  schemaVersion: "eidolon.prepared-agent-definition/v1"
  status: "prepared"
  requirement: AIAgentTaskRequirementProjection
  candidateSet: AIAgentDefinitionCandidateSet
  admission: SelectedAIAgentDefinitionAdmission
  taskBinding: FrozenAIAgentTaskBinding
  snapshot: EidolonResourceRegistrySnapshot
  codeExecutions: readonly CompiledAIAgentCodeExecution[]
  frozenExecution: EidolonFrozenAgentExecutionBundle
  authoringReceipt?: ResourceAuthoringReceipt
}>

export type EidolonAIAgentDefinitionPreparationResult =
  | EidolonPreparedAIAgentDefinition
  | RejectedAIAgentDefinitionAdmission

type SelectionAuthority = Readonly<{
  snapshot: EidolonResourceRegistrySnapshot
  registry: EffectiveResourceRegistry
  projection: EidolonResourceRegistrySnapshot["agentResources"]
  layers: readonly ResourceLayerContentIdentityInput[]
  executionRegistry: EidolonFrozenAgentResourceRegistry
  restored: boolean
  workspaceInstructions?: string | null
  effectiveVfsRevision?: string
}>

/**
 * Composes the depa-flows decision protocol with Eidolon's real Halfcode registry.
 * The host never selects by objective text: callers submit one typed decision over
 * an authentic observation, and author-new is reconciled before it can execute.
 */
export class EidolonAutonomousAgentResourceHost {
  private readonly authoring: EidolonAIAgentDefinitionAuthoringAdapter
  private readonly selectionOwner: AIAgentDefinitionSelectionOwner
  private readonly observations = new WeakMap<object, SelectionAuthority>()

  constructor(
    private readonly registry: EidolonAppResourceRegistryAdapter,
    layers: readonly ResourcePackageLayerBinding[],
    supportRoot: string,
    private readonly effectiveVfsAuthoring?: EidolonEffectiveVfsAuthoringPort,
  ) {
    this.authoring = new EidolonAIAgentDefinitionAuthoringAdapter(
      registry,
      layers,
      supportRoot,
      effectiveVfsAuthoring,
    )
    this.selectionOwner = createAIAgentDefinitionSelectionOwner({ receiptAuthority: this.authoring })
  }

  async observe(
    requirementInput: AIAgentTaskRequirement,
  ): Promise<EidolonAIAgentDefinitionSelectionObservation> {
    const requirement = normalizeAIAgentTaskRequirement(requirementInput)
    const authority = await this.loadAuthority(await this.registry.refresh())
    const candidateSet = projectAIAgentDefinitionCandidates({
      selectionOwner: this.selectionOwner,
      executionResources: authority.snapshot.executionResources,
      registry: authority.registry,
      projection: authority.projection,
      layers: authority.layers,
    })
    const observation = Object.freeze({
      schemaVersion: "eidolon.agent-definition-selection-observation/v1" as const,
      requirement,
      candidateSet,
    })
    this.observations.set(observation, authority)
    return observation
  }

  async captureObservation(observation: EidolonAIAgentDefinitionSelectionObservation): Promise<EidolonAgentPreparationObservationMaterial> {
    const authority = this.observations.get(observation)
    if (!authority) throw new Error("EIDOLON_AGENT_SELECTION_OBSERVATION_UNTRUSTED")
    const closure = await authority.executionRegistry.captureAgentResourceObservation(authority.snapshot)
    return Object.freeze({ schemaVersion: "eidolon.agent-preparation-observation/v1",
      requirement: observation.requirement.requirement, requirementDigest: observation.requirement.requirementDigest,
      candidateSetDigest: observation.candidateSet.candidateSetDigest, registryRevision: observation.candidateSet.registryRevision,
      closure, closureDigest: digestClosure(closure),
      ...(authority.effectiveVfsRevision ? { effectiveVfsRevision: authority.effectiveVfsRevision } : {}) })
  }

  /** Original reader-owned authoring inputs for the selection Agent, without live reads. */
  async describeObservation(observation: EidolonAIAgentDefinitionSelectionObservation): Promise<EidolonAgentObservationDescription> {
    const authority = this.observations.get(observation)
    if (!authority) throw new Error("EIDOLON_AGENT_SELECTION_OBSERVATION_UNTRUSTED")
    const closure = await authority.executionRegistry.captureAgentResourceObservation(authority.snapshot)
    const authoringLayer = authority.layers.find(layer => layer.id === "effective-vfs")
      ?? authority.layers.find(layer => layer.id === "workspace")
    const catalogs = (authoringLayer?.tree.manifest.node.subdomains.Catalogs?.body ?? []).filter((value): value is ResourceNode =>
      typeof value === "object" && value !== null && !Array.isArray(value) && "tag" in value && value.tag === "Catalog")
    const candidates: EidolonAgentObservationDescription["candidates"][number][] = []
    for (const candidate of observation.candidateSet.candidates) {
      const resourceId = candidate.agentDefinitionRef.slice("resource://".length)
      const entry = authority.registry.byId.get(resourceId)
      const resource = entry?.resource
      const identity = authority.snapshot.contentIdentities.get(resourceId)
      if (!resource || !entry.effectiveOrigin || !identity || resource.kind !== "AIAgentDefinition"
        || resource.sourceShape !== "single-file" || !resource.documentUri.startsWith("vfs://@/")) continue
      const relative = resource.documentUri.slice("vfs://@/".length)
      const matching = catalogs.filter(catalog => {
        const root = catalog.properties.root
        return catalog.properties.kind === resource.kind && catalog.properties.shape === "single-file"
          && typeof root === "string" && root.startsWith("vfs://./") && root.endsWith("/")
          && relative.startsWith(root.slice("vfs://./".length))
      })
      if (matching.length !== 1) continue
      const catalogId = matching[0]!.resourceId
      if (typeof catalogId !== "string" || !catalogId || catalogId.trim() !== catalogId) continue
      const layerId = entry.effectiveOrigin.layerId
      const file = closure.files[`.agent-resources/${layerId}/${layerId === "effective-vfs" ? ".eidolon/resources/" : ""}${relative}`]
      if (file === undefined) throw new Error("EIDOLON_AGENT_OBSERVATION_AUTHORITY_BYTES_MISSING")
      const bytes = Buffer.from(file, "base64")
      if (sha256Digest(bytes) !== identity.authorityDigest) throw new Error("EIDOLON_AGENT_OBSERVATION_AUTHORITY_BYTES_MISMATCH")
      if (resource.metadata.envelopeVersion !== "halfcode.resource-envelope/v1"
        || !Number.isSafeInteger(resource.metadata.specVersion) || Number(resource.metadata.specVersion) < 1) {
        throw new Error("EIDOLON_AGENT_OBSERVATION_AUTHORITY_METADATA_INVALID")
      }
      candidates.push(Object.freeze({ agentDefinitionRef: candidate.agentDefinitionRef, resourceId,
        catalogId, documentUri: resource.documentUri as `vfs://@/${string}`,
        authorityDigest: identity.authorityDigest, authorityText: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        envelopeVersion: "halfcode.resource-envelope/v1", writerSpecVersion: Number(resource.metadata.specVersion),
        kind: "AIAgentDefinition", sourceShape: "single-file" }))
    }
    return Object.freeze({ schemaVersion: "eidolon.agent-observation-description/v1", registryRevision: observation.candidateSet.registryRevision,
      candidates: Object.freeze(candidates) })
  }

  async restoreObservation(input: EidolonAgentPreparationObservationMaterial): Promise<EidolonAIAgentDefinitionSelectionObservation> {
    const material = JSON.parse(JSON.stringify(input)) as EidolonAgentPreparationObservationMaterial
    if (material.schemaVersion !== "eidolon.agent-preparation-observation/v1"
      || Object.keys(material).some(key => !["schemaVersion", "requirement", "requirementDigest", "candidateSetDigest", "registryRevision", "closure", "closureDigest", "effectiveVfsRevision"].includes(key))
      || digestClosure(material.closure) !== material.closureDigest
      || material.closure.layers.includes("effective-vfs") && !/^sha256:[0-9a-f]{64}$/.test(material.effectiveVfsRevision ?? "")) throw new Error("EIDOLON_AGENT_SELECTION_OBSERVATION_MATERIAL_INVALID")
    const executionRegistry = await EidolonAppResourceRegistryAdapter.restoreAgentResourceObservation(material.closure)
    const authority = await this.loadAuthority(await executionRegistry.snapshot(), executionRegistry, true, material.effectiveVfsRevision)
    const requirement = normalizeAIAgentTaskRequirement(material.requirement)
    const candidateSet = projectAIAgentDefinitionCandidates({ selectionOwner: this.selectionOwner,
      executionResources: authority.snapshot.executionResources, registry: authority.registry, projection: authority.projection, layers: authority.layers })
    if (requirement.requirementDigest !== material.requirementDigest || candidateSet.candidateSetDigest !== material.candidateSetDigest
      || candidateSet.registryRevision !== material.registryRevision) throw new Error("EIDOLON_AGENT_SELECTION_OBSERVATION_MATERIAL_MISMATCH")
    const observation = Object.freeze({ schemaVersion: "eidolon.agent-definition-selection-observation/v1" as const, requirement, candidateSet })
    this.observations.set(observation, authority)
    return observation
  }

  async prepare(input: Readonly<{
    observation: EidolonAIAgentDefinitionSelectionObservation
    decision: AIAgentDefinitionSelectionDecision
    target: EidolonAIAgentDefinitionTaskTarget
    previousExecution?: FrozenAIAgentTaskBinding
  }>): Promise<EidolonAIAgentDefinitionPreparationResult> {
    const authority = this.observations.get(input.observation)
    if (!authority
      || input.observation.requirement.requirementDigest !== input.decision.requirementDigest
      || input.observation.candidateSet.candidateSetDigest !== input.decision.candidateSetDigest) {
      throw new Error("EIDOLON_AGENT_SELECTION_OBSERVATION_UNTRUSTED")
    }
    if (!authority.restored && await this.registry.snapshot() !== authority.snapshot) {
      throw new Error("EIDOLON_AGENT_SELECTION_OBSERVATION_STALE")
    }

    const admission = admitAIAgentDefinitionSelection({
      selectionOwner: this.selectionOwner,
      previousExecution: input.previousExecution,
      requirement: input.observation.requirement,
      candidateSet: input.observation.candidateSet,
      decision: input.decision,
    })
    if (admission.status === "rejected") return admission
    if (admission.status === "selected") {
      return this.freeze({
        requirement: input.observation.requirement,
        candidateSet: input.observation.candidateSet,
        admission,
        authority,
        target: input.target,
      })
    }

    // Original bytes precede the effect. On replay the authoring owner restores
    // its exact pins/receipt; its returned live snapshot may already be V3.
    const before = await authority.executionRegistry.captureAgentResourceObservation(authority.snapshot)
    const authored = await this.authoring.author({ proposal: admission.proposal })
    if (authority.effectiveVfsRevision) {
      const publication = await this.effectiveVfsAuthoring?.lookupPublication?.(authored.receipt.transactionId)
      if (!publication || publication.association?.planDigest !== authored.receipt.planDigest
        || publication.association.transactionId !== authored.receipt.transactionId
        || publication.association.receiptDigest !== authored.receipt.receiptDigest
        || publication.plan.expectedCurrentRevision !== authority.effectiveVfsRevision) {
        throw new Error("EIDOLON_AGENT_AUTHORING_RECOVERY_PUBLICATION_PROOF_UNAVAILABLE")
      }
    }
    const layerId = authored.receipt.effectiveOrigin.layerId
    if (!before.layers.includes(layerId)) throw new Error("EIDOLON_AGENT_AUTHORING_RECOVERY_LAYER_UNAVAILABLE")
    const relativePath = admission.proposal.documentUri.slice("vfs://@/".length)
    const sourcePath = `.agent-resources/${layerId}/${layerId === "effective-vfs" ? ".eidolon/resources/" : ""}${relativePath}`
    const after = { ...before, files: { ...before.files, [sourcePath]: Buffer.from(admission.proposal.authorityText).toString("base64") } }
    const executionRegistry = await EidolonAppResourceRegistryAdapter.restoreAgentResourceObservation(after)
    const reconstructed = await this.loadAuthority(await executionRegistry.snapshot(), executionRegistry, true)
    if (reconstructed.snapshot.registryRevision !== authored.receipt.registryRevisionAfter) {
      throw new Error("EIDOLON_AGENT_AUTHORING_RECOVERY_EXACT_SNAPSHOT_UNAVAILABLE")
    }
    // Keep native publication metadata when its exact snapshot is still current;
    // ambient instructions always come from the observation before the effect.
    const refreshed = !authority.restored && authored.snapshot.registryRevision === authored.receipt.registryRevisionAfter
      ? { ...await this.loadAuthority(authored.snapshot), workspaceInstructions: before.workspaceInstructions }
      : reconstructed
    const refreshedCandidates = projectAIAgentDefinitionCandidates({
      selectionOwner: this.selectionOwner,
      executionResources: refreshed.snapshot.executionResources,
      registry: refreshed.registry,
      projection: refreshed.projection,
      layers: refreshed.layers,
    })
    const reconciled = await reconcileAuthoredAIAgentDefinition({
      selectionOwner: this.selectionOwner,
      executionResources: refreshed.snapshot.executionResources,
      registry: refreshed.registry,
      projection: refreshed.projection,
      layers: refreshed.layers,
      candidateSet: refreshedCandidates,
      authoringAdmission: admission,
      receipt: authored.receipt,
      receiptAuthority: this.authoring,
    })
    const candidate = reconciled.candidates.find(
      ({ agentDefinitionRef }) => agentDefinitionRef === admission.agentDefinitionRef,
    )
    if (!candidate?.authoringEvidence) {
      throw new Error("EIDOLON_AGENT_AUTHORING_RECONCILIATION_MISSING")
    }
    const selected = admitAIAgentDefinitionSelection({
      selectionOwner: this.selectionOwner,
      requirement: input.observation.requirement,
      candidateSet: reconciled,
      decision: Object.freeze({
        schemaVersion: input.observation.requirement.schemaVersion,
        mode: "select-existing" as const,
        requirementDigest: input.observation.requirement.requirementDigest,
        candidateSetDigest: reconciled.candidateSetDigest,
        candidateRef: candidate.agentDefinitionRef,
        candidateDigest: candidate.candidateDigest,
        reason: `Exact authored resource reconciled from ${candidate.authoringEvidence.receiptDigest}.`,
      }),
    })
    if (selected.status !== "selected") {
      const reason = selected.status === "rejected" ? selected.code : selected.status
      throw new Error(`EIDOLON_AGENT_AUTHORED_SELECTION_REJECTED: ${reason}`)
    }
    return this.freeze({
      requirement: input.observation.requirement,
      candidateSet: reconciled,
      admission: selected,
      authority: refreshed,
      target: input.target,
      authoringReceipt: authored.receipt,
    })
  }

  loadAuthoringReceipt(planDigest: string): Promise<ResourceAuthoringReceipt | undefined> {
    return this.authoring.loadReceipt(planDigest)
  }

  private async freeze(input: Readonly<{
    requirement: AIAgentTaskRequirementProjection
    candidateSet: AIAgentDefinitionCandidateSet
    admission: SelectedAIAgentDefinitionAdmission
    authority: SelectionAuthority
    target: EidolonAIAgentDefinitionTaskTarget
    authoringReceipt?: ResourceAuthoringReceipt
  }>): Promise<EidolonPreparedAIAgentDefinition> {
    const codeExecutions = await input.authority.executionRegistry.compileAgentCodeExecutions(input.authority.snapshot, input.admission.candidate.agentDefinitionRef.slice("resource://".length))
    const taskBinding = freezeSelectedAIAgentTaskBinding({
      codeExecutions,
      selectionOwner: this.selectionOwner,
      executionResources: input.authority.snapshot.executionResources,
      registry: input.authority.registry,
      projection: input.authority.projection,
      contentIdentities: input.authority.snapshot.contentIdentities,
      admission: input.admission,
      workflowKind: input.target.workflowKind,
      workflowRef: input.target.workflowRef,
      nodeId: input.target.nodeId,
    })
    const frozenExecution = await input.authority.executionRegistry.captureFrozenAgentExecution(taskBinding.task, input.authority.snapshot, codeExecutions,
      { workspaceInstructions: input.authority.workspaceInstructions })
    if (!input.authority.restored && await this.registry.snapshot() !== input.authority.snapshot) throw new Error("EIDOLON_AGENT_SELECTION_REGISTRY_AUTHORITY_DRIFT")
    return Object.freeze({
      schemaVersion: "eidolon.prepared-agent-definition/v1" as const,
      status: "prepared" as const,
      requirement: input.requirement,
      candidateSet: input.candidateSet,
      admission: input.admission,
      taskBinding,
      snapshot: input.authority.snapshot,
      codeExecutions,
      frozenExecution,
      ...(input.authoringReceipt === undefined ? {} : { authoringReceipt: input.authoringReceipt }),
    })
  }

  private async loadAuthority(
    snapshot: EidolonResourceRegistrySnapshot,
    executionRegistry: EidolonFrozenAgentResourceRegistry = this.registry,
    restored = false,
    effectiveVfsRevision = snapshot.effectiveVfs?.revision,
  ): Promise<SelectionAuthority> {
    const layers = snapshot.contentIdentityLayers
    const registry = snapshot.contentIdentityRegistry
    const projection = projectAIWorkflowAgentResources(registry)
    const revision = deriveResourceAuthoringRegistryRevision({ registry, layers })
    if (revision !== snapshot.registryRevision) {
      throw new Error("EIDOLON_AGENT_SELECTION_REGISTRY_AUTHORITY_DRIFT")
    }
    return Object.freeze({ snapshot, registry, projection, layers, executionRegistry, restored,
      ...(effectiveVfsRevision ? { effectiveVfsRevision } : {}) })
  }
}

function digestClosure(closure: EidolonAgentResourceObservationClosure): string {
  return sha256Digest(JSON.stringify({ schemaVersion: closure.schemaVersion, fileEncoding: closure.fileEncoding,
    layers: closure.layers, files: Object.entries(closure.files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    ...(closure.workspaceInstructions !== undefined ? { workspaceInstructions: closure.workspaceInstructions } : {}) }))
}
