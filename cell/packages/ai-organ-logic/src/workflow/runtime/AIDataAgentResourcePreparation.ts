import path from "node:path"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"

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
import type {
  DefinitionStepExtensionCodecRegistryPort,
  DefinitionStepValue,
} from "flow-step-space-contract"
import { sha256Digest } from "halfcode-compiler.xnl/resource-core"

import {
  EidolonAutonomousAgentResourceHost,
  type EidolonAIAgentDefinitionSelectionObservation,
  type EidolonPreparedAIAgentDefinition,
} from "../../resources/EidolonAutonomousAgentResourceHost"
import type {
  EidolonAppResourceRegistryAdapter,
  EidolonPreparedWorkflowAgentExecution,
} from "../../resources/EidolonAppResourceRegistryAdapter"
import {
  findAIDataAutonomousControlStateInExtensions,
  normalizeAIDataAutonomousControlState,
  writeAIDataAutonomousControlExtension,
} from "./AIDataAutonomousControlLoop"

export const AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION = "eidolon.ai-data-agent-preparation/v1" as const
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
  schemaVersion: typeof AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION
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
  authoring?: Readonly<{
    planDigest: `sha256:${string}`
    transactionId: string
    receiptDigest: `sha256:${string}`
  }>
  receiptDigest: `sha256:${string}`
}>

export type AIDataPreparedAgentResource = Readonly<{
  receipt: AIDataAgentPreparationReceipt
  proof: FrozenAIAgentTaskBinding
}>

export type AIDataAgentPreparationExtensionValue = Readonly<{
  schemaVersion: typeof AI_DATA_AGENT_PREPARATION_EXTENSION_VALUE_SCHEMA_VERSION
  receipts: readonly AIDataAgentPreparationReceipt[]
}>

type AgentExecutionRegistry = Pick<EidolonAppResourceRegistryAdapter, "prepareWorkflowAgentExecution">

export class FileAIDataAgentPreparationStore {
  constructor(private readonly root: string) {}

  async save(receiptValue: AIDataAgentPreparationReceipt): Promise<void> {
    const receipt = normalizeAIDataAgentPreparationReceipt(receiptValue)
    const filePath = this.filePath(receipt.instanceId, receipt.task.nodeId)
    await mkdir(path.dirname(filePath), { recursive: true })
    const bytes = `${canonicalJson(receipt)}\n`
    try {
      await writeFile(filePath, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (await readFile(filePath, "utf8") !== bytes) {
        throw new Error("AI_DATA_AGENT_PREPARATION_IMMUTABLE_CONFLICT")
      }
    }
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

/** Routes prepared tasks to the live registry but rejects any closure drift. */
export class EidolonFixedAgentExecutionRegistry implements AgentExecutionRegistry {
  private readonly byTask = new Map<string, AIDataPreparedAgentResource>()

  constructor(
    private readonly frozen: AgentExecutionRegistry | undefined,
    private readonly live: AgentExecutionRegistry,
    prepared: readonly AIDataPreparedAgentResource[],
  ) {
    for (const item of prepared) {
      const key = taskKey(item.receipt.task)
      if (this.byTask.has(key)) throw new Error("AI_DATA_AGENT_PREPARATION_TASK_DUPLICATE")
      this.byTask.set(key, item)
    }
  }

  async prepareWorkflowAgentExecution(
    task: AIWorkflowAgentTaskRef,
    input: { readonly payload?: unknown } = {},
  ): Promise<EidolonPreparedWorkflowAgentExecution> {
    const prepared = this.byTask.get(taskKey(task))
    const registry = prepared ? this.live : this.frozen
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

  async prepare(input: Readonly<{
    instanceId: string
    observation: EidolonAIAgentDefinitionSelectionObservation
    decision: AIAgentDefinitionSelectionDecision
    workflowRef: `resource://${string}`
    nodeId: string
    instanceName: string
    capability: AIDataPreparedAgentCapabilityInput
  }>): Promise<AIDataAgentPreparationResult> {
    const prepared = await this.host.prepare({
      observation: input.observation,
      decision: input.decision,
      target: {
        workflowKind: "AIDataWorkflow",
        workflowRef: exactResourceRef(input.workflowRef, "workflowRef"),
        nodeId: exactIdentity(input.nodeId, "nodeId"),
      },
    })
    if (prepared.status === "rejected") return prepared
    return Object.freeze({
      receipt: preparationReceipt(prepared, input),
      proof: prepared.taskBinding,
    })
  }

  async recover(
    value: AIDataAgentPreparationReceipt,
  ): Promise<AIDataPreparedAgentResource> {
    const receipt = normalizeAIDataAgentPreparationReceipt(value)
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
  if (receipt.schemaVersion !== AI_DATA_AGENT_PREPARATION_SCHEMA_VERSION
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
  if (receipt.authoring && (!isDigest(receipt.authoring.planDigest)
    || !isDigest(receipt.authoring.receiptDigest)
    || !exactString(receipt.authoring.transactionId))) {
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
  if (!control) throw new Error("AI_DATA_AGENT_PREPARATION_CONTROL_STATE_REQUIRED")
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
