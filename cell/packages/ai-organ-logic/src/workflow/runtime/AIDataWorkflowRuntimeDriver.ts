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
  createAIDataWorkflowRunGraph,
  createAIDataWorkflowRuntime,
  createAIDataWorkflowSemanticFingerprint,
  findReusableAIDataWorkflowNodeResult,
  listReadyAIDataWorkflowNodes,
  projectAIDataWorkflowRunState,
  recordAIDataWorkflowNodeResult,
  restoreAIDataWorkflowRunGraph,
} from "ai-data-workflow-logic"
import { createFilesystemCodeResolver } from "eager-data-flow-logic"
import type { WorkflowAuthoringWorkspace } from "../authoring"
import { EidolonWorkflowEffectProvider, StoreBackedWorkflowMaterialAccess } from "../effects"
import type { ResolvedWorkflowDefinition } from "./WorkflowDefinitionRepository"
import type { WorkflowFactStore, WorkflowRunDescriptor } from "./WorkflowFactStore"

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

function exactOutput(value: unknown, outputs: readonly string[], label: string): Record<string, unknown> {
  const output = record(value)
  const actual = Object.keys(output)
  if (actual.length !== outputs.length || !actual.every((key) => outputs.includes(key))) {
    throw new Error(`${label} must return exact output keys [${outputs.join(", ")}], got [${actual.join(", ")}]`)
  }
  return Object.fromEntries(outputs.map((key) => [key, output[key]]))
}

function workflowRef(descriptor: WorkflowRunDescriptor) {
  return {
    ref: descriptor.workflowRef,
    scheme: descriptor.workflowRef.startsWith("resource://") ? "resource" as const : "vfs" as const,
  }
}

export class AIDataWorkflowRuntimeDriver {
  private graph?: AIDataWorkflowRunGraph
  private activeRunAuthority: AIWorkflowRunRef
  private readonly code = createFilesystemCodeResolver<any>((specifier) => import(specifier))
  private readonly aiRuntime: ReturnType<typeof createAIDataWorkflowRuntime>

  constructor(
    private readonly runtime: WorkflowRuntime,
    private readonly workspace: WorkflowAuthoringWorkspace,
    private readonly facts: WorkflowFactStore,
    private readonly descriptor: WorkflowRunDescriptor,
    private readonly definition: ResolvedWorkflowDefinition,
    roots: { globalRoot: string; workspaceRoot: string },
    onMaterialWrite?: ConstructorParameters<typeof EidolonWorkflowEffectProvider>[3],
  ) {
    this.activeRunAuthority = this.runRef(descriptor.generation)
    this.aiRuntime = createAIDataWorkflowRuntime({
      ai: {
        roots,
        stateStore: facts,
        effects: new EidolonWorkflowEffectProvider(
          runtime,
          new StoreBackedWorkflowMaterialAccess(workspace.store),
          facts,
          onMaterialWrite,
          () => this.activeRunAuthority,
        ),
        metadata: { run: this.activeRunAuthority },
      },
    })
  }

  async start(input: unknown): Promise<DataRunProjection> {
    if (this.definition.binding.kind !== "AIDataWorkflow") throw new Error("Expected AIDataWorkflow binding")
    this.graph = createAIDataWorkflowRunGraph({
      binding: this.definition.binding,
      runId: this.descriptor.runId,
    })
    await this.facts.saveDataGraph(this.graph)
    await this.advance(record(input))
    return this.project("workflow.run")
  }

  async restore(): Promise<boolean> {
    const stored = await this.facts.loadDataGraph(this.descriptor.runId)
    if (!stored) return false
    let graph = restoreAIDataWorkflowRunGraph(stored)
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
    if (graph !== stored) await this.persist()
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
        output = exactOutput(input, this.definition.binding.definition.contract.outputPorts, node.id)
      } else if (node.tag === "TransformNode" || node.tag === "SinkNode") {
        const planNode = this.definition.binding.definition.nodeById[node.id] as any
        const reference = planNode?.src ?? planNode?.impl ?? node.config.src ?? node.config.impl
        if (typeof reference !== "string") throw new Error(`${node.id} has no EagerDataFlow code binding`)
        const fn = await this.code({
          reference,
          flowId: this.definition.binding.definition.fqn,
          nodeId: node.id,
          baseUri: this.definition.binding.definition.baseUri,
        })
        const result = await fn(this.runtimeForGeneration(generation), input, node.config)
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
        output: { error: String((error as Error)?.message ?? error) },
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
      workflow: Object.freeze(workflowRef(this.descriptor)),
      runId: this.descriptor.runId,
      generation,
    })
  }

  private runtimeForGeneration(generation: number): ReturnType<typeof createAIDataWorkflowRuntime> {
    this.activeRunAuthority = this.runRef(generation)
    return {
      ...this.aiRuntime,
      ai: {
        ...this.aiRuntime.ai,
        metadata: {
          ...this.aiRuntime.ai.metadata,
          run: this.activeRunAuthority,
        },
      },
    }
  }

  private async persist(): Promise<void> {
    await this.facts.saveDataGraph(this.graph!)
    const state = projectAIDataWorkflowRunState(this.graph!, workflowRef(this.descriptor))
    await this.facts.saveRunState({
      ...state,
      status: this.statusValue() === "Waiting" ? "Waiting" : state.status,
    })
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
