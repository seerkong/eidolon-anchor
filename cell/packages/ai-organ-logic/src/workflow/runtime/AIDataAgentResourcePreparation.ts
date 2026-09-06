import path from "node:path"
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises"

import type {
  AIDataControlCapability,
  AIDataControlCapabilityCatalog,
} from "ai-data-workflow-contract"
import {
  createAIDataControlRuntime,
  freezeAIDataControlCapabilityCatalog,
} from "ai-data-workflow-logic"
import type {
  AIAgentDefinitionSelectionDecision,
  AIAgentTaskRequirement,
  AIWorkflowAgentTaskRef,
  FlowClosedObject,
  FlowRunStepExtensions,
  FrozenAIAgentTaskBinding,
  RejectedAIAgentDefinitionAdmission,
} from "ai-workflow-contract"
import { normalizeAIAgentTaskRequirement } from "ai-workflow-logic"
import { frozenAIAgentTaskAgentContentDigest } from "ai-workflow-logic/run-freeze"
import type {
  DefinitionStepExtensionCodecRegistryPort,
  DefinitionStepValue,
} from "flow-step-space-contract"
import { sha256Digest } from "halfcode-compiler.xnl/resource-core"

import {
  EidolonAutonomousAgentResourceHost,
  type EidolonAIAgentDefinitionSelectionObservation,
  type EidolonPreparedAIAgentDefinition,
  type EidolonAgentPreparationObservationMaterial,
  type EidolonAgentObservationDescription,
} from "../../resources/EidolonAutonomousAgentResourceHost"
import {
  EidolonAppResourceRegistryAdapter,
  type EidolonPreparedWorkflowAgentExecution,
  type EidolonFrozenAgentExecutionBundle,
} from "../../resources/EidolonAppResourceRegistryAdapter"
import {
  findAIDataAutonomousControlStateInExtensions,
  normalizeAIDataAutonomousControlState,
  writeAIDataAutonomousControlExtension,
} from "./AIDataAutonomousControlLoop"

export const AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION = "eidolon.ai-data-agent-preparation/v2" as const
const LEGACY_AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION = "eidolon.ai-data-agent-preparation/v1" as const
export const AI_DATA_AGENT_PREPARATION_EXTENSION_KIND = "eidolon.ai-data-agent-preparation" as const
export const AI_DATA_AGENT_PREPARATION_EXTENSION_SCHEMA_REF = "schema://eidolon.ai-data-agent-preparation/v1" as const
export const AI_DATA_AGENT_PREPARATION_EXTENSION_VALUE_SCHEMA_VERSION = "eidolon.ai-data-agent-preparations/v1" as const

export type AIDataPreparedAgentCapabilityInput = Readonly<{
  capabilityId: string
  tag: "TransformNode" | "SinkNode"
  inputSchemaRefs: Readonly<Record<string, string>>
  outputSchemaRefs: Readonly<Record<string, string>>
  fixedConfig: FlowClosedObject
}>

type AIDataControlAgentCapability = AIDataControlCapability & Readonly<{
  tag: "TransformNode" | "SinkNode"
  nodeType: "agent"
  implementation: Readonly<{
    kind: "agent"
    agentDefinitionRef: `resource://${string}`
    taskProofRef: `resource://${string}`
  }>
}>

export type AIDataAgentPreparationReceipt = Readonly<{
  schemaVersion: typeof AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION | typeof LEGACY_AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION
  instanceId: string
  requirement: AIAgentTaskRequirement
  requirementDigest: `sha256:${string}`
  agentDefinitionRef: `resource://${string}`
  agentContentDigest: `sha256:${string}`
  selectionCandidateDigest: `sha256:${string}`
  taskProofRef: `resource://${string}`
  task: FrozenAIAgentTaskBinding["task"]
  semanticFingerprint: `sha256:${string}`
  snapshotRevision: `sha256:${string}`
  closureResourceIds: readonly string[]
  instanceName: string
  capability: AIDataControlAgentCapability
  frozenExecution?: EidolonFrozenAgentExecutionBundle
  authoring?: Readonly<{
    planDigest: `sha256:${string}`
    transactionId: string
    receiptDigest: `sha256:${string}`
  }>
  preparation?: Readonly<{
    intentDigest: `sha256:${string}`
    decisionDigest: `sha256:${string}`
    targetDigest: `sha256:${string}`
  }>
  receiptDigest: `sha256:${string}`
}>

export type AIDataPreparedAgentResource = Readonly<{
  receipt: AIDataAgentPreparationReceipt
  proof: FrozenAIAgentTaskBinding
  executionRegistry?: AgentExecutionRegistry
}>

export type AIDataAgentPreparationExtensionValue = Readonly<{
  schemaVersion: typeof AI_DATA_AGENT_PREPARATION_EXTENSION_VALUE_SCHEMA_VERSION
  receipts: readonly AIDataAgentPreparationReceipt[]
}>

export type AIDataAgentPreparationIntent = Readonly<{
  schemaVersion: "eidolon.ai-data-agent-preparation-intent/v1"
  instanceId: string
  nodeId: string
  identity: FlowClosedObject
  requirement: AIAgentTaskRequirement
  observationMaterial: EidolonAgentPreparationObservationMaterial
  intentDigest: `sha256:${string}`
}>

