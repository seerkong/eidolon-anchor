import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"

import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import {
  AI_DATA_CHILD_INVOCATION_SCHEMA_VERSION,
  type AIDataWorkflowChildFreezeReceipt,
  type AIDataWorkflowChildInvocationIdentity,
  type AIDataWorkflowChildInvocationObservation,
  type AIDataWorkflowChildInvocationRuntimePort,
  type AIDataWorkflowChildTerminalReceipt,
  type AIDataWorkflowGraphPatch,
  type AIWorkflowRunRef,
  type FlowClosedObject,
} from "@cell/ai-workflow-contract"
import {
  createAICtrlWorkflowAgentNodeRuntimeBinder,
  createAICtrlWorkflowCheckpointStore,
  createAICtrlWorkflowController,
  getAICtrlWorkflowRunRecord,
  observeAICtrlHolonTask,
  openAICtrlHolonTask,
  projectAICtrlWorkflowRunRecord,
  replanAICtrlHolonTask,
  resumeAICtrlWorkflowRun,
  startAICtrlWorkflowRun,
} from "ai-ctrl-workflow-logic"
import {
  consumeAIDataHolonTask,
  loadAIDataWorkflowCheckpoint,
  normalizeAIDataWorkflowChildFreezeReceipt,
  type AIDataHolonTaskMaterialValidationInput,
} from "ai-data-workflow-logic"
import {
  holonTaskTargetFromNodeConfig,
  normalizeHolonTaskSnapshotReceipt,
  normalizeHolonTaskSnapshotAdoptionReceipt,
  normalizeHolonTaskTarget,
  type FrozenHolonTaskTarget,
  type HolonTaskTarget,
} from "ai-workflow-contract"
import { runAgent, normalizeFlowClosedObject, normalizeAIAgentTaskRequirement } from "ai-workflow-logic"
import { assertFrozenAIAgentTaskBinding } from "ai-workflow-logic/run-freeze"
import {
  canonicalHolonEffectiveSnapshotBytes,
  canonicalHolonEffectiveSnapshotIssuanceReceiptBytes,
} from "holarchy-core-contract"
import type { TaskRecord, TaskSettlementReceipt } from "task-manager-contract"
import type { TaskManagerRuntime } from "task-manager-logic"
import type {
  AIWorkflowAgentTaskRef,
  AIAgentDefinitionSelectionDecision,
  AIAgentTaskRequirement,
  AIWorkflowAuthoredRuntimeContext,
  FrozenAIAgentTaskBinding,
} from "ai-workflow-contract"
import type { DefinitionStepExtensionCodecRegistryPort } from "flow-step-space-contract"
import { createFilesystemFlowCodeResolver } from "instant-ctrl-flow-logic"
import type { ResumeSignal } from "work-ctrl-flow-contract"
import { hashWorkflowSources, type WorkflowAuthoringWorkspace } from "../authoring"
import { createWorkflowComponentForRuntime } from "../component"
import {
  EidolonAppResourceRegistryAdapter,
  EidolonAutonomousAgentResourceHost,
  loadFrozenEffectiveEidolonVfsReadPort,
  type EidolonAIAgentDefinitionSelectionObservation,
  type EidolonEffectiveVfsAuthoringPort,
  type ResourcePackageLayerBinding,
} from "../../resources"
import {
  EidolonWorkflowEffectProvider,
  StoreBackedWorkflowMaterialAccess,
  type EidolonWorkflowEffectProviderFaultObserver,
} from "../effects"
import {
  bindWorkflowStepExtensionAuthoredRuntime,
  createWorkflowStepExtensionAuthoredFacade,
} from "../effects/WorkflowStepExtensionAuthoredFacade"
import { AIDataWorkflowRuntimeDriver } from "./AIDataWorkflowRuntimeDriver"
import {
  createAIDataChildAgentPreparationExtensionCodecRegistry,
  readAIDataChildAgentPreparationDeclaration,
} from "./AIDataChildAgentPreparation"
import {
  normalizeAgentExecutionSchema,
  normalizeAgentExecutionValue,
  validateAgentExecutionValue,
} from "../../agent/AgentExecutionContract"
import { EMPTY_AI_WORKFLOW_DURABLE_STATE, WorkflowDepaPersistence } from "./WorkflowDepaPersistence"
import { WorkflowLegacyMigration } from "./WorkflowLegacyMigration"
import {
  normalizeFrozenWorkflowCodeReference,
  WorkflowDefinitionRepository,
  type ResolvedWorkflowDefinition,
} from "./WorkflowDefinitionRepository"
import { WorkflowFactStore, type WorkflowRunDescriptor } from "./WorkflowFactStore"
import type {
  WorkflowDefinitionRevision,
  WorkflowInstance,
  WorkflowMaterialBinding,
  WorkflowMaterialRevisionRef,
  WorkflowRunReceipt,
} from "./WorkflowLifecycleFacts"
import { WorkflowMaterialService } from "./WorkflowMaterialService"
import { createAIDataAutonomousControlExtensionCodecRegistry } from "./AIDataAutonomousControlLoop"
import {
  AIDataAgentResourcePreparationService,
  EidolonFixedAgentExecutionRegistry,
  FileAIDataAgentPreparationStore,
  createAIDataAgentPreparationExtensionCodecRegistry,
  mergeAIDataPreparedAgentProofs,
  readAIDataAgentPreparationReceipts,
  type AIDataAgentPreparationResult,
  type AIDataPreparedAgentCapabilityInput,
} from "./AIDataAgentResourcePreparation"
import type { AIDataAutonomousVerifierPort } from "./AIDataAutonomousControlRunner"
import type {
  AIDataControlAdmission,
  AIDataControlDecision,
  AIDataControlObservation,
  AIDataControlVerifierFact,
} from "@cell/ai-workflow-contract"
import {
  loadHolonDeploymentDefinition,
  materializeHolonDeploymentDefinition,
  type MaterializedHolonDeploymentDefinition,
} from "../../organization/HolonDeploymentDefinition"
import { FileHolonDeploymentRuntimeStore } from "../../organization/HolonDeploymentRuntimeStore"
import { resolveHolonTaskMemberIdentity } from "../../organization/HolonTaskMemberIdentity"
import {
  EidolonHolonLocalActorRuntime,
  type HolonExecutionAdapterPorts,
  type HolonGenericActorOwnerPort,
} from "../../organization/HolonLocalActorRuntime"
import {
  createHolonTaskProcessorRuntime,
  executeHolonWorkflowTask,
  type ExecuteHolonWorkflowTaskInput,
  type HolonWorkflowTaskProcessorRuntime,
  type HolonWorkflowTaskExecutionResult,
} from "../../organization/HolonWorkflowTaskRuntime"
import {
  type HolonTaskPumpJournalFaultObserver,
  type HolonTaskPumpJournalPort,
  type HolonTaskPumpSubscription,
} from "../../organization/HolonTaskPumpJournal"
import {
  assignHolonTaskThroughMountedCapability,
  registerHolonTaskRuntimeCapabilityBinding,
} from "../../organization/HolonTaskRuntimeCapability"
import { projectFrozenWorkflowHolonTaskAdmission } from "../../organization/LegacyWorkflowHolonTaskProfileAdapter"
import {
  mountLocalHolonTaskRuntimeSupport,
  type LocalHolonTaskRuntimeSupport as LocalWorkflowHolonTaskRuntimeSupport,
} from "../../organization/HolonTaskRuntimeComposition"
import { requireHolonTaskRuntimeCapability } from "../../organization/HolonTaskRuntimeCapability"

type WorkflowRuntime = AiAgentOneActorRuntime<any, any>
type CtrlController = ReturnType<typeof createAICtrlWorkflowController>

export type StartWorkflowRunInput = {
  instanceId: string
  runId?: string
  confirmed?: boolean
  replayOf?: string
}

export type ProcessWorkflowHolonTaskInput = Readonly<{
  runId: string
  nodeId: string
  taskSpaceId: string
  taskId: string
  assignmentCommandId: string
  startCommandId: string
  settlementCommandId: string
  invocationRef: string
  claimedAt: string
  startedAt: string
  settledAt: string
  leaseDurationMs: number
  input: import("holarchy-eidolon-adapter").ClosedValue
}>

export type ReplanWorkflowHolonTaskInput = Readonly<{
  runId: string
  nodeId: string
  taskSpaceId: string
  previousTaskId: string
  successorTaskId: string
  successorTaskName: string
  successorEffectiveAt: string
  cancelCommandId: string
  replanCommandId: string
  planId: string
  replannedAt: string
  activeClaim?: import("task-manager-contract").TaskClaimToken
}>

export type WorkflowRunProjection = {
  ok: true
  kind: "workflow.run" | "workflow.runStatus" | "workflow.runResume" | "workflow.runResult"
  runtime: "depa-flows.AICtrlWorkflow"
  form: "AICtrlWorkflow"
  workflow_ref: string
  instance_id: string
  definition_revision: string
  run_id: string
  generation: number
  status: string
  terminal: boolean
  nodes: unknown[]
  open_wait_handles: unknown[]
  vars?: Record<string, unknown>
}

export type WorkflowRuntimeServiceOptions = Readonly<{
  holonJournalFaults?: HolonTaskPumpJournalFaultObserver
  holonEffectFaults?: EidolonWorkflowEffectProviderFaultObserver
  holonPumpMaxSteps?: number
  holonPumpWaitingProbeMs?: number
  holonFaults?: Readonly<{
    afterTaskSpaceSettlement?(input: Readonly<{
      runId: string
      settlementReceiptIds: readonly string[]
    }>): void | Promise<void>
  }>
}>

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, stableValue(item)]))
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`
}

/**
 * Workflow-authored TaskSpace ids are local names. The standalone service has
 * one TaskSpace authority for the whole VM/session, so its durable identity
 * must include the run boundary that the former per-instance directory
 * supplied implicitly.
 */
export function workflowHolonTaskSpaceId(runId: string, authoredTaskSpaceId: string): string {
  const exact = (value: string, location: string): string => {
    if (typeof value !== "string" || !value || value !== value.trim()
      || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`EIDOLON_HOLON_WORKFLOW_TASK_SPACE_ID_INVALID: ${location}`)
    }
    return value
  }
  const identity = createHash("sha256").update(JSON.stringify([
    "eidolon.workflow-holon-task-space/v1",
    exact(runId, "runId"),
    exact(authoredTaskSpaceId, "authoredTaskSpaceId"),
  ])).digest("hex").slice(0, 40)
  return `workflow-holon-task-space-${identity}`
}

function metadata(runtime: WorkflowRuntime): Record<string, unknown> {
  const value = runtime.vm?.outerCtx?.metadata
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

async function terminalTaskSettlement(
  owner: TaskManagerRuntime["owner"],
  taskSpaceId: string,
  taskId: string,
): Promise<Readonly<{
  task: TaskRecord
  receipt: TaskSettlementReceipt
}> | undefined> {
  const snapshot = await owner.readSnapshot(taskSpaceId)
  const task = snapshot?.tasks.find((candidate) => candidate.taskId === taskId)
  if (!task || !["Succeeded", "Failed", "Cancelled"].includes(task.status)) return undefined
  const history = await owner.readHistory(taskSpaceId)
  let terminalEvent: (typeof history)[number] | undefined
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index]!
    if ("taskId" in event && event.taskId === taskId
      && ["task.settled", "task.failed", "task.cancelled"].includes(event.kind)) {
      terminalEvent = event
      break
    }
  }
  if (!terminalEvent) return undefined
  const receipt = await owner.readReceiptByCommand(taskSpaceId, terminalEvent.commandId)
  if (!receipt || receipt.kind !== "task-settlement-receipt"
    || receipt.taskId !== taskId || receipt.status !== task.status) return undefined
  return Object.freeze({ task, receipt })
}

function effectOwnerNodeId(request: { nodeId?: unknown; config?: unknown }): string {
  if (typeof request.nodeId === "string" && request.nodeId.trim()) return request.nodeId
  const configured = nestedRecord(request.config).nodeId
  return typeof configured === "string" && configured.trim() ? configured : "effect"
}

function durableCtrlValue(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Array.isArray(value)) return value.map(durableCtrlValue)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .map(([key, nested]) => [key, durableCtrlValue(nested)]))
}

function discoverAgentTasks(
  descriptor: WorkflowRunDescriptor,
  definition: ResolvedWorkflowDefinition,
): readonly AIWorkflowAgentTaskRef[] {
  if (!definition.resourceReceipt) return []
  const tasks = new Map<string, AIWorkflowAgentTaskRef>()
  const visited = new WeakSet<object>()
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    const record = value as Record<string, unknown>
    const attrs = nestedRecord(record.attrs)
    const directConfig = nestedRecord(record.config)
    const authoredConfig = nestedRecord(attrs.config)
    const config = typeof directConfig.agentDefinitionRef === "string" ? directConfig
      : typeof authoredConfig.agentDefinitionRef === "string" ? authoredConfig
        : attrs
    const nodeId = typeof record.id === "string" ? record.id
      : typeof record.nodeId === "string" ? record.nodeId
      : typeof record.Key === "string" ? record.Key
        : typeof record.key === "string" ? record.key : undefined
    if (typeof nodeId === "string"
      && typeof config.agentDefinitionRef === "string"
      && config.agentDefinitionRef.startsWith("resource://")) {
      const task: AIWorkflowAgentTaskRef = Object.freeze({
        workflowKind: descriptor.form,
        workflowRef: descriptor.workflowRef as `resource://${string}`,
        nodeId,
        agentDefinitionRef: config.agentDefinitionRef as `resource://${string}`,
      })
      const prior = tasks.get(task.nodeId)
      if (prior && prior.agentDefinitionRef !== task.agentDefinitionRef) {
        throw new Error(`Frozen workflow node ${task.nodeId} declares conflicting Agent definitions`)
      }
      tasks.set(task.nodeId, task)
    }
    for (const nested of Object.values(record)) visit(nested)
  }
  visit(definition.binding.definition)
  return Object.freeze([...tasks.values()].sort((left, right) => left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0))
}

function runtimeRoots(runtime: WorkflowRuntime, workspaceRoot: string) {
  const aiWorkflow = nestedRecord(metadata(runtime).aiWorkflow)
  const roots = nestedRecord(aiWorkflow.roots)
  return {
    globalRoot: typeof roots.globalRoot === "string" ? roots.globalRoot : path.join(workspaceRoot, ".global"),
    workspaceRoot: typeof roots.workspaceRoot === "string" ? roots.workspaceRoot : workspaceRoot,
  }
}

function factRoot(runtime: WorkflowRuntime, workspaceRoot: string): string {
  const value = metadata(runtime).sessionDir
  return typeof value === "string" && path.isAbsolute(value)
    ? path.join(value, "workflow-runtime")
    : path.join(workspaceRoot, ".runtime")
}

function stepExtensionCodecs(runtime: WorkflowRuntime): DefinitionStepExtensionCodecRegistryPort {
  const aiWorkflow = nestedRecord(metadata(runtime).aiWorkflow)
  const candidate = aiWorkflow.extensionCodecs
  if (candidate && typeof candidate === "object" && typeof (candidate as { resolve?: unknown }).resolve === "function") {
    return createAIDataChildAgentPreparationExtensionCodecRegistry(createAIDataAgentPreparationExtensionCodecRegistry(createAIDataAutonomousControlExtensionCodecRegistry(
      candidate as DefinitionStepExtensionCodecRegistryPort,
    )))
  }
  return createAIDataChildAgentPreparationExtensionCodecRegistry(createAIDataAgentPreparationExtensionCodecRegistry(
    createAIDataAutonomousControlExtensionCodecRegistry(),
  ))
}

function runRef(
  descriptor: WorkflowRunDescriptor,
  definition: ResolvedWorkflowDefinition,
): AIWorkflowRunRef {
  return Object.freeze({
    workflow: Object.freeze({
      ref: descriptor.workflowRef,
      scheme: definition.resourceReceipt ? "resource" : "vfs",
    }),
    runId: descriptor.runId,
    generation: descriptor.generation,
  })
}

