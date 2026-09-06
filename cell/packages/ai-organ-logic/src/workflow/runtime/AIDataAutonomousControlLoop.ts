import type {
  AIDataControlAdmission,
  AIDataControlBudget,
  AIDataControlCapabilityCatalog,
  AIDataControlDecision,
  AIDataControlFeedback,
  AIDataControlGoal,
  AIDataControlIterationReceipt,
  AIDataControlObservation,
  AIDataControlVerifierFact,
  AIDataWorkflowRunGraph,
  AIDataWorkflowRunNode,
} from "ai-data-workflow-contract"
import {
  applyAIDataWorkflowGraphPatch,
  createAIDataControlRuntime,
  freezeAIDataControlCapabilityCatalog,
  recordAIDataWorkflowNodeResult,
} from "ai-data-workflow-logic"
import type {
  DefinitionStepExtensionCodecRegistryPort,
  DefinitionStepValue,
} from "flow-step-space-contract"
import type {
  AIAgentEffectConfig,
  AIAgentInvocation,
  AIAgentSelector,
  AIWorkflowFlowRunCheckpoint,
  AIWorkflowProfileDurableState,
  FlowRunStepExtensions,
  FlowClosedValue,
  FrozenAIAgentTaskBinding,
} from "ai-workflow-contract"
import { assertFrozenAIAgentTaskBinding } from "ai-workflow-logic/run-freeze"

export const AI_DATA_AUTONOMOUS_CONTROL_SCHEMA_VERSION = "eidolon.ai-data-autonomous-control/v1" as const
export const AI_DATA_AUTONOMOUS_CONTROL_EXTENSION_KIND = "eidolon.ai-data-autonomous-control" as const
export const AI_DATA_AUTONOMOUS_CONTROL_EXTENSION_SCHEMA_REF = "schema://eidolon.ai-data-autonomous-control/v1" as const

export type AIDataAutonomousControlPhase =
  | "planning"
  | "executing"
  | "verifying"
  | "completed"
  | "failed"

export type AIDataAutonomousControllerBinding = Readonly<{
  taskProofRef: `resource://${string}`
  agentDefinitionRef: `resource://${string}`
  instanceName: string
}>

export type AIDataAutonomousControlBinding = Readonly<{
  controlNodeId: string
  goal: AIDataControlGoal
  catalog: AIDataControlCapabilityCatalog
  controller: AIDataAutonomousControllerBinding
  maxObservedNodes: number
}>

export type AIDataAutonomousControlTerminal = Readonly<{
  kind: "complete" | "failed"
  code: string
}>

export type AIDataExecutionFailure = Readonly<{
  nodeId: string
  generation: number
  message: string
}>

export type AIDataAutonomousControlState = Readonly<{
  schemaVersion: typeof AI_DATA_AUTONOMOUS_CONTROL_SCHEMA_VERSION
  binding: AIDataAutonomousControlBinding
  budget: AIDataControlBudget
  phase: AIDataAutonomousControlPhase
  iteration: number
  noProgressCount: number
  feedback: readonly AIDataControlFeedback[]
  receipts: readonly AIDataControlIterationReceipt[]
  latestObservation?: AIDataControlObservation
  latestVerifier?: AIDataControlVerifierFact
  executionFailures?: readonly AIDataExecutionFailure[]
  terminal?: AIDataAutonomousControlTerminal
}>

export class AIDataAutonomousControlInvariantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "AIDataAutonomousControlInvariantError"
  }
}

function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AIDataAutonomousControlInvariantError(code, message)
}