type AIDataAgentPreparationDecisionRecord = Readonly<{
  schemaVersion: "eidolon.ai-data-agent-preparation-decision/v1"
  intentDigest: `sha256:${string}`
  targetDigest: `sha256:${string}`
  decision: AIAgentDefinitionSelectionDecision
  decisionDigest: `sha256:${string}`
}>

type AgentExecutionRegistry = Pick<EidolonAppResourceRegistryAdapter, "prepareWorkflowAgentExecution">

export class FileAIDataAgentPreparationStore {
  constructor(private readonly root: string) {}

  async save(receiptValue: AIDataAgentPreparationReceipt): Promise<void> {
    const receipt = normalizeAIDataAgentPreparationReceipt(receiptValue)
    await writeImmutablePreparationJson(this.filePath(receipt.instanceId, receipt.task.nodeId), receipt)
  }

  async list(instanceId: string): Promise<readonly AIDataAgentPreparationReceipt[]> {
    const directory = this.instanceDirectory(exactIdentity(instanceId, "instanceId"))
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([])
      throw error
    }
    const receipts = await Promise.all(entries.filter((name) => name.endsWith(".json")).sort()
      .map(async (name) => normalizeAIDataAgentPreparationReceipt(
        JSON.parse(await readFile(path.join(directory, name), "utf8")),
      )))
    if (receipts.some((receipt) => receipt.instanceId !== instanceId)) {
      throw new Error("AI_DATA_AGENT_PREPARATION_INSTANCE_MISMATCH")
    }
    return Object.freeze(receipts.sort((left, right) => (
      left.task.nodeId < right.task.nodeId ? -1 : left.task.nodeId > right.task.nodeId ? 1 : 0
    )))
  }

  async loadIntent(instanceId: string, nodeId: string): Promise<AIDataAgentPreparationIntent | undefined> {
    const value = await readOptionalPreparationJson(this.pendingPath(instanceId, nodeId, "intent"))
    if (value === undefined) return undefined
    const intent = value as AIDataAgentPreparationIntent
    if (intent.schemaVersion !== "eidolon.ai-data-agent-preparation-intent/v1"
      || intent.instanceId !== instanceId || intent.nodeId !== nodeId
      || Object.keys(intent).sort().join(",") !== "identity,instanceId,intentDigest,nodeId,observationMaterial,requirement,schemaVersion") {
      throw new Error("AI_DATA_AGENT_PREPARATION_INTENT_INVALID")
    }
    const { intentDigest, ...unsigned } = intent
    if (sha256Digest(canonicalJson(unsigned)) !== intentDigest) throw new Error("AI_DATA_AGENT_PREPARATION_INTENT_DIGEST_MISMATCH")
    return Object.freeze(intent)
  }

  async saveIntent(input: Omit<AIDataAgentPreparationIntent, "schemaVersion" | "intentDigest">): Promise<AIDataAgentPreparationIntent> {
    const unsigned = { schemaVersion: "eidolon.ai-data-agent-preparation-intent/v1" as const, ...clone(input) }
    const intent = { ...unsigned, intentDigest: sha256Digest(canonicalJson(unsigned)) }
    await writeImmutablePreparationJson(this.pendingPath(input.instanceId, input.nodeId, "intent"), intent)
    return (await this.loadIntent(input.instanceId, input.nodeId))!
  }

  async loadDecision(instanceId: string, nodeId: string): Promise<AIAgentDefinitionSelectionDecision | undefined> {
    return (await this.loadDecisionRecord(instanceId, nodeId))?.decision
  }

  async assertReceiptBinding(value: AIDataAgentPreparationReceipt): Promise<void> {
    const receipt = normalizeAIDataAgentPreparationReceipt(value)
    const record = await this.loadDecisionRecord(receipt.instanceId, receipt.task.nodeId)
    if (!record || canonicalJson(receipt.preparation ?? null) !== canonicalJson({
      intentDigest: record.intentDigest, decisionDigest: record.decisionDigest, targetDigest: record.targetDigest,
    })) throw new Error("AI_DATA_AGENT_PREPARATION_RECEIPT_INTENT_MISMATCH")
  }

  async saveDecision(instanceId: string, nodeId: string, decision: AIAgentDefinitionSelectionDecision, targetDigest: `sha256:${string}`): Promise<AIDataAgentPreparationDecisionRecord> {
    const intent = await this.loadIntent(instanceId, nodeId)
    if (!intent) throw new Error("AI_DATA_AGENT_PREPARATION_INTENT_MISSING")
    const unsigned = { schemaVersion: "eidolon.ai-data-agent-preparation-decision/v1" as const,
      intentDigest: intent.intentDigest, targetDigest, decision: clone(decision) }
    const value = { ...unsigned, decisionDigest: sha256Digest(canonicalJson(unsigned)) }
    await writeImmutablePreparationJson(this.pendingPath(instanceId, nodeId, "decision"), value)
    return Object.freeze(value)
  }

  private async loadDecisionRecord(instanceId: string, nodeId: string): Promise<AIDataAgentPreparationDecisionRecord | undefined> {
    const value = await readOptionalPreparationJson(this.pendingPath(instanceId, nodeId, "decision"))
    if (value === undefined) return undefined
    const record = value as AIDataAgentPreparationDecisionRecord
    const intent = await this.loadIntent(instanceId, nodeId)
    if (!intent || record.schemaVersion !== "eidolon.ai-data-agent-preparation-decision/v1"
      || record.intentDigest !== intent.intentDigest || !isDigest(record.targetDigest)
      || Object.keys(record).sort().join(",") !== "decision,decisionDigest,intentDigest,schemaVersion,targetDigest") throw new Error("AI_DATA_AGENT_PREPARATION_DECISION_INVALID")
    const { decisionDigest, ...unsigned } = record
    if (sha256Digest(canonicalJson(unsigned)) !== decisionDigest) throw new Error("AI_DATA_AGENT_PREPARATION_DECISION_DIGEST_MISMATCH")
    return Object.freeze(record)
  }

  private pendingPath(instanceId: string, nodeId: string, kind: "intent" | "decision"): string {
    return path.join(this.instanceDirectory(exactIdentity(instanceId, "instanceId")), ".preparation",
      sha256Digest(exactIdentity(nodeId, "nodeId")).slice("sha256:".length), `${kind}.json`)
  }

  private instanceDirectory(instanceId: string): string {
    return path.join(this.root, sha256Digest(instanceId).slice("sha256:".length))
  }

  private filePath(instanceId: string, nodeId: string): string {
    return path.join(
      this.instanceDirectory(exactIdentity(instanceId, "instanceId")),
      `${sha256Digest(exactIdentity(nodeId, "nodeId")).slice("sha256:".length)}.json`,
    )
  }
}

