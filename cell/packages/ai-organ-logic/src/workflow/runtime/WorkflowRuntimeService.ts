import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"

import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { AIDataWorkflowGraphPatch, AIWorkflowRunRef } from "@cell/ai-workflow-contract"
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
  type AIDataHolonTaskMaterialValidationInput,
} from "ai-data-workflow-logic"
import {
  holonTaskTargetFromNodeConfig,
  normalizeHolonTaskSnapshotReceipt,
  normalizeHolonTaskTarget,
  type FrozenHolonTaskTarget,
  type HolonTaskTarget,
} from "ai-workflow-contract"
import { runAgent } from "ai-workflow-logic"
import { assertFrozenAIAgentTaskBinding } from "ai-workflow-logic/run-freeze"
import {
  canonicalHolonEffectiveSnapshotBytes,
  canonicalHolonEffectiveSnapshotIssuanceReceiptBytes,
} from "holarchy-core-contract"
import { FileTaskSpaceOwner } from "task-manager-file-support"
import type {
  AIWorkflowAgentTaskRef,
  AIWorkflowAuthoredRuntimeContext,
  FrozenAIAgentTaskBinding,
} from "ai-workflow-contract"
import type { DefinitionStepExtensionCodecRegistryPort } from "flow-step-space-contract"
import { createFilesystemFlowCodeResolver } from "instant-ctrl-flow-logic"
import type { ResumeSignal } from "work-ctrl-flow-contract"
import { hashWorkflowSources, type WorkflowAuthoringWorkspace } from "../authoring"
import { createWorkflowComponentForRuntime } from "../component"
import { EidolonAppResourceRegistryAdapter } from "../../resources"
import { EidolonWorkflowEffectProvider, StoreBackedWorkflowMaterialAccess } from "../effects"
import {
  bindWorkflowStepExtensionAuthoredRuntime,
  createWorkflowStepExtensionAuthoredFacade,
} from "../effects/WorkflowStepExtensionAuthoredFacade"
import { AIDataWorkflowRuntimeDriver } from "./AIDataWorkflowRuntimeDriver"
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
import {
  loadHolonDeploymentDefinition,
  materializeHolonDeploymentDefinition,
  type MaterializedHolonDeploymentDefinition,
} from "../../organization/HolonDeploymentDefinition"
import { FileHolonDeploymentRuntimeStore } from "../../organization/HolonDeploymentRuntimeStore"
import {
  EidolonHolonLocalActorRuntime,
  type HolonExecutionAdapterPorts,
  type HolonGenericActorOwnerPort,
} from "../../organization/HolonLocalActorRuntime"
import {
  executeHolonWorkflowTask,
  type ExecuteHolonWorkflowTaskInput,
  type HolonWorkflowTaskExecutionResult,
} from "../../organization/HolonWorkflowTaskRuntime"

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

