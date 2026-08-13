import { createHash, randomUUID } from "node:crypto"
import path from "node:path"

import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { AIDataWorkflowGraphPatch, AIWorkflowRunRef } from "@cell/ai-workflow-contract"
import {
  createAICtrlWorkflowController,
  getAICtrlWorkflowRunRecord,
  resumeAICtrlWorkflowRun,
  startAICtrlWorkflowRun,
} from "ai-ctrl-workflow-logic"
import { createFilesystemFlowCodeResolver } from "instant-ctrl-flow-logic"
import type { ResumeSignal } from "work-ctrl-flow-contract"
import type { WorkflowAuthoringWorkspace } from "../authoring"
import { createWorkflowComponentForRuntime } from "../component"
import { EidolonWorkflowEffectProvider, StoreBackedWorkflowMaterialAccess } from "../effects"
import { AIDataWorkflowRuntimeDriver } from "./AIDataWorkflowRuntimeDriver"
import { WorkflowDefinitionRepository, type ResolvedWorkflowDefinition } from "./WorkflowDefinitionRepository"
import { WorkflowFactStore, type WorkflowRunDescriptor } from "./WorkflowFactStore"
import type {
  WorkflowDefinitionRevision,
  WorkflowInstance,
  WorkflowMaterialBinding,
  WorkflowMaterialRevisionRef,
  WorkflowRunReceipt,
} from "./WorkflowLifecycleFacts"
import { WorkflowMaterialService } from "./WorkflowMaterialService"

type WorkflowRuntime = AiAgentOneActorRuntime<any, any>
type CtrlController = ReturnType<typeof createAICtrlWorkflowController>

export type StartWorkflowRunInput = {
  instanceId: string
  runId?: string
  confirmed?: boolean
  replayOf?: string
}

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
    .sort(([left], [right]) => left.localeCompare(right))
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

function runRef(descriptor: WorkflowRunDescriptor): AIWorkflowRunRef {
  return Object.freeze({
    workflow: Object.freeze({
      ref: descriptor.workflowRef,
      scheme: descriptor.workflowRef.startsWith("resource://") ? "resource" : "vfs",
    }),
    runId: descriptor.runId,
    generation: descriptor.generation,
  })
}

export class WorkflowRuntimeService {
  readonly facts: WorkflowFactStore
  readonly materials: WorkflowMaterialService
  private readonly repository: WorkflowDefinitionRepository
  private readonly controllers = new Map<string, CtrlController>()
  private readonly dataDrivers = new Map<string, AIDataWorkflowRuntimeDriver>()
  private readonly workspace: WorkflowAuthoringWorkspace
  private readonly catalog: ReturnType<typeof createWorkflowComponentForRuntime>["catalog"]

  constructor(private readonly runtime: WorkflowRuntime) {
    const component = createWorkflowComponentForRuntime(runtime)
    if (!component.authoring) throw new Error("Workflow authoring workspace is not bound")
    this.workspace = component.authoring
    this.catalog = component.catalog
    this.repository = new WorkflowDefinitionRepository(component.authoring)
    this.facts = new WorkflowFactStore(factRoot(runtime, component.authoring.store.rootPath))
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
    const frozen = await this.repository.capture(input.workflowRef)
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
    await this.facts.saveInstance(instance)
    return instance
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
    await this.facts.saveInstance(instance)
    return instance
  }

  getInstance(instanceId: string): Promise<WorkflowInstance | undefined> {
    return this.facts.loadInstance(instanceId)
  }

  listInstances(): Promise<WorkflowInstance[]> {
    return this.facts.listInstances()
  }

  async flowSummary(runId: string): Promise<Record<string, unknown> | undefined> {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor) return undefined
    return {
      ok: true,
      kind: "workflow.flowSummary",
      run: await this.status(runId),
      descriptor,
      instance: descriptor.instanceId ? await this.facts.loadInstance(descriptor.instanceId) : undefined,
      receipt: await this.facts.loadRunReceipt(runId),
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
    if (instance.status !== "Prepared") throw new Error(`Instance has already started: ${instance.instanceId}`)
    const frozen = await this.facts.loadDefinitionRevision(instance.definitionRevision)
    if (!frozen) throw new Error(`Frozen definition revision not found: ${instance.definitionRevision}`)
    const definition = this.repository.resolveFrozen(frozen, this.facts.frozenDefinitionRoot(frozen.revision))
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
    if (descriptor?.form === "AIDataWorkflow") {
      const result = await (await this.loadDataDriver(descriptor))?.status()
      return result && this.attachDescriptor(descriptor, result)
    }
    const loaded = await this.loadController(runId)
    if (!loaded) return undefined
    const record = await getAICtrlWorkflowRunRecord(loaded.controller, runId)
    return record ? this.project("workflow.runStatus", loaded.descriptor, record, await this.facts.load(runId)) : undefined
  }