/** Prepared tasks execute their admitted frozen resources; legacy receipts detect drift. */
export class EidolonFixedAgentExecutionRegistry implements AgentExecutionRegistry {
  private readonly byTask = new Map<string, AIDataPreparedAgentResource>()

  constructor(
    private readonly frozen: AgentExecutionRegistry | undefined,
    private readonly live: AgentExecutionRegistry,
    prepared: readonly AIDataPreparedAgentResource[],
  ) {
    for (const item of prepared) {
      const receipt = normalizeAIDataAgentPreparationReceipt(item.receipt)
      const key = taskKey(receipt.task)
      if (this.byTask.has(key)) throw new Error("AI_DATA_AGENT_PREPARATION_TASK_DUPLICATE")
      this.byTask.set(key, Object.freeze({ ...item, receipt }))
    }
  }

  async prepareWorkflowAgentExecution(
    task: AIWorkflowAgentTaskRef,
    input: { readonly payload?: unknown } = {},
  ): Promise<EidolonPreparedWorkflowAgentExecution> {
    const prepared = this.byTask.get(taskKey(task))
    const registry = prepared
      ? prepared.executionRegistry ?? (prepared.receipt.frozenExecution
        ? await EidolonAppResourceRegistryAdapter.restoreFrozenAgentExecution(prepared.receipt.frozenExecution)
        : this.live)
      : this.frozen
    if (!registry) throw new Error("AI_DATA_AGENT_PREPARATION_EXECUTION_REGISTRY_MISSING")
    const execution = await registry.prepareWorkflowAgentExecution(task, input)
    if (prepared && (execution.receipt.semanticFingerprint !== prepared.receipt.semanticFingerprint
      || execution.plan.agentContentDigest !== prepared.receipt.agentContentDigest)) {
      throw new Error("AI_DATA_AGENT_PREPARATION_EXECUTION_CLOSURE_DRIFT")
    }
    return execution
  }
}

export function mergeAIDataPreparedAgentProofs(input: Readonly<{
  taskProofs: Readonly<Record<string, FrozenAIAgentTaskBinding>>
  taskProofRefs: Readonly<Record<string, readonly `resource://${string}`[]>>
  prepared: readonly AIDataPreparedAgentResource[]
}>): Readonly<{
  taskProofs: Readonly<Record<string, FrozenAIAgentTaskBinding>>
  taskProofRefs: Readonly<Record<string, readonly `resource://${string}`[]>>
}> {
  const taskProofs = { ...input.taskProofs }
  const taskProofRefs = Object.fromEntries(Object.entries(input.taskProofRefs).map(([nodeId, refs]) => [nodeId, [...refs]]))
  for (const item of input.prepared) {
    const nodeId = item.receipt.task.nodeId
    const prior = taskProofs[nodeId]
    if (prior && prior.semanticFingerprint !== item.proof.semanticFingerprint) {
      throw new Error(`AI_DATA_AGENT_PREPARATION_TASK_PROOF_CONFLICT: ${nodeId}`)
    }
    taskProofs[nodeId] = item.proof
    const refs = taskProofRefs[nodeId] ?? []
    if (!refs.includes(item.receipt.taskProofRef)) refs.push(item.receipt.taskProofRef)
    taskProofRefs[nodeId] = refs.sort()
  }
  return Object.freeze({
    taskProofs: Object.freeze(taskProofs),
    taskProofRefs: Object.freeze(Object.fromEntries(Object.entries(taskProofRefs)
      .map(([nodeId, refs]) => [nodeId, Object.freeze(refs)]))),
  })
}

