import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type {
  AIDataWorkflowChildInvocationRuntimePort,
  AIDataWorkflowGraphPatch,
  AIDataWorkflowRunGraph,
  AIDataWorkflowRunNode,
  AIDataControlAdmission,
  AIDataControlDecision,
  AIDataControlObservation,
  AIDataControlVerifierFact,
  AIWorkflowNodeResult,
  AIWorkflowRunRef,
} from "@cell/ai-workflow-contract"
import {
  acceptAIDataWorkflowChildTerminalReceipt,
  applyAIDataWorkflowGraphPatch,
  commitAIDataWorkflowCheckpoint,
  createAIDataWorkflowCheckpoint,
  createAIDataWorkflowChildInvocationIdentity,
  createAIDataWorkflowAgentNodeRuntimeBinder,
  createAIDataWorkflowRunGraph,
  createAIDataWorkflowRuntime,
  createAIDataWorkflowSemanticFingerprint,
  findReusableAIDataWorkflowNodeResult,
  listReadyAIDataWorkflowNodes,
  loadAIDataWorkflowCheckpoint,
  normalizeAIDataWorkflowChildInvocationObservation,
  normalizeAIDataWorkflowChildTerminalReceipt,
  projectAIDataWorkflowRunState,
  recordAIDataWorkflowNodeResult,
  recordAIDataWorkflowChildFreezeReceipt,
  reserveAIDataWorkflowChildInvocation,
  restoreAIDataWorkflowRunGraph,
} from "ai-data-workflow-logic"
import type { AIWorkflowFlowRunCheckpoint, FlowClosedValue, FrozenAIAgentTaskBinding } from "ai-workflow-contract"
import type { FrozenHolonTaskTarget } from "ai-workflow-contract"
import { assertFrozenAIAgentTaskBinding } from "ai-workflow-logic/run-freeze"
import { bindAIAgentProcessors, normalizeFlowClosedObject } from "ai-workflow-logic"
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
import {
  resolveAIDataDynamicAgentBinding,
  findAIDataAutonomousControlState,
  findAIDataAutonomousControlStateInExtensions,
  readAIDataAutonomousControlState,
  selectAIDataAgentDispatch,
  transitionAIDataAutonomousControlCheckpoint,
  type AIDataAutonomousControlPhase,
  type AIDataAutonomousControlState,
  type AIDataDynamicAgentBinding,
} from "./AIDataAutonomousControlLoop"
import {
  AIDataAutonomousAdmissionValidationError,
  AIDataAutonomousControllerOutputError,
  projectAIDataAutonomousControllerPayload,
  runAIDataAutonomousControlLoop,
  type AIDataAutonomousControllerInput,
  type AIDataAutonomousControllerResult,
  type AIDataAutonomousControlRunResult,
  type AIDataAutonomousVerifierPort,
} from "./AIDataAutonomousControlRunner"
import { AgentExecutionContractError } from "../../agent/AgentExecutionContract"
import { bindAIDataPreparedAgentSlots, writeAIDataExecutionFailures, type AIDataExecutionFailure } from "./AIDataChildAgentPreparation"
import {
  readAIDataAgentPreparationReceipts,
  writeAIDataAgentPreparationExtensions,
  writeAIDataPreparedAgentCapabilities,
  type AIDataPreparedAgentResource,
} from "./AIDataAgentResourcePreparation"

type WorkflowRuntime = AiAgentOneActorRuntime<any, any>

class AIDataChildInvocationSuspendedError extends Error {}

