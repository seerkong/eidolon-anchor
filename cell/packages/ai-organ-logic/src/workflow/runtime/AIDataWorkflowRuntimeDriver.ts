import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type {
  AIDataWorkflowGraphPatch,
  AIDataWorkflowRunGraph,
  AIDataWorkflowRunNode,
  AIWorkflowNodeResult,
  AIWorkflowRunRef,
} from "@cell/ai-workflow-contract"
import {
  applyAIDataWorkflowGraphPatch,
  commitAIDataWorkflowCheckpoint,
  createAIDataWorkflowCheckpoint,
  createAIDataWorkflowAgentNodeRuntimeBinder,
  createAIDataWorkflowRunGraph,
  createAIDataWorkflowRuntime,
  createAIDataWorkflowSemanticFingerprint,
  findReusableAIDataWorkflowNodeResult,
  listReadyAIDataWorkflowNodes,
  loadAIDataWorkflowCheckpoint,
  projectAIDataWorkflowRunState,
  recordAIDataWorkflowNodeResult,
  restoreAIDataWorkflowRunGraph,
} from "ai-data-workflow-logic"
import type { FlowClosedValue, FrozenAIAgentTaskBinding } from "ai-workflow-contract"
import { createFilesystemCodeResolver } from "eager-data-flow-logic"
import type { WorkflowAuthoringWorkspace } from "../authoring"
import {
  EidolonWorkflowEffectProvider,
  StoreBackedWorkflowMaterialAccess,
  bindWorkflowStepExtensionAuthoredRuntime,
  type WorkflowStepExtensionAuthoredFacade,
} from "../effects"
import type { ResolvedWorkflowDefinition } from "./WorkflowDefinitionRepository"
import type { WorkflowFactStore, WorkflowRunDescriptor } from "./WorkflowFactStore"
import { EMPTY_AI_WORKFLOW_DURABLE_STATE, type WorkflowDepaPersistence } from "./WorkflowDepaPersistence"
import type { EidolonAppResourceRegistryAdapter } from "../../resources"
import { normalizeFrozenWorkflowCodeReference } from "./WorkflowDefinitionRepository"

type WorkflowRuntime = AiAgentOneActorRuntime<any, any>

type DataRunProjection = {
  ok: true
  kind: "workflow.run" | "workflow.runStatus" | "workflow.runResume" | "workflow.runResult" | "workflow.graphPatch"
  runtime: "depa-flows.AIDataWorkflow"
  form: "AIDataWorkflow"
  workflow_ref: string
  run_id: string
  generation: number
  status: string
  terminal: boolean
  nodes: AIDataWorkflowRunNode[]
  graph: {
    declarationOrder: readonly string[]
    patchHistory: AIDataWorkflowRunGraph["patchHistory"]
    invalidations: AIDataWorkflowRunGraph["invalidations"]
  }
  output?: unknown
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function canonicalJson(value: unknown): string {
  const normalize = (nested: unknown): unknown => {
    if (Array.isArray(nested)) return nested.map(normalize)
    if (typeof nested !== "object" || nested === null) return nested
    return Object.fromEntries(Object.entries(nested as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, normalize(item)]))
  }
  return JSON.stringify(normalize(value))
}

function exactOutput(value: unknown, outputs: readonly string[], label: string): Record<string, unknown> {
  const output = record(value)
  const actual = Object.keys(output)
  if (actual.length !== outputs.length || !actual.every((key) => outputs.includes(key))) {
    throw new Error(`${label} must return exact output keys [${outputs.join(", ")}], got [${actual.join(", ")}]`)
  }
  return Object.fromEntries(outputs.map((key) => [key, output[key]]))
}

function workflowRef(
  descriptor: WorkflowRunDescriptor,
  definition: ResolvedWorkflowDefinition,
) {
  return {
    ref: descriptor.workflowRef,
    scheme: definition.resourceReceipt ? "resource" as const : "vfs" as const,
  }
}