  async resume(runId: string, signal: ResumeSignal): Promise<WorkflowRunProjection | undefined> {
    const loaded = await this.loadController(runId)
    if (!loaded) return undefined
    const record = await resumeAICtrlWorkflowRun(loaded.controller, runId, signal)
    const projected = this.project("workflow.runResume", loaded.descriptor, record, await this.facts.load(runId))
    await this.synchronizeInstanceStatus(runId, projected)
    return projected
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
    }
  }

  async result(runId: string, allowPartial = false): Promise<any | undefined> {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (descriptor?.form === "AIDataWorkflow") {
      const result = await (await this.loadDataDriver(descriptor))?.result(allowPartial)
      return result && this.attachDescriptor(descriptor, result)
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
          input: receipt.input,
          material_bindings: receipt.inputMaterials,
          requested_run_id: input.newRunId ?? null,
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
      input: receipt.input,
      bindingIds: [],
      runIds: [],
      idempotencyKey: undefined,
      requestFingerprint: fingerprint({ definitionRevision: receipt.definitionRevision, input: receipt.input, replayOf: receipt.runId }),
      createdAt: now,
      updatedAt: now,
    }
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
    return this.start({ instanceId, runId: input.newRunId, confirmed: true, replayOf: receipt.runId })
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
      const driver = this.createDataDriver(descriptor, definition)
      this.dataDrivers.set(descriptor.runId, driver)
      return this.attachDescriptor(descriptor, await driver.start(input))
    }
    const controller = this.createController(descriptor, definition)
    this.controllers.set(descriptor.runId, controller)
    const record = await startAICtrlWorkflowRun(controller, descriptor.runId, { input: nestedRecord(input) })
    return this.project("workflow.run", descriptor, record, await this.facts.load(descriptor.runId))
  }

  private createController(descriptor: WorkflowRunDescriptor, definition: ResolvedWorkflowDefinition): CtrlController {
    if (definition.binding.kind !== "AICtrlWorkflow") throw new Error("Expected AICtrlWorkflow binding")
    const component = createWorkflowComponentForRuntime(this.runtime)
    if (!component.authoring) throw new Error("Workflow authoring workspace is not bound")
    const activeRunAuthority = runRef(descriptor)
    return createAICtrlWorkflowController({
      binding: definition.binding,
      store: this.facts,
      resolveCode: createFilesystemFlowCodeResolver(),
      ai: {
        roots: runtimeRoots(this.runtime, component.authoring.store.rootPath),
        stateStore: this.facts,
        effects: new EidolonWorkflowEffectProvider(
          this.runtime,
          new StoreBackedWorkflowMaterialAccess(component.authoring.store),
          this.facts,
          (request, output) => this.captureMaterialOutput(request.run.runId, request.nodeId ?? "effect", output.path),
          () => activeRunAuthority,
        ),
        metadata: { run: activeRunAuthority },
      },
    })
  }

  private createDataDriver(descriptor: WorkflowRunDescriptor, definition: ResolvedWorkflowDefinition): AIDataWorkflowRuntimeDriver {
    return new AIDataWorkflowRuntimeDriver(
      this.runtime,
      this.workspace,
      this.facts,
      descriptor,
      definition,
      runtimeRoots(this.runtime, this.workspace.store.rootPath),
      (request, output) => this.captureMaterialOutput(request.run.runId, request.nodeId ?? "effect", output.path),
    )
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
    return this.repository.resolveFrozen(frozen, this.facts.frozenDefinitionRoot(frozen.revision))
  }

  private async loadDataDriver(descriptor: WorkflowRunDescriptor): Promise<AIDataWorkflowRuntimeDriver | undefined> {
    let driver = this.dataDrivers.get(descriptor.runId)
    if (!driver) {
      driver = this.createDataDriver(descriptor, await this.loadFrozenDefinition(descriptor, "AIDataWorkflow"))
      if (!await driver.restore()) return undefined
      this.dataDrivers.set(descriptor.runId, driver)
    }
    return driver
  }

  private async loadController(runId: string): Promise<{ descriptor: WorkflowRunDescriptor; controller: CtrlController } | undefined> {
    const descriptor = await this.facts.loadDescriptor(runId)
    if (!descriptor || descriptor.form !== "AICtrlWorkflow") return undefined
    let controller = this.controllers.get(runId)
    if (!controller) {
      controller = this.createController(descriptor, await this.loadFrozenDefinition(descriptor, "AICtrlWorkflow"))
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
      nodes: record.nodes,
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