export type AIDataAgentPreparationResult =
  | AIDataPreparedAgentResource
  | RejectedAIAgentDefinitionAdmission

export class AIDataAgentResourcePreparationService {
  constructor(private readonly host: EidolonAutonomousAgentResourceHost) {}

  observe(requirement: AIAgentTaskRequirement): Promise<EidolonAIAgentDefinitionSelectionObservation> {
    return this.host.observe(requirement)
  }

  describeObservation(observation: EidolonAIAgentDefinitionSelectionObservation): Promise<EidolonAgentObservationDescription> {
    return this.host.describeObservation(observation)
  }

  async observeDurably(input: Readonly<{
    store: FileAIDataAgentPreparationStore
    instanceId: string
    nodeId: string
    requirement: AIAgentTaskRequirement
    identity: FlowClosedObject
  }>): Promise<EidolonAIAgentDefinitionSelectionObservation> {
    const prior = await input.store.loadIntent(input.instanceId, input.nodeId)
    if (prior) {
      assertPreparationIntentInput(prior, input)
      return this.host.restoreObservation(prior.observationMaterial)
    }
    const observation = await this.host.observe(input.requirement)
    const observationMaterial = await this.host.captureObservation(observation)
    await input.store.saveIntent({ instanceId: input.instanceId, nodeId: input.nodeId,
      requirement: input.requirement, identity: input.identity, observationMaterial })
    return observation
  }

  async prepareDurably(input: Parameters<AIDataAgentResourcePreparationService["prepare"]>[0] & Readonly<{
    store: FileAIDataAgentPreparationStore
    identity: FlowClosedObject
  }>): Promise<AIDataAgentPreparationResult> {
    const intent = await input.store.loadIntent(input.instanceId, input.nodeId)
    if (!intent) throw new Error("AI_DATA_AGENT_PREPARATION_INTENT_MISSING")
    assertPreparationIntentInput(intent, { ...input, requirement: input.observation.requirement.requirement })
    if (input.observation.requirement.requirementDigest !== intent.observationMaterial.requirementDigest
      || input.observation.candidateSet.candidateSetDigest !== intent.observationMaterial.candidateSetDigest
      || input.observation.candidateSet.registryRevision !== intent.observationMaterial.registryRevision) {
      throw new Error("AI_DATA_AGENT_PREPARATION_INTENT_OBSERVATION_MISMATCH")
    }
    const targetDigest = sha256Digest(canonicalJson({ workflowRef: input.workflowRef, nodeId: input.nodeId,
      instanceName: input.instanceName, capability: input.capability,
      previousExecutionFingerprint: input.previousExecution?.semanticFingerprint ?? null }))
    const decision = await input.store.saveDecision(input.instanceId, input.nodeId, input.decision, targetDigest)
    const preparation = { intentDigest: intent.intentDigest, decisionDigest: decision.decisionDigest, targetDigest }
    const prior = (await input.store.list(input.instanceId)).find(receipt => receipt.task.nodeId === input.nodeId)
    if (prior) {
      const expectedCapability = { ...input.capability, fixedConfig: { ...input.capability.fixedConfig, instanceName: input.instanceName } }
      const { implementation: _implementation, nodeType: _nodeType, ...actualCapability } = prior.capability
      if (prior.task.workflowRef !== input.workflowRef || prior.instanceName !== input.instanceName
        || prior.requirementDigest !== input.observation.requirement.requirementDigest
        || canonicalJson(actualCapability) !== canonicalJson(expectedCapability)) {
        throw new Error("AI_DATA_AGENT_PREPARATION_RECEIPT_TARGET_MISMATCH")
      }
      if (canonicalJson(prior.preparation ?? null) !== canonicalJson(preparation)) {
        throw new Error("AI_DATA_AGENT_PREPARATION_RECEIPT_INTENT_MISMATCH")
      }
      return this.recover(prior)
    }
    const result = await this.prepare(input)
    if (!("receipt" in result)) return result
    const { receiptDigest: _digest, ...fields } = result.receipt
    const unsigned = { ...fields, preparation }
    const receipt = normalizeAIDataAgentPreparationReceipt({ ...unsigned, receiptDigest: sha256Digest(canonicalJson(unsigned)) })
    await input.store.save(receipt)
    return Object.freeze({ ...result, receipt })
  }

  async prepare(input: Readonly<{
    instanceId: string
    observation: EidolonAIAgentDefinitionSelectionObservation
    decision: AIAgentDefinitionSelectionDecision
    workflowRef: `resource://${string}`
    nodeId: string
    instanceName: string
    capability: AIDataPreparedAgentCapabilityInput
    previousExecution?: FrozenAIAgentTaskBinding
  }>): Promise<AIDataAgentPreparationResult> {
    const prepared = await this.host.prepare({
      observation: input.observation,
      decision: input.decision,
      previousExecution: input.previousExecution,
      target: {
        workflowKind: "AIDataWorkflow",
        workflowRef: exactResourceRef(input.workflowRef, "workflowRef"),
        nodeId: exactIdentity(input.nodeId, "nodeId"),
      },
    })
    if (prepared.status === "rejected") return prepared
    const receipt = preparationReceipt(prepared, input)
    const executionRegistry = await EidolonAppResourceRegistryAdapter.restoreFrozenAgentExecution(prepared.frozenExecution)
    const proof = await executionRegistry.freezeWorkflowAgentTaskBinding(receipt.task)
    assertFrozenRecoveredProof(receipt, proof)
    return Object.freeze({
      receipt,
      proof,
      executionRegistry,
    })
  }