export class AIDataWorkflowRuntimeDriver {
  private graph?: AIDataWorkflowRunGraph
  private activeRunAuthority: AIWorkflowRunRef
  private readonly code = createFilesystemCodeResolver<any>((specifier) => import(specifier))
  private readonly aiRuntime: ReturnType<typeof createAIDataWorkflowRuntime>
  private readonly bindAgentNode?: ReturnType<typeof createAIDataWorkflowAgentNodeRuntimeBinder>

  constructor(
    private readonly runtime: WorkflowRuntime,
    private readonly workspace: WorkflowAuthoringWorkspace,
    private readonly facts: WorkflowFactStore,
    private readonly depa: WorkflowDepaPersistence,
    private readonly descriptor: WorkflowRunDescriptor,
    private readonly definition: ResolvedWorkflowDefinition,
    roots: { globalRoot: string; workspaceRoot: string },
    onMaterialWrite?: ConstructorParameters<typeof EidolonWorkflowEffectProvider>[3],
    resourceRegistry?: EidolonAppResourceRegistryAdapter,
    taskProofs: Readonly<Record<string, FrozenAIAgentTaskBinding>> = {},
    stepExtensions?: WorkflowStepExtensionAuthoredFacade,
  ) {
    this.activeRunAuthority = this.runRef(descriptor.generation)
    const agentEffects = new EidolonWorkflowEffectProvider(
      runtime,
      new StoreBackedWorkflowMaterialAccess(workspace.store),
      facts,
      onMaterialWrite,
      () => this.activeRunAuthority,
      resourceRegistry ? { workflowForm: descriptor.form, resourceRegistry } : undefined,
      stepExtensions,
    )
    this.aiRuntime = createAIDataWorkflowRuntime({
      ai: {
        roots,
        stateStore: depa.stateProjection(descriptor.instanceId),
        effects: agentEffects,
        metadata: { run: this.activeRunAuthority, flowInstanceId: descriptor.instanceId },
      },
    })
    if (definition.resourceReceipt && resourceRegistry) {
      const bindAgentNode = createAIDataWorkflowAgentNodeRuntimeBinder({
        flowInstanceId: descriptor.instanceId,
        runId: descriptor.runId,
        checkpointRuntime: depa.checkpointRuntime,
        effects: agentEffects,
        workflowRef: descriptor.workflowRef as `resource://${string}`,
        taskProofs,
        generationForNode: (nodeId) => this.graph?.nodes[nodeId]?.generation ?? descriptor.generation,
      })
      this.bindAgentNode = (nodeRuntime, identity) => {
        if (!taskProofs[identity.nodeId]) return nodeRuntime
        const bound = bindAgentNode(nodeRuntime, identity)
        return stepExtensions
          ? Object.freeze({
              ...bound,
              ai: bindWorkflowStepExtensionAuthoredRuntime(bound.ai, stepExtensions),
            })
          : bound
      }
    }
  }