type WorkflowHolonDeployment = Readonly<{
  deploymentId: string
  definition: MaterializedHolonDeploymentDefinition
  store: FileHolonDeploymentRuntimeStore
}>

type WorkflowHolonTaskContext = Readonly<{
  proofs: Readonly<Record<string, FrozenHolonTaskTarget>>
  targets: Readonly<Record<string, HolonTaskTarget>>
  taskManager: Readonly<{ owner: TaskManagerRuntime["owner"] }>
  journal: HolonTaskPumpJournalPort
  support: LocalWorkflowHolonTaskRuntimeSupport
  organizationSnapshots: Readonly<{
    readEffectiveSnapshot(input: Readonly<{
      rootHolonRef: string
      effectiveAt: string
    }>): Promise<Readonly<{
      snapshotBytes: Uint8Array
      issuanceReceiptBytes: Uint8Array
    }>>
  }>
  deployments: ReadonlyMap<string, WorkflowHolonDeployment>
  taskSpaceId(authoredTaskSpaceId: string): Promise<string>
  proofForNode(nodeId: string): FrozenHolonTaskTarget
  openTask(
    input: Parameters<typeof openAICtrlHolonTask>[1],
    config: Parameters<typeof openAICtrlHolonTask>[2],
  ): ReturnType<typeof openAICtrlHolonTask>
  observeTask(
    input: Parameters<typeof observeAICtrlHolonTask>[1],
    config: Parameters<typeof observeAICtrlHolonTask>[2],
  ): ReturnType<typeof observeAICtrlHolonTask>
  replanTask(
    input: Parameters<typeof replanAICtrlHolonTask>[1],
    config: Parameters<typeof replanAICtrlHolonTask>[2],
  ): ReturnType<typeof replanAICtrlHolonTask>
  consumeTask(
    input: Parameters<typeof consumeAIDataHolonTask>[1],
    config: Parameters<typeof consumeAIDataHolonTask>[2],
  ): ReturnType<typeof consumeAIDataHolonTask>
}>

function discoverHolonTaskTargets(
  descriptor: WorkflowRunDescriptor,
  definition: ResolvedWorkflowDefinition,
): Readonly<Record<string, HolonTaskTarget>> {
  if (!definition.resourceReceipt) return Object.freeze({})
  const targets: Record<string, HolonTaskTarget> = Object.create(null)
  const visited = new WeakSet<object>()
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    const record = value as Record<string, unknown>
    const attrs = nestedRecord(record.attrs)
    const configs = [nestedRecord(record.config), nestedRecord(attrs.config), attrs]
    const config = configs.find((candidate) => Object.prototype.hasOwnProperty.call(candidate, "holonTaskTarget"))
    const nodeId = typeof record.id === "string" ? record.id
      : typeof record.nodeId === "string" ? record.nodeId
      : typeof record.Key === "string" ? record.Key
      : typeof record.key === "string" ? record.key : undefined
    if (config && nodeId) {
      const target = holonTaskTargetFromNodeConfig(config, {
        workflowKind: descriptor.form,
        workflowRef: descriptor.workflowRef as `resource://${string}`,
        nodeId,
      })
      if (target) {
        const prior = targets[nodeId]
        if (prior && fingerprint(prior) !== fingerprint(target)) {
          throw new Error(`Frozen workflow node ${nodeId} declares conflicting Holon targets`)
        }
        targets[nodeId] = target
      }
    }
    for (const nested of Object.values(record)) visit(nested)
  }
  visit(definition.binding.definition)
  return Object.freeze(targets)
}