  async recover(
    value: AIDataAgentPreparationReceipt,
  ): Promise<AIDataPreparedAgentResource> {
    const receipt = normalizeAIDataAgentPreparationReceipt(value)
    if (receipt.schemaVersion === AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION) {
      if (normalizeAIAgentTaskRequirement(receipt.requirement).requirementDigest !== receipt.requirementDigest) {
        throw new Error("AI_DATA_AGENT_PREPARATION_REQUIREMENT_DRIFT")
      }
      const executionRegistry = await EidolonAppResourceRegistryAdapter.restoreFrozenAgentExecution(receipt.frozenExecution!)
      const proof = await executionRegistry.freezeWorkflowAgentTaskBinding(receipt.task)
      assertFrozenRecoveredProof(receipt, proof)
      return Object.freeze({ receipt, proof, executionRegistry })
    }
    const observation = await this.host.observe(receipt.requirement)
    if (observation.requirement.requirementDigest !== receipt.requirementDigest) {
      throw new Error("AI_DATA_AGENT_PREPARATION_REQUIREMENT_DRIFT")
    }
    const candidate = observation.candidateSet.candidates.find(
      ({ agentDefinitionRef }) => agentDefinitionRef === receipt.agentDefinitionRef,
    )
    if (!candidate || candidate.contentDigest !== receipt.agentContentDigest) {
      throw new Error("AI_DATA_AGENT_PREPARATION_RESOURCE_DRIFT")
    }
    if (receipt.authoring) {
      const authoring = await this.host.loadAuthoringReceipt(receipt.authoring.planDigest)
      if (!authoring
        || authoring.transactionId !== receipt.authoring.transactionId
        || authoring.receiptDigest !== receipt.authoring.receiptDigest
        || authoring.resourceId !== receipt.agentDefinitionRef.slice("resource://".length)
        || authoring.contentDigest !== receipt.agentContentDigest) {
        throw new Error("AI_DATA_AGENT_PREPARATION_AUTHORING_RECEIPT_DRIFT")
      }
    }
    const recovered = await this.host.prepare({
      observation,
      decision: {
        schemaVersion: observation.requirement.schemaVersion,
        mode: "select-existing",
        requirementDigest: observation.requirement.requirementDigest,
        candidateSetDigest: observation.candidateSet.candidateSetDigest,
        candidateRef: candidate.agentDefinitionRef,
        candidateDigest: candidate.candidateDigest,
        reason: `Fresh recovery of fixed preparation ${receipt.receiptDigest}.`,
      },
      target: receipt.task,
    })
    if (recovered.status !== "prepared") {
      throw new Error(`AI_DATA_AGENT_PREPARATION_SELECTION_REJECTED: ${recovered.code}`)
    }
    assertRecoveredProof(receipt, recovered)
    return Object.freeze({ receipt, proof: recovered.taskBinding })
  }
}

export function normalizeAIDataAgentPreparationReceipt(
  value: AIDataAgentPreparationReceipt,
): AIDataAgentPreparationReceipt {
  const receipt = clone(value)
  if (![AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION, LEGACY_AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION].includes(receipt.schemaVersion)
    || !exactString(receipt.instanceId)
    || !exactString(receipt.instanceName)
    || !isDigest(receipt.requirementDigest)
    || !isDigest(receipt.agentContentDigest)
    || !isDigest(receipt.selectionCandidateDigest)
    || !isDigest(receipt.semanticFingerprint)
    || !isDigest(receipt.snapshotRevision)
    || !isDigest(receipt.receiptDigest)
    || !receipt.agentDefinitionRef?.startsWith("resource://")
    || receipt.taskProofRef !== receipt.agentDefinitionRef
    || receipt.task?.workflowKind !== "AIDataWorkflow"
    || receipt.task.agentDefinitionRef !== receipt.agentDefinitionRef
    || receipt.capability?.implementation?.kind !== "agent"
    || receipt.capability.implementation.agentDefinitionRef !== receipt.agentDefinitionRef
    || receipt.capability.implementation.taskProofRef !== receipt.taskProofRef
    || receipt.capability.nodeType !== "agent"
    || !Array.isArray(receipt.closureResourceIds)) {
    throw new Error("AI_DATA_AGENT_PREPARATION_RECEIPT_INVALID")
  }
  if (receipt.schemaVersion === AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION
    && (receipt.frozenExecution?.schemaVersion !== "eidolon.frozen-agent-execution/v1"
      || receipt.frozenExecution.agentDefinitionRef !== receipt.agentDefinitionRef)) {
    throw new Error("AI_DATA_AGENT_PREPARATION_FROZEN_EXECUTION_MISSING")
  }
  if (receipt.authoring && (!isDigest(receipt.authoring.planDigest)
    || !isDigest(receipt.authoring.receiptDigest)
    || !exactString(receipt.authoring.transactionId))) {
    throw new Error("AI_DATA_AGENT_PREPARATION_RECEIPT_INVALID")
  }
  if (receipt.preparation && (Object.keys(receipt.preparation).sort().join(",") !== "decisionDigest,intentDigest,targetDigest"
    || !isDigest(receipt.preparation.intentDigest) || !isDigest(receipt.preparation.decisionDigest)
    || !isDigest(receipt.preparation.targetDigest))) {
    throw new Error("AI_DATA_AGENT_PREPARATION_RECEIPT_INVALID")
  }
  const { receiptDigest, ...unsigned } = receipt
  if (sha256Digest(canonicalJson(unsigned)) !== receiptDigest) {
    throw new Error("AI_DATA_AGENT_PREPARATION_RECEIPT_DIGEST_MISMATCH")
  }
  return Object.freeze(receipt)
}