export type AIDataWorkflowHolonTaskFacade = Readonly<{
  proofForNode(nodeId: string): FrozenHolonTaskTarget
  openTask(input: unknown, config: unknown): Promise<unknown>
  consumeTask(input: unknown, config: Readonly<Record<string, never>>): Promise<unknown>
}>

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
  private autonomousControlPhase?: AIDataAutonomousControlPhase
  private activeRunAuthority: AIWorkflowRunRef
  private readonly code = createFilesystemCodeResolver<any>((specifier) => import(specifier))
  private readonly aiRuntime: ReturnType<typeof createAIDataWorkflowRuntime>
  private readonly bindAgentNode?: ReturnType<typeof createAIDataWorkflowAgentNodeRuntimeBinder>
  private readonly agentEffects: EidolonWorkflowEffectProvider
  private pendingExecutionFailures: AIDataExecutionFailure[] = []

  constructor(
    private readonly runtime: WorkflowRuntime,
    private readonly workspace: WorkflowAuthoringWorkspace,
    private readonly facts: WorkflowFactStore,
    private readonly depa: WorkflowDepaPersistence,
    private readonly descriptor: WorkflowRunDescriptor,
    private readonly definition: ResolvedWorkflowDefinition,
    roots: { globalRoot: string; workspaceRoot: string },
    onMaterialWrite?: ConstructorParameters<typeof EidolonWorkflowEffectProvider>[3],
    resourceRegistry?: Pick<EidolonAppResourceRegistryAdapter, "prepareWorkflowAgentExecution">,
    private readonly taskProofs: Readonly<Record<string, FrozenAIAgentTaskBinding>> = {},
    private readonly taskProofRefs: Readonly<Record<string, readonly `resource://${string}`[]>> = {},
    stepExtensions?: WorkflowStepExtensionAuthoredFacade,
    private readonly holonTasks?: AIDataWorkflowHolonTaskFacade,
    private readonly preparedAgents: readonly AIDataPreparedAgentResource[] = [],
    private readonly childInvocations?: AIDataWorkflowChildInvocationRuntimePort,
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
      { instanceId: descriptor.instanceId, workflowForm: descriptor.form },
    )
    this.agentEffects = agentEffects
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
        taskProofs: this.taskProofs,
        generationForNode: (nodeId) => this.graph?.nodes[nodeId]?.generation ?? descriptor.generation,
      })
      this.bindAgentNode = (nodeRuntime, identity) => {
        if (!this.taskProofs[identity.nodeId]) return nodeRuntime
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
    const definitionStepExtensions = this.depa.initialStepExtensions(
      this.descriptor.instanceId,
      instance.descriptor.definition,
      "AIDataWorkflow",
    )
    const initialCheckpoint = await createAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      instanceId: this.descriptor.instanceId,
      definition: instance.descriptor.definition,
      graph: this.durableGraph(),
      input: record(input) as FlowClosedValue,
      config: { requestFingerprint: this.descriptor.requestFingerprint },
      state: { status: "Pending", generation: this.graph.currentGeneration },
      output: null,
      controllerSidecars: { status: "Pending" },
      nodeSidecars: this.nodeSidecars(),
      ai: EMPTY_AI_WORKFLOW_DURABLE_STATE,
      stepExtensions: definitionStepExtensions,
    })
    const preparedCheckpoint = await this.completePreparationCheckpoint(initialCheckpoint)
    const autonomousControl = findAIDataAutonomousControlStateInExtensions(preparedCheckpoint.stepExtensions)
    if (autonomousControl) {
      this.autonomousControlPhase = autonomousControl.phase
      this.assertAutonomousControlBarrier(this.graph, autonomousControl)
    }
    const bound = bindAIDataPreparedAgentSlots(this.graph, this.preparedAgents)
    if (bound !== this.graph) {
      this.graph = bound
      this.descriptor.generation = bound.currentGeneration
      await this.facts.saveDescriptor(this.descriptor)
      await this.persist()
    }
    await this.advance(record(input))
    return this.project("workflow.run")
  }

  private async completePreparationCheckpoint(initialCheckpoint: Awaited<ReturnType<typeof createAIDataWorkflowCheckpoint>>) {
    const receipts = this.preparedAgents.map(({ receipt }) => receipt)
    const existingReceipts = readAIDataAgentPreparationReceipts(initialCheckpoint.stepExtensions)
    const receiptExtensions = canonicalJson(existingReceipts) === canonicalJson(receipts)
      ? initialCheckpoint.stepExtensions
      : writeAIDataAgentPreparationExtensions(initialCheckpoint.stepExtensions, receipts)
    let preparedCheckpoint = initialCheckpoint
    if (receiptExtensions !== initialCheckpoint.stepExtensions) {
      preparedCheckpoint = await commitAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
        expectedVersion: preparedCheckpoint.version,
        checkpoint: {
          ...preparedCheckpoint,
          version: preparedCheckpoint.version + 1,
          stepExtensions: receiptExtensions,
        },
      })
    }
    const control = findAIDataAutonomousControlStateInExtensions(preparedCheckpoint.stepExtensions)
    const capabilitiesMissing = control && receipts.some(({ capability }) =>
      canonicalJson(control.binding.catalog.capabilities[capability.capabilityId] ?? null) !== canonicalJson(capability))
    const preparedStepExtensions = capabilitiesMissing
      ? writeAIDataPreparedAgentCapabilities(preparedCheckpoint.stepExtensions, receipts)
      : preparedCheckpoint.stepExtensions
    if (preparedStepExtensions !== preparedCheckpoint.stepExtensions) {
      preparedCheckpoint = await commitAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
        expectedVersion: preparedCheckpoint.version,
        checkpoint: {
          ...preparedCheckpoint,
          version: preparedCheckpoint.version + 1,
          stepExtensions: preparedStepExtensions,
        },
      })
    }
    return preparedCheckpoint
  }

  async restore(): Promise<boolean> {
    let stored = await loadAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      instanceId: this.descriptor.instanceId,
      runId: this.descriptor.runId,
    })
    if (!stored) return false
    const durablePreparations = readAIDataAgentPreparationReceipts(stored.stepExtensions)
    const recoveredPreparations = this.preparedAgents.map(({ receipt }) => receipt)
    if (canonicalJson(durablePreparations) !== canonicalJson(recoveredPreparations)
      && !(stored.version === 0 && durablePreparations.length === 0)) {
      throw new Error("AI_DATA_AGENT_PREPARATION_CHECKPOINT_DRIFT")
    }
    if (stored.profile.runGraph.currentGeneration === 0
      && Object.keys(stored.profile.ai.invocationsByKey).length === 0) {
      stored = await this.completePreparationCheckpoint(stored)
    }
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
    const preparedGraph = bindAIDataPreparedAgentSlots(graph, this.preparedAgents)
    this.graph = preparedGraph
    this.autonomousControlPhase = findAIDataAutonomousControlState(
      stored as unknown as AIWorkflowFlowRunCheckpoint,
    )?.phase
    this.descriptor.generation = preparedGraph.currentGeneration
    if (preparedGraph !== graph) await this.facts.saveDescriptor(this.descriptor)
    if (preparedGraph !== graph || Object.values(graph.nodes).some((node) => node.status === "Running" && node.nodeType !== "manual")) await this.persist()
    return true
  }

  async continue(): Promise<DataRunProjection> {
    await this.requireGraph()
    for (const node of Object.values(this.graph!.nodes)) {
      if (node.tag === "SubFlowNode" && node.status === "Running") {
        this.graph = recordAIDataWorkflowNodeResult(this.graph!, node.id, {
          nodeId: node.id,
          generation: node.generation,
          status: "Pending",
          semanticFingerprint: node.semanticFingerprint,
        })
      }
    }
    await this.persist()
    await this.advance()
    return this.project("workflow.runResume")
  }

  async status(): Promise<DataRunProjection | undefined> {
    if (!this.graph && !await this.restore()) return undefined
    return this.project("workflow.runStatus")
  }

  async resumeManual(nodeId: string, output: unknown): Promise<DataRunProjection> {
    await this.requireGraph()
    const control = await this.loadAutonomousControlState()
    if (control?.binding.controlNodeId === nodeId) {
      throw new Error(`AI_DATA_CONTROL_BARRIER_RESUME_FORBIDDEN: ${nodeId}`)
    }
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
    const control = await this.loadAutonomousControlState()
    if (control && patch.operations.some((operation) => (
      (operation.op === "remove-node" || operation.op === "update-node")
        ? operation.nodeId === control.binding.controlNodeId
        : operation.node.id === control.binding.controlNodeId
    ))) {
      throw new Error(`AI_DATA_CONTROL_BARRIER_PATCH_FORBIDDEN: ${control.binding.controlNodeId}`)
    }
    const candidate = applyAIDataWorkflowGraphPatch(this.graph!, patch)
    for (const node of Object.values(candidate.nodes)) {
      if (node.status !== "Removed" && node.config.agent !== undefined) this.dynamicAgentBinding(node)
    }
    this.graph = candidate
    this.descriptor.generation = this.graph.currentGeneration
    await this.facts.saveDescriptor(this.descriptor)
    await this.persist()
    await this.advance()
    return this.project("workflow.graphPatch")
  }

  async autonomousControlCheckpoint(): Promise<AIWorkflowFlowRunCheckpoint | undefined> {
    const checkpoint = await loadAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      instanceId: this.descriptor.instanceId,
      runId: this.descriptor.runId,
    })
    const canonical = checkpoint as unknown as AIWorkflowFlowRunCheckpoint | undefined
    const control = canonical ? findAIDataAutonomousControlState(canonical) : undefined
    if (!canonical || !control) return undefined
    this.autonomousControlPhase = control.phase
    return canonical
  }

  async commitAutonomousControlTransition(input: Readonly<{
    observation: AIDataControlObservation
    decision: AIDataControlDecision
    admission: AIDataControlAdmission
    verifier: AIDataControlVerifierFact
    budget?: import("ai-data-workflow-contract").AIDataControlBudget
  }>): Promise<DataRunProjection> {
    await this.requireGraph()
    const current = await this.autonomousControlCheckpoint()
    if (!current) throw new Error(`AI_DATA_CONTROL_STATE_MISSING: ${this.descriptor.runId}`)
    const candidate = transitionAIDataAutonomousControlCheckpoint(current, input)
    const accepted = await commitAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      expectedVersion: current.version,
      checkpoint: candidate as any,
    })
    if (accepted.profile.kind !== "AIDataWorkflow") {
      throw new Error(`AI_DATA_CONTROL_PROFILE_MISMATCH: ${this.descriptor.runId}`)
    }
    this.autonomousControlPhase = readAIDataAutonomousControlState(
      accepted as unknown as AIWorkflowFlowRunCheckpoint,
    ).phase
    this.graph = restoreAIDataWorkflowRunGraph({
      ...accepted.profile.runGraph,
      binding: this.definition.binding.kind === "AIDataWorkflow"
        ? this.definition.binding
        : (accepted.profile.runGraph as any).binding,
    } as any)
    this.descriptor.generation = this.graph.currentGeneration
    await this.facts.saveDescriptor(this.descriptor)
    if (input.admission.kind === "patch" || input.admission.kind === "complete") await this.advance()
    return this.project(input.admission.kind === "patch" ? "workflow.graphPatch" : "workflow.runStatus")
  }

  async runAutonomousControl(
    verifier: AIDataAutonomousVerifierPort,
  ): Promise<AIDataAutonomousControlRunResult> {
    return runAIDataAutonomousControlLoop({
      verifier,
      checkpoint: {
        load: () => this.autonomousControlCheckpoint(),
        commit: async (input) => { await this.commitAutonomousControlTransition(input) },
      },
      controller: {
        decide: (input) => this.decideAutonomousControl(input),
      },
      admissionValidation: {
        validate: (input) => this.validateAutonomousAdmission(input),
      },
    })
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
      let haltedOnRepairableFailure = false
      for (const node of listReadyAIDataWorkflowNodes(this.graph!)) {
        progressed = true
        await this.applyNode(node, initialInput)
        initialInput = undefined
        const appliedStatus = this.graph!.nodes[node.id]?.status
        if (appliedStatus === "Failed"
          || ((this.autonomousControlPhase === "planning" || this.autonomousControlPhase === "executing")
            && appliedStatus === "Invalidated")) {
          haltedOnRepairableFailure = appliedStatus === "Invalidated"
          break
        }
      }
      if (haltedOnRepairableFailure
        || Object.values(this.graph!.nodes).some((node) => node.status === "Failed")) break
    }
    await this.persist()
  }

  private async applyNode(node: AIDataWorkflowRunNode, initialInput?: Record<string, unknown>): Promise<void> {
    const generation = node.generation
    const input = node.tag === "EntryNode" ? (initialInput ?? this.initialInput()) : this.effectiveInput(node)
    const dynamicAgent = this.dynamicAgentBinding(node)
    const fingerprint = createAIDataWorkflowSemanticFingerprint({
      nodeId: node.id,
      nodeTag: node.tag,
      effectiveInput: input,
      config: node.config,
      materialRevisions: record(node.config.material_revisions) as Record<string, string>,
      effectPolicy: { operation: node.config.operation, nodeType: node.nodeType },
    })
    const reusable = node.tag === "SubFlowNode"
      ? undefined
      : findReusableAIDataWorkflowNodeResult({
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
    if (node.tag === "SubFlowNode") {
      await this.applySubFlowNode(node.id, input)
      return
    }
    try {
      let output: unknown
      if (node.tag === "EntryNode") {
        output = exactOutput(input, node.outputs, node.id)
      } else if (node.tag === "ReturnNode") {
        if (this.definition.binding.kind !== "AIDataWorkflow") throw new Error("Expected AIDataWorkflow binding")
        output = exactOutput(input, this.definition.binding.definition.contract.outputPorts, node.id)
      } else if (node.tag === "TransformNode" || node.tag === "SinkNode") {
        if (this.definition.binding.kind !== "AIDataWorkflow") throw new Error("Expected AIDataWorkflow binding")
        const result = dynamicAgent
          ? await this.executeDynamicAgent(node, dynamicAgent, input, generation)
          : await this.executeCodeNode(node, input, generation)
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
      this.pendingExecutionFailures.push({ nodeId: node.id, generation,
        message: String((error as Error)?.message ?? error) })
      this.graph = recordAIDataWorkflowNodeResult(this.graph!, node.id, {
        nodeId: node.id,
        generation,
        status: this.autonomousControlPhase === "planning" || this.autonomousControlPhase === "executing"
          ? "Invalidated"
          : "Failed",
        semanticFingerprint: fingerprint,
      })
    }
    await this.persist()
  }

  private async applySubFlowNode(nodeId: string, input: Record<string, unknown>): Promise<void> {
    const node = this.graph!.nodes[nodeId]
    if (!node || node.tag !== "SubFlowNode" || node.subflow?.kind !== "autonomous") {
      this.graph = recordAIDataWorkflowNodeResult(this.graph!, nodeId, {
        nodeId,
        generation: node?.generation ?? this.graph!.currentGeneration,
        status: "Failed",
        semanticFingerprint: node?.semanticFingerprint,
      })
      await this.persist()
      return
    }
    if (!this.childInvocations) {
      this.graph = recordAIDataWorkflowNodeResult(this.graph!, nodeId, {
        nodeId,
        generation: node.generation,
        status: "Failed",
        semanticFingerprint: node.semanticFingerprint,
      })
      await this.persist()
      return
    }
    try {
      const identity = node.childInvocation ?? createAIDataWorkflowChildInvocationIdentity({
        graph: this.graph!,
        parentInstanceId: this.descriptor.instanceId,
        nodeId,
      })
      this.graph = reserveAIDataWorkflowChildInvocation({ graph: this.graph!, identity })
      await this.persist()
      let current = this.graph!.nodes[nodeId]!
      let freeze = current.childFreezeReceipt
      if (!freeze) {
        freeze = await this.childInvocations.resolveAndFreeze({ identity })
        this.graph = recordAIDataWorkflowChildFreezeReceipt({ graph: this.graph!, nodeId, receipt: freeze })
        await this.persist()
        current = this.graph!.nodes[nodeId]!
        freeze = current.childFreezeReceipt
      }
      if (!freeze) throw new Error(`AI_DATA_CHILD_FREEZE_RECEIPT_MISSING: ${nodeId}`)
      let observation = normalizeAIDataWorkflowChildInvocationObservation(
        await this.childInvocations.startOrContinue({
          identity,
          freeze,
          input: normalizeFlowClosedObject(input, `aiData.child.${nodeId}.input`),
        }),
        identity,
      )
      if (observation.status === "Reserved" || observation.status === "Running") {
        observation = normalizeAIDataWorkflowChildInvocationObservation(
          await this.childInvocations.load({ identity, freeze }),
          identity,
        )
      }
      if (observation.status === "Reserved" || observation.status === "Running") {
        throw new AIDataChildInvocationSuspendedError(
          `AI Data child invocation ${nodeId} is ${observation.status}`,
        )
      }
      const receipt = normalizeAIDataWorkflowChildTerminalReceipt(
        await this.childInvocations.settle({ identity, freeze, terminalStatus: observation.status }),
        identity,
      )
      this.graph = acceptAIDataWorkflowChildTerminalReceipt({ graph: this.graph!, nodeId, receipt })
    } catch (error) {
      if (error instanceof AIDataChildInvocationSuspendedError) {
        await this.persist()
        return
      }
      const failed = this.graph!.nodes[nodeId]
      this.pendingExecutionFailures.push({ nodeId, generation: failed?.generation ?? this.graph!.currentGeneration,
        message: String((error as Error)?.message ?? error) })
      this.graph = recordAIDataWorkflowNodeResult(this.graph!, nodeId, {
        nodeId,
        generation: failed?.generation ?? this.graph!.currentGeneration,
        status: this.autonomousControlPhase === "planning" || this.autonomousControlPhase === "executing"
          ? "Invalidated"
          : "Failed",
        semanticFingerprint: failed?.semanticFingerprint,
      })
    }
    await this.persist()
  }

  private dynamicAgentBinding(node: AIDataWorkflowRunNode): AIDataDynamicAgentBinding | undefined {
    if (node.config.agent === undefined) return undefined
    if (!this.definition.resourceReceipt || this.definition.binding.kind !== "AIDataWorkflow") {
      throw new Error(`AI_DATA_AGENT_FROZEN_RESOURCE_REQUIRED: dynamic Agent node ${node.id} requires a frozen resource workflow`)
    }
    return resolveAIDataDynamicAgentBinding({
      node,
      workflowRef: this.descriptor.workflowRef as `resource://${string}`,
      taskProofs: this.taskProofs,
      taskProofRefs: this.taskProofRefs,
    })
  }

  private validateAutonomousAdmission(input: Readonly<{
    state: AIDataAutonomousControlState
    decision: AIDataControlDecision
    admission: AIDataControlAdmission
  }>): void {
    if (input.admission.kind !== "patch" || input.decision.kind !== "revise") return
    for (const operation of input.decision.operations) {
      if (operation.op === "remove-node") continue
      const controlNodeId = input.state.binding.controlNodeId
      const readsControlBarrier = operation.dependsOn?.includes(controlNodeId) === true
        || Object.values(operation.inputs).some((binding) => binding.kind === "port" && binding.nodeId === controlNodeId)
      if (readsControlBarrier) {
        throw new AIDataAutonomousAdmissionValidationError(
          `decision.operations node '${operation.nodeId}' cannot depend on protected control barrier '${controlNodeId}'; the barrier is released only after verifier completion`,
        )
      }
      const capabilityId = operation.op === "add-subflow" || operation.op === "rewire-subflow"
        ? operation.subflowCapabilityId
        : operation.capabilityId
      const capability = input.state.binding.catalog.capabilities[capabilityId]
      const implementation = capability?.implementation
      if (!implementation || implementation.kind !== "agent") continue
      const allowedNodeIds = Object.entries(this.taskProofRefs)
        .filter(([, refs]) => refs.includes(implementation.taskProofRef))
        .map(([nodeId]) => nodeId)
        .sort()
      if (allowedNodeIds.length === 0) {
        throw new Error(`AI_DATA_CONTROL_TASK_PROOF_MISSING: ${implementation.taskProofRef}`)
      }
      if (!allowedNodeIds.includes(operation.nodeId)) {
        throw new AIDataAutonomousAdmissionValidationError(
          `decision.operations nodeId '${operation.nodeId}' does not select the exact frozen task proof node; allowed nodeIds: ${allowedNodeIds.join(", ")}`,
        )
      }
      const proof = this.taskProofs[operation.nodeId]
      if (!proof) throw new Error(`AI_DATA_CONTROL_TASK_PROOF_MISSING: ${operation.nodeId}`)
      const task = assertFrozenAIAgentTaskBinding(proof).task
      if (task.workflowKind !== "AIDataWorkflow"
        || task.workflowRef !== this.descriptor.workflowRef
        || task.nodeId !== operation.nodeId
        || task.agentDefinitionRef !== implementation.agentDefinitionRef) {
        throw new Error(`AI_DATA_CONTROL_TASK_PROOF_IDENTITY_MISMATCH: ${operation.nodeId}`)
      }
    }
  }

  private async executeDynamicAgent(
    node: AIDataWorkflowRunNode,
    binding: AIDataDynamicAgentBinding,
    input: Record<string, unknown>,
    generation: number,
  ): Promise<unknown> {
    const checkpoint = await loadAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      instanceId: this.descriptor.instanceId,
      runId: this.descriptor.runId,
    })
    if (!checkpoint || checkpoint.profile.kind !== "AIDataWorkflow") {
      throw new Error(`AI_DATA_AGENT_CHECKPOINT_MISSING: ${this.descriptor.runId}`)
    }
    const dispatch = selectAIDataAgentDispatch(checkpoint.profile.ai, {
      instanceName: binding.instanceName,
      agentDefinitionRef: binding.agentDefinitionRef,
      payload: input as FlowClosedValue,
    })
    const effects = (this.runtimeForGeneration(generation, node.id) as any).ai?.effects
    if (!effects || typeof effects.runAgent !== "function" || typeof effects.runTargetedAgent !== "function") {
      throw new Error(`AI_DATA_AGENT_RUNTIME_UNBOUND: ${node.id}`)
    }
    const result = dispatch.mode === "new"
      ? await effects.runAgent(dispatch.input, dispatch.config)
      : await effects.runTargetedAgent(dispatch.selector, dispatch.invocation, dispatch.config)
    return result.output
  }

  private async executeCodeNode(
    node: AIDataWorkflowRunNode,
    input: Record<string, unknown>,
    generation: number,
  ): Promise<unknown> {
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
    return fn(this.runtimeForGeneration(generation, node.id), input, node.config)
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
    return record(entry?.result?.output ?? this.descriptor.frozenInput)
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
    const bound = this.bindAgentNode && nodeId ? this.bindAgentNode(runtime, { nodeId }) : runtime
    return this.holonTasks
      ? Object.freeze({ ...bound, holonTasks: this.holonTasks })
      : bound
  }

  private async persist(): Promise<void> {
    const current = await loadAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      instanceId: this.descriptor.instanceId,
      runId: this.descriptor.runId,
    })
    if (!current) throw new Error(`AIDataWorkflow checkpoint missing for ${this.descriptor.runId}`)
    this.autonomousControlPhase = findAIDataAutonomousControlState(
      current as unknown as AIWorkflowFlowRunCheckpoint,
    )?.phase
    if ((current.controllerSidecars.status === "Succeeded" || current.controllerSidecars.status === "Failed")
      && canonicalJson(current.profile.runGraph) === canonicalJson(this.durableGraph())) {
      return
    }
    const checkpointStatus = this.statusValue() === "Waiting" ? "Running" : this.statusValue()
    const stepExtensions = writeAIDataExecutionFailures(current.stepExtensions, this.pendingExecutionFailures)
    await commitAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      expectedVersion: current.version,
      checkpoint: {
        ...current,
        version: current.version + 1,
        state: { status: checkpointStatus, generation: this.graph!.currentGeneration },
        output: this.checkpointOutput(),
        controllerSidecars: { ...current.controllerSidecars, status: checkpointStatus },
        nodeSidecars: this.nodeSidecars(),
        ...(stepExtensions === undefined ? {} : { stepExtensions }),
        profile: { ...current.profile, runGraph: this.durableGraph() },
      },
    })
    this.pendingExecutionFailures = []
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
    return JSON.parse(canonicalJson({
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
    })) as DataRunProjection
  }

  private async requireGraph(): Promise<void> {
    if (!this.graph && !await this.restore()) throw new Error(`AIDataWorkflow graph missing for ${this.descriptor.runId}`)
  }

  private assertAutonomousControlBarrier(
    graph: AIDataWorkflowRunGraph,
    control: AIDataAutonomousControlState,
  ): void {
    const barrier = graph.nodes[control.binding.controlNodeId]
    if (!barrier || barrier.nodeType !== "manual") {
      throw new Error(`AI_DATA_CONTROL_BARRIER_INVALID: ${control.binding.controlNodeId}`)
    }
    if (!control.binding.catalog.foundationNodes[barrier.id]?.protected) {
      throw new Error(`AI_DATA_CONTROL_BARRIER_NOT_PROTECTED: ${barrier.id}`)
    }
  }

  private async loadAutonomousControlState(): Promise<AIDataAutonomousControlState | undefined> {
    const checkpoint = await this.autonomousControlCheckpoint()
    return checkpoint ? readAIDataAutonomousControlState(checkpoint) : undefined
  }

  private async decideAutonomousControl(
    input: AIDataAutonomousControllerInput,
  ): Promise<AIDataAutonomousControllerResult> {
    return this.invokeFrozenController({
      state: input.state,
      invocationKey: `${input.state.binding.controlNodeId}#control-${input.state.iteration}`,
      payload: projectAIDataAutonomousControllerPayload(input) as unknown as FlowClosedValue,
      metadata: { controlIteration: input.state.iteration, observationId: input.observation.observationId },
    })
  }

  async childPreparationFeedback(nodeId: string) {
    const checkpoint = await this.autonomousControlCheckpoint()
    if (!checkpoint || checkpoint.profile.kind !== "AIDataWorkflow") throw new Error("AI_DATA_CHILD_PREPARATION_PARENT_MISSING")
    const state = readAIDataAutonomousControlState(checkpoint)
    const node = (checkpoint.profile.runGraph as unknown as AIDataWorkflowRunGraph).nodes[nodeId]
    const proof = this.taskProofs[nodeId]
    const observed = state.latestObservation?.graph.nodes.find(item => item.nodeId === nodeId)
    const verifier = state.latestVerifier
    if (!node || !proof || !node.result || !observed || !verifier || verifier.status !== "failed"
      || observed.status !== node.status || verifier.graphGeneration !== state.latestObservation!.graph.generation) {
      throw new Error("AI_DATA_CHILD_PREPARATION_FEEDBACK_UNVERIFIED")
    }
    const task = assertFrozenAIAgentTaskBinding(proof).task
    if (task.nodeId !== nodeId || task.workflowRef !== this.descriptor.workflowRef) throw new Error("AI_DATA_CHILD_PREPARATION_PROOF_MISMATCH")
    const attemptKey = `${nodeId}#${node.generation}`
    if (!checkpoint.profile.ai.invocationsByKey[attemptKey]) throw new Error("AI_DATA_CHILD_PREPARATION_ATTEMPT_MISSING")
    const executionFailure = state.executionFailures?.find(failure => failure.nodeId === nodeId && failure.generation === node.generation)
    return { proof, evidence: {
      parentInstanceId: this.descriptor.instanceId, parentRunId: this.descriptor.runId, nodeId,
      generation: node.generation, checkpointVersion: checkpoint.version,
      observationRef: state.latestObservation!.observationId,
      attemptRef: `${this.descriptor.runId}/${attemptKey}`, verificationRef: verifier.factId,
      previousExecutionFingerprint: proof.semanticFingerprint,
      verifier, result: node.result,
      ...(executionFailure === undefined ? {} : { executionFailure }),
    } }
  }

  async selectChildWorker(input: { invocationKey: string; payload: FlowClosedValue }): Promise<FlowClosedValue> {
    const checkpoint = await this.autonomousControlCheckpoint()
    if (!checkpoint) throw new Error("AI_DATA_CHILD_PREPARATION_PARENT_MISSING")
    return (await this.invokeFrozenController({ ...input, state: readAIDataAutonomousControlState(checkpoint),
      metadata: { childPreparationInvocation: input.invocationKey } })).value
  }

  private async invokeFrozenController(input: {
    state: AIDataAutonomousControlState
    invocationKey: string
    payload: FlowClosedValue
    metadata: Record<string, FlowClosedValue>
  }): Promise<AIDataAutonomousControllerResult> {
    if (this.definition.binding.kind !== "AIDataWorkflow" || !this.definition.resourceReceipt) {
      throw new Error("AI_DATA_CONTROL_RESOURCE_WORKFLOW_REQUIRED: controller execution requires a frozen resource workflow")
    }
    const binding = input.state.binding.controller
    const nodeId = input.state.binding.controlNodeId
    if (this.taskProofRefs[nodeId]?.includes(binding.taskProofRef) !== true) {
      throw new Error(`AI_DATA_CONTROL_TASK_PROOF_REF_MISMATCH: ${binding.taskProofRef}`)
    }
    const proof = this.taskProofs[nodeId]
    if (!proof) throw new Error(`AI_DATA_CONTROL_TASK_PROOF_MISSING: ${nodeId}`)
    const task = assertFrozenAIAgentTaskBinding(proof).task
    if (task.workflowKind !== "AIDataWorkflow"
      || task.workflowRef !== this.descriptor.workflowRef
      || task.nodeId !== nodeId
      || task.agentDefinitionRef !== binding.agentDefinitionRef) {
      throw new Error(`AI_DATA_CONTROL_TASK_PROOF_IDENTITY_MISMATCH: ${nodeId}`)
    }
    const checkpoint = await this.autonomousControlCheckpoint()
    if (!checkpoint || checkpoint.profile.kind !== "AIDataWorkflow") {
      throw new Error(`AI_DATA_CONTROL_STATE_MISSING: ${this.descriptor.runId}`)
    }
    const dispatch = selectAIDataAgentDispatch(checkpoint.profile.ai, {
      instanceName: binding.instanceName,
      agentDefinitionRef: binding.agentDefinitionRef,
      payload: input.payload,
    })
    const effects = bindAIAgentProcessors({
      checkpointRuntime: this.depa.checkpointRuntime,
      checkpointKey: { instanceId: this.descriptor.instanceId, runId: this.descriptor.runId },
      nodeId,
      invocationKey: input.invocationKey,
      generation: Number((checkpoint.profile.runGraph as any).currentGeneration),
      workflowKind: "AIDataWorkflow",
      workflowRef: this.descriptor.workflowRef as `resource://${string}`,
      taskBinding: task,
      effects: this.agentEffects,
      metadata: input.metadata,
    })
    try {
      const result = dispatch.mode === "new"
        ? await effects.runAgent(dispatch.input, dispatch.config)
        : await effects.runTargetedAgent(dispatch.selector, dispatch.invocation, dispatch.config)
      return Object.freeze({ value: result.output })
    } catch (error) {
      if (error instanceof AgentExecutionContractError) {
        throw new AIDataAutonomousControllerOutputError(error.message, error)
      }
      throw error
    }
  }
}

export type { DataRunProjection }