  async start(input: unknown): Promise<DataRunProjection> {
    if (this.definition.binding.kind !== "AIDataWorkflow") throw new Error("Expected AIDataWorkflow binding")
    this.graph = createAIDataWorkflowRunGraph({
      binding: this.definition.binding,
      runId: this.descriptor.runId,
    })
    const instance = this.depa.load(this.descriptor.instanceId)
    await createAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      instanceId: this.descriptor.instanceId,
      definition: instance.descriptor.definition,
      graph: this.durableGraph(),
      input: record(input) as FlowClosedValue,
      config: { requestFingerprint: this.descriptor.requestFingerprint },
      state: { status: "Pending", generation: 0 },
      output: null,
      controllerSidecars: { status: "Pending" },
      nodeSidecars: this.nodeSidecars(),
      ai: EMPTY_AI_WORKFLOW_DURABLE_STATE,
      stepExtensions: this.depa.initialStepExtensions(
        this.descriptor.instanceId,
        instance.descriptor.definition,
        "AIDataWorkflow",
      ),
    })
    await this.advance(record(input))
    return this.project("workflow.run")
  }

  async restore(): Promise<boolean> {
    const stored = await loadAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      instanceId: this.descriptor.instanceId,
      runId: this.descriptor.runId,
    })
    if (!stored) return false
    let graph = restoreAIDataWorkflowRunGraph({
      ...stored.profile.runGraph,
      binding: this.definition.binding.kind === "AIDataWorkflow" ? this.definition.binding : stored.profile.runGraph.binding,
    })
    for (const node of Object.values(graph.nodes)) {
      if (node.status === "Running" && node.nodeType !== "manual") {
        graph = recordAIDataWorkflowNodeResult(graph, node.id, {
          nodeId: node.id,
          generation: node.generation,
          status: "Pending",
        })
      }
    }
    this.graph = graph
    if (Object.values(graph.nodes).some((node) => node.status === "Running" && node.nodeType !== "manual")) await this.persist()
    return true
  }

  async status(): Promise<DataRunProjection | undefined> {
    if (!this.graph && !await this.restore()) return undefined
    return this.project("workflow.runStatus")
  }

  async resumeManual(nodeId: string, output: unknown): Promise<DataRunProjection> {
    await this.requireGraph()
    const node = this.graph!.nodes[nodeId]
    if (!node || node.nodeType !== "manual" || node.result?.status !== "Waiting") {
      throw new Error(`AIDataWorkflow node ${nodeId} is not a waiting manual node`)
    }
    const normalized = exactOutput(output, node.outputs, nodeId)
    this.graph = recordAIDataWorkflowNodeResult(this.graph!, nodeId, {
      nodeId,
      generation: this.graph!.currentGeneration,
      status: "Succeeded",
      output: normalized,
      semanticFingerprint: node.semanticFingerprint,
    })
    await this.persist()
    await this.advance()
    return this.project("workflow.runResume")
  }

  async applyPatch(patch: AIDataWorkflowGraphPatch): Promise<DataRunProjection> {
    await this.requireGraph()
    this.graph = applyAIDataWorkflowGraphPatch(this.graph!, patch)
    this.descriptor.generation = this.graph.currentGeneration
    await this.facts.saveDescriptor(this.descriptor)
    await this.persist()
    await this.advance()
    return this.project("workflow.graphPatch")
  }

  async result(allowPartial = false): Promise<DataRunProjection | {
    ok: false
    error: "not_terminal"
    run_id: string
    status: string
    runtime: "depa-flows.AIDataWorkflow"
  } | undefined> {
    const status = await this.status()
    if (!status) return undefined
    if (!status.terminal && !allowPartial) {
      return {
        ok: false,
        error: "not_terminal",
        run_id: this.descriptor.runId,
        status: status.status,
        runtime: "depa-flows.AIDataWorkflow",
      }
    }
    return { ...status, kind: "workflow.runResult" }
  }

  private async advance(initialInput?: Record<string, unknown>): Promise<void> {
    await this.requireGraph()
    let progressed = true
    while (progressed) {
      progressed = false
      for (const node of listReadyAIDataWorkflowNodes(this.graph!)) {
        progressed = true
        await this.applyNode(node, initialInput)
        initialInput = undefined
        if (this.graph!.nodes[node.id]?.status === "Failed") break
      }
      if (Object.values(this.graph!.nodes).some((node) => node.status === "Failed")) break
    }
    await this.persist()
  }

  private async applyNode(node: AIDataWorkflowRunNode, initialInput?: Record<string, unknown>): Promise<void> {
    const generation = this.graph!.currentGeneration
    const input = node.tag === "EntryNode" ? (initialInput ?? this.initialInput()) : this.effectiveInput(node)
    const fingerprint = createAIDataWorkflowSemanticFingerprint({
      nodeId: node.id,
      nodeTag: node.tag,
      effectiveInput: input,
      config: node.config,
      materialRevisions: record(node.config.material_revisions) as Record<string, string>,
      effectPolicy: { operation: node.config.operation, nodeType: node.nodeType },
    })
    const reusable = findReusableAIDataWorkflowNodeResult({
      runId: this.descriptor.runId,
      nodeId: node.id,
      fingerprint,
      policy: node.reusePolicy,
      candidates: await this.facts.listReusableNodeCandidates(this.descriptor.runId, node.id),
    })
    if (reusable) {
      this.graph = recordAIDataWorkflowNodeResult(this.graph!, node.id, {
        ...reusable,
        generation,
        status: "Reused",
        reusedFrom: {
          runId: this.descriptor.runId,
          generation: reusable.generation,
          nodeId: node.id,
        },
      })
      await this.persist()
      return
    }

    if (node.nodeType === "manual") {
      this.graph = recordAIDataWorkflowNodeResult(this.graph!, node.id, {
        nodeId: node.id,
        generation,
        status: "Waiting",
        semanticFingerprint: fingerprint,
      })
      await this.persist()
      return
    }

    this.graph = recordAIDataWorkflowNodeResult(this.graph!, node.id, {
      nodeId: node.id,
      generation,
      status: "Running",
      semanticFingerprint: fingerprint,
    })
    await this.persist()
    try {
      let output: unknown
      if (node.tag === "EntryNode") {
        output = exactOutput(input, node.outputs, node.id)
      } else if (node.tag === "ReturnNode") {
        if (this.definition.binding.kind !== "AIDataWorkflow") throw new Error("Expected AIDataWorkflow binding")
        output = exactOutput(input, this.definition.binding.definition.contract.outputPorts, node.id)
      } else if (node.tag === "TransformNode" || node.tag === "SinkNode") {
        if (this.definition.binding.kind !== "AIDataWorkflow") throw new Error("Expected AIDataWorkflow binding")
        const planNode = this.definition.binding.definition.nodeById[node.id] as any
        const reference = planNode?.src ?? planNode?.impl ?? node.config.src ?? node.config.impl
        if (typeof reference !== "string") throw new Error(`${node.id} has no EagerDataFlow code binding`)
        const fn = await this.code({
          reference: normalizeFrozenWorkflowCodeReference(reference),
          flowId: this.definition.binding.definition.fqn,
          nodeId: node.id,
          baseUri: this.definition.binding.definition.baseUri,
        })
        const result = await fn(this.runtimeForGeneration(generation, node.id), input, node.config)
        output = node.tag === "SinkNode" ? undefined : exactOutput(result, node.outputs, node.id)
      } else {
        throw new Error(`Unsupported AIDataWorkflow node tag: ${node.tag}`)
      }
      this.graph = recordAIDataWorkflowNodeResult(this.graph!, node.id, {
        nodeId: node.id,
        generation,
        status: "Succeeded",
        output,
        semanticFingerprint: fingerprint,
      })
    } catch (error) {
      this.graph = recordAIDataWorkflowNodeResult(this.graph!, node.id, {
        nodeId: node.id,
        generation,
        status: "Failed",
        semanticFingerprint: fingerprint,
      })
    }
    await this.persist()
  }

  private effectiveInput(node: AIDataWorkflowRunNode): Record<string, unknown> {
    return Object.fromEntries(Object.entries(node.inputs).map(([name, binding]) => {
      if (binding && typeof binding === "object" && !Array.isArray(binding)
        && "nodeId" in binding && "port" in binding) {
        const ref = binding as { nodeId: string; port: string }
        const output = record(this.graph!.nodes[ref.nodeId]?.result?.output)
        return [name, output[ref.port]]
      }
      return [name, binding]
    }))
  }

  private initialInput(): Record<string, unknown> {
    const entry = Object.values(this.graph!.nodes).find((node) => node.tag === "EntryNode")
    return record(entry?.result?.output)
  }

  private runRef(generation = this.descriptor.generation): AIWorkflowRunRef {
    return Object.freeze({
      workflow: Object.freeze(workflowRef(this.descriptor, this.definition)),
      runId: this.descriptor.runId,
      generation,
    })
  }

  private runtimeForGeneration(generation: number, nodeId?: string) {
    this.activeRunAuthority = this.runRef(generation)
    const runtime = {
      ...this.aiRuntime,
      ai: {
        ...this.aiRuntime.ai,
        metadata: {
          ...this.aiRuntime.ai.metadata,
          run: this.activeRunAuthority,
        },
      },
    }
    return this.bindAgentNode && nodeId ? this.bindAgentNode(runtime, { nodeId }) : runtime
  }

  private async persist(): Promise<void> {
    const current = await loadAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      instanceId: this.descriptor.instanceId,
      runId: this.descriptor.runId,
    })
    if (!current) throw new Error(`AIDataWorkflow checkpoint missing for ${this.descriptor.runId}`)
    if ((current.controllerSidecars.status === "Succeeded" || current.controllerSidecars.status === "Failed")
      && canonicalJson(current.profile.runGraph) === canonicalJson(this.durableGraph())) {
      return
    }
    const checkpointStatus = this.statusValue() === "Waiting" ? "Running" : this.statusValue()
    await commitAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      expectedVersion: current.version,
      checkpoint: {
        ...current,
        version: current.version + 1,
        state: { status: checkpointStatus, generation: this.graph!.currentGeneration },
        output: this.checkpointOutput(),
        controllerSidecars: { status: checkpointStatus },
        nodeSidecars: this.nodeSidecars(),
        profile: { ...current.profile, runGraph: this.durableGraph() },
      },
    })
  }

  private durableGraph(): AIDataWorkflowRunGraph {
    const graph = this.graph!
    const {
      baseUri: _baseUri,
      definitionStepForest: _definitionStepForest,
      ...definition
    } = graph.binding.definition
    return { ...graph, binding: { ...graph.binding, definition } }
  }

  private nodeSidecars(): Record<string, FlowClosedValue> {
    return Object.fromEntries(this.graph!.declarationOrder.map((nodeId) => [nodeId, {
      status: this.graph!.nodes[nodeId]!.status,
      generation: this.graph!.nodes[nodeId]!.generation,
    }]))
  }

  private checkpointOutput(): FlowClosedValue {
    if (this.statusValue() !== "Succeeded") return null
    const returnNode = this.graph!.declarationOrder
      .map((nodeId) => this.graph!.nodes[nodeId])
      .find((node) => node?.tag === "ReturnNode")
    return returnNode?.result?.output as FlowClosedValue ?? null
  }

  private statusValue(): string {
    const nodes = Object.values(this.graph!.nodes).filter((node) => node.status !== "Removed")
    if (nodes.some((node) => node.status === "Failed")) return "Failed"
    if (nodes.some((node) => node.nodeType === "manual" && node.result?.status === "Waiting")) return "Waiting"
    if (nodes.length > 0 && nodes.every((node) => node.status === "Succeeded" || node.status === "Reused")) return "Succeeded"
    if (nodes.some((node) => node.status === "Running")) return "Running"
    return "Pending"
  }

  private project(kind: DataRunProjection["kind"]): DataRunProjection {
    const status = this.statusValue()
    const returnNode = Object.values(this.graph!.nodes).find((node) => node.tag === "ReturnNode")
    return {
      ok: true,
      kind,
      runtime: "depa-flows.AIDataWorkflow",
      form: "AIDataWorkflow",
      workflow_ref: this.descriptor.workflowRef,
      run_id: this.descriptor.runId,
      generation: this.graph!.currentGeneration,
      status,
      terminal: status === "Succeeded" || status === "Failed",
      nodes: this.graph!.declarationOrder.map((nodeId) => this.graph!.nodes[nodeId]).filter(Boolean),
      graph: {
        declarationOrder: this.graph!.declarationOrder,
        patchHistory: this.graph!.patchHistory,
        invalidations: this.graph!.invalidations,
      },
      ...(returnNode?.result?.output === undefined ? {} : { output: returnNode.result.output }),
    }
  }

  private async requireGraph(): Promise<void> {
    if (!this.graph && !await this.restore()) throw new Error(`AIDataWorkflow graph missing for ${this.descriptor.runId}`)
  }
}

export type { DataRunProjection }