export function writeAIDataAgentPreparationExtensions(
  current: FlowRunStepExtensions | undefined,
  receipts: readonly AIDataAgentPreparationReceipt[],
): FlowRunStepExtensions | undefined {
  if (receipts.length === 0) return current
  if (!current) throw new Error("AI_DATA_AGENT_PREPARATION_EXTENSION_SLOT_REQUIRED")
  const extensions = current
  const slot = findPreparationExtensionSlot(extensions)
  if (!slot) throw new Error("AI_DATA_AGENT_PREPARATION_EXTENSION_SLOT_REQUIRED")
  const prior = normalizeAIDataAgentPreparationExtensionValue(slot.fact.value)
  const byNodeId = new Map(prior.receipts.map((receipt) => [receipt.task.nodeId, receipt]))
  for (const value of receipts) {
    const receipt = normalizeAIDataAgentPreparationReceipt(value)
    const existing = byNodeId.get(receipt.task.nodeId)
    if (existing && canonicalJson(existing) !== canonicalJson(receipt)) {
      throw new Error(`AI_DATA_AGENT_PREPARATION_EXTENSION_CONFLICT: ${receipt.task.nodeId}`)
    }
    byNodeId.set(receipt.task.nodeId, receipt)
  }
  const value = normalizeAIDataAgentPreparationExtensionValue({
    schemaVersion: AI_DATA_AGENT_PREPARATION_EXTENSION_VALUE_SCHEMA_VERSION,
    receipts: [...byNodeId.values()].sort((left, right) => (
      left.task.nodeId < right.task.nodeId ? -1 : left.task.nodeId > right.task.nodeId ? 1 : 0
    )),
  })
  return Object.freeze({
    schemaVersion: "depa.flow-run-step-extensions/v1" as const,
    byStepId: Object.freeze({
      ...extensions.byStepId,
      [slot.stepId]: Object.freeze({
        ...extensions.byStepId[slot.stepId],
        [AI_DATA_AGENT_PREPARATION_EXTENSION_KIND]: Object.freeze({
          ...slot.fact,
          revision: slot.fact.revision + 1,
          value: value as unknown as FlowClosedObject,
        }),
      }),
    }),
  })
}

/** Publishes prepared Agent capabilities as one separately versioned control fact. */
export function writeAIDataPreparedAgentCapabilities(
  current: FlowRunStepExtensions | undefined,
  receipts: readonly AIDataAgentPreparationReceipt[],
): FlowRunStepExtensions | undefined {
  if (receipts.length === 0) return current
  if (!current) throw new Error("AI_DATA_AGENT_PREPARATION_CONTROL_STATE_REQUIRED")
  const control = findAIDataAutonomousControlStateInExtensions(current)
  // A resource-declared child slot can consume the same preparation without
  // owning an autonomous controller/catalog; the parent still owns its loop.
  if (!control) return current
  const capabilities = { ...control.binding.catalog.capabilities }
  for (const value of receipts) {
    const receipt = normalizeAIDataAgentPreparationReceipt(value)
    const prior = capabilities[receipt.capability.capabilityId]
    if (prior && canonicalJson(prior) !== canonicalJson(receipt.capability)) {
      throw new Error(`AI_DATA_AGENT_PREPARATION_CAPABILITY_CONFLICT: ${receipt.capability.capabilityId}`)
    }
    capabilities[receipt.capability.capabilityId] = receipt.capability
  }
  const { digest: _digest, ...catalog } = control.binding.catalog
  const frozenCatalog = freezeAIDataControlCapabilityCatalog(createAIDataControlRuntime(), {
    ...catalog,
    capabilities,
  } as Omit<AIDataControlCapabilityCatalog, "digest">, {})
  return writeAIDataAutonomousControlExtension(current, normalizeAIDataAutonomousControlState({
    ...control,
    binding: { ...control.binding, catalog: frozenCatalog },
  }))
}

