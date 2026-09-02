import type {
  AIAgentDefinitionCandidateSet,
  AIAgentDefinitionSelectionDecision,
  AIAgentTaskRequirement,
  AIAgentTaskRequirementProjection,
  AIWorkflowDefinitionResourceKind,
  FrozenAIAgentTaskBinding,
  RejectedAIAgentDefinitionAdmission,
  SelectedAIAgentDefinitionAdmission,
} from "ai-workflow-contract"
import {
  admitAIAgentDefinitionSelection,
  freezeSelectedAIAgentTaskBinding,
  normalizeAIAgentTaskRequirement,
  projectAIAgentDefinitionCandidates,
  reconcileAuthoredAIAgentDefinition,
} from "ai-workflow-logic"
import type { ResourceAuthoringReceipt } from "halfcode-compiler.xnl/authoring-runtime"
import {
  deriveResourceAuthoringRegistryRevision,
} from "halfcode-compiler.xnl/authoring-runtime"
import type { ResourceLayerContentIdentityInput } from "halfcode-compiler.xnl/resource-core"

import {
  EidolonAIAgentDefinitionAuthoringAdapter,
  type EidolonEffectiveVfsAuthoringPort,
} from "./EidolonAIAgentDefinitionAuthoringAdapter"
import {
  EidolonAppResourceRegistryAdapter,
  type EidolonResourceRegistrySnapshot,
  type ResourcePackageLayerBinding,
} from "./EidolonAppResourceRegistryAdapter"

export type EidolonAIAgentDefinitionSelectionObservation = Readonly<{
  schemaVersion: "eidolon.agent-definition-selection-observation/v1"
  requirement: AIAgentTaskRequirementProjection
  candidateSet: AIAgentDefinitionCandidateSet
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
  authoringReceipt?: ResourceAuthoringReceipt
}>

export type EidolonAIAgentDefinitionPreparationResult =
  | EidolonPreparedAIAgentDefinition
  | RejectedAIAgentDefinitionAdmission

type SelectionAuthority = Readonly<{
  snapshot: EidolonResourceRegistrySnapshot
  layers: readonly ResourceLayerContentIdentityInput[]
}>

/**
 * Composes the depa-flows decision protocol with Eidolon's real Halfcode registry.
 * The host never selects by objective text: callers submit one typed decision over
 * an authentic observation, and author-new is reconciled before it can execute.
 */
export class EidolonAutonomousAgentResourceHost {
  private readonly authoring: EidolonAIAgentDefinitionAuthoringAdapter
  private readonly observations = new WeakMap<object, SelectionAuthority>()

  constructor(
    private readonly registry: EidolonAppResourceRegistryAdapter,
    layers: readonly ResourcePackageLayerBinding[],
    supportRoot: string,
    effectiveVfsAuthoring?: EidolonEffectiveVfsAuthoringPort,
  ) {
    this.authoring = new EidolonAIAgentDefinitionAuthoringAdapter(
      registry,
      layers,
      supportRoot,
      effectiveVfsAuthoring,
    )
  }

  async observe(
    requirementInput: AIAgentTaskRequirement,
  ): Promise<EidolonAIAgentDefinitionSelectionObservation> {
    const requirement = normalizeAIAgentTaskRequirement(requirementInput)
    const authority = await this.loadAuthority(await this.registry.refresh())
    const candidateSet = projectAIAgentDefinitionCandidates({
      registry: authority.snapshot.registry,
      projection: authority.snapshot.agentResources,
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

  async prepare(input: Readonly<{
    observation: EidolonAIAgentDefinitionSelectionObservation
    decision: AIAgentDefinitionSelectionDecision
    target: EidolonAIAgentDefinitionTaskTarget
  }>): Promise<EidolonAIAgentDefinitionPreparationResult> {
    const authority = this.observations.get(input.observation)
    if (!authority
      || input.observation.requirement.requirementDigest !== input.decision.requirementDigest
      || input.observation.candidateSet.candidateSetDigest !== input.decision.candidateSetDigest) {
      throw new Error("EIDOLON_AGENT_SELECTION_OBSERVATION_UNTRUSTED")
    }
    if (await this.registry.snapshot() !== authority.snapshot) {
      throw new Error("EIDOLON_AGENT_SELECTION_OBSERVATION_STALE")
    }

    const admission = admitAIAgentDefinitionSelection({
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

    const authored = await this.authoring.author({ proposal: admission.proposal })
    const refreshed = await this.loadAuthority(authored.snapshot)
    const refreshedCandidates = projectAIAgentDefinitionCandidates({
      registry: refreshed.snapshot.registry,
      projection: refreshed.snapshot.agentResources,
      layers: refreshed.layers,
    })
    const reconciled = await reconcileAuthoredAIAgentDefinition({
      registry: refreshed.snapshot.registry,
      projection: refreshed.snapshot.agentResources,
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

  private freeze(input: Readonly<{
    requirement: AIAgentTaskRequirementProjection
    candidateSet: AIAgentDefinitionCandidateSet
    admission: SelectedAIAgentDefinitionAdmission
    authority: SelectionAuthority
    target: EidolonAIAgentDefinitionTaskTarget
    authoringReceipt?: ResourceAuthoringReceipt
  }>): EidolonPreparedAIAgentDefinition {
    const taskBinding = freezeSelectedAIAgentTaskBinding({
      registry: input.authority.snapshot.registry,
      projection: input.authority.snapshot.agentResources,
      contentIdentities: input.authority.snapshot.contentIdentities,
      admission: input.admission,
      workflowKind: input.target.workflowKind,
      workflowRef: input.target.workflowRef,
      nodeId: input.target.nodeId,
    })
    return Object.freeze({
      schemaVersion: "eidolon.prepared-agent-definition/v1" as const,
      status: "prepared" as const,
      requirement: input.requirement,
      candidateSet: input.candidateSet,
      admission: input.admission,
      taskBinding,
      snapshot: input.authority.snapshot,
      ...(input.authoringReceipt === undefined ? {} : { authoringReceipt: input.authoringReceipt }),
    })
  }

  private async loadAuthority(
    snapshot: EidolonResourceRegistrySnapshot,
  ): Promise<SelectionAuthority> {
    const layers = snapshot.contentIdentityLayers
    const revision = deriveResourceAuthoringRegistryRevision({ registry: snapshot.registry, layers })
    if (revision !== snapshot.registryRevision) {
      throw new Error("EIDOLON_AGENT_SELECTION_REGISTRY_AUTHORITY_DRIFT")
    }
    return Object.freeze({ snapshot, layers })
  }
}