async function validateHolonSettlementMaterial(
  registry: EidolonAppResourceRegistryAdapter,
  input: AIDataHolonTaskMaterialValidationInput,
) {
  const snapshot = await registry.snapshot()
  const schemaId = input.schemaRef.slice("resource://".length)
  const schemaEntry = snapshot.registry.byId.get(schemaId)
  if (!schemaEntry?.resource || schemaEntry.kind !== "MessageSchema") {
    throw new Error(`EIDOLON_HOLON_OUTPUT_SCHEMA_MISSING: ${input.schemaRef}`)
  }
  const values: Array<readonly [`resource://${string}`, ReturnType<typeof normalizeAgentExecutionValue>]> = []
  for (const material of input.materials) {
    const portId = material.materialPortRef.slice("resource://".length)
    const port = snapshot.agentResources.materialPorts.find(
      (candidate) => candidate.resource.resourceId === portId,
    )
    if (!port || port.schema?.ref !== input.schemaRef
      || port.schema.resource.resourceId !== schemaEntry.resource.resourceId) {
      throw new Error(`EIDOLON_HOLON_MATERIAL_PORT_SCHEMA_MISMATCH: ${material.materialPortRef}`)
    }
    if (material.body.encoding !== "base64" || material.body.mediaType !== "application/json") {
      throw new Error(`EIDOLON_HOLON_MATERIAL_ENCODING_UNSUPPORTED: ${material.materialPortRef}`)
    }
    const bytes = Buffer.from(material.body.data, "base64")
    if (bytes.byteLength !== material.body.sizeBytes || bytes.toString("base64") !== material.body.data) {
      throw new Error(`EIDOLON_HOLON_MATERIAL_BYTES_MISMATCH: ${material.materialPortRef}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString("utf8"))
    } catch {
      throw new Error(`EIDOLON_HOLON_MATERIAL_JSON_INVALID: ${material.materialPortRef}`)
    }
    const value = normalizeAgentExecutionValue(parsed, `holonMaterial.${portId}`)
    validateAgentExecutionValue(
      normalizeAgentExecutionSchema(port.schema.schema, `holonMaterial.${portId}.schema`),
      value,
      `holonMaterial.${portId}`,
    )
    values.push(Object.freeze([material.materialPortRef, value] as const))
  }
  if (values.length === 1) return values[0]![1]
  return normalizeAgentExecutionValue(Object.fromEntries(values), "holonMaterial.output")
}

function workflowHolonDeploymentId(
  bindingRef: string,
  snapshotIdentity: string,
): string {
  const identity = `${bindingRef}\u0000${snapshotIdentity}`
  return `holon-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`
}

function sameHolonTargetExecutableIdentity(
  frozen: HolonTaskTarget,
  candidate: HolonTaskTarget,
): boolean {
  return fingerprint(frozen) === fingerprint({
    ...candidate,
    holon: { ...candidate.holon, effectiveAt: frozen.holon.effectiveAt },
  })
}

function resourceDocumentPath(documentUri: string): string {
  if (!documentUri.startsWith("vfs://@/")) {
    throw new Error("EIDOLON_HOLON_REPLAN_SNAPSHOT_DOCUMENT_UNSUPPORTED")
  }
  return documentUri.slice("vfs://@/".length).split(/[?#]/, 1)[0]!
}

async function assertOrganizationOnlyResourceChange(
  frozenRegistry: EidolonAppResourceRegistryAdapter,
  liveRegistry: EidolonAppResourceRegistryAdapter,
  frozenSnapshotDocumentUri: string,
  liveSnapshotDocumentUri: string,
): Promise<void> {
  const frozenSnapshotPath = resourceDocumentPath(frozenSnapshotDocumentUri)
  const liveSnapshotPath = resourceDocumentPath(liveSnapshotDocumentUri)
  if (frozenSnapshotPath !== liveSnapshotPath) {
    throw new Error("EIDOLON_HOLON_REPLAN_SUCCESSOR_INSTANCE_REQUIRED: organization Resource identity moved")
  }
  const [frozenFiles, liveFiles] = await Promise.all([
    frozenRegistry.captureFrozenResourceClosure(),
    liveRegistry.captureFrozenResourceClosure(),
  ])
  const excluded = (filePath: string) => filePath.endsWith(`/${frozenSnapshotPath}`)
  const byPath = ([left]: readonly [string, string], [right]: readonly [string, string]) => (
    left < right ? -1 : left > right ? 1 : 0
  )
  const frozenEntries = Object.entries(frozenFiles).filter(([filePath]) => !excluded(filePath)).sort(byPath)
  const liveEntries = Object.entries(liveFiles).filter(([filePath]) => !excluded(filePath)).sort(byPath)
  if (fingerprint(frozenEntries) !== fingerprint(liveEntries)) {
    const frozenMap = new Map(frozenEntries)
    const liveMap = new Map(liveEntries)
    const changed = [...new Set([...frozenMap.keys(), ...liveMap.keys()])]
      .filter((filePath) => frozenMap.get(filePath) !== liveMap.get(filePath))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    throw new Error(`EIDOLON_HOLON_REPLAN_SUCCESSOR_INSTANCE_REQUIRED: executable ResourcePackage closure changed (${changed.join(", ")})`)
  }
}

export class WorkflowRuntimeService {
  readonly facts: WorkflowFactStore
  readonly materials: WorkflowMaterialService
  readonly depa: WorkflowDepaPersistence
  readonly legacyMigration: WorkflowLegacyMigration
  private readonly repository: WorkflowDefinitionRepository
  private readonly controllers = new Map<string, CtrlController>()
  private readonly ctrlNodeOrder = new Map<string, ReadonlyMap<string, number>>()
  private readonly dataDrivers = new Map<string, AIDataWorkflowRuntimeDriver>()
  private readonly holonContexts = new Map<string, WorkflowHolonTaskContext>()
  private readonly workspace: WorkflowAuthoringWorkspace
  private readonly catalog: ReturnType<typeof createWorkflowComponentForRuntime>["catalog"]
  private readonly resourceRegistry: EidolonAppResourceRegistryAdapter
  private readonly resourceLayers: readonly ResourcePackageLayerBinding[]
  private readonly effectiveVfsAuthoring?: EidolonEffectiveVfsAuthoringPort
  private readonly supportRoot: string
  private readonly agentPreparationStore: FileAIDataAgentPreparationStore
  private agentPreparationService?: AIDataAgentResourcePreparationService

  constructor(
    private readonly runtime: WorkflowRuntime,
    private readonly options: WorkflowRuntimeServiceOptions = {},
  ) {
    const component = createWorkflowComponentForRuntime(runtime)
    if (!component.authoring) throw new Error("Workflow authoring workspace is not bound")
    if (!component.repository) throw new Error("Workflow definition repository is not bound")
    this.workspace = component.authoring
    this.catalog = component.catalog
    this.resourceRegistry = component.resourceRegistry
    this.resourceLayers = component.resourceLayers
    this.effectiveVfsAuthoring = component.effectiveVfsAuthoring
    this.repository = component.repository
    this.supportRoot = factRoot(runtime, component.authoring.store.rootPath)
    this.agentPreparationStore = new FileAIDataAgentPreparationStore(
      path.join(this.supportRoot, "agent-preparations"),
    )
    this.facts = new WorkflowFactStore(this.supportRoot)
    this.depa = new WorkflowDepaPersistence(this.supportRoot, stepExtensionCodecs(runtime))
    this.legacyMigration = new WorkflowLegacyMigration(this.supportRoot, this.depa)
    this.materials = new WorkflowMaterialService(component.authoring, this.facts)
  }

  getType(workflowRef: string): Promise<WorkflowDefinitionRevision> {
    return this.repository.capture(workflowRef)
  }

  async listTypes(): Promise<WorkflowDefinitionRevision[]> {
    return Promise.all((await this.repository.listResourceRefs()).map((ref) => this.repository.capture(ref)))
  }

  async observeAIDataAgentDefinition(input: Readonly<{
    instanceId: string
    requirement: AIAgentTaskRequirement
  }>): Promise<EidolonAIAgentDefinitionSelectionObservation> {
    const instance = await this.requirePreparedAIDataInstance(input.instanceId)
    void instance
    return (await this.liveAgentPreparationService()).observe(input.requirement)
  }

  async prepareAIDataAgentDefinition(input: Readonly<{
    instanceId: string
    observation: EidolonAIAgentDefinitionSelectionObservation
    decision: AIAgentDefinitionSelectionDecision
    nodeId: string
    instanceName: string
    capability: AIDataPreparedAgentCapabilityInput
  }>): Promise<AIDataAgentPreparationResult> {
    const instance = await this.requirePreparedAIDataInstance(input.instanceId)
    if (!instance.workflowRef.startsWith("resource://")) {
      throw new Error("AI_DATA_AGENT_PREPARATION_RESOURCE_WORKFLOW_REQUIRED")
    }
    const prepared = await (await this.liveAgentPreparationService()).prepare({
      instanceId: instance.instanceId,
      observation: input.observation,
      decision: input.decision,
      workflowRef: instance.workflowRef as `resource://${string}`,
      nodeId: input.nodeId,
      instanceName: input.instanceName,
      capability: input.capability,
    })
    if ("receipt" in prepared) await this.agentPreparationStore.save(prepared.receipt)
    return prepared
  }

  private async requirePreparedAIDataInstance(instanceId: string): Promise<WorkflowInstance> {
    const instance = await this.requireInstance(instanceId)
    if (instance.form !== "AIDataWorkflow") {
      throw new Error("AI_DATA_AGENT_PREPARATION_DATA_WORKFLOW_REQUIRED")
    }
    if (instance.status !== "Prepared") {
      throw new Error(`AI_DATA_AGENT_PREPARATION_INSTANCE_FROZEN: ${instance.instanceId}`)
    }
    return instance
  }

  private async liveAgentPreparationService(): Promise<AIDataAgentResourcePreparationService> {
    if (this.agentPreparationService) return this.agentPreparationService
    const snapshot = await this.resourceRegistry.snapshot()
    this.agentPreparationService = new AIDataAgentResourcePreparationService(
      new EidolonAutonomousAgentResourceHost(
        this.resourceRegistry,
        this.resourceLayers.length > 0 ? this.resourceLayers : snapshot.layers,
        path.join(this.supportRoot, "agent-definition-authoring"),
        this.effectiveVfsAuthoring,
      ),
    )
    return this.agentPreparationService
  }

  async createInstance(input: {
    workflowRef: string
    instanceId?: string
    initialInput?: unknown
    idempotencyKey?: string
  }): Promise<WorkflowInstance> {
    const frozen = await this.captureInstanceDefinition(input.workflowRef)
    await this.facts.saveDefinitionRevision(frozen)
    const requestFingerprint = fingerprint({
      workflowRef: frozen.workflowRef,
      definitionRevision: frozen.revision,
      input: input.initialInput,
    })
    if (input.idempotencyKey) {
      const prior = (await this.facts.listInstances()).find((item) => item.idempotencyKey === input.idempotencyKey)
      if (prior) {
        if (prior.requestFingerprint !== requestFingerprint) {
          throw new Error(`Instance idempotency conflict: ${input.idempotencyKey}`)
        }
        return prior
      }
    }
    const instanceId = input.instanceId?.trim() || `instance-${randomUUID()}`
    const existing = await this.facts.loadInstance(instanceId)
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new Error(`Instance id conflict: ${instanceId}`)
      this.materializeInstance(existing.instanceId, frozen)
      return existing
    }
    const now = Date.now()
    const instance: WorkflowInstance = {
      instanceId,
      workflowRef: frozen.workflowRef,
      definitionRevision: frozen.revision,
      form: frozen.form,
      status: "Prepared",
      input: input.initialInput,
      bindingIds: [],
      runIds: [],
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      createdAt: now,
      updatedAt: now,
    }
    this.materializeInstance(instanceId, frozen)
    await this.facts.saveInstance(instance)
    return instance
  }

  private async captureInstanceDefinition(workflowRef: string): Promise<WorkflowDefinitionRevision> {
    const frozen = await this.repository.capture(workflowRef)
    if (!frozen.resourceReceipt) return frozen
    const closure = await this.resourceRegistry.captureFrozenResourceClosure(undefined, {
      workspaceRoot: this.runtime.vm.outerCtx.workDir,
    })
    const files = { ...frozen.files, ...closure }
    return {
      ...frozen,
      files,
      revision: hashWorkflowSources(Object.entries(files).map(([filePath, content]) => ({ path: filePath, content }))),
    }
  }

  async createInstanceFromPrebuilt(input: {
    prebuiltId: string
    instanceId?: string
    initialInput?: unknown
    idempotencyKey?: string
  }): Promise<WorkflowInstance> {
    const prebuilt = this.catalog.getPrebuiltWorkflow(input.prebuiltId)
    const frozen = this.repository.captureSources({
      files: prebuilt.files,
      form: prebuilt.form,
      sourceBundlePath: `prebuilt:${prebuilt.id}`,
      workflowRef: `builtin://workflow/${prebuilt.id}`,
    })
    await this.facts.saveDefinitionRevision(frozen)
    const requestFingerprint = fingerprint({
      prebuiltId: input.prebuiltId,
      definitionRevision: frozen.revision,
      input: input.initialInput,
    })
    if (input.idempotencyKey) {
      const prior = (await this.facts.listInstances()).find((item) => item.idempotencyKey === input.idempotencyKey)
      if (prior) {
        if (prior.requestFingerprint !== requestFingerprint) throw new Error(`Instance idempotency conflict: ${input.idempotencyKey}`)
        return prior
      }
    }
    const instanceId = input.instanceId?.trim() || `instance-${randomUUID()}`
    const existing = await this.facts.loadInstance(instanceId)
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new Error(`Instance id conflict: ${instanceId}`)
      this.materializeInstance(existing.instanceId, frozen)
      return existing
    }
    const now = Date.now()
    const instance: WorkflowInstance = {
      instanceId,
      workflowRef: frozen.workflowRef,
      definitionRevision: frozen.revision,
      form: frozen.form,
      status: "Prepared",
      input: input.initialInput,
      bindingIds: [],
      runIds: [],
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      createdAt: now,
      updatedAt: now,
    }
    this.materializeInstance(instanceId, frozen)
    await this.facts.saveInstance(instance)
    return instance
  }

  getInstance(instanceId: string): Promise<WorkflowInstance | undefined> {
    return this.facts.loadInstance(instanceId)
  }

  async listInstances(): Promise<WorkflowInstance[]> {
    const instances = await this.facts.listInstances()
    return Promise.all(instances.map(async (instance) => {
      const states = (await Promise.all(instance.runIds.map((runId) => this.status(runId))))
        .filter((value): value is Record<string, unknown> => Boolean(value))
      if (states.length === 0) return instance
      const status = states.some((value) => value.status === "Running" || value.status === "Waiting")
        ? "Running"
        : states.some((value) => value.status === "Failed") ? "Failed" : "Completed"
      return { ...instance, status }
    }))
  }

  mutateRunStepExtension(input: {
    instanceId: string
    runId: string
    stepId: string
    kind: string
    expectedRevision: number
    value: import("ai-workflow-contract").FlowClosedValue
  }) {
    return this.stepExtensionFacade().mutateRunStepExtension(
      { instanceId: input.instanceId, runId: input.runId, stepId: input.stepId, kind: input.kind },
      { expectedRevision: input.expectedRevision, value: input.value },
      {},
    )
  }

  private stepExtensionFacade() {
    return createWorkflowStepExtensionAuthoredFacade(this.depa.stepExtensionRuntime)
  }

  async flowSummary(runId: string): Promise<Record<string, unknown> | undefined> {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor) return undefined
    const checkpoint = await this.ensureCanonicalCheckpoint(descriptor)
    const { bundlePath: _physicalBundlePath, ...portableDescriptor } = descriptor
    return {
      ok: true,
      kind: "workflow.flowSummary",
      run: await this.status(runId),
      descriptor: portableDescriptor,
      instance: descriptor.instanceId ? await this.facts.loadInstance(descriptor.instanceId) : undefined,
      receipt: await this.facts.loadRunReceipt(runId),
      receipt_authority: "derived-read-only",
      checkpoint: checkpoint ? {
        schemaVersion: checkpoint.schemaVersion,
        version: checkpoint.version,
        status: nestedRecord(checkpoint.state).status,
        profileKind: checkpoint.profile.kind,
        stepExtensions: checkpoint.stepExtensions,
      } : undefined,
      migration: this.legacyMigration.readReceipt({ instanceId: descriptor.instanceId, runId }),
    }
  }

  async updateInstanceInput(instanceId: string, input: unknown): Promise<WorkflowInstance> {
    const instance = await this.requireInstance(instanceId)
    if (instance.status !== "Prepared") throw new Error(`Instance input is frozen after start: ${instanceId}`)
    const next = {
      ...instance,
      input,
      updatedAt: Date.now(),
    }
    await this.facts.saveInstance(next)
    return next
  }

  async bindMaterial(input: {
    instanceId: string
    nodeId: string
    port: string
    material: WorkflowMaterialRevisionRef
  }): Promise<WorkflowMaterialBinding> {
    const instance = await this.requireInstance(input.instanceId)
    if (instance.status !== "Prepared") throw new Error(`Instance bindings are frozen after start: ${input.instanceId}`)
    await this.materials.inspect(input.material)
    const bindingId = fingerprint(input)
    const binding: WorkflowMaterialBinding = {
      bindingId,
      instanceId: input.instanceId,
      nodeId: input.nodeId,
      port: input.port,
      material: input.material,
      createdAt: Date.now(),
    }
    await this.facts.saveMaterialBinding(binding)
    const priorBindings = (await Promise.all(instance.bindingIds.map((id) => this.facts.loadMaterialBinding(id))))
      .filter((item): item is WorkflowMaterialBinding => Boolean(item))
    const replaced = priorBindings.filter((item) => item.nodeId === input.nodeId && item.port === input.port)
    for (const prior of replaced) await this.facts.removeMaterialBinding(prior.bindingId)
    await this.facts.saveInstance({
      ...instance,
      bindingIds: [
        ...priorBindings
          .filter((item) => item.nodeId !== input.nodeId || item.port !== input.port)
          .map((item) => item.bindingId),
        bindingId,
      ],
      updatedAt: Date.now(),
    })
    return binding
  }

  async start(input: StartWorkflowRunInput): Promise<any> {
    const instance = await this.requireInstance(input.instanceId)
    const bindings = (await Promise.all(instance.bindingIds.map((id) => this.facts.loadMaterialBinding(id))))
      .filter((item): item is WorkflowMaterialBinding => Boolean(item))
    const agentPreparations = instance.form === "AIDataWorkflow"
      ? await this.agentPreparationStore.list(instance.instanceId)
      : []
    const requestFingerprint = fingerprint({
      instanceId: instance.instanceId,
      definitionRevision: instance.definitionRevision,
      input: instance.input,
      bindings,
      agentPreparations,
      replayOf: input.replayOf,
    })
    const requestedRunId = input.runId?.trim()
    if (requestedRunId) {
      const existing = await this.facts.loadDescriptor(requestedRunId)
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) throw new Error(`Run id conflict: ${requestedRunId}`)
        if (this.holonAutomaticPumpEnabled()) {
          const continued = await this.continueHolonRun(requestedRunId)
          if (continued) return continued
        }
        if (existing.form === "AIDataWorkflow") {
          const driver = await this.loadDataDriver(existing)
          if (!driver && !await this.facts.loadDataGraph(existing.runId)) {
            if (existing.generation !== 0 || existing.requestFingerprint !== fingerprint({
              instanceId: existing.instanceId,
              definitionRevision: existing.definitionRevision,
              input: existing.frozenInput,
              bindings: existing.frozenBindings,
              agentPreparations,
              replayOf: existing.replayOf,
            })) throw new Error("AI_DATA_WORKFLOW_START_INTENT_MISMATCH")
            const definition = await this.loadFrozenDefinition(existing, "AIDataWorkflow")
            await this.persistRunStart(existing, instance)
            const resumed = await this.execute(existing, definition, existing.frozenInput)
            await this.synchronizeInstanceStatus(existing.runId, resumed)
            return resumed
          }
          const current = await driver?.status()
          if (current?.terminal) return this.status(requestedRunId)
          const continued = await driver?.continue()
          if (continued) {
            const projection = this.attachDescriptor(existing, continued)
            await this.synchronizeInstanceStatus(existing.runId, projection)
            return projection
          }
        }
        return this.status(requestedRunId)
      }
    }
    if (input.confirmed !== true) {
      return {
        ok: false,
        status: "confirmation_required",
        operation: "workflow.start",
        effectDispatched: false,
        preview: {
          instance_id: instance.instanceId,
          workflow_ref: instance.workflowRef,
          definition_revision: instance.definitionRevision,
          form: instance.form,
          input: instance.input,
          material_bindings: bindings,
          agent_preparations: agentPreparations,
          requested_run_id: requestedRunId ?? null,
        },
      }
    }
    if (instance.status === "Running") throw new Error(`Instance already has an active run: ${instance.instanceId}`)
    const frozen = await this.facts.loadDefinitionRevision(instance.definitionRevision)
    if (!frozen) throw new Error(`Frozen definition revision not found: ${instance.definitionRevision}`)
    const definition = this.repository.resolveFrozen(
      frozen,
      this.depa.load(instance.instanceId).definitionDir,
    )
    const descriptor: WorkflowRunDescriptor = {
      runId: requestedRunId || `workflow-${randomUUID()}`,
      form: definition.binding.kind,
      workflowRef: definition.workflowRef,
      bundlePath: this.facts.frozenDefinitionRoot(frozen.revision),
      createdAt: Date.now(),
      generation: 0,
      instanceId: instance.instanceId,
      definitionRevision: frozen.revision,
      requestFingerprint,
      frozenInput: instance.input,
      frozenBindings: bindings,
      replayOf: input.replayOf,
    }
    await this.facts.saveDescriptor(descriptor)
    await this.persistRunStart(descriptor, instance)
    try {
      let result = await this.execute(descriptor, definition, instance.input)
      if (this.holonAutomaticPumpEnabled()) {
        result = await this.continueHolonRun(descriptor.runId) ?? result
      }
      await this.synchronizeInstanceStatus(descriptor.runId, result)
      return result
    } catch (error) {
      await this.facts.saveInstance({ ...instance, status: "Failed", runIds: [...instance.runIds, descriptor.runId], updatedAt: Date.now() })
      throw error
    }
  }

  private async persistRunStart(descriptor: WorkflowRunDescriptor, instance: WorkflowInstance): Promise<void> {
    if (!await this.facts.loadRunReceipt(descriptor.runId)) {
      await this.facts.saveRunReceipt({
        runId: descriptor.runId,
        instanceId: descriptor.instanceId,
        definitionRevision: descriptor.definitionRevision,
        input: descriptor.frozenInput,
        inputMaterials: descriptor.frozenBindings,
        outputMaterials: [],
        requestFingerprint: descriptor.requestFingerprint,
        replayOf: descriptor.replayOf,
        createdAt: descriptor.createdAt,
        updatedAt: Date.now(),
      })
    }
    await this.facts.saveInstance({
      ...instance,
      status: "Running",
      runIds: instance.runIds.includes(descriptor.runId) ? instance.runIds : [...instance.runIds, descriptor.runId],
      updatedAt: Date.now(),
    })
  }

  async status(runId: string): Promise<any | undefined> {
    const descriptor = await this.facts.loadDescriptor(runId)
    let checkpoint: any
    if (descriptor) {
      checkpoint = await this.ensureCanonicalCheckpoint(descriptor)
      if (checkpoint?.profile.kind === "WorkCtrlFlow" || checkpoint?.profile.kind === "AICtrlWorkflow") {
        if (!this.ctrlNodeOrder.has(descriptor.runId)) await this.loadController(descriptor.runId)
        const snapshot = checkpoint.profile.snapshot as any
        return {
          ...this.project(
          "workflow.runStatus",
          descriptor,
          projectAICtrlWorkflowRunRecord(snapshot),
          snapshot,
          ),
          checkpoint_version: checkpoint.version,
          step_extensions: checkpoint.stepExtensions,
        }
      }
    }
    if (descriptor?.form === "AIDataWorkflow") {
      const result = await (await this.loadDataDriver(descriptor))?.status()
      return result && {
        ...this.attachDescriptor(descriptor, result),
        checkpoint_version: checkpoint?.version,
        step_extensions: checkpoint?.stepExtensions,
      }
    }
    const loaded = await this.loadController(runId)
    if (!loaded) return undefined
    const record = await getAICtrlWorkflowRunRecord(loaded.controller, runId)
    return record ? this.project("workflow.runStatus", loaded.descriptor, record, await loaded.controller.store.load(runId)) : undefined
  }

  async resume(runId: string, signal: ResumeSignal): Promise<WorkflowRunProjection | undefined> {
    const loaded = await this.loadController(runId)
    if (!loaded) return undefined
    const record = await resumeAICtrlWorkflowRun(loaded.controller, runId, signal)
    const snapshot = await loaded.controller.store.load(runId)
    const checkpoint = await this.ensureCanonicalCheckpoint(loaded.descriptor)
    const projected = {
      ...this.project("workflow.runResume", loaded.descriptor, record, snapshot),
      checkpoint_version: checkpoint?.version,
      step_extensions: checkpoint?.stepExtensions,
    }
    await this.synchronizeInstanceStatus(runId, projected)
    return projected
  }

  /**
   * Host lifecycle entry point for both initial execution and fresh-process
   * recovery. Durable subscriptions discover canonical TaskSpaces; the Flow is
   * resumed only from accepted settlement receipts.
   */
  async continueHolonRun(runId: string, observedAt = new Date().toISOString()): Promise<any | undefined> {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor) return undefined
    const definition = await this.loadFrozenDefinition(descriptor, descriptor.form)
    const registry = this.frozenAgentRegistry(descriptor.instanceId)
    const context = registry
      ? await this.workflowHolonContext(descriptor, definition, registry)
      : undefined
    if (!context) return undefined

    for (let cycle = 0; cycle < 128; cycle += 1) {
      let yielded = false
      const correlations: Array<Readonly<{
        subscription: HolonTaskPumpSubscription
        settlement: TaskSettlementReceipt
      }>> = []
      for (const subscription of await context.journal.listSubscriptions(runId)) {
        if (subscription.recoveryScope.kind !== "workflow") continue
        const taskSpace = await context.taskManager.owner.readSnapshot(subscription.taskSpaceId)
        const task = taskSpace?.tasks.find((candidate) => {
          if (candidate.taskId !== subscription.taskId) return false
          if (candidate.profile.profileKind !== "depa.ai.organization-task") return false
          try {
            const receipt = normalizeHolonTaskSnapshotReceipt(candidate.profile.facts.snapshotReceipt)
            return receipt.issuerReceiptId === subscription.snapshotReceiptId
          } catch {
            return false
          }
        })
        if (!task) continue
        const target = normalizeHolonTaskTarget(task.profile.facts.target)
        const prepared = await this.workflowHolonTaskProcessorRuntime(
          descriptor,
          definition,
          context,
          subscription.recoveryScope.nodeId,
          target,
          subscription.snapshotReceiptId,
        )
        if (prepared.deployment.deploymentId !== subscription.deploymentId) {
          throw new Error("EIDOLON_HOLON_PUMP_SUBSCRIPTION_DEPLOYMENT_MISMATCH")
        }
        const pumped = await context.support.wakeSubscription(subscription)
        if (pumped.status === "yielded") yielded = true
        if (pumped.status === "waiting") {
          context.support.scheduleSubscription(
            subscription,
            async () => {
            if (!this.holonAutomaticPumpEnabled()) return
            await this.continueHolonRun(runId, new Date().toISOString())
            },
          )
        }
        const settlement = await this.workflowHolonSubscriptionSettlement(context, subscription)
        if (settlement) correlations.push(Object.freeze({ subscription, settlement }))
      }

      if (correlations.length > 0) {
        await this.options.holonFaults?.afterTaskSpaceSettlement?.({
          runId,
          settlementReceiptIds: Object.freeze(correlations.map(({ settlement }) => settlement.receiptId)),
        })
      }

      let projection = await this.status(runId)
      if (projection?.terminal) return projection
      let consumed = false
      for (const correlation of correlations) {
        const recoveryScope = correlation.subscription.recoveryScope
        if (recoveryScope.kind !== "workflow") continue
        if (descriptor.form === "AICtrlWorkflow") {
          const handle = Array.isArray(projection?.open_wait_handles)
            ? projection.open_wait_handles.find((candidate: any) => (
                candidate?.signalKey === correlation.subscription.taskSpaceId
                || (typeof candidate?.signalKey === "string"
                  && workflowHolonTaskSpaceId(descriptor.runId, candidate.signalKey)
                    === correlation.subscription.taskSpaceId)
              )) as any
            : undefined
          if (!handle) continue
          projection = await this.resume(runId, {
            signalKind: handle.signalKind,
            signalKey: handle.signalKey,
            resumeToken: handle.resumeToken,
            payload: { settlementReceiptId: correlation.settlement.receiptId },
          })
        } else {
          const waiting = Array.isArray(projection?.nodes)
            ? projection.nodes.find((node: any) => node?.nodeType === "manual"
                && node?.result?.status === "Waiting"
                && Object.values(nestedRecord(node.inputs)).some((binding: any) => (
                  binding?.nodeId === recoveryScope.nodeId
                )))
            : undefined
          if (!waiting) continue
          const outputs = Array.isArray(waiting.outputs) ? waiting.outputs : []
          if (outputs.length !== 1) {
            throw new Error(`EIDOLON_HOLON_DATA_WAIT_OUTPUT_INVALID: ${waiting.id}`)
          }
          projection = await this.resumeDataNode(runId, waiting.id, {
            [outputs[0]]: correlation.settlement.receiptId,
          })
        }
        consumed = true
        break
      }
      if (!consumed) {
        if (yielded) continue
        return projection
      }
      if (projection) await this.synchronizeInstanceStatus(runId, projection)
    }
    throw new Error(`EIDOLON_HOLON_PUMP_CONTROL_BUDGET_EXHAUSTED: ${runId}`)
  }

  async processHolonTask(
    input: ProcessWorkflowHolonTaskInput,
  ): Promise<HolonWorkflowTaskExecutionResult> {
    const descriptor = await this.facts.loadDescriptor(input.runId)
    if (!descriptor) throw new Error(`Holon task run descriptor not found: ${input.runId}`)
    const definition = await this.loadFrozenDefinition(descriptor, descriptor.form)
    const registry = this.frozenAgentRegistry(descriptor.instanceId)
    if (!registry) throw new Error("Holon task execution requires one frozen ResourcePackage registry")
    const context = await this.workflowHolonContext(descriptor, definition, registry)
    if (!context) throw new Error(`Workflow ${descriptor.workflowRef} has no frozen Holon task targets`)
    const frozenTarget = context.targets[input.nodeId]
    const proof = context.proofs[input.nodeId]
    if (!frozenTarget || !proof || fingerprint(proof.target) !== fingerprint(frozenTarget)) {
      throw new Error(`Holon task node ${input.nodeId} has no authentic frozen target`)
    }
    const durableTaskSpaceId = await context.taskSpaceId(input.taskSpaceId)
    const taskSpace = await context.taskManager.owner.readSnapshot(durableTaskSpaceId)
    const task = taskSpace?.tasks.find((candidate) => candidate.taskId === input.taskId)
    const taskFacts = nestedRecord(task?.profile?.facts)
    const target = normalizeHolonTaskTarget(taskFacts.target)
    const snapshotReceipt = normalizeHolonTaskSnapshotReceipt(taskFacts.snapshotReceipt)
    if (!sameHolonTargetExecutableIdentity(frozenTarget, target)) {
      throw new Error("EIDOLON_HOLON_TASK_SUCCESSOR_INSTANCE_REQUIRED: task executable identity differs from the frozen Flow node")
    }
    const prepared = await this.workflowHolonTaskProcessorRuntime(
      descriptor,
      definition,
      context,
      input.nodeId,
      target,
      snapshotReceipt.issuerReceiptId,
    )
    const executionInput: ExecuteHolonWorkflowTaskInput = {
      deploymentId: prepared.deployment.deploymentId,
      bindingRef: target.executionBinding.ref,
      holonRef: target.holon.rootHolonRef,
      taskSpaceId: durableTaskSpaceId,
      taskId: input.taskId,
      workflowInstanceId: descriptor.instanceId,
      runId: descriptor.runId,
      assignmentCommandId: input.assignmentCommandId,
      startCommandId: input.startCommandId,
      settlementCommandId: input.settlementCommandId,
      invocationRef: input.invocationRef,
      claimedAt: input.claimedAt,
      startedAt: input.startedAt,
      settledAt: input.settledAt,
      leaseDurationMs: input.leaseDurationMs,
      input: input.input,
    }
    return executeHolonWorkflowTask(prepared.runtime, executionInput, {
      maxTasks: 1_024,
      maxRelations: 4_096,
      maxLeaseDurationMs: 24 * 60 * 60 * 1_000,
    })
  }

  async replanHolonTask(
    input: ReplanWorkflowHolonTaskInput,
  ): ReturnType<typeof replanAICtrlHolonTask> {
    const descriptor = await this.facts.loadDescriptor(input.runId)
    if (!descriptor || !["AICtrlWorkflow", "AIDataWorkflow"].includes(descriptor.form)) {
      throw new Error(`EIDOLON_HOLON_REPLAN_WORKFLOW_RUN_REQUIRED: ${input.runId}`)
    }
    const definition = await this.loadFrozenDefinition(descriptor, descriptor.form)
    const frozenRegistry = this.frozenAgentRegistry(descriptor.instanceId)
    if (!frozenRegistry) throw new Error("EIDOLON_HOLON_REPLAN_FROZEN_REGISTRY_REQUIRED")
    const context = await this.workflowHolonContext(descriptor, definition, frozenRegistry)
    if (!context) throw new Error(`Workflow ${descriptor.workflowRef} has no frozen Holon task targets`)
    const frozenTarget = context.targets[input.nodeId]
    const frozenProof = context.proofs[input.nodeId]
    const frozenDeployment = frozenTarget
      ? context.deployments.get(frozenTarget.executionBinding.ref)
      : undefined
    if (!frozenTarget || !frozenProof || !frozenDeployment
      || fingerprint(frozenProof.target) !== fingerprint(frozenTarget)) {
      throw new Error(`EIDOLON_HOLON_REPLAN_TARGET_PROOF_REQUIRED: ${input.nodeId}`)
    }
    const durableTaskSpaceId = await context.taskSpaceId(input.taskSpaceId)

    const liveSnapshot = await this.resourceRegistry.refresh()
    const liveProjection = liveSnapshot.holonExecutionBindings.find(
      (candidate) => candidate.binding.bindingRef === frozenTarget.executionBinding.ref,
    )
    if (!liveProjection
      || liveProjection.snapshot.rootHolonRef !== frozenTarget.holon.rootHolonRef
      || liveProjection.snapshot.effectiveAt !== input.successorEffectiveAt) {
      throw new Error("EIDOLON_HOLON_REPLAN_SUCCESSOR_SNAPSHOT_MISSING")
    }
    const successorTarget = normalizeHolonTaskTarget({
      ...frozenTarget,
      holon: { ...frozenTarget.holon, effectiveAt: input.successorEffectiveAt },
    })
    const successorProof = await this.resourceRegistry.freezeWorkflowHolonTaskTarget(successorTarget)
    if (!sameHolonTargetExecutableIdentity(frozenTarget, successorProof.target)) {
      throw new Error("EIDOLON_HOLON_REPLAN_SUCCESSOR_INSTANCE_REQUIRED: target executable identity changed")
    }
    await assertOrganizationOnlyResourceChange(
      frozenRegistry,
      this.resourceRegistry,
      frozenDeployment.definition.bindingProjection.snapshotResource.documentUri,
      liveProjection.snapshotResource.documentUri,
    )
    const binding = frozenDeployment.definition.bindingProjection.binding
    if (binding.adapter.kind !== "ai-agent" || liveProjection.bindingBytesDigest !== frozenDeployment.definition.bindingProjection.bindingBytesDigest) {
      throw new Error("EIDOLON_HOLON_REPLAN_SUCCESSOR_INSTANCE_REQUIRED: binding changed")
    }
    const taskIdentity = {
      workflowKind: descriptor.form,
      workflowRef: descriptor.workflowRef as `resource://${string}`,
      nodeId: input.nodeId,
      agentDefinitionRef: binding.adapter.agentDefinitionRef,
    } as const
    const [frozenAgentProof, liveAgentProof] = await Promise.all([
      frozenRegistry.freezeWorkflowAgentTaskBinding(taskIdentity),
      this.resourceRegistry.freezeWorkflowAgentTaskBinding(taskIdentity),
    ])
    if (frozenAgentProof.semanticFingerprint !== liveAgentProof.semanticFingerprint) {
      throw new Error("EIDOLON_HOLON_REPLAN_SUCCESSOR_INSTANCE_REQUIRED: Agent or Material closure changed")
    }

    const instanceRoot = this.holonTaskRuntimeComposition().scope.supportRoot
    const deploymentId = workflowHolonDeploymentId(
      frozenTarget.executionBinding.ref,
      liveProjection.receiptBytesDigest,
    )
    const successorDeployment = await materializeHolonDeploymentDefinition({
      supportRoot: instanceRoot,
      resourceRegistry: this.resourceRegistry,
    }, {
      deploymentId,
      bindingRef: frozenTarget.executionBinding.ref,
    }, {})
    const organizationSnapshots = Object.freeze({
      readEffectiveSnapshot: async (requested: Readonly<{ rootHolonRef: string; effectiveAt: string }>) => {
        if (requested.rootHolonRef !== successorDeployment.bindingProjection.snapshot.rootHolonRef
          || requested.effectiveAt !== successorDeployment.bindingProjection.snapshot.effectiveAt) {
          throw new Error("EIDOLON_HOLON_REPLAN_SNAPSHOT_AUTHORITY_MISMATCH")
        }
        return Object.freeze({
          snapshotBytes: await canonicalHolonEffectiveSnapshotBytes(successorDeployment.bindingProjection.snapshot),
          issuanceReceiptBytes: canonicalHolonEffectiveSnapshotIssuanceReceiptBytes(
            successorDeployment.bindingProjection.receipt,
            successorDeployment.bindingProjection.snapshot,
          ),
        })
      },
    })
    const replanned = await replanAICtrlHolonTask({
      taskManager: context.taskManager,
      organizationSnapshots,
    }, {
      frozenSuccessorTarget: successorProof,
      taskSpaceId: durableTaskSpaceId,
      previousTaskId: input.previousTaskId,
      successorTaskId: input.successorTaskId,
      successorTaskName: input.successorTaskName,
      cancelCommandId: input.cancelCommandId,
      replanCommandId: input.replanCommandId,
      planId: input.planId,
      replannedAt: input.replannedAt,
      ...(input.activeClaim === undefined ? {} : { activeClaim: input.activeClaim }),
    }, {
      maxTasks: 1_024,
      maxRelations: 4_096,
      maxLeaseDurationMs: 24 * 60 * 60 * 1_000,
    })
    const successorAdmission = await projectFrozenWorkflowHolonTaskAdmission({
      proof: successorProof,
      deployment: successorDeployment,
      scopeRef: descriptor.runId,
    })
    const processorConfig = Object.freeze({
      leaseDurationMs: 30_000,
      maxSteps: this.options.holonPumpMaxSteps ?? 1_024,
    })
    const route = context.support.bind({
      admission: successorAdmission,
      processorConfig,
      deploymentId,
      contextRef: `${descriptor.runId}:${input.nodeId}:${liveProjection.receiptBytesDigest}`,
      recoveryScope: Object.freeze({
        kind: "workflow" as const,
        workflowInstanceId: descriptor.instanceId,
        runId: descriptor.runId,
        nodeId: input.nodeId,
      }),
      snapshotReceiptId: replanned.successorSnapshotReceipt.issuerReceiptId as `sha256:${string}`,
      automaticPump: () => this.holonAutomaticPumpEnabled(),
      resolveMemberIdentity: (subscription, claim) => {
        const deployment = context.deployments.get(frozenTarget.executionBinding.ref)
        return deployment
          ? resolveHolonTaskMemberIdentity({ store: deployment.store }, { subscription, claim })
          : Promise.resolve(undefined)
      },
      prepareProcessorRuntime: async (subscription) => {
        const infrastructure = (
          await this.workflowHolonTaskProcessorRuntime(
            descriptor,
            definition,
            context,
            input.nodeId,
            successorTarget,
            subscription.snapshotReceiptId,
          )
        ).runtime
        return createHolonTaskProcessorRuntime(infrastructure, {
          deploymentId,
          workflowSessionLineage: {
            workflowInstanceId: descriptor.instanceId,
            runId: descriptor.runId,
          },
        })
      },
    })
    registerHolonTaskRuntimeCapabilityBinding(
      this.runtime.vm,
      this.holonTaskRuntimeComposition().scope,
      { admission: successorAdmission, route, processorConfig },
    )
    await context.journal.subscribe({
      admissionId: successorAdmission.admissionId,
      deploymentId,
      bindingRef: successorTarget.executionBinding.ref,
      holonRef: successorTarget.holon.rootHolonRef,
      snapshotReceiptId: replanned.successorSnapshotReceipt.issuerReceiptId,
      taskSpaceId: durableTaskSpaceId,
      taskId: input.successorTaskId,
      origin: {
        kind: "workflow",
        workflowKind: descriptor.form,
        workflowRef: descriptor.workflowRef as `resource://${string}`,
        runId: descriptor.runId,
        nodeId: input.nodeId,
        invocationId: successorTarget.invocation.invocationId,
      },
      recoveryScope: Object.freeze({
        kind: "workflow" as const,
        workflowInstanceId: descriptor.instanceId,
        runId: descriptor.runId,
        nodeId: input.nodeId,
      }),
      processorConfig,
      input: descriptor.frozenInput as import("holarchy-eidolon-adapter").ClosedValue,
      createdAt: input.replannedAt,
    })
    if (this.holonAutomaticPumpEnabled()) {
      await this.continueHolonRun(descriptor.runId, input.replannedAt)
    }
    return replanned
  }

  async resumeDataNode(runId: string, nodeId: string, output: unknown): Promise<any | undefined> {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor || descriptor.form !== "AIDataWorkflow") return undefined
    const result = await (await this.loadDataDriver(descriptor))?.resumeManual(nodeId, output)
    if (result) await this.synchronizeInstanceStatus(runId, result)
    return result && this.attachDescriptor(descriptor, result)
  }

  async applyGraphPatch(runId: string, patch: AIDataWorkflowGraphPatch): Promise<any | undefined> {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor || descriptor.form !== "AIDataWorkflow") return undefined
    const result = await (await this.loadDataDriver(descriptor))?.applyPatch(patch)
    return result && this.attachDescriptor(descriptor, result)
  }

  async autonomousControlCheckpoint(runId: string) {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor || descriptor.form !== "AIDataWorkflow") return undefined
    return (await this.loadDataDriver(descriptor))?.autonomousControlCheckpoint()
  }

  async runAutonomousControl(runId: string, verifier: AIDataAutonomousVerifierPort) {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor) throw new Error(`Workflow run descriptor not found: ${runId}`)
    if (descriptor.form !== "AIDataWorkflow") {
      throw new Error(`AI_DATA_CONTROL_PROFILE_MISMATCH: ${runId}`)
    }
    const driver = await this.loadDataDriver(descriptor)
    if (!driver) throw new Error(`AI_DATA_CONTROL_STATE_MISSING: ${runId}`)
    const result = await driver.runAutonomousControl(verifier)
    const projection = await driver.status()
    if (projection) await this.synchronizeInstanceStatus(runId, projection)
    return result
  }

  async commitAutonomousControlTransition(runId: string, input: Readonly<{
    observation: AIDataControlObservation
    decision: AIDataControlDecision
    admission: AIDataControlAdmission
    verifier: AIDataControlVerifierFact
    budget?: import("ai-data-workflow-contract").AIDataControlBudget
  }>): Promise<any | undefined> {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor || descriptor.form !== "AIDataWorkflow") return undefined
    const result = await (await this.loadDataDriver(descriptor))?.commitAutonomousControlTransition(input)
    if (result) await this.synchronizeInstanceStatus(runId, result)
    return result && this.attachDescriptor(descriptor, result)
  }

  async events(runId: string) {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor) return undefined
    const checkpoint = await this.ensureCanonicalCheckpoint(descriptor)
    return {
      ok: true,
      kind: "workflow.runEvents" as const,
      runtime: descriptor.form === "AICtrlWorkflow"
        ? "depa-flows.AICtrlWorkflow" as const
        : "depa-flows.AIDataWorkflow" as const,
      form: descriptor.form,
      workflow_ref: descriptor.workflowRef,
      instance_id: descriptor.instanceId ?? `legacy-${descriptor.runId}`,
      definition_revision: descriptor.definitionRevision,
      run_id: descriptor.runId,
      generation: descriptor.generation,
      entries: await this.facts.readRunEvents(runId),
      evidence_authority: "derived-read-only" as const,
      checkpoint: checkpoint ? {
        version: checkpoint.version,
        stepExtensions: checkpoint.stepExtensions,
      } : undefined,
      migration: this.legacyMigration.readReceipt({ instanceId: descriptor.instanceId, runId }),
    }
  }

  async result(runId: string, allowPartial = false): Promise<any | undefined> {
    const descriptor = await this.facts.loadDescriptor(runId)
    const checkpoint = descriptor ? await this.ensureCanonicalCheckpoint(descriptor) : undefined
    if (descriptor?.form === "AIDataWorkflow") {
      const result = await (await this.loadDataDriver(descriptor))?.result(allowPartial)
      return result && {
        ...this.attachDescriptor(descriptor, result),
        checkpoint_version: checkpoint?.version,
        step_extensions: checkpoint?.stepExtensions,
      }
    }
    const status = await this.status(runId)
    if (!status) return undefined
    if (!status.terminal && !allowPartial) {
      return {
        ok: false,
        error: "not_terminal",
        run_id: runId,
        status: status.status,
        runtime: "depa-flows.AICtrlWorkflow",
      }
    }
    return { ...status, kind: "workflow.runResult" }
  }

  async replay(input: { runId: string; newRunId?: string; confirmed?: boolean }): Promise<any> {
    const descriptor = await this.facts.loadDescriptor(input.runId)
    if (!descriptor) throw new Error(`Run descriptor not found: ${input.runId}`)
    const checkpoint = await this.ensureCanonicalCheckpoint(descriptor)
    if (!checkpoint) throw new Error(`Canonical checkpoint not found: ${input.runId}`)
    const receipt = await this.facts.loadRunReceipt(input.runId)
    if (!receipt) throw new Error(`Run receipt not found: ${input.runId}`)
    if (input.confirmed !== true) {
      return {
        ok: false,
        status: "confirmation_required",
        operation: "workflow.replay",
        effectDispatched: false,
        preview: {
          replay_of: receipt.runId,
          definition_revision: receipt.definitionRevision,
          input: checkpoint.input,
          material_bindings: receipt.inputMaterials,
          requested_run_id: input.newRunId ?? null,
          source_checkpoint: {
            version: checkpoint.version,
            profile_kind: checkpoint.profile.kind,
            step_extensions: checkpoint.stepExtensions,
          },
        },
      }
    }
    const prior = await this.requireInstance(receipt.instanceId)
    const instanceId = `instance-${randomUUID()}`
    const now = Date.now()
    const replayInstance: WorkflowInstance = {
      ...prior,
      instanceId,
      status: "Prepared",
      input: checkpoint.input,
      bindingIds: [],
      runIds: [],
      idempotencyKey: undefined,
      requestFingerprint: fingerprint({ definitionRevision: receipt.definitionRevision, input: checkpoint.input, replayOf: receipt.runId }),
      createdAt: now,
      updatedAt: now,
    }
    const frozen = await this.facts.loadDefinitionRevision(receipt.definitionRevision)
    if (!frozen) throw new Error(`Frozen definition revision not found: ${receipt.definitionRevision}`)
    this.materializeInstance(instanceId, frozen)
    await this.facts.saveInstance(replayInstance)
    const replayBindingIds: string[] = []
    for (const source of receipt.inputMaterials) {
      const binding: WorkflowMaterialBinding = {
        ...source,
        bindingId: fingerprint({ instanceId, nodeId: source.nodeId, port: source.port, material: source.material }),
        instanceId,
        createdAt: now,
      }
      await this.facts.saveMaterialBinding(binding)
      replayBindingIds.push(binding.bindingId)
    }
    await this.facts.saveInstance({ ...replayInstance, bindingIds: replayBindingIds })
    const replay = await this.start({ instanceId, runId: input.newRunId, confirmed: true, replayOf: receipt.runId })
    return {
      ...replay,
      replay_source_checkpoint: {
        version: checkpoint.version,
        profile_kind: checkpoint.profile.kind,
        step_extensions: checkpoint.stepExtensions,
      },
    }
  }

  async recordMaterialOutput(runId: string, material: WorkflowMaterialRevisionRef): Promise<WorkflowRunReceipt> {
    await this.materials.inspect(material)
    const receipt = await this.facts.loadRunReceipt(runId)
    if (!receipt) throw new Error(`Run receipt not found: ${runId}`)
    const next = {
      ...receipt,
      outputMaterials: receipt.outputMaterials.some((item) => item.materialRef === material.materialRef && item.revision === material.revision)
        ? receipt.outputMaterials
        : [...receipt.outputMaterials, material],
      updatedAt: Date.now(),
    }
    await this.facts.saveRunReceipt(next)
    return next
  }

  private async execute(
    descriptor: WorkflowRunDescriptor,
    definition: ResolvedWorkflowDefinition,
    input: unknown,
  ): Promise<any> {
    if (descriptor.form === "AIDataWorkflow") {
      const driver = await this.createDataDriver(descriptor, definition)
      this.dataDrivers.set(descriptor.runId, driver)
      return this.attachDescriptor(descriptor, await driver.start(input))
    }
    const controller = await this.createController(descriptor, definition)
    this.controllers.set(descriptor.runId, controller)
    const record = await startAICtrlWorkflowRun(controller, descriptor.runId, { input: nestedRecord(input) })
    return this.project("workflow.run", descriptor, record, await controller.store.load(descriptor.runId))
  }

  private async createController(descriptor: WorkflowRunDescriptor, definition: ResolvedWorkflowDefinition): Promise<CtrlController> {
    if (definition.binding.kind !== "AICtrlWorkflow") throw new Error("Expected AICtrlWorkflow binding")
    const component = createWorkflowComponentForRuntime(this.runtime)
    if (!component.authoring) throw new Error("Workflow authoring workspace is not bound")
    const activeRunAuthority = runRef(descriptor, definition)
    const filesystemCode = createFilesystemFlowCodeResolver()
    const declarationOrder: string[] = []
    const visit = (node: any): void => {
      if (typeof node?.id === "string") declarationOrder.push(node.id)
      for (const child of node?.children ?? []) visit(child)
      for (const section of Object.values(node?.sections ?? {})) visit(section)
    }
    for (const statement of definition.binding.definition.statements ?? []) visit(statement)
    this.ctrlNodeOrder.set(descriptor.runId, new Map(declarationOrder.map((nodeId, index) => [nodeId, index])))
    const instance = this.depa.load(descriptor.instanceId)
    const canonicalCheckpointStore = createAICtrlWorkflowCheckpointStore(
      this.depa.checkpointRuntime,
      {
        instanceId: descriptor.instanceId,
        definition: instance.descriptor.definition,
        config: { requestFingerprint: descriptor.requestFingerprint },
        ai: EMPTY_AI_WORKFLOW_DURABLE_STATE,
        initialStepExtensions: this.depa.initialStepExtensions(
          descriptor.instanceId,
          instance.descriptor.definition,
          "AICtrlWorkflow",
        ),
      },
    )
    const checkpointStore: typeof canonicalCheckpointStore = {
      load: (treeId) => canonicalCheckpointStore.load(treeId),
      save: (snapshot) => canonicalCheckpointStore.save(durableCtrlValue(snapshot) as typeof snapshot),
      remove: (treeId) => canonicalCheckpointStore.remove(treeId),
    }
    const frozenRegistry = this.frozenAgentRegistry(descriptor.instanceId)
    const taskProofs = frozenRegistry
      ? await this.frozenAgentTaskProofs(descriptor, definition, frozenRegistry)
      : {}
    const holonContext = frozenRegistry
      ? await this.workflowHolonContext(descriptor, definition, frozenRegistry)
      : undefined
    const agentEffects = new EidolonWorkflowEffectProvider(
      this.runtime,
      new StoreBackedWorkflowMaterialAccess(component.authoring.store),
      this.facts,
      (request, output) => this.captureMaterialOutput(request.run.runId, effectOwnerNodeId(request), output.path),
      () => activeRunAuthority,
      frozenRegistry ? { workflowForm: descriptor.form, resourceRegistry: frozenRegistry } : undefined,
      this.stepExtensionFacade(),
      { instanceId: descriptor.instanceId, workflowForm: descriptor.form },
      this.options.holonEffectFaults,
    )
    const bindAgentNode = definition.resourceReceipt
      ? createAICtrlWorkflowAgentNodeRuntimeBinder({
          flowInstanceId: descriptor.instanceId,
          checkpointRuntime: this.depa.checkpointRuntime,
          effects: agentEffects,
          workflowRef: descriptor.workflowRef as `resource://${string}`,
          taskProofs,
        })
      : undefined
    return createAICtrlWorkflowController({
      binding: definition.binding,
      store: checkpointStore,
      resolveCode: (input) => filesystemCode({
        ...input,
        reference: normalizeFrozenWorkflowCodeReference(input.reference),
      }),
      ...(bindAgentNode || holonContext ? {
        bindNodeRuntime: (nodeRuntime, identity) => {
          let bound = nodeRuntime as typeof nodeRuntime & { readonly ai?: AIWorkflowAuthoredRuntimeContext }
          if (bindAgentNode && taskProofs[identity.nodeId]) bound = bindAgentNode(nodeRuntime, identity)
          const facade = this.stepExtensionFacade()
          const withAi = bound.ai ? Object.freeze({
            ...bound,
            ai: bindWorkflowStepExtensionAuthoredRuntime(bound.ai, facade),
          }) : bound
          return holonContext
            ? Object.freeze({ ...withAi, holonTasks: holonContext })
            : withAi
        },
      } : {}),
      ai: {
        roots: runtimeRoots(this.runtime, component.authoring.store.rootPath),
        stateStore: this.depa.stateProjection(descriptor.instanceId),
        effects: agentEffects,
        metadata: { run: activeRunAuthority, flowInstanceId: descriptor.instanceId },
      },
    })
  }

  private async createDataDriver(descriptor: WorkflowRunDescriptor, definition: ResolvedWorkflowDefinition): Promise<AIDataWorkflowRuntimeDriver> {
    const component = createWorkflowComponentForRuntime(this.runtime)
    const frozenRegistry = this.frozenAgentRegistry(descriptor.instanceId)
    const frozenTaskProofs = frozenRegistry
      ? await this.frozenAgentTaskProofs(descriptor, definition, frozenRegistry)
      : {}
    const frozenTaskProofRefs = frozenRegistry
      ? await this.frozenAgentTaskProofRefs(descriptor, frozenRegistry)
      : {}
    const storedCheckpoint = await loadAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      instanceId: descriptor.instanceId,
      runId: descriptor.runId,
    })
    const storedPreparationReceipts = await this.agentPreparationStore.list(descriptor.instanceId)
    const checkpointPreparationReceipts = storedCheckpoint
      ? readAIDataAgentPreparationReceipts(storedCheckpoint.stepExtensions)
      : undefined
    // Version zero is admitted with the frozen definition's empty extension values.
    // The original start request binds the receipts that must be attached next.
    const resumesPreparationInitialization = storedCheckpoint?.version === 0
      && checkpointPreparationReceipts?.length === 0
      && descriptor.requestFingerprint === fingerprint({
        instanceId: descriptor.instanceId,
        definitionRevision: descriptor.definitionRevision,
        input: descriptor.frozenInput,
        bindings: descriptor.frozenBindings,
        agentPreparations: storedPreparationReceipts,
        replayOf: descriptor.replayOf,
      })
    if (checkpointPreparationReceipts
      && fingerprint(checkpointPreparationReceipts) !== fingerprint(storedPreparationReceipts)
      && !resumesPreparationInitialization) {
      throw new Error("AI_DATA_AGENT_PREPARATION_CHECKPOINT_AUTHORITY_MISMATCH")
    }
    const preparationReceipts = resumesPreparationInitialization
      ? storedPreparationReceipts
      : checkpointPreparationReceipts ?? storedPreparationReceipts
    const preparationService = preparationReceipts.length > 0
      ? await this.liveAgentPreparationService()
      : undefined
    const preparedAgents = preparationService
      ? Object.freeze(await Promise.all(preparationReceipts.map((receipt) => preparationService.recover(receipt))))
      : Object.freeze([])
    const mergedProofs = mergeAIDataPreparedAgentProofs({
      taskProofs: frozenTaskProofs,
      taskProofRefs: frozenTaskProofRefs,
      prepared: preparedAgents,
    })
    const executionRegistry = preparedAgents.length > 0
      ? new EidolonFixedAgentExecutionRegistry(frozenRegistry, this.resourceRegistry, preparedAgents)
      : frozenRegistry
    const holonContext = frozenRegistry
      ? await this.workflowHolonContext(descriptor, definition, frozenRegistry)
      : undefined
    return new AIDataWorkflowRuntimeDriver(
      this.runtime,
      this.workspace,
      this.facts,
      this.depa,
      descriptor,
      definition,
      runtimeRoots(this.runtime, this.workspace.store.rootPath),
      (request, output) => this.captureMaterialOutput(request.run.runId, effectOwnerNodeId(request), output.path),
      executionRegistry,
      mergedProofs.taskProofs,
      mergedProofs.taskProofRefs,
      this.stepExtensionFacade(),
      holonContext,
      preparedAgents,
      this.childInvocationRuntime(),
    )
  }

  private childInvocationRuntime(): AIDataWorkflowChildInvocationRuntimePort {
    const port: AIDataWorkflowChildInvocationRuntimePort = {
      resolveAndFreeze: (request) => this.resolveAndFreezeChildWorkflow(request.identity),
      startOrContinue: (request) => this.startOrContinueChildWorkflow(
        request.identity,
        request.freeze,
        request.input,
      ),
      load: (request) => this.loadChildWorkflow(request.identity, request.freeze),
      settle: (request) => this.settleChildWorkflow(
        request.identity,
        request.freeze,
        request.terminalStatus,
      ),
    }
    return Object.freeze(port)
  }

  private async resolveAndFreezeChildWorkflow(
    identity: AIDataWorkflowChildInvocationIdentity,
  ): Promise<AIDataWorkflowChildFreezeReceipt> {
    const existing = await this.facts.loadChildFreezeReceipt(identity.invocationKey)
    if (existing) return normalizeAIDataWorkflowChildFreezeReceipt(existing, identity)
    const frozen = await this.captureInstanceDefinition(identity.subflow.definitionRef)
    if (frozen.form !== "AIDataWorkflow"
      || `eager-data-flow://${frozen.fqn}` !== identity.subflow.flowRef) {
      throw new Error(`AI_DATA_CHILD_DEFINITION_IDENTITY_MISMATCH: ${identity.invocationKey}`)
    }
    await this.facts.saveDefinitionRevision(frozen)
    const receipt = normalizeAIDataWorkflowChildFreezeReceipt({
      schemaVersion: AI_DATA_CHILD_INVOCATION_SCHEMA_VERSION,
      invocationKey: identity.invocationKey,
      childInstanceId: identity.childInstanceId,
      childRunId: identity.childRunId,
      definitionRef: identity.subflow.definitionRef,
      flowRef: identity.subflow.flowRef,
      contractDigest: identity.subflow.contractDigest,
      definitionRevision: frozen.revision,
      definitionDigest: frozen.revision,
    }, identity)
    await this.facts.saveChildFreezeReceipt(receipt)
    return receipt
  }

  private async startOrContinueChildWorkflow(
    identity: AIDataWorkflowChildInvocationIdentity,
    rawFreeze: AIDataWorkflowChildFreezeReceipt,
    input: FlowClosedObject,
  ): Promise<AIDataWorkflowChildInvocationObservation> {
    const freeze = normalizeAIDataWorkflowChildFreezeReceipt(rawFreeze, identity)
    const instance = await this.ensureChildWorkflowInstance(identity, freeze, input)
    await this.prepareChildWorkflowWorker(identity, freeze, instance, input)
    const projection = await this.start({
      instanceId: identity.childInstanceId,
      runId: identity.childRunId,
      confirmed: true,
    })
    return this.childWorkflowObservation(identity, projection)
  }

  private async prepareChildWorkflowWorker(
    identity: AIDataWorkflowChildInvocationIdentity,
    freeze: AIDataWorkflowChildFreezeReceipt,
    instance: WorkflowInstance,
    input: FlowClosedObject,
  ): Promise<void> {
    const materialized = this.depa.load(instance.instanceId)
    const declaration = readAIDataChildAgentPreparationDeclaration(this.depa.initialStepExtensions(
      instance.instanceId, materialized.descriptor.definition, "AIDataWorkflow",
    ))
    if (!declaration) return
    const sourceNodeId = input[declaration.sourceNodeInput]
    if (typeof sourceNodeId !== "string" || !sourceNodeId || sourceNodeId.trim() !== sourceNodeId) {
      throw new Error("AI_DATA_CHILD_PREPARATION_SOURCE_NODE_REQUIRED")
    }
    const receipts = await this.agentPreparationStore.list(instance.instanceId)
    const existing = receipts.find(receipt => receipt.task.nodeId === declaration.nodeId)
    if (existing) {
      const intent = await this.agentPreparationStore.loadIntent(instance.instanceId, declaration.nodeId)
      const { implementation: _implementation, nodeType: _nodeType, ...capability } = existing.capability
      if (existing.task.workflowRef !== identity.subflow.definitionRef
        || existing.instanceName !== declaration.instanceName
        || existing.requirementDigest !== normalizeAIAgentTaskRequirement(declaration.requirement).requirementDigest
        || fingerprint(capability) !== fingerprint({ ...declaration.capability,
          fixedConfig: { ...declaration.capability.fixedConfig, instanceName: declaration.instanceName } })
        || !intent || fingerprint(intent.identity.childInvocation) !== fingerprint(identity)
        || existing.preparation?.intentDigest !== intent.intentDigest
        || fingerprint(intent.identity.childFreeze) !== fingerprint(freeze)
        || nestedRecord(intent.identity.feedback).nodeId !== sourceNodeId) throw new Error("AI_DATA_CHILD_PREPARATION_RECEIPT_MISMATCH")
      await this.agentPreparationStore.assertReceiptBinding(existing)
      await (await this.liveAgentPreparationService()).recover(existing)
      return
    }
    if (instance.status !== "Prepared") throw new Error("AI_DATA_CHILD_PREPARATION_RECEIPT_MISSING")
    const parentDescriptor = await this.facts.loadDescriptor(identity.parentRunId)
    if (!parentDescriptor || parentDescriptor.instanceId !== identity.parentInstanceId) throw new Error("AI_DATA_CHILD_PREPARATION_PARENT_MISMATCH")
    const parent = await this.loadDataDriver(parentDescriptor)
    if (!parent) throw new Error("AI_DATA_CHILD_PREPARATION_PARENT_MISSING")
    const source = await parent.childPreparationFeedback(sourceNodeId)
    const { checkpointVersion: _version, ...feedback } = source.evidence
    const preparationIdentity = normalizeFlowClosedObject({ childInvocation: identity, childFreeze: freeze, feedback }, "childPreparation.identity")
    const service = await this.liveAgentPreparationService()
    const observation = await service.observeDurably({ store: this.agentPreparationStore,
      instanceId: instance.instanceId, nodeId: declaration.nodeId, requirement: declaration.requirement, identity: preparationIdentity })
    const priorDecision = await this.agentPreparationStore.loadDecision(instance.instanceId, declaration.nodeId)
    const value = priorDecision ?? await parent.selectChildWorker({
      invocationKey: `${identity.invocationKey}/prepare/${declaration.nodeId}`,
      payload: normalizeFlowClosedObject({ schemaVersion: "eidolon.ai-data-child-worker-selection/v1", observation,
        authoring: await service.describeObservation(observation),
        feedback, target: { instanceId: instance.instanceId, workflowRef: identity.subflow.definitionRef,
          nodeId: declaration.nodeId, instanceName: declaration.instanceName }, input }, "childPreparation.selection"),
    })
    const decision = (typeof value === "string" ? JSON.parse(value) : value) as AIAgentDefinitionSelectionDecision
    if (decision?.mode === "revise-existing" && (!decision.feedback || decision.feedback.observationRef !== feedback.observationRef
      || decision.feedback.attemptRef !== feedback.attemptRef || decision.feedback.verificationRef !== feedback.verificationRef)) {
      throw new Error("AI_DATA_CHILD_PREPARATION_FEEDBACK_REF_MISMATCH")
    }
    const prepared = await service.prepareDurably({ store: this.agentPreparationStore, identity: preparationIdentity,
      instanceId: instance.instanceId, observation, decision, previousExecution: source.proof,
      workflowRef: identity.subflow.definitionRef, nodeId: declaration.nodeId,
      instanceName: declaration.instanceName, capability: declaration.capability })
    if (!("receipt" in prepared)) throw new Error(`AI_DATA_CHILD_PREPARATION_REJECTED: ${prepared.code}`)
  }

  private async loadChildWorkflow(
    identity: AIDataWorkflowChildInvocationIdentity,
    rawFreeze: AIDataWorkflowChildFreezeReceipt,
  ): Promise<AIDataWorkflowChildInvocationObservation> {
    const freeze = normalizeAIDataWorkflowChildFreezeReceipt(rawFreeze, identity)
    const instance = await this.facts.loadInstance(identity.childInstanceId)
    if (!instance) return this.childWorkflowObservation(identity, undefined)
    if (instance.definitionRevision !== freeze.definitionRevision
      || instance.workflowRef !== identity.subflow.definitionRef) {
      throw new Error(`AI_DATA_CHILD_INSTANCE_FREEZE_MISMATCH: ${identity.invocationKey}`)
    }
    return this.childWorkflowObservation(identity, await this.status(identity.childRunId))
  }

  private async settleChildWorkflow(
    identity: AIDataWorkflowChildInvocationIdentity,
    rawFreeze: AIDataWorkflowChildFreezeReceipt,
    terminalStatus: "Succeeded" | "Failed",
  ): Promise<AIDataWorkflowChildTerminalReceipt> {
    const freeze = normalizeAIDataWorkflowChildFreezeReceipt(rawFreeze, identity)
    const projection = await this.result(identity.childRunId, true)
    const observed = this.childWorkflowObservation(identity, projection)
    if (observed.status !== terminalStatus) {
      throw new Error(`AI_DATA_CHILD_TERMINAL_STATUS_MISMATCH: ${identity.invocationKey}`)
    }
    const common = {
      schemaVersion: AI_DATA_CHILD_INVOCATION_SCHEMA_VERSION,
      invocationKey: identity.invocationKey,
      childInstanceId: identity.childInstanceId,
      childRunId: identity.childRunId,
      definitionRef: identity.subflow.definitionRef,
      flowRef: identity.subflow.flowRef,
      contractDigest: identity.subflow.contractDigest,
    } as const
    if (terminalStatus === "Succeeded") {
      const output = nestedRecord(projection?.output) as FlowClosedObject
      const body = { ...common, status: terminalStatus, output } as const
      return Object.freeze({ ...body, receiptDigest: fingerprint(body) })
    }
    const body = {
      ...common,
      status: terminalStatus,
      failureCode: "CHILD_WORKFLOW_FAILED",
      failureMessage: `Child workflow ${identity.childRunId} failed`,
    } as const
    return Object.freeze({ ...body, receiptDigest: fingerprint(body) })
  }

  private async ensureChildWorkflowInstance(
    identity: AIDataWorkflowChildInvocationIdentity,
    freeze: AIDataWorkflowChildFreezeReceipt,
    input: FlowClosedObject,
  ): Promise<WorkflowInstance> {
    const frozen = await this.facts.loadDefinitionRevision(freeze.definitionRevision)
    if (!frozen || frozen.workflowRef !== identity.subflow.definitionRef
      || `eager-data-flow://${frozen.fqn}` !== identity.subflow.flowRef
      || frozen.revision !== freeze.definitionDigest) {
      throw new Error(`AI_DATA_CHILD_FROZEN_DEFINITION_MISSING: ${identity.invocationKey}`)
    }
    const requestFingerprint = fingerprint({
      workflowRef: frozen.workflowRef,
      definitionRevision: frozen.revision,
      input,
    })
    const existing = await this.facts.loadInstance(identity.childInstanceId)
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint
        || existing.definitionRevision !== frozen.revision) {
        throw new Error(`AI_DATA_CHILD_INSTANCE_CONFLICT: ${identity.invocationKey}`)
      }
      this.materializeInstance(existing.instanceId, frozen)
      return existing
    }
    const now = Date.now()
    const instance: WorkflowInstance = {
      instanceId: identity.childInstanceId,
      workflowRef: frozen.workflowRef,
      definitionRevision: frozen.revision,
      form: frozen.form,
      status: "Prepared",
      input,
      bindingIds: [],
      runIds: [],
      idempotencyKey: identity.invocationKey,
      requestFingerprint,
      createdAt: now,
      updatedAt: now,
    }
    this.materializeInstance(instance.instanceId, frozen)
    await this.facts.saveInstance(instance)
    return instance
  }

  private childWorkflowObservation(
    identity: AIDataWorkflowChildInvocationIdentity,
    projection: any | undefined,
  ): AIDataWorkflowChildInvocationObservation {
    const status = !projection
      ? "Reserved" as const
      : projection.terminal
        ? projection.status === "Failed" ? "Failed" as const : "Succeeded" as const
        : "Running" as const
    return Object.freeze({
      schemaVersion: AI_DATA_CHILD_INVOCATION_SCHEMA_VERSION,
      invocationKey: identity.invocationKey,
      childInstanceId: identity.childInstanceId,
      childRunId: identity.childRunId,
      status,
    })
  }

  private async workflowHolonContext(
    descriptor: WorkflowRunDescriptor,
    definition: ResolvedWorkflowDefinition,
    registry: EidolonAppResourceRegistryAdapter,
  ): Promise<WorkflowHolonTaskContext | undefined> {
    const cached = this.holonContexts.get(descriptor.runId)
    if (cached) return cached
    const targets = discoverHolonTaskTargets(descriptor, definition)
    const entries = Object.entries(targets)
    if (entries.length === 0) return undefined
    const composition = this.holonTaskRuntimeComposition()
    const instanceRoot = composition.scope.supportRoot
    const deployments = new Map<string, WorkflowHolonDeployment>()
    for (const target of Object.values(targets)) {
      if (deployments.has(target.executionBinding.ref)) continue
      const deploymentId = workflowHolonDeploymentId(
        target.executionBinding.ref,
        target.holon.effectiveAt,
      )
      const materialized = await materializeHolonDeploymentDefinition({
        supportRoot: instanceRoot,
        resourceRegistry: registry,
      }, {
        deploymentId,
        bindingRef: target.executionBinding.ref,
      }, {})
      const store = new FileHolonDeploymentRuntimeStore({ supportRoot: instanceRoot })
      await store.open(deploymentId)
      deployments.set(target.executionBinding.ref, Object.freeze({
        deploymentId,
        definition: materialized,
        store,
      }))
    }
    const proofs: Record<string, FrozenHolonTaskTarget> = Object.create(null)
    for (const [nodeId, target] of entries) {
      proofs[nodeId] = await registry.freezeWorkflowHolonTaskTarget(target)
    }
    const taskManager = composition.support.taskManager
    const journal = composition.support.journal
    const taskSpaceId = async (authoredTaskSpaceId: string): Promise<string> => {
      const scoped = workflowHolonTaskSpaceId(descriptor.runId, authoredTaskSpaceId)
      const retained = (await journal.listSubscriptions(descriptor.runId)).find(
        (subscription) => subscription.taskSpaceId === authoredTaskSpaceId
          || subscription.taskSpaceId === scoped,
      )
      return retained?.taskSpaceId ?? scoped
    }
    const organizationSnapshots = Object.freeze({
      readEffectiveSnapshot: async (input: Readonly<{ rootHolonRef: string; effectiveAt: string }>) => {
        const matches: MaterializedHolonDeploymentDefinition[] = []
        for (const deployment of deployments.values()) {
          const loaded = await deployment.store.loadDefinition(deployment.deploymentId)
          if (loaded.bindingProjection.snapshot.rootHolonRef === input.rootHolonRef
            && loaded.bindingProjection.snapshot.effectiveAt === input.effectiveAt) matches.push(loaded)
        }
        if (matches.length !== 1) {
          throw new Error("EIDOLON_HOLON_SNAPSHOT_AUTHORITY_AMBIGUOUS: frozen target must resolve one deployment snapshot")
        }
        const selected = matches[0]!
        return Object.freeze({
          snapshotBytes: await canonicalHolonEffectiveSnapshotBytes(selected.bindingProjection.snapshot),
          issuanceReceiptBytes: canonicalHolonEffectiveSnapshotIssuanceReceiptBytes(
            selected.bindingProjection.receipt,
            selected.bindingProjection.snapshot,
          ),
        })
      },
    })
    const holonRuntime = Object.freeze({ taskManager, organizationSnapshots })
    const admissions: Record<string, Awaited<ReturnType<typeof projectFrozenWorkflowHolonTaskAdmission>>> = Object.create(null)
    let context!: WorkflowHolonTaskContext
    for (const [nodeId, proof] of Object.entries(proofs)) {
      const target = targets[nodeId]!
      const deployment = deployments.get(target.executionBinding.ref)
      if (!deployment) throw new Error("EIDOLON_HOLON_DEPLOYMENT_REQUIRED")
      const admission = await projectFrozenWorkflowHolonTaskAdmission({
        proof,
        deployment: deployment.definition,
        scopeRef: descriptor.runId,
      })
      admissions[nodeId] = admission
      const route = composition.support.bind({
        admission,
        processorConfig: {
          leaseDurationMs: 30_000,
          maxSteps: this.options.holonPumpMaxSteps ?? 1_024,
        },
        deploymentId: deployment.deploymentId,
        contextRef: `${descriptor.runId}:${nodeId}`,
        recoveryScope: Object.freeze({
          kind: "workflow" as const,
          workflowInstanceId: descriptor.instanceId,
          runId: descriptor.runId,
          nodeId,
        }),
        snapshotReceiptId: deployment.definition.definition.snapshotReceiptDigest,
        automaticPump: () => this.holonAutomaticPumpEnabled(),
        resolveMemberIdentity: (subscription, claim) => resolveHolonTaskMemberIdentity({ store: deployment.store }, { subscription, claim }),
        openTask: async (input) => {
          const opened = await openAICtrlHolonTask({
            taskManager,
            organizationSnapshots,
          }, {
            frozenTarget: proof,
            commandId: input.commandId,
            taskSpaceId: input.taskSpaceId,
            taskId: input.taskId,
            taskName: input.taskName,
            createdAt: input.invocation.occurredAt,
          }, {
            maxTasks: 1_024,
            maxRelations: 4_096,
            maxLeaseDurationMs: 24 * 60 * 60 * 1_000,
          })
          return Object.freeze({
            replayed: opened.replayed,
            snapshotReceipt: Object.freeze({
              ...opened.snapshotReceipt,
              schemaVersion: "eidolon.holon-task-snapshot-receipt/v1" as const,
            }),
          })
        },
        prepareProcessorRuntime: async (subscription) => {
          const infrastructure = (
            await this.workflowHolonTaskProcessorRuntime(
            descriptor,
            definition,
            context,
            nodeId,
            target,
            subscription.snapshotReceiptId,
            )
          ).runtime
          return createHolonTaskProcessorRuntime(infrastructure, {
            deploymentId: deployment.deploymentId,
            workflowSessionLineage: {
              workflowInstanceId: descriptor.instanceId,
              runId: descriptor.runId,
            },
          })
        },
      })
      const registered = registerHolonTaskRuntimeCapabilityBinding(
        this.runtime.vm,
        composition.scope,
        {
          admission,
          route,
          processorConfig: {
            leaseDurationMs: 30_000,
            maxSteps: this.options.holonPumpMaxSteps ?? 1_024,
          },
        },
      )
      if (registered.serviceRuntimeRef !== composition.capability.serviceRuntimeRef) {
        throw new Error("EIDOLON_HOLON_TASK_WORKFLOW_SERVICE_OWNER_MISMATCH")
      }
    }
    context = Object.freeze({
      proofs: Object.freeze(proofs),
      targets,
      taskManager,
      journal,
      support: composition.support,
      deployments,
      organizationSnapshots,
      taskSpaceId,
      proofForNode: (nodeId: string) => {
        const proof = proofs[nodeId]
        if (!proof) throw new Error(`EIDOLON_HOLON_TARGET_PROOF_REQUIRED: ${nodeId}`)
        return proof
      },
      openTask: async (input, _config) => {
        const entry = Object.entries(proofs).find(([, proof]) => (
          fingerprint(proof) === fingerprint(input.frozenTarget)
        ))
        const nodeId = entry?.[0]
        const target = nodeId ? targets[nodeId] : undefined
        const admission = nodeId ? admissions[nodeId] : undefined
        if (!nodeId || !target || !admission) {
          throw new Error("EIDOLON_HOLON_TASK_WORKFLOW_ADMISSION_UNRESOLVED")
        }
        const durableTaskSpaceId = await taskSpaceId(input.taskSpaceId)
        const accepted = await assignHolonTaskThroughMountedCapability(
          this.runtime.vm,
          { kind: "admission", admissionId: admission.admissionId },
          {
            kind: "holon-task-runtime-invocation",
            schemaVersion: "eidolon.holon-task-runtime-invocation/v1",
            requestId: `${descriptor.runId}:${nodeId}:${input.commandId}`,
            idempotencyKey: `${descriptor.runId}:${nodeId}:${input.commandId}`,
            replyMode: "none",
            occurredAt: input.createdAt,
            origin: {
              kind: "workflow",
              workflowKind: target.invocation.workflowKind,
              workflowRef: target.invocation.workflowRef,
              runId: descriptor.runId,
              nodeId,
              invocationId: target.invocation.invocationId,
            },
            taskRequest: {
              kind: "exact",
              identity: {
                taskSpaceId: durableTaskSpaceId,
                taskId: input.taskId,
                commandId: input.commandId,
              },
              name: input.taskName,
            },
            input: descriptor.frozenInput as import("holarchy-eidolon-adapter").ClosedValue,
          },
        )
        const snapshot = await taskManager.owner.readSnapshot(accepted.task.taskSpaceId)
        const receipt = await taskManager.owner.readReceiptByCommand(
          accepted.task.taskSpaceId,
          accepted.task.commandId,
        )
        if (!snapshot || !receipt || receipt.kind !== "task-transition-receipt") {
          throw new Error("EIDOLON_HOLON_TASK_WORKFLOW_OPEN_PROJECTION_MISSING")
        }
        return Object.freeze({
          snapshot,
          receipt,
          snapshotReceipt: Object.freeze({
            ...accepted.task.snapshotReceipt,
            schemaVersion: "ai-workflow.holon-task-snapshot-receipt/v1" as const,
          }),
          created: !accepted.task.replayed,
          replayed: accepted.task.replayed,
        })
      },
      observeTask: async (input, config) => {
        const durableInput = Object.freeze({
          ...input,
          taskSpaceId: await taskSpaceId(input.taskSpaceId),
        })
        const observed = await observeAICtrlHolonTask(holonRuntime, durableInput, config)
        if (observed.kind !== "waiting") return observed
        const terminal = await terminalTaskSettlement(
          taskManager.owner,
          durableInput.taskSpaceId,
          durableInput.taskId,
        )
        return terminal
          ? Object.freeze({ kind: "settled" as const, ...terminal })
          : observed
      },
      replanTask: async (input, config) => replanAICtrlHolonTask(holonRuntime, {
        ...input,
        taskSpaceId: await taskSpaceId(input.taskSpaceId),
      }, config),
      consumeTask: async (input, config) => {
        const durableInput = Object.freeze({
          ...input,
          taskSpaceId: await taskSpaceId(input.taskSpaceId),
        })
        const authority = await this.workflowHolonConsumptionAuthority(
          descriptor,
          context,
          durableInput,
        )
        const consumptionRuntime = {
          taskManager,
          materials: {
            validateSettlementMaterial: (materialInput: AIDataHolonTaskMaterialValidationInput) => (
              validateHolonSettlementMaterial(authority.registry, materialInput)
            ),
          },
        }
        try {
          return await consumeAIDataHolonTask(consumptionRuntime, {
            ...durableInput,
            frozenTarget: authority.proof,
            taskId: authority.taskId,
            settlementCommandId: authority.settlementCommandId,
          }, config)
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("SETTLEMENT_RECEIPT_MISMATCH")) throw error
          const terminal = await terminalTaskSettlement(taskManager.owner, input.taskSpaceId, authority.taskId)
          if (!terminal) throw error
          return consumeAIDataHolonTask(consumptionRuntime, {
            ...durableInput,
            frozenTarget: authority.proof,
            taskId: authority.taskId,
            settlementCommandId: terminal.receipt.commandId,
          }, config)
        }
      },
    })
    this.holonContexts.set(descriptor.runId, context)
    return context
  }

  private holonTaskRuntimeComposition() {
    const runtimeMetadata = metadata(this.runtime)
    const outer = this.runtime.vm.outerCtx as { workDir?: unknown } | undefined
    const workspaceRoot = typeof outer?.workDir === "string" && path.isAbsolute(outer.workDir)
      ? outer.workDir
      : this.workspace.store.rootPath
    const sessionDir = typeof runtimeMetadata.sessionDir === "string"
      && path.isAbsolute(runtimeMetadata.sessionDir)
      ? runtimeMetadata.sessionDir
      : path.dirname(this.supportRoot)
    const scope = Object.freeze({
      supportRoot: path.join(sessionDir, "holon-task-runtime"),
      registryRef: `resource://eidolon.effective-resource-registry/${createHash("sha256")
        .update(workspaceRoot)
        .digest("hex")}` as const,
    })
    const capability = requireHolonTaskRuntimeCapability(this.runtime.vm)
    if (capability.scope.supportRoot !== scope.supportRoot || capability.scope.registryRef !== scope.registryRef) {
      throw new Error("EIDOLON_HOLON_TASK_CAPABILITY_SCOPE_CONFLICT")
    }
    const support = mountLocalHolonTaskRuntimeSupport({
      vm: this.runtime.vm,
      supportRoot: scope.supportRoot,
      options: {
        journalFaults: this.options.holonJournalFaults,
        waitingProbeMs: this.options.holonPumpWaitingProbeMs,
      },
    })
    return Object.freeze({ scope, capability, support })
  }

  private async workflowHolonDeploymentForTask(
    descriptor: WorkflowRunDescriptor,
    context: WorkflowHolonTaskContext,
    target: HolonTaskTarget,
    issuerReceiptId: string,
  ): Promise<WorkflowHolonDeployment> {
    const initial = context.deployments.get(target.executionBinding.ref)
    if (initial?.definition.definition.snapshotReceiptDigest === issuerReceiptId) return initial
    const instanceRoot = this.holonTaskRuntimeComposition().scope.supportRoot
    const deploymentId = workflowHolonDeploymentId(
      target.executionBinding.ref,
      issuerReceiptId,
    )
    const definition = await loadHolonDeploymentDefinition({ supportRoot: instanceRoot }, { deploymentId }, {})
    if (definition.definition.bindingRef !== target.executionBinding.ref
      || definition.definition.rootHolonRef !== target.holon.rootHolonRef
      || definition.bindingProjection.snapshot.effectiveAt !== target.holon.effectiveAt
      || definition.definition.snapshotReceiptDigest !== issuerReceiptId) {
      throw new Error("EIDOLON_HOLON_ADOPTED_DEPLOYMENT_MISMATCH")
    }
    const store = new FileHolonDeploymentRuntimeStore({ supportRoot: instanceRoot })
    await store.open(deploymentId)
    return Object.freeze({ deploymentId, definition, store })
  }

  private async workflowHolonConsumptionAuthority(
    descriptor: WorkflowRunDescriptor,
    context: WorkflowHolonTaskContext,
    input: Parameters<typeof consumeAIDataHolonTask>[1],
  ): Promise<Readonly<{
    proof: FrozenHolonTaskTarget
    registry: EidolonAppResourceRegistryAdapter
    taskId: string
    settlementCommandId: string
  }>> {
    const expected = input.frozenTarget.target
    const initialDeployment = context.deployments.get(expected.executionBinding.ref)
    if (!initialDeployment) {
      throw new Error("EIDOLON_HOLON_CONSUMPTION_DEPLOYMENT_MISSING")
    }
    const snapshot = await context.taskManager.owner.readSnapshot(input.taskSpaceId)
    const requestedTask = snapshot?.tasks.find((candidate) => candidate.taskId === input.taskId)
    if (!snapshot || !requestedTask || requestedTask.profile.profileKind !== "depa.ai.organization-task") {
      throw new Error(`EIDOLON_HOLON_CONSUMPTION_TASK_MISSING: ${input.taskSpaceId}/${input.taskId}`)
    }
    let task = requestedTask
    let expectedChainRoot: string | undefined
    if (task.status !== "Succeeded") {
      const successors = snapshot.tasks.filter((candidate) => {
        if (candidate.status !== "Succeeded" || candidate.profile.profileKind !== "depa.ai.organization-task") return false
        const adoptions = Array.isArray(candidate.profile.facts.snapshotAdoptions)
          ? candidate.profile.facts.snapshotAdoptions
          : []
        if (adoptions.length === 0) return false
        return normalizeHolonTaskSnapshotAdoptionReceipt(adoptions[0]).previousTaskId === input.taskId
      })
      if (successors.length !== 1) {
        throw new Error("EIDOLON_HOLON_CONSUMPTION_SUCCESSOR_AMBIGUOUS")
      }
      task = successors[0]!
      expectedChainRoot = input.taskId
    }
    const settlement = await terminalTaskSettlement(context.taskManager.owner, input.taskSpaceId, task.taskId)
    if (!settlement || settlement.receipt.status !== "Succeeded") {
      throw new Error(`EIDOLON_HOLON_CONSUMPTION_SETTLEMENT_MISSING: ${input.taskSpaceId}/${task.taskId}`)
    }
    const actual = normalizeHolonTaskTarget(task.profile.facts.target)
    if (fingerprint(actual) === fingerprint(expected)) {
      return Object.freeze({
        proof: input.frozenTarget,
        registry: initialDeployment.definition.resourceRegistry,
        taskId: task.taskId,
        settlementCommandId: settlement.receipt.commandId,
      })
    }
    if (!sameHolonTargetExecutableIdentity(expected, actual)) {
      throw new Error("EIDOLON_HOLON_CONSUMPTION_SUCCESSOR_INSTANCE_REQUIRED")
    }

    const receipt = normalizeHolonTaskSnapshotReceipt(task.profile.facts.snapshotReceipt)
    const rawAdoptions = Array.isArray(task.profile.facts.snapshotAdoptions)
      ? task.profile.facts.snapshotAdoptions
      : []
    let issuerReceiptId = initialDeployment.definition.definition.snapshotReceiptDigest
    let successorTaskId: string | undefined
    for (const value of rawAdoptions) {
      const adoption = normalizeHolonTaskSnapshotAdoptionReceipt(value)
      if (adoption.taskSpaceId !== input.taskSpaceId
        || adoption.previousIssuerReceiptId !== issuerReceiptId
        || (successorTaskId === undefined && expectedChainRoot !== undefined
          && adoption.previousTaskId !== expectedChainRoot)
        || (successorTaskId !== undefined && adoption.previousTaskId !== successorTaskId)
        || adoption.executionBindingDigest !== expected.executionBinding.digest) {
        throw new Error("EIDOLON_HOLON_CONSUMPTION_ADOPTION_CHAIN_INVALID")
      }
      issuerReceiptId = adoption.successorIssuerReceiptId
      successorTaskId = adoption.successorTaskId
    }
    if (rawAdoptions.length === 0
      || issuerReceiptId !== receipt.issuerReceiptId
      || successorTaskId !== task.taskId) {
      throw new Error("EIDOLON_HOLON_CONSUMPTION_ADOPTION_CHAIN_INCOMPLETE")
    }

    const deployment = await this.workflowHolonDeploymentForTask(
      descriptor,
      context,
      actual,
      receipt.issuerReceiptId,
    )
    const proof = await deployment.definition.resourceRegistry.freezeWorkflowHolonTaskTarget(actual)
    if (fingerprint(proof.target) !== fingerprint(actual)) {
      throw new Error("EIDOLON_HOLON_CONSUMPTION_ADOPTED_PROOF_MISMATCH")
    }
    return Object.freeze({
      proof,
      registry: deployment.definition.resourceRegistry,
      taskId: task.taskId,
      settlementCommandId: settlement.receipt.commandId,
    })
  }

  private async workflowHolonTaskProcessorRuntime(
    descriptor: WorkflowRunDescriptor,
    definition: ResolvedWorkflowDefinition,
    context: WorkflowHolonTaskContext,
    nodeId: string,
    target: HolonTaskTarget,
    snapshotReceiptId: string,
  ): Promise<Readonly<{
    deployment: WorkflowHolonDeployment
    runtime: HolonWorkflowTaskProcessorRuntime
  }>> {
    const deployment = await this.workflowHolonDeploymentForTask(
      descriptor,
      context,
      target,
      snapshotReceiptId,
    )
    const binding = deployment.definition.bindingProjection.binding
    if (binding.adapter.kind !== "ai-agent") {
      throw new Error(`EIDOLON_HOLON_PRODUCT_ADAPTER_UNSUPPORTED: ${binding.adapter.kind}`)
    }
    const agentAdapter = binding.adapter
    const executionRegistry = deployment.definition.resourceRegistry
    const taskProof = await executionRegistry.freezeWorkflowAgentTaskBinding({
      workflowKind: descriptor.form,
      workflowRef: descriptor.workflowRef as `resource://${string}`,
      nodeId,
      agentDefinitionRef: agentAdapter.agentDefinitionRef,
    })
    const taskBinding = assertFrozenAIAgentTaskBinding(taskProof).task
    const activeRun = runRef(descriptor, definition)
    const component = createWorkflowComponentForRuntime(this.runtime)
    if (!component.authoring) throw new Error("EIDOLON_HOLON_AUTHORING_STORE_REQUIRED")
    const effects = new EidolonWorkflowEffectProvider(
      this.runtime,
      new StoreBackedWorkflowMaterialAccess(component.authoring.store),
      this.facts,
      (request, output) => this.captureMaterialOutput(request.run.runId, effectOwnerNodeId(request), output.path),
      () => activeRun,
      { workflowForm: descriptor.form, resourceRegistry: executionRegistry },
      this.stepExtensionFacade(),
      { instanceId: descriptor.instanceId, workflowForm: descriptor.form },
      this.options.holonEffectFaults,
    )
    const genericOwner = this.workflowHolonGenericOwner(descriptor, agentAdapter.agentDefinitionRef)
    const adapters: HolonExecutionAdapterPorts = {
      aiAgent: {
        executeIdempotent: async ({ idempotencyKey, invocation, runtimeRef, taskAttempt }) => {
          const checkpointKey = { instanceId: descriptor.instanceId, runId: descriptor.runId }
          const checkpoint = await this.depa.checkpointRuntime.checkpointStore.load(checkpointKey) as any
          if (!checkpoint) throw new Error("Holon Agent execution requires the canonical Flow checkpoint")
          const logicalTaskDigest = createHash("sha256").update(idempotencyKey).digest("hex")
          const instanceName = `holon-task-${logicalTaskDigest.slice(0, 32)}`
          const processorRuntime = {
            checkpointRuntime: this.depa.checkpointRuntime,
            checkpointKey,
            workflowKind: descriptor.form,
            workflowRef: descriptor.workflowRef as `resource://${string}`,
            nodeId,
            invocationKey: idempotencyKey,
            generation: descriptor.generation,
            effects,
            taskBinding,
            metadata: {
              deploymentId: deployment.deploymentId,
              memberRuntimeRef: runtimeRef,
              taskSpaceId: taskAttempt.taskSpaceId,
              taskId: taskAttempt.taskId,
              sessionRef: idempotencyKey,
              holonInvocationRef: invocation.invocationRef,
            },
          }
          const config = {
            agentDefinitionRef: agentAdapter.agentDefinitionRef,
            materialRefs: invocation.materialRefs,
          }
          const result = await runAgent(processorRuntime, invocation.input, { ...config, instanceName })
          return result.output as import("holarchy-eidolon-adapter").ClosedValue
        },
      },
      humanEndpoint: { executeIdempotent: () => { throw new Error("EIDOLON_HOLON_HUMAN_ENDPOINT_NOT_BOUND") } },
      service: { executeIdempotent: () => { throw new Error("EIDOLON_HOLON_SERVICE_ADAPTER_NOT_BOUND") } },
      hybrid: { executeIdempotent: () => { throw new Error("EIDOLON_HOLON_HYBRID_ADAPTER_NOT_BOUND") } },
    }
    const actorRuntime = new EidolonHolonLocalActorRuntime(
      deployment.store,
      genericOwner,
      adapters,
      `workflow-${descriptor.runId}`,
    )
    await actorRuntime.recover(deployment.deploymentId)
    return Object.freeze({
      deployment,
      runtime: Object.freeze({
        store: deployment.store,
        taskManager: context.taskManager,
        actorRuntime,
        journal: context.journal,
      }),
    })
  }

  private async workflowHolonSubscriptionSettlement(
    context: WorkflowHolonTaskContext,
    subscription: HolonTaskPumpSubscription,
  ): Promise<TaskSettlementReceipt | undefined> {
    const terminal = await terminalTaskSettlement(
      context.taskManager.owner,
      subscription.taskSpaceId,
      subscription.taskId,
    )
    if (!terminal) return undefined
    const receipt = normalizeHolonTaskSnapshotReceipt(terminal.task.profile.facts.snapshotReceipt)
    return receipt.issuerReceiptId === subscription.snapshotReceiptId
      ? terminal.receipt
      : undefined
  }

  private workflowHolonGenericOwner(
    descriptor: WorkflowRunDescriptor,
    agentDefinitionRef: `resource://${string}`,
  ): HolonGenericActorOwnerPort {
    const stableRef = (kind: string, value: unknown): string => (
      `${kind}-${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex").slice(0, 32)}`
    )
    return Object.freeze({
      ensureActor: ({ address }: Parameters<HolonGenericActorOwnerPort["ensureActor"]>[0]) => (
        Object.freeze({ actorRef: stableRef("actor", address) })
      ),
      ensureTaskAttemptSession: (
        input: Parameters<HolonGenericActorOwnerPort["ensureTaskAttemptSession"]>[0],
      ) => Object.freeze({
        sessionRef: stableRef("session", {
          deploymentId: input.deploymentId,
          runtimeRef: input.runtimeRef,
          scopeRef: input.scopeRef,
          taskAttempt: input.taskAttempt,
        }),
      }),
      resolveTargetedAgentSession: async ({ selector }: Parameters<HolonGenericActorOwnerPort["resolveTargetedAgentSession"]>[0]) => {
        const checkpoint = await this.depa.checkpointRuntime.checkpointStore.load({
          instanceId: descriptor.instanceId,
          runId: descriptor.runId,
        }) as any
        const ai = checkpoint?.profile?.ai
        const instanceId = "byId" in selector
          ? selector.byId
          : ai?.instanceIdByName?.[selector.byName]
        const instance = typeof instanceId === "string" ? ai?.instancesById?.[instanceId] : undefined
        if (!instance || instance.agentDefinitionRef !== agentDefinitionRef) {
          throw new Error("EIDOLON_HOLON_TARGETED_AGENT_SESSION_UNRESOLVED")
        }
        return Object.freeze({
          sessionRef: typeof instance.sessionId === "string" ? instance.sessionId : instance.instanceId,
          agentDefinitionRef,
        })
      },
    })
  }

  private holonAutomaticPumpEnabled(): boolean {
    const workflow = nestedRecord(metadata(this.runtime).aiWorkflow)
    return workflow.holonAutomaticPump !== false
  }

  private frozenAgentRegistry(instanceId: string): EidolonAppResourceRegistryAdapter | undefined {
    const definitionDir = this.depa.load(instanceId).definitionDir
    const frozenWorkspaceInstructions = EidolonAppResourceRegistryAdapter.loadFrozenWorkspaceInstructions(definitionDir)
    const effectiveRoot = path.join(definitionDir, ".agent-resources", "effective-vfs")
    if (existsSync(effectiveRoot)) {
      return new EidolonAppResourceRegistryAdapter({
        effectiveVfs: () => loadFrozenEffectiveEidolonVfsReadPort(effectiveRoot),
        frozenWorkspaceInstructions,
      })
    }
    const layers = (["global", "workspace"] as const).flatMap((id) => {
      const rootDir = path.join(definitionDir, ".agent-resources", id)
      return existsSync(rootDir) ? [{ id, rootDir }] : []
    })
    return layers.length > 0 ? new EidolonAppResourceRegistryAdapter({ layers, frozenWorkspaceInstructions }) : undefined
  }

  private async frozenAgentTaskProofs(
    descriptor: WorkflowRunDescriptor,
    definition: ResolvedWorkflowDefinition,
    registry: EidolonAppResourceRegistryAdapter,
  ): Promise<Readonly<Record<string, FrozenAIAgentTaskBinding>>> {
    const discovered = discoverAgentTasks(descriptor, definition)
    const declared = await registry.listWorkflowAgentTasks(descriptor.workflowRef)
    const tasksByNodeId = new Map<string, AIWorkflowAgentTaskRef>()
    for (const task of [...declared, ...discovered]) {
      const prior = tasksByNodeId.get(task.nodeId)
      if (prior && (prior.workflowKind !== task.workflowKind
        || prior.workflowRef !== task.workflowRef
        || prior.agentDefinitionRef !== task.agentDefinitionRef)) {
        throw new Error(`Frozen Agent task ${task.nodeId} has conflicting declared and discovered identities`)
      }
      tasksByNodeId.set(task.nodeId, task)
    }
    const tasks = [...tasksByNodeId.values()].sort((left, right) => left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)
    const proofs: Record<string, FrozenAIAgentTaskBinding> = {}
    for (const task of tasks) {
      if (task.workflowKind !== descriptor.form) {
        throw new Error(`Frozen Agent task ${task.nodeId} declares workflow kind ${task.workflowKind}, expected ${descriptor.form}`)
      }
      proofs[task.nodeId] = await registry.freezeWorkflowAgentTaskBinding(task)
    }
    return Object.freeze(proofs)
  }

  private async frozenAgentTaskProofRefs(
    descriptor: WorkflowRunDescriptor,
    registry: EidolonAppResourceRegistryAdapter,
  ): Promise<Readonly<Record<string, readonly `resource://${string}`[]>>> {
    const declared = await registry.listWorkflowAgentTaskProofRefs(descriptor.workflowRef)
    const refs: Record<string, `resource://${string}`[]> = {}
    for (const entry of declared) {
      if (entry.task.workflowKind !== descriptor.form
        || entry.task.workflowRef !== descriptor.workflowRef) {
        throw new Error(`Frozen Agent task proof ${entry.taskProofRef} does not match workflow ${descriptor.workflowRef}`)
      }
      const byNode = refs[entry.task.nodeId] ?? []
      if (!byNode.includes(entry.taskProofRef)) byNode.push(entry.taskProofRef)
      refs[entry.task.nodeId] = byNode
    }
    return Object.freeze(Object.fromEntries(Object.entries(refs).map(([nodeId, values]) => [
      nodeId,
      Object.freeze([...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)),
    ])))
  }

  private async loadFrozenDefinition(
    descriptor: WorkflowRunDescriptor,
    expectedForm: "AICtrlWorkflow" | "AIDataWorkflow",
  ): Promise<ResolvedWorkflowDefinition> {
    if (!descriptor.definitionRevision) {
      return this.repository.resolve(descriptor.workflowRef, expectedForm)
    }
    const frozen = await this.facts.loadDefinitionRevision(descriptor.definitionRevision)
    if (!frozen) throw new Error(`Frozen definition revision not found: ${descriptor.definitionRevision}`)
    if (frozen.form !== expectedForm) throw new Error(`Frozen workflow form mismatch: ${descriptor.definitionRevision}`)
    return this.repository.resolveFrozen(frozen, this.depa.load(descriptor.instanceId).definitionDir)
  }

  private materializeInstance(instanceId: string, frozen: WorkflowDefinitionRevision): void {
    this.depa.materialize(
      instanceId,
      frozen,
      this.facts.frozenDefinitionRoot(frozen.revision),
      () => {
        const validated = this.repository.captureSources({
          files: Object.entries(frozen.files).map(([filePath, content]) => ({ path: filePath, content })),
          form: frozen.form,
          sourceBundlePath: `frozen:${frozen.revision}`,
          workflowRef: frozen.workflowRef,
        })
        if (validated.fqn !== frozen.fqn || validated.form !== frozen.form) {
          throw new Error(`Frozen workflow definition identity mismatch: ${frozen.revision}`)
        }
      },
    )
  }

  private async loadDataDriver(descriptor: WorkflowRunDescriptor): Promise<AIDataWorkflowRuntimeDriver | undefined> {
    let driver = this.dataDrivers.get(descriptor.runId)
    if (!driver) {
      driver = await this.createDataDriver(descriptor, await this.loadFrozenDefinition(descriptor, "AIDataWorkflow"))
      if (!await driver.restore()) return undefined
      this.dataDrivers.set(descriptor.runId, driver)
    }
    return driver
  }

  private async ensureCanonicalCheckpoint(descriptor: WorkflowRunDescriptor) {
    const key = { instanceId: descriptor.instanceId, runId: descriptor.runId }
    if (existsSync(this.depa.instanceDirectory(descriptor.instanceId))) {
      const existing = await this.depa.checkpointRuntime.checkpointStore.load(key)
      if (existing) {
        if (this.legacyMigration.readReceipt(key)) {
          await this.legacyMigration.migrate({
            legacyRunId: descriptor.runId,
            targetInstanceId: descriptor.instanceId,
            targetRunId: descriptor.runId,
          })
        }
        return existing
      }
    }
    await this.legacyMigration.migrate({
      legacyRunId: descriptor.runId,
      targetInstanceId: descriptor.instanceId,
      targetRunId: descriptor.runId,
    })
    return this.depa.checkpointRuntime.checkpointStore.load(key)
  }

  private async loadController(runId: string): Promise<{ descriptor: WorkflowRunDescriptor; controller: CtrlController } | undefined> {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor || descriptor.form !== "AICtrlWorkflow") return undefined
    let controller = this.controllers.get(runId)
    if (!controller) {
      controller = await this.createController(descriptor, await this.loadFrozenDefinition(descriptor, "AICtrlWorkflow"))
      this.controllers.set(runId, controller)
    }
    return { descriptor, controller }
  }

  private project(
    kind: WorkflowRunProjection["kind"],
    descriptor: WorkflowRunDescriptor,
    record: any,
    snapshot?: { vars: Record<string, unknown> },
  ): WorkflowRunProjection {
    const terminal = record.status === "Completed" || record.status === "Failed"
    return {
      ok: true,
      kind,
      runtime: "depa-flows.AICtrlWorkflow",
      form: "AICtrlWorkflow",
      workflow_ref: descriptor.workflowRef,
      instance_id: descriptor.instanceId ?? `legacy-${descriptor.runId}`,
      definition_revision: descriptor.definitionRevision ?? "legacy-current-publication",
      run_id: descriptor.runId,
      generation: descriptor.generation,
      status: record.status,
      terminal,
      nodes: [...record.nodes].sort((left: any, right: any) => (
        (this.ctrlNodeOrder.get(descriptor.runId)?.get(left.nodeId) ?? Number.MAX_SAFE_INTEGER)
        - (this.ctrlNodeOrder.get(descriptor.runId)?.get(right.nodeId) ?? Number.MAX_SAFE_INTEGER)
      )),
      open_wait_handles: record.openWaitHandles,
      ...(snapshot ? { vars: snapshot.vars } : {}),
    }
  }

  private attachDescriptor(descriptor: WorkflowRunDescriptor, result: any): any {
    return {
      ...result,
      instance_id: descriptor.instanceId ?? `legacy-${descriptor.runId}`,
      definition_revision: descriptor.definitionRevision ?? "legacy-current-publication",
    }
  }

  private async requireInstance(instanceId: string): Promise<WorkflowInstance> {
    const instance = await this.facts.loadInstance(instanceId)
    if (!instance) throw new Error(`Workflow instance not found: ${instanceId}`)
    return instance
  }

  private async synchronizeInstanceStatus(runId: string, result: any): Promise<void> {
    if (!result?.terminal) return
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor) return
    const instance = await this.facts.loadInstance(descriptor.instanceId)
    if (!instance) return
    const failed = result.status === "Failed" || result.status === "Cancelled"
    await this.facts.saveInstance({ ...instance, status: failed ? "Failed" : "Completed", updatedAt: Date.now() })
  }

  private async captureMaterialOutput(runId: string, nodeId: string, sourcePath: string): Promise<void> {
    if (!sourcePath) return
    const material = await this.materials.import({
      materialRef: `material://run/${runId}/${nodeId}`,
      sourcePath,
      provenance: { operation: "workflow-output", runId, nodeId },
      confirmed: true,
    })
    if ("revision" in material && "materialRef" in material) {
      await this.recordMaterialOutput(runId, {
        materialRef: String(material.materialRef),
        revision: String(material.revision),
      })
    }
  }
}

const SERVICE_BY_VM = new WeakMap<object, WorkflowRuntimeService>()

export function getWorkflowRuntimeService(runtime: WorkflowRuntime): WorkflowRuntimeService {
  const vm = runtime.vm as object
  const existing = SERVICE_BY_VM.get(vm)
  if (existing) return existing
  const service = new WorkflowRuntimeService(runtime)
  SERVICE_BY_VM.set(vm, service)
  return service
}