export function readAIDataAgentPreparationReceipts(
  extensions: FlowRunStepExtensions | undefined,
): readonly AIDataAgentPreparationReceipt[] {
  if (!extensions) return Object.freeze([])
  const slot = findPreparationExtensionSlot(extensions)
  if (!slot) return Object.freeze([])
  return normalizeAIDataAgentPreparationExtensionValue(slot.fact.value).receipts
}

export function emptyAIDataAgentPreparationExtensionValue(): AIDataAgentPreparationExtensionValue {
  return normalizeAIDataAgentPreparationExtensionValue({
    schemaVersion: AI_DATA_AGENT_PREPARATION_EXTENSION_VALUE_SCHEMA_VERSION,
    receipts: [],
  })
}

export function createAIDataAgentPreparationExtensionCodecRegistry(
  fallback: DefinitionStepExtensionCodecRegistryPort,
): DefinitionStepExtensionCodecRegistryPort {
  return Object.freeze({
    resolve: (kind: string) => kind === AI_DATA_AGENT_PREPARATION_EXTENSION_KIND
      ? Object.freeze({
          schemaRef: AI_DATA_AGENT_PREPARATION_EXTENSION_SCHEMA_REF,
          codec: Object.freeze({
            normalize: (value: DefinitionStepValue) => (
              normalizeAIDataAgentPreparationExtensionValue(
                value as unknown as AIDataAgentPreparationExtensionValue,
              ) as unknown as DefinitionStepValue
            ),
          }),
        })
      : fallback.resolve(kind),
  })
}

function normalizeAIDataAgentPreparationExtensionValue(
  value: unknown,
): AIDataAgentPreparationExtensionValue {
  let decoded = value
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded)
    } catch {
      throw new Error("AI_DATA_AGENT_PREPARATION_EXTENSION_VALUE_INVALID")
    }
  }
  const input = clone(decoded) as AIDataAgentPreparationExtensionValue
  if (!input || typeof input !== "object" || Array.isArray(input)
    || input.schemaVersion !== AI_DATA_AGENT_PREPARATION_EXTENSION_VALUE_SCHEMA_VERSION
    || !Array.isArray(input.receipts)
    || Object.keys(input).sort().join(",") !== "receipts,schemaVersion") {
    throw new Error("AI_DATA_AGENT_PREPARATION_EXTENSION_VALUE_INVALID")
  }
  const receipts = input.receipts.map(normalizeAIDataAgentPreparationReceipt)
    .sort((left, right) => left.task.nodeId < right.task.nodeId ? -1 : left.task.nodeId > right.task.nodeId ? 1 : 0)
  if (new Set(receipts.map((receipt) => receipt.task.nodeId)).size !== receipts.length) {
    throw new Error("AI_DATA_AGENT_PREPARATION_EXTENSION_TASK_DUPLICATE")
  }
  return Object.freeze({
    schemaVersion: AI_DATA_AGENT_PREPARATION_EXTENSION_VALUE_SCHEMA_VERSION,
    receipts: Object.freeze(receipts),
  })
}

function findPreparationExtensionSlot(extensions: FlowRunStepExtensions): Readonly<{
  stepId: string
  fact: FlowRunStepExtensions["byStepId"][string][string]
}> | undefined {
  const slots = Object.entries(extensions.byStepId).flatMap(([stepId, byKind]) => {
    const fact = byKind[AI_DATA_AGENT_PREPARATION_EXTENSION_KIND]
    if (!fact) return []
    if (fact.schemaRef !== AI_DATA_AGENT_PREPARATION_EXTENSION_SCHEMA_REF) {
      throw new Error("AI_DATA_AGENT_PREPARATION_EXTENSION_SCHEMA_MISMATCH")
    }
    return [{ stepId, fact }]
  })
  if (slots.length > 1) throw new Error("AI_DATA_AGENT_PREPARATION_EXTENSION_SLOT_DUPLICATE")
  return slots[0]
}

function preparationReceipt(
  prepared: EidolonPreparedAIAgentDefinition,
  input: Readonly<{
    instanceId: string
    instanceName: string
    capability: AIDataPreparedAgentCapabilityInput
  }>,
): AIDataAgentPreparationReceipt {
  const instanceId = exactIdentity(input.instanceId, "instanceId")
  const instanceName = exactIdentity(input.instanceName, "instanceName")
  const capabilityId = exactIdentity(input.capability.capabilityId, "capability.capabilityId")
  const agentDefinitionRef = prepared.admission.candidate.agentDefinitionRef
  const taskProofRef = agentDefinitionRef
  const capability = Object.freeze({
    capabilityId,
    tag: input.capability.tag,
    nodeType: "agent" as const,
    inputSchemaRefs: clone(input.capability.inputSchemaRefs),
    outputSchemaRefs: clone(input.capability.outputSchemaRefs),
    fixedConfig: Object.freeze({ ...clone(input.capability.fixedConfig), instanceName }),
    implementation: Object.freeze({
      kind: "agent" as const,
      agentDefinitionRef,
      taskProofRef,
    }),
  }) satisfies AIDataControlAgentCapability
  const unsigned = Object.freeze({
    schemaVersion: AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION,
    instanceId,
    requirement: prepared.requirement.requirement,
    requirementDigest: prepared.requirement.requirementDigest,
    agentDefinitionRef,
    agentContentDigest: prepared.admission.candidate.contentDigest,
    selectionCandidateDigest: prepared.admission.candidate.candidateDigest,
    taskProofRef,
    task: prepared.taskBinding.task,
    semanticFingerprint: prepared.taskBinding.semanticFingerprint,
    snapshotRevision: prepared.taskBinding.snapshotRevision,
    closureResourceIds: prepared.taskBinding.closureResourceIds,
    instanceName,
    capability,
    frozenExecution: clone(prepared.frozenExecution),
    ...(prepared.authoringReceipt === undefined ? {} : {
      authoring: Object.freeze({
        planDigest: prepared.authoringReceipt.planDigest as `sha256:${string}`,
        transactionId: prepared.authoringReceipt.transactionId,
        receiptDigest: prepared.authoringReceipt.receiptDigest as `sha256:${string}`,
      }),
    }),
  })
  return normalizeAIDataAgentPreparationReceipt({
    ...unsigned,
    receiptDigest: sha256Digest(canonicalJson(unsigned)),
  })
}