function exactIdentity(value: unknown, code: string, label: string): string {
  invariant(typeof value === "string" && value.length > 0 && value === value.trim(), code, `${label} must be an exact non-empty identity`)
  return value
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function record(value: unknown): Record<string, unknown> {
  invariant(typeof value === "object" && value !== null && !Array.isArray(value),
    "AI_DATA_CONTROL_STATE_INVALID", "Autonomous control state must be a closed object")
  return value as Record<string, unknown>
}

function nonNegativeInteger(value: unknown, code: string, label: string): number {
  invariant(Number.isSafeInteger(value) && Number(value) >= 0, code, `${label} must be a non-negative safe integer`)
  return Number(value)
}

/**
 * Normalizes both the initial authored extension value and every later checkpoint
 * revision. The XNL resource may use a JSON string to retain a closed, lossless
 * representation of the protocol state without teaching the XNL parser the
 * protocol's nested vocabulary.
 */
export function normalizeAIDataAutonomousControlState(value: unknown): AIDataAutonomousControlState {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value
  const state = record(parsed)
  invariant(state.schemaVersion === AI_DATA_AUTONOMOUS_CONTROL_SCHEMA_VERSION,
    "AI_DATA_CONTROL_STATE_SCHEMA_MISMATCH", "Autonomous control state schema is unsupported")
  const binding = record(state.binding)
  const controlNodeId = exactIdentity(binding.controlNodeId,
    "AI_DATA_CONTROL_NODE_ID_INVALID", "binding.controlNodeId")
  const goal = record(binding.goal) as unknown as AIDataControlGoal
  const catalog = record(binding.catalog) as unknown as AIDataControlCapabilityCatalog
  const controller = record(binding.controller)
  const budget = record(state.budget) as unknown as AIDataControlBudget
  const usage = record(budget.usage)
  const iteration = nonNegativeInteger(state.iteration,
    "AI_DATA_CONTROL_CURSOR_INVALID", "iteration")
  const noProgressCount = nonNegativeInteger(state.noProgressCount,
    "AI_DATA_CONTROL_CURSOR_INVALID", "noProgressCount")
  invariant(goal.schemaVersion === "depa.ai-data-control/v1"
    && catalog.schemaVersion === "depa.ai-data-control/v1"
    && budget.schemaVersion === "depa.ai-data-control/v1",
  "AI_DATA_CONTROL_PROTOCOL_VERSION_INVALID", "Control binding must use depa.ai-data-control/v1")
  invariant(typeof goal.verifierRef === "string" && goal.verifierRef.startsWith("resource://")
    && typeof controller.agentDefinitionRef === "string" && controller.agentDefinitionRef.startsWith("resource://")
    && typeof controller.taskProofRef === "string" && controller.taskProofRef.startsWith("resource://"),
  "AI_DATA_CONTROL_RESOURCE_REF_INVALID", "Control resources must use exact resource:// references")
  exactIdentity(controller.instanceName, "AI_DATA_CONTROL_AGENT_NAME_INVALID", "binding.controller.instanceName")
  invariant(Number.isSafeInteger(binding.maxObservedNodes) && Number(binding.maxObservedNodes) > 0,
    "AI_DATA_CONTROL_OBSERVATION_LIMIT_INVALID", "binding.maxObservedNodes must be a positive safe integer")
  invariant(nonNegativeInteger(usage.iteration, "AI_DATA_CONTROL_BUDGET_CURSOR_INVALID", "budget.usage.iteration") === iteration
    && nonNegativeInteger(usage.noProgressIterations,
      "AI_DATA_CONTROL_BUDGET_CURSOR_INVALID", "budget.usage.noProgressIterations") === noProgressCount,
  "AI_DATA_CONTROL_BUDGET_CURSOR_MISMATCH", "Control cursor and budget usage are not reciprocal")
  invariant(Array.isArray(state.feedback) && Array.isArray(state.receipts),
    "AI_DATA_CONTROL_STATE_INVALID", "Control feedback and receipts must be arrays")
  if (state.executionFailures !== undefined) {
    invariant(Array.isArray(state.executionFailures), "AI_DATA_CONTROL_FAILURES_INVALID", "Execution failures must be an array")
    const attempts = new Set<string>()
    for (const value of state.executionFailures) {
      const failure = record(value)
      invariant(Object.keys(failure).sort().join(",") === "generation,message,nodeId"
        && typeof failure.message === "string", "AI_DATA_CONTROL_FAILURES_INVALID", "Execution failure must be an exact typed observation")
      const nodeId = exactIdentity(failure.nodeId, "AI_DATA_CONTROL_FAILURES_INVALID", "failure.nodeId")
      const generation = nonNegativeInteger(failure.generation, "AI_DATA_CONTROL_FAILURES_INVALID", "failure.generation")
      const key = `${nodeId}#${generation}`
      invariant(!attempts.has(key), "AI_DATA_CONTROL_FAILURES_INVALID", "Execution failure attempts must be unique")
      attempts.add(key)
    }
  }
  invariant(state.receipts.length === iteration,
    "AI_DATA_CONTROL_RECEIPT_CURSOR_MISMATCH", "Control receipt count must equal the iteration cursor")
  const phase = state.phase
  invariant(phase === "planning" || phase === "executing" || phase === "verifying"
    || phase === "completed" || phase === "failed",
  "AI_DATA_CONTROL_PHASE_INVALID", "Autonomous control phase is unsupported")

  const catalogContent = { ...catalog } as Record<string, unknown>
  delete catalogContent.digest
  const frozenCatalog = freezeAIDataControlCapabilityCatalog(
    createAIDataControlRuntime(),
    catalogContent as unknown as Omit<AIDataControlCapabilityCatalog, "digest">,
    {},
  )
  invariant(frozenCatalog.digest === catalog.digest,
    "AI_DATA_CONTROL_CATALOG_DIGEST_MISMATCH", "Frozen capability catalog digest does not match its content")
  return Object.freeze(clone(parsed as AIDataAutonomousControlState))
}

export function createAIDataAutonomousControlExtensionCodecRegistry(
  fallback?: DefinitionStepExtensionCodecRegistryPort,
): DefinitionStepExtensionCodecRegistryPort {
  return Object.freeze({
    resolve: (kind: string) => kind === AI_DATA_AUTONOMOUS_CONTROL_EXTENSION_KIND
      ? Object.freeze({
          schemaRef: AI_DATA_AUTONOMOUS_CONTROL_EXTENSION_SCHEMA_REF,
          codec: Object.freeze({
            normalize: (value: DefinitionStepValue) => (
              normalizeAIDataAutonomousControlState(value) as unknown as DefinitionStepValue
            ),
          }),
        })
      : fallback?.resolve(kind),
  })
}

export function createAIDataAutonomousControlState(input: Readonly<{
  controlNodeId: string
  goal: AIDataControlGoal
  catalog: AIDataControlCapabilityCatalog
  budget: AIDataControlBudget
  controller: AIDataAutonomousControllerBinding
  maxObservedNodes: number
}>): AIDataAutonomousControlState {
  const controlNodeId = exactIdentity(input.controlNodeId, "AI_DATA_CONTROL_NODE_ID_INVALID", "controlNodeId")
  const instanceName = exactIdentity(input.controller.instanceName, "AI_DATA_CONTROL_AGENT_NAME_INVALID", "controller.instanceName")
  invariant(Number.isSafeInteger(input.maxObservedNodes) && input.maxObservedNodes > 0,
    "AI_DATA_CONTROL_OBSERVATION_LIMIT_INVALID", "maxObservedNodes must be a positive safe integer")
  invariant(input.goal.schemaVersion === "depa.ai-data-control/v1"
    && input.catalog.schemaVersion === "depa.ai-data-control/v1"
    && input.budget.schemaVersion === "depa.ai-data-control/v1",
  "AI_DATA_CONTROL_PROTOCOL_VERSION_INVALID", "Control binding must use depa.ai-data-control/v1")
  invariant(input.goal.verifierRef.startsWith("resource://")
    && input.controller.agentDefinitionRef.startsWith("resource://")
    && input.controller.taskProofRef.startsWith("resource://"),
  "AI_DATA_CONTROL_RESOURCE_REF_INVALID", "Control resources must use exact resource:// references")
  invariant(input.budget.usage.iteration === 0 && input.budget.usage.noProgressIterations === 0,
    "AI_DATA_CONTROL_BUDGET_INITIAL_USAGE_INVALID", "Initial control budget usage must be zero")
  return normalizeAIDataAutonomousControlState({
    schemaVersion: AI_DATA_AUTONOMOUS_CONTROL_SCHEMA_VERSION,
    binding: Object.freeze({
      controlNodeId,
      goal: clone(input.goal),
      catalog: clone(input.catalog),
      controller: Object.freeze({ ...input.controller, instanceName }),
      maxObservedNodes: input.maxObservedNodes,
    }),
    budget: clone(input.budget),
    phase: "planning",
    iteration: 0,
    noProgressCount: 0,
    feedback: Object.freeze([]),
    receipts: Object.freeze([]),
  })
}

export type AIDataAgentDispatch =
  | Readonly<{
    mode: "new"
    input: FlowClosedValue
    config: AIAgentEffectConfig & { readonly instanceName: string }
  }>
  | Readonly<{
    mode: "targeted"
    selector: Extract<AIAgentSelector, { readonly byId: string }>
    invocation: AIAgentInvocation
    config: AIAgentEffectConfig
  }>

export function selectAIDataAgentDispatch(
  ai: AIWorkflowProfileDurableState,
  input: Readonly<{
    instanceName: string
    agentDefinitionRef: `resource://${string}`
    payload: FlowClosedValue
  }>,
): AIDataAgentDispatch {
  const instanceName = exactIdentity(input.instanceName, "AI_DATA_AGENT_NAME_INVALID", "instanceName")
  const indexedId = ai.instanceIdByName[instanceName]
  const namedInstances = Object.values(ai.instancesById).filter((instance) => instance.instanceName === instanceName)
  if (indexedId === undefined) {
    invariant(namedInstances.length === 0, "AI_DATA_AGENT_INSTANCE_INDEX_MISSING",
      `Agent instance '${instanceName}' exists without its reciprocal name index`)
    return Object.freeze({
      mode: "new",
      input: input.payload,
      config: Object.freeze({ agentDefinitionRef: input.agentDefinitionRef, instanceName }),
    })
  }
  const instance = ai.instancesById[indexedId]
  invariant(instance !== undefined, "AI_DATA_AGENT_INSTANCE_MISSING",
    `Agent name '${instanceName}' points to missing instance '${indexedId}'`)
  invariant(instance.instanceName === instanceName && namedInstances.length === 1,
    "AI_DATA_AGENT_INSTANCE_INDEX_CONFLICT", `Agent instance '${instanceName}' does not have a reciprocal unique index`)
  invariant(instance.agentDefinitionRef === input.agentDefinitionRef,
    "AI_DATA_AGENT_DEFINITION_MISMATCH", `Agent instance '${instanceName}' belongs to another AgentDefinition`)
  return Object.freeze({
    mode: "targeted",
    selector: Object.freeze({ byId: instance.instanceId }),
    invocation: Object.freeze({ kind: "ai.agent", payload: input.payload }),
    config: Object.freeze({ agentDefinitionRef: input.agentDefinitionRef }),
  })
}

export type AIDataDynamicAgentBinding = Readonly<{
  taskProofRef: `resource://${string}`
  agentDefinitionRef: `resource://${string}`
  instanceName: string
  proof: FrozenAIAgentTaskBinding
}>

export function resolveAIDataDynamicAgentBinding(input: Readonly<{
  node: AIDataWorkflowRunNode
  workflowRef: `resource://${string}`
  taskProofs: Readonly<Record<string, FrozenAIAgentTaskBinding>>
  taskProofRefs: Readonly<Record<string, readonly `resource://${string}`[]>>
}>): AIDataDynamicAgentBinding | undefined {
  const config = input.node.config.agent
  if (config === undefined) return undefined
  invariant(typeof config === "object" && config !== null && !Array.isArray(config),
    "AI_DATA_AGENT_CONFIG_INVALID", `Dynamic Agent node '${input.node.id}' requires a closed agent config`)
  const agent = config as Record<string, unknown>
  const agentDefinitionRef = exactIdentity(agent.agentDefinitionRef,
    "AI_DATA_AGENT_DEFINITION_REF_INVALID", `Dynamic Agent node '${input.node.id}' agentDefinitionRef`)
  const taskProofRef = exactIdentity(agent.taskProofRef,
    "AI_DATA_AGENT_TASK_PROOF_REF_INVALID", `Dynamic Agent node '${input.node.id}' taskProofRef`)
  invariant(agentDefinitionRef.startsWith("resource://") && taskProofRef.startsWith("resource://"),
    "AI_DATA_AGENT_RESOURCE_REF_INVALID", `Dynamic Agent node '${input.node.id}' requires resource:// identities`)
  invariant(input.taskProofRefs[input.node.id]?.includes(taskProofRef as `resource://${string}`) === true,
    "AI_DATA_AGENT_TASK_PROOF_REF_MISMATCH", `Dynamic Agent node '${input.node.id}' does not select its exact frozen task proof`)
  const proof = input.taskProofs[input.node.id]
  invariant(proof !== undefined, "AI_DATA_AGENT_TASK_PROOF_MISSING",
    `Dynamic Agent node '${input.node.id}' has no frozen task proof`)
  assertFrozenAIAgentTaskBinding(proof)
  invariant(proof.task.workflowKind === "AIDataWorkflow"
    && proof.task.workflowRef === input.workflowRef
    && proof.task.nodeId === input.node.id
    && proof.task.agentDefinitionRef === agentDefinitionRef,
  "AI_DATA_AGENT_TASK_PROOF_IDENTITY_MISMATCH",
  `Dynamic Agent node '${input.node.id}' does not match the frozen workflow, node and AgentDefinition tuple`)
  const configuredName = input.node.config.instanceName
  const instanceName = configuredName === undefined
    ? `node:${input.node.id}`
    : exactIdentity(configuredName, "AI_DATA_AGENT_NAME_INVALID", `Dynamic Agent node '${input.node.id}' instanceName`)
  return Object.freeze({
    taskProofRef: taskProofRef as `resource://${string}`,
    agentDefinitionRef: agentDefinitionRef as `resource://${string}`,
    instanceName,
    proof,
  })
}

export function findAIDataAutonomousControlStateInExtensions(
  extensions: FlowRunStepExtensions | undefined,
): AIDataAutonomousControlState | undefined {
  const matches = Object.entries(extensions?.byStepId ?? {}).flatMap(([stepId, byKind]) => {
    const fact = byKind[AI_DATA_AUTONOMOUS_CONTROL_EXTENSION_KIND]
    return fact ? [{ stepId, fact }] : []
  })
  invariant(matches.length <= 1, "AI_DATA_CONTROL_STATE_DUPLICATE",
    "Canonical checkpoint contains multiple autonomous control extension facts")
  if (matches.length === 0) return undefined
  const { stepId, fact } = matches[0]!
  invariant(fact.schemaRef === AI_DATA_AUTONOMOUS_CONTROL_EXTENSION_SCHEMA_REF,
    "AI_DATA_CONTROL_STATE_SCHEMA_MISMATCH", "Autonomous control extension schema is unsupported")
  const value = normalizeAIDataAutonomousControlState(fact.value)
  invariant(value.binding.controlNodeId === stepId,
    "AI_DATA_CONTROL_STATE_STEP_MISMATCH", "Autonomous control extension is bound to another control node")
  invariant(value.iteration === value.budget.usage.iteration
    && value.noProgressCount === value.budget.usage.noProgressIterations,
  "AI_DATA_CONTROL_BUDGET_CURSOR_MISMATCH", "Control cursor and budget usage are not reciprocal")
  return value
}

export function findAIDataAutonomousControlState(
  checkpoint: AIWorkflowFlowRunCheckpoint,
): AIDataAutonomousControlState | undefined {
  return findAIDataAutonomousControlStateInExtensions(checkpoint.stepExtensions)
}

export function readAIDataAutonomousControlState(checkpoint: AIWorkflowFlowRunCheckpoint): AIDataAutonomousControlState {
  const value = findAIDataAutonomousControlState(checkpoint)
  invariant(value !== undefined, "AI_DATA_CONTROL_STATE_MISSING",
    "Canonical checkpoint has no autonomous control extension fact")
  return value
}

export function writeAIDataAutonomousControlExtension(
  current: FlowRunStepExtensions | undefined,
  state: AIDataAutonomousControlState,
): FlowRunStepExtensions {
  const currentByStep = current?.byStepId ?? {}
  const currentByKind = currentByStep[state.binding.controlNodeId] ?? {}
  const prior = currentByKind[AI_DATA_AUTONOMOUS_CONTROL_EXTENSION_KIND]
  return Object.freeze({
    schemaVersion: "depa.flow-run-step-extensions/v1",
    byStepId: Object.freeze({
      ...currentByStep,
      [state.binding.controlNodeId]: Object.freeze({
        ...currentByKind,
        [AI_DATA_AUTONOMOUS_CONTROL_EXTENSION_KIND]: Object.freeze({
          schemaRef: AI_DATA_AUTONOMOUS_CONTROL_EXTENSION_SCHEMA_REF,
          revision: prior === undefined ? 0 : prior.revision + 1,
          value: state as unknown as FlowClosedValue,
        }),
      }),
    }),
  })
}

function assertProtectedControlPatch(
  controlNodeId: string,
  admission: AIDataControlAdmission,
): void {
  if (admission.kind !== "patch") return
  const touchesBarrier = admission.patch.operations.some((operation) => (
    (operation.op === "remove-node" || operation.op === "update-node")
      ? operation.nodeId === controlNodeId
      : operation.node.id === controlNodeId
  ))
  invariant(!touchesBarrier, "AI_DATA_CONTROL_BARRIER_PATCH_FORBIDDEN",
    `Graph patch must not mutate protected control node '${controlNodeId}'`)
}

function graphState(checkpoint: AIWorkflowFlowRunCheckpoint): AIDataWorkflowRunGraph {
  invariant(checkpoint.profile.kind === "AIDataWorkflow",
    "AI_DATA_CONTROL_PROFILE_MISMATCH", "Autonomous control requires an AIDataWorkflow checkpoint")
  return checkpoint.profile.runGraph as unknown as AIDataWorkflowRunGraph
}

function graphNodeSidecars(graph: AIDataWorkflowRunGraph): Record<string, FlowClosedValue> {
  return Object.fromEntries(graph.declarationOrder.flatMap((nodeId) => {
    const node = graph.nodes[nodeId]
    return node ? [[nodeId, { status: node.status, generation: node.generation } as FlowClosedValue]] : []
  }))
}

function checkpointStatus(graph: AIDataWorkflowRunGraph): "Pending" | "Running" | "Succeeded" | "Failed" {
  const nodes = Object.values(graph.nodes).filter((node) => node.status !== "Removed")
  if (nodes.some((node) => node.status === "Failed")) return "Failed"
  if (nodes.some((node) => node.status === "Running")) return "Running"
  if (nodes.length > 0 && nodes.every((node) => node.status === "Succeeded" || node.status === "Reused")) {
    return "Succeeded"
  }
  return "Pending"
}

function completionOutput(graph: AIDataWorkflowRunGraph): FlowClosedValue {
  if (checkpointStatus(graph) !== "Succeeded") return null
  const output = graph.declarationOrder
    .map((nodeId) => graph.nodes[nodeId])
    .find((node) => node?.tag === "ReturnNode")
    ?.result?.output
  return output as FlowClosedValue ?? null
}

function controlBarrierOutput(
  graph: AIDataWorkflowRunGraph,
  barrier: AIDataWorkflowRunNode,
  admission: Extract<AIDataControlAdmission, { readonly kind: "complete" }>,
): Readonly<Record<string, FlowClosedValue>> {
  const inputs = Object.fromEntries(Object.entries(barrier.inputs).map(([port, binding]) => {
    if (binding && typeof binding === "object" && !Array.isArray(binding)
      && "nodeId" in binding && "port" in binding) {
      const ref = binding as { readonly nodeId: string; readonly port: string }
      const upstream = graph.nodes[ref.nodeId]?.result?.output
      invariant(typeof upstream === "object" && upstream !== null && !Array.isArray(upstream),
        "AI_DATA_CONTROL_BARRIER_INPUT_MISSING", `Control barrier input '${port}' has no durable upstream output`)
      return [port, (upstream as Readonly<Record<string, FlowClosedValue>>)[ref.port]]
    }
    return [port, binding as FlowClosedValue]
  }))
  const selectedOutput = graph.nodes[admission.outputNodeId]?.result?.output
  invariant(typeof selectedOutput === "object" && selectedOutput !== null && !Array.isArray(selectedOutput)
    && Object.prototype.hasOwnProperty.call(selectedOutput, admission.outputPort),
  "AI_DATA_CONTROL_COMPLETION_OUTPUT_MISSING", "Completion output is not durably present in the canonical graph")
  const selectedValue = (selectedOutput as Readonly<Record<string, FlowClosedValue>>)[admission.outputPort]
  return Object.freeze(Object.fromEntries(barrier.outputs.map((port) => {
    if (barrier.outputs.length === 1 || port === admission.outputPort) return [port, selectedValue]
    invariant(Object.prototype.hasOwnProperty.call(inputs, port),
      "AI_DATA_CONTROL_BARRIER_OUTPUT_UNBOUND", `Control barrier output '${port}' requires a same-named input binding`)
    return [port, inputs[port] as FlowClosedValue]
  })))
}

export function transitionAIDataAutonomousControlCheckpoint(
  current: AIWorkflowFlowRunCheckpoint,
  input: Readonly<{
    observation: AIDataControlObservation
    decision: AIDataControlDecision
    admission: AIDataControlAdmission
    verifier: AIDataControlVerifierFact
    budget?: AIDataControlBudget
  }>,
): AIWorkflowFlowRunCheckpoint {
  const state = readAIDataAutonomousControlState(current)
  const graph = graphState(current)
  const runtime = createAIDataControlRuntime()
  const budget = input.budget ?? state.budget
  invariant(state.phase !== "completed" && state.phase !== "failed",
    "AI_DATA_CONTROL_TERMINAL", "Terminal autonomous control state is immutable")
  invariant(input.observation.graph.runId === graph.runId
    && input.observation.graph.generation === graph.currentGeneration
    && input.observation.graph.digest === runtime.stableDigest(graph),
  "AI_DATA_CONTROL_STALE_OBSERVATION", "Control transition requires the current canonical graph observation")
  invariant(input.observation.observationId === input.decision.observationId
    && input.observation.observationDigest === input.decision.observationDigest,
  "AI_DATA_CONTROL_DECISION_OBSERVATION_MISMATCH", "Decision does not address the supplied observation")
  invariant(input.admission.decisionId === input.decision.decisionId
    && input.admission.decisionDigest === runtime.stableDigest(input.decision),
  "AI_DATA_CONTROL_ADMISSION_DECISION_MISMATCH", "Admission does not authenticate the supplied decision")
  invariant(input.verifier.factId === input.observation.verifier.factId
    && input.verifier.graphGeneration === graph.currentGeneration
    && input.verifier.goalId === state.binding.goal.goalId
    && input.verifier.verifierRef === state.binding.goal.verifierRef,
  "AI_DATA_CONTROL_VERIFIER_MISMATCH", "Verifier is not the exact current host-owned fact")
  invariant(runtime.stableDigest(budget.limits) === runtime.stableDigest(state.budget.limits),
    "AI_DATA_CONTROL_BUDGET_LIMITS_CHANGED", "Control budget limits are immutable")
  invariant(budget.usage.iteration === state.iteration
    && budget.usage.noProgressIterations === state.noProgressCount,
  "AI_DATA_CONTROL_BUDGET_CURSOR_MISMATCH", "Control budget must address the current cursor")
  invariant((budget.usage.tokensUsed ?? 0) >= (state.budget.usage.tokensUsed ?? 0)
    && (budget.usage.nowEpochMs ?? 0) >= (state.budget.usage.nowEpochMs ?? 0),
  "AI_DATA_CONTROL_BUDGET_USAGE_REGRESSION", "Host-owned budget usage cannot move backwards")
  assertProtectedControlPatch(state.binding.controlNodeId, input.admission)

  const generationBefore = graph.currentGeneration
  let nextGraph = graph
  let feedback: readonly AIDataControlFeedback[] = []
  let phase: AIDataAutonomousControlPhase = "planning"
  let noProgressCount = 0
  let terminal: AIDataAutonomousControlTerminal | undefined

  if (input.admission.kind === "patch") {
    nextGraph = applyAIDataWorkflowGraphPatch(graph, input.admission.patch)
    phase = "executing"
  } else if (input.admission.kind === "complete") {
    invariant(input.verifier.status === "passed"
      && input.admission.verifierFactId === input.verifier.factId,
    "AI_DATA_CONTROL_VERIFIER_PASS_REQUIRED", "Completion requires the exact current passing verifier")
    const barrier = graph.nodes[state.binding.controlNodeId]
    invariant(barrier?.nodeType === "manual" && barrier.result?.status === "Waiting",
      "AI_DATA_CONTROL_BARRIER_INVALID", "Completion requires the explicit waiting protected control node")
    nextGraph = recordAIDataWorkflowNodeResult(graph, barrier.id, {
      nodeId: barrier.id,
      generation: barrier.generation,
      status: "Succeeded",
      output: controlBarrierOutput(graph, barrier, input.admission),
      semanticFingerprint: barrier.semanticFingerprint,
    })
    phase = "completed"
    terminal = Object.freeze({ kind: "complete", code: "VERIFIER_PASSED" })
  } else if (input.admission.kind === "fail") {
    const barrier = graph.nodes[state.binding.controlNodeId]
    invariant(barrier !== undefined, "AI_DATA_CONTROL_BARRIER_MISSING", "Failure transition requires the protected control node")
    nextGraph = recordAIDataWorkflowNodeResult(graph, barrier.id, {
      nodeId: barrier.id,
      generation: barrier.generation,
      status: "Failed",
      ...(barrier.semanticFingerprint === undefined ? {} : { semanticFingerprint: barrier.semanticFingerprint }),
    })
    phase = "failed"
    terminal = Object.freeze({ kind: "failed", code: input.admission.failureCode })
  } else {
    feedback = Object.freeze(input.admission.feedback.map((item) => Object.freeze({ ...item })))
    noProgressCount = state.noProgressCount + 1
    phase = input.admission.terminal ? "failed" : "planning"
    if (input.admission.terminal) {
      const barrier = graph.nodes[state.binding.controlNodeId]
      invariant(barrier !== undefined, "AI_DATA_CONTROL_BARRIER_MISSING",
        "Terminal rejection requires the protected control node")
      nextGraph = recordAIDataWorkflowNodeResult(graph, barrier.id, {
        nodeId: barrier.id,
        generation: barrier.generation,
        status: "Failed",
        ...(barrier.semanticFingerprint === undefined ? {} : { semanticFingerprint: barrier.semanticFingerprint }),
      })
      terminal = Object.freeze({ kind: "failed", code: "BUDGET_EXHAUSTED" })
    }
  }

  const iteration = state.iteration + 1
  const receipt: AIDataControlIterationReceipt = Object.freeze({
    schemaVersion: "depa.ai-data-control/v1",
    iteration,
    observationId: input.observation.observationId,
    observationDigest: input.observation.observationDigest,
    decisionId: input.decision.decisionId,
    decisionDigest: input.admission.decisionDigest,
    admissionKind: input.admission.kind,
    generationBefore,
    generationAfter: nextGraph.currentGeneration,
  })
  const nextState: AIDataAutonomousControlState = Object.freeze({
    ...state,
    budget: Object.freeze({
      ...budget,
      usage: Object.freeze({
        ...budget.usage,
        iteration,
        noProgressIterations: noProgressCount,
      }),
    }),
    phase,
    iteration,
    noProgressCount,
    feedback,
    receipts: Object.freeze([...state.receipts, receipt]),
    latestObservation: clone(input.observation),
    latestVerifier: clone(input.verifier),
    ...(terminal === undefined ? {} : { terminal }),
  })
  const status = checkpointStatus(nextGraph)
  return Object.freeze({
    ...current,
    version: current.version + 1,
    state: { status, generation: nextGraph.currentGeneration },
    output: completionOutput(nextGraph),
    controllerSidecars: { status },
    nodeSidecars: graphNodeSidecars(nextGraph),
    stepExtensions: writeAIDataAutonomousControlExtension(current.stepExtensions, nextState),
    profile: { ...current.profile, runGraph: nextGraph },
  }) as unknown as AIWorkflowFlowRunCheckpoint
}