function metadata(runtime: WorkflowRuntime): Record<string, unknown> {
  const value = runtime.vm?.outerCtx?.metadata
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
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
    return candidate as DefinitionStepExtensionCodecRegistryPort
  }
  return Object.freeze({ resolve: () => undefined })
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
  taskManager: Readonly<{ owner: FileTaskSpaceOwner }>
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
  instanceId: string,
  bindingRef: string,
  snapshotReceiptDigest?: string,
): string {
  const identity = snapshotReceiptDigest === undefined
    ? `${instanceId}\u0000${bindingRef}`
    : `${instanceId}\u0000${bindingRef}\u0000${snapshotReceiptDigest}`
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
  private readonly supportRoot: string

  constructor(private readonly runtime: WorkflowRuntime) {
    const component = createWorkflowComponentForRuntime(runtime)
    if (!component.authoring) throw new Error("Workflow authoring workspace is not bound")
    if (!component.repository) throw new Error("Workflow definition repository is not bound")
    this.workspace = component.authoring
    this.catalog = component.catalog
    this.resourceRegistry = component.resourceRegistry
    this.repository = component.repository
    this.supportRoot = factRoot(runtime, component.authoring.store.rootPath)
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
    const closure = await this.resourceRegistry.captureFrozenResourceClosure()
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
    const requestFingerprint = fingerprint({
      instanceId: instance.instanceId,
      definitionRevision: instance.definitionRevision,
      input: instance.input,
      bindings,
      replayOf: input.replayOf,
    })
    const requestedRunId = input.runId?.trim()
    if (requestedRunId) {
      const existing = await this.facts.loadDescriptor(requestedRunId)
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) throw new Error(`Run id conflict: ${requestedRunId}`)
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
    const now = Date.now()
    const receipt: WorkflowRunReceipt = {
      runId: descriptor.runId,
      instanceId: instance.instanceId,
      definitionRevision: frozen.revision,
      input: instance.input,
      inputMaterials: bindings,
      outputMaterials: [],
      requestFingerprint,
      replayOf: input.replayOf,
      createdAt: now,
      updatedAt: now,
    }
    await this.facts.saveRunReceipt(receipt)
    await this.facts.saveInstance({
      ...instance,
      status: "Running",
      runIds: [...instance.runIds, descriptor.runId],
      updatedAt: now,
    })
    try {
      const result = await this.execute(descriptor, definition, instance.input)
      await this.synchronizeInstanceStatus(descriptor.runId, result)
      return result
    } catch (error) {
      await this.facts.saveInstance({ ...instance, status: "Failed", runIds: [...instance.runIds, descriptor.runId], updatedAt: Date.now() })
      throw error
    }
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
    const taskSpace = await context.taskManager.owner.readSnapshot(input.taskSpaceId)
    const task = taskSpace?.tasks.find((candidate) => candidate.taskId === input.taskId)
    const taskFacts = nestedRecord(task?.profile?.facts)
    const target = normalizeHolonTaskTarget(taskFacts.target)
    const snapshotReceipt = normalizeHolonTaskSnapshotReceipt(taskFacts.snapshotReceipt)
    if (!sameHolonTargetExecutableIdentity(frozenTarget, target)) {
      throw new Error("EIDOLON_HOLON_TASK_SUCCESSOR_INSTANCE_REQUIRED: task executable identity differs from the frozen Flow node")
    }
    const deployment = await this.workflowHolonDeploymentForTask(
      descriptor,
      context,
      target,
      snapshotReceipt.issuerReceiptId,
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
      nodeId: input.nodeId,
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
    )
    const genericOwner = this.workflowHolonGenericOwner(descriptor, agentAdapter.agentDefinitionRef)
    const adapters: HolonExecutionAdapterPorts = {
      aiAgent: {
        execute: async ({ invocation, runtimeRef, sessionRef, taskAttempt }) => {
          const checkpointKey = { instanceId: descriptor.instanceId, runId: descriptor.runId }
          const checkpoint = await this.depa.checkpointRuntime.checkpointStore.load(checkpointKey) as any
          if (!checkpoint) throw new Error("Holon Agent execution requires the canonical Flow checkpoint")
          const taskAttemptIdentity = JSON.stringify([
            taskAttempt.taskSpaceId,
            taskAttempt.taskId,
            taskAttempt.claimId,
            taskAttempt.attempt,
          ])
          const taskAttemptDigest = createHash("sha256").update(taskAttemptIdentity).digest("hex")
          const instanceName = `holon-task-attempt-${taskAttemptDigest.slice(0, 32)}`
          const processorRuntime = {
            checkpointRuntime: this.depa.checkpointRuntime,
            checkpointKey,
            workflowKind: descriptor.form,
            workflowRef: descriptor.workflowRef as `resource://${string}`,
            nodeId: input.nodeId,
            invocationKey: `holon-task-attempt:${taskAttemptDigest}`,
            generation: descriptor.generation,
            effects,
            taskBinding,
            metadata: {
              deploymentId: deployment.deploymentId,
              memberRuntimeRef: runtimeRef,
              taskSpaceId: input.taskSpaceId,
              taskId: input.taskId,
              claimId: taskAttempt.claimId,
              attempt: taskAttempt.attempt,
              sessionRef,
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
      humanEndpoint: { execute: () => { throw new Error("EIDOLON_HOLON_HUMAN_ENDPOINT_NOT_BOUND") } },
      service: { execute: () => { throw new Error("EIDOLON_HOLON_SERVICE_ADAPTER_NOT_BOUND") } },
      hybrid: { execute: () => { throw new Error("EIDOLON_HOLON_HYBRID_ADAPTER_NOT_BOUND") } },
    }
    const actorRuntime = new EidolonHolonLocalActorRuntime(
      deployment.store,
      genericOwner,
      adapters,
      `workflow-${descriptor.runId}`,
    )
    await actorRuntime.recover(deployment.deploymentId)
    const executionInput: ExecuteHolonWorkflowTaskInput = {
      deploymentId: deployment.deploymentId,
      bindingRef: target.executionBinding.ref,
      holonRef: target.holon.rootHolonRef,
      taskSpaceId: input.taskSpaceId,
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
    return executeHolonWorkflowTask({
      store: deployment.store,
      taskManager: context.taskManager,
      actorRuntime,
    }, executionInput, {
      maxTasks: 1_024,
      maxRelations: 4_096,
      maxLeaseDurationMs: 24 * 60 * 60 * 1_000,
    })
  }

  async replanHolonTask(
    input: ReplanWorkflowHolonTaskInput,
  ): ReturnType<typeof replanAICtrlHolonTask> {
    const descriptor = await this.facts.loadDescriptor(input.runId)
    if (!descriptor || descriptor.form !== "AICtrlWorkflow") {
      throw new Error(`EIDOLON_HOLON_REPLAN_CTRL_RUN_REQUIRED: ${input.runId}`)
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

    const instanceRoot = path.dirname(this.depa.load(descriptor.instanceId).definitionDir)
    const deploymentId = workflowHolonDeploymentId(
      descriptor.instanceId,
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
    return replanAICtrlHolonTask({
      taskManager: context.taskManager,
      organizationSnapshots,
    }, {
      frozenSuccessorTarget: successorProof,
      taskSpaceId: input.taskSpaceId,
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

  private async execute(descriptor: WorkflowRunDescriptor, definition: ResolvedWorkflowDefinition, input: unknown): Promise<any> {
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
    const taskProofs = frozenRegistry
      ? await this.frozenAgentTaskProofs(descriptor, definition, frozenRegistry)
      : {}
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
      frozenRegistry,
      taskProofs,
      this.stepExtensionFacade(),
      holonContext,
    )
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
    const instanceRoot = path.dirname(this.depa.load(descriptor.instanceId).definitionDir)
    const deployments = new Map<string, WorkflowHolonDeployment>()
    for (const target of Object.values(targets)) {
      if (deployments.has(target.executionBinding.ref)) continue
      const deploymentId = workflowHolonDeploymentId(descriptor.instanceId, target.executionBinding.ref)
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
    const taskManager = Object.freeze({
      owner: new FileTaskSpaceOwner({ root: path.join(instanceRoot, "task-spaces") }),
    })
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
    const context: WorkflowHolonTaskContext = Object.freeze({
      proofs: Object.freeze(proofs),
      targets,
      taskManager,
      deployments,
      organizationSnapshots,
      proofForNode: (nodeId: string) => {
        const proof = proofs[nodeId]
        if (!proof) throw new Error(`EIDOLON_HOLON_TARGET_PROOF_REQUIRED: ${nodeId}`)
        return proof
      },
      openTask: (input, config) => openAICtrlHolonTask(holonRuntime, input, config),
      observeTask: (input, config) => observeAICtrlHolonTask(holonRuntime, input, config),
      replanTask: (input, config) => replanAICtrlHolonTask(holonRuntime, input, config),
      consumeTask: (input, config) => consumeAIDataHolonTask({
        taskManager,
        materials: {
          validateSettlementMaterial: (materialInput) => validateHolonSettlementMaterial(registry, materialInput),
        },
      }, input, config),
    })
    this.holonContexts.set(descriptor.runId, context)
    return context
  }

  private async workflowHolonDeploymentForTask(
    descriptor: WorkflowRunDescriptor,
    context: WorkflowHolonTaskContext,
    target: HolonTaskTarget,
    issuerReceiptId: string,
  ): Promise<WorkflowHolonDeployment> {
    const initial = context.deployments.get(target.executionBinding.ref)
    if (initial?.definition.definition.snapshotReceiptDigest === issuerReceiptId) return initial
    const instanceRoot = path.dirname(this.depa.load(descriptor.instanceId).definitionDir)
    const deploymentId = workflowHolonDeploymentId(
      descriptor.instanceId,
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
        const instanceId = "byInstanceId" in selector
          ? selector.byInstanceId
          : ai?.instanceIdByName?.[selector.byInstanceName]
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

  private frozenAgentRegistry(instanceId: string): EidolonAppResourceRegistryAdapter | undefined {
    const definitionDir = this.depa.load(instanceId).definitionDir
    const layers = (["global", "workspace"] as const).flatMap((id) => {
      const rootDir = path.join(definitionDir, ".agent-resources", id)
      return existsSync(rootDir) ? [{ id, rootDir }] : []
    })
    return layers.length > 0 ? new EidolonAppResourceRegistryAdapter({ layers }) : undefined
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