function assertRecoveredProof(
  receipt: AIDataAgentPreparationReceipt,
  recovered: EidolonPreparedAIAgentDefinition,
): void {
  const proof = recovered.taskBinding
  const drift = [
    canonicalJson(proof.task) === canonicalJson(receipt.task) ? undefined : "task",
    proof.semanticFingerprint === receipt.semanticFingerprint ? undefined : "semanticFingerprint",
    canonicalJson(proof.closureResourceIds) === canonicalJson(receipt.closureResourceIds) ? undefined : "closureResourceIds",
    recovered.admission.candidate.contentDigest === receipt.agentContentDigest ? undefined : "agentContentDigest",
  ].filter((value): value is string => value !== undefined)
  if (drift.length > 0) throw new Error(`AI_DATA_AGENT_PREPARATION_PROOF_DRIFT: ${drift.join(",")}`)
}

function assertFrozenRecoveredProof(receipt: AIDataAgentPreparationReceipt, proof: FrozenAIAgentTaskBinding): void {
  const drift = [
    canonicalJson(proof.task) === canonicalJson(receipt.task) ? undefined : "task",
    proof.semanticFingerprint === receipt.semanticFingerprint ? undefined : "semanticFingerprint",
    proof.snapshotRevision === receipt.snapshotRevision ? undefined : "snapshotRevision",
    canonicalJson(proof.closureResourceIds) === canonicalJson(receipt.closureResourceIds) ? undefined : "closureResourceIds",
    frozenAIAgentTaskAgentContentDigest(proof) === receipt.agentContentDigest ? undefined : "agentContentDigest",
  ].filter((value): value is string => value !== undefined)
  if (drift.length > 0) throw new Error(`AI_DATA_AGENT_PREPARATION_PROOF_DRIFT: ${drift.join(",")}`)
}

function exactResourceRef<T extends `resource://${string}`>(value: T, label: string): T {
  if (!exactString(value) || !value.startsWith("resource://")) throw new Error(`AI_DATA_AGENT_PREPARATION_${label.toUpperCase()}_INVALID`)
  return value
}

function exactIdentity(value: string, label: string): string {
  if (!exactString(value)) throw new Error(`AI_DATA_AGENT_PREPARATION_${label.toUpperCase()}_INVALID`)
  return value
}

function exactString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim()
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object" || value === null) throw new Error("AI_DATA_AGENT_PREPARATION_VALUE_INVALID")
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => {
    const item = record[key]
    if (item === undefined) throw new Error("AI_DATA_AGENT_PREPARATION_VALUE_INVALID")
    return `${JSON.stringify(key)}:${canonicalJson(item)}`
  }).join(",")}}`
}

function taskKey(task: AIWorkflowAgentTaskRef): string {
  return canonicalJson(task)
}

function assertPreparationIntentInput(intent: AIDataAgentPreparationIntent, input: Readonly<{
  instanceId: string; nodeId: string; identity: FlowClosedObject; requirement: AIAgentTaskRequirement
}>): void {
  if (intent.instanceId !== input.instanceId || intent.nodeId !== input.nodeId
    || canonicalJson(intent.identity) !== canonicalJson(input.identity)
    || normalizeAIAgentTaskRequirement(intent.requirement).requirementDigest !== normalizeAIAgentTaskRequirement(input.requirement).requirementDigest) {
    throw new Error("AI_DATA_AGENT_PREPARATION_INTENT_IDENTITY_MISMATCH")
  }
}

async function readOptionalPreparationJson(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function writeImmutablePreparationJson(file: string, value: unknown): Promise<void> {
  const bytes = `${canonicalJson(value)}\n`
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  const handle = await open(temporary, "wx", 0o600)
  try { await handle.writeFile(bytes, "utf8"); await handle.sync() } finally { await handle.close() }
  try {
    await link(temporary, file)
    const directory = await open(path.dirname(file), "r")
    try { await directory.sync() } finally { await directory.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (await readFile(file, "utf8") !== bytes) throw new Error("AI_DATA_AGENT_PREPARATION_IMMUTABLE_CONFLICT")
  } finally { await unlink(temporary).catch(() => undefined) }
}
