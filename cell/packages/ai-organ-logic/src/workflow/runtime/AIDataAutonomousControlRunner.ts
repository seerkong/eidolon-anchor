import type {
  AIDataControlAdmission,
  AIDataControlBudget,
  AIDataControlDecision,
  AIDataControlGoal,
  AIDataControlVerifierFact,
  AIDataWorkflowRunGraph,
} from "ai-data-workflow-contract"
import {
  AIDataControlProtocolError,
  admitAIDataControlDecision,
  createAIDataControlRuntime,
  normalizeAIDataControlDecision,
  projectAIDataControlObservation,
} from "ai-data-workflow-logic"
import type { AIWorkflowFlowRunCheckpoint, FlowClosedValue } from "ai-workflow-contract"

import {
  readAIDataAutonomousControlState,
  type AIDataAutonomousControlState,
} from "./AIDataAutonomousControlLoop"

export class AIDataAutonomousControllerOutputError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = "AIDataAutonomousControllerOutputError"
  }
}

export class AIDataAutonomousAdmissionValidationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = "AIDataAutonomousAdmissionValidationError"
  }
}

export type AIDataAutonomousVerifierInput = Readonly<{
  checkpointVersion: number
  runId: string
  goal: AIDataControlGoal
  graph: AIDataWorkflowRunGraph
}>

export interface AIDataAutonomousVerifierPort {
  verify(input: AIDataAutonomousVerifierInput): Promise<AIDataControlVerifierFact>
}

export type AIDataAutonomousControllerInput = Readonly<{
  state: AIDataAutonomousControlState
  observation: ReturnType<typeof projectAIDataControlObservation>
}>

export type AIDataAutonomousControllerPayload = Readonly<{
  schemaVersion: "eidolon.ai-data-controller-input/v1"
  goal: AIDataControlGoal
  catalog: AIDataAutonomousControlState["binding"]["catalog"]
  observation: ReturnType<typeof projectAIDataControlObservation>
}>

export function projectAIDataAutonomousControllerPayload(
  input: AIDataAutonomousControllerInput,
): AIDataAutonomousControllerPayload {
  return Object.freeze({
    schemaVersion: "eidolon.ai-data-controller-input/v1",
    goal: input.state.binding.goal,
    catalog: input.state.binding.catalog,
    observation: input.observation,
  })
}

export type AIDataAutonomousControllerResult = Readonly<{
  value: FlowClosedValue
  /** Cumulative usage for this run, not a per-turn delta. */
  cumulativeTokensUsed?: number
}>

export interface AIDataAutonomousControllerPort {
  decide(input: AIDataAutonomousControllerInput): Promise<AIDataAutonomousControllerResult>
}

export interface AIDataAutonomousAdmissionValidationPort {
  validate(input: Readonly<{
    state: AIDataAutonomousControlState
    graph: AIDataWorkflowRunGraph
    observation: ReturnType<typeof projectAIDataControlObservation>
    decision: AIDataControlDecision
    admission: AIDataControlAdmission
  }>): Promise<void> | void
}

export interface AIDataAutonomousCheckpointPort {
  load(): Promise<AIWorkflowFlowRunCheckpoint | undefined>
  commit(input: Readonly<{
    observation: ReturnType<typeof projectAIDataControlObservation>
    decision: AIDataControlDecision
    admission: AIDataControlAdmission
    verifier: AIDataControlVerifierFact
    budget: AIDataControlBudget
  }>): Promise<void>
}

export type AIDataAutonomousControlRunResult = Readonly<{
  checkpoint: AIWorkflowFlowRunCheckpoint
  state: AIDataAutonomousControlState
}>

export type AIDataAutonomousControlRunnerOptions = Readonly<{
  checkpoint: AIDataAutonomousCheckpointPort
  controller: AIDataAutonomousControllerPort
  verifier: AIDataAutonomousVerifierPort
  admissionValidation?: AIDataAutonomousAdmissionValidationPort
  now?: () => number
}>

function graph(checkpoint: AIWorkflowFlowRunCheckpoint): AIDataWorkflowRunGraph {
  if (checkpoint.profile.kind !== "AIDataWorkflow") {
    throw new Error("AI_DATA_CONTROL_PROFILE_MISMATCH: autonomous control requires AIDataWorkflow")
  }
  return checkpoint.profile.runGraph as unknown as AIDataWorkflowRunGraph
}

function currentBudget(state: AIDataAutonomousControlState, now: () => number): AIDataControlBudget {
  return Object.freeze({
    ...state.budget,
    usage: Object.freeze({
      ...state.budget.usage,
      ...(state.budget.limits.deadlineEpochMs === undefined ? {} : { nowEpochMs: now() }),
    }),
  })
}

function exhaustionReason(budget: AIDataControlBudget): string | undefined {
  if (budget.usage.iteration >= budget.limits.maxIterations) return "iteration budget exhausted"
  if (budget.usage.noProgressIterations >= budget.limits.maxNoProgressIterations) {
    return "no-progress budget exhausted"
  }
  if (budget.limits.maxTokens !== undefined
    && (budget.usage.tokensUsed ?? 0) >= budget.limits.maxTokens) return "token budget exhausted"
  if (budget.limits.deadlineEpochMs !== undefined
    && (budget.usage.nowEpochMs ?? 0) >= budget.limits.deadlineEpochMs) return "deadline budget exhausted"
  return undefined
}

function syntheticFailureDecision(
  state: AIDataAutonomousControlState,
  observation: ReturnType<typeof projectAIDataControlObservation>,
  reason: string,
): Extract<AIDataControlDecision, { readonly kind: "fail" }> {
  const runtime = createAIDataControlRuntime()
  return Object.freeze({
    schemaVersion: "depa.ai-data-control/v1",
    kind: "fail",
    decisionId: `host-fail:${state.iteration}:${runtime.stableDigest(reason)}`,
    goalId: state.binding.goal.goalId,
    observationId: observation.observationId,
    observationDigest: observation.observationDigest,
    catalogDigest: state.binding.catalog.digest,
    reason,
    failureCode: "BUDGET_EXHAUSTED",
  })
}

function invalidOutputAdmission(
  state: AIDataAutonomousControlState,
  observation: ReturnType<typeof projectAIDataControlObservation>,
  error: unknown,
): Readonly<{ decision: AIDataControlDecision; admission: AIDataControlAdmission }> {
  const runtime = createAIDataControlRuntime()
  const message = String((error as Error)?.message ?? error).slice(0, 480)
  const decision: AIDataControlDecision = Object.freeze({
    schemaVersion: "depa.ai-data-control/v1",
    kind: "fail",
    decisionId: `invalid:${state.iteration}:${runtime.stableDigest(message)}`,
    goalId: state.binding.goal.goalId,
    observationId: observation.observationId,
    observationDigest: observation.observationDigest,
    catalogDigest: state.binding.catalog.digest,
    reason: "Controller output did not satisfy the typed decision contract",
    failureCode: "CONTROLLER_DECLARED_FAILURE",
  })
  const nextIteration = state.iteration + 1
  const nextNoProgress = state.noProgressCount + 1
  return Object.freeze({
    decision,
    admission: Object.freeze({
      schemaVersion: "depa.ai-data-control/v1",
      kind: "rejected",
      decisionId: decision.decisionId,
      decisionDigest: runtime.stableDigest(decision),
      feedback: Object.freeze([{ code: "INVALID_DECISION" as const, message }]),
      terminal: nextIteration >= state.budget.limits.maxIterations
        || nextNoProgress >= state.budget.limits.maxNoProgressIterations,
    }),
  })
}

function decisionValue(value: FlowClosedValue): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new AIDataAutonomousControllerOutputError("Controller output is not valid JSON", error)
  }
}

function withControllerUsage(
  budget: AIDataControlBudget,
  result: AIDataAutonomousControllerResult,
): AIDataControlBudget {
  if (budget.limits.maxTokens === undefined) return budget
  if (!Number.isSafeInteger(result.cumulativeTokensUsed) || Number(result.cumulativeTokensUsed) < 0) {
    throw new Error("AI_DATA_CONTROL_TOKEN_METER_REQUIRED: maxTokens requires cumulative host usage")
  }
  if (Number(result.cumulativeTokensUsed) < (budget.usage.tokensUsed ?? 0)) {
    throw new Error("AI_DATA_CONTROL_TOKEN_USAGE_REGRESSION: cumulative host usage moved backwards")
  }
  return Object.freeze({
    ...budget,
    usage: Object.freeze({ ...budget.usage, tokensUsed: Number(result.cumulativeTokensUsed) }),
  })
}

export async function runAIDataAutonomousControlLoop(
  options: AIDataAutonomousControlRunnerOptions,
): Promise<AIDataAutonomousControlRunResult> {
  const runtime = createAIDataControlRuntime()
  const now = options.now ?? Date.now
  while (true) {
    const checkpoint = await options.checkpoint.load()
    if (!checkpoint) throw new Error("AI_DATA_CONTROL_STATE_MISSING: canonical checkpoint does not exist")
    const state = readAIDataAutonomousControlState(checkpoint)
    if (state.phase === "completed" || state.phase === "failed") {
      return Object.freeze({ checkpoint, state })
    }
    const canonicalGraph = graph(checkpoint)
    let budget = currentBudget(state, now)
    const observationBudget = budget
    const verifier = await options.verifier.verify({
      checkpointVersion: checkpoint.version,
      runId: canonicalGraph.runId,
      goal: state.binding.goal,
      graph: canonicalGraph,
    })
    const observation = projectAIDataControlObservation(runtime, {
      goal: state.binding.goal,
      budget: observationBudget,
      catalog: state.binding.catalog,
      graph: canonicalGraph,
      verifier,
      feedback: state.feedback,
    }, { maxObservedNodes: state.binding.maxObservedNodes })

    const exhausted = exhaustionReason(budget)
    if (exhausted) {
      const decision = syntheticFailureDecision(state, observation, exhausted)
      const admission: AIDataControlAdmission = Object.freeze({
        schemaVersion: "depa.ai-data-control/v1",
        kind: "fail",
        decisionId: decision.decisionId,
        decisionDigest: runtime.stableDigest(decision),
        failureCode: "BUDGET_EXHAUSTED",
        reason: exhausted,
      })
      await options.checkpoint.commit({ observation, decision, admission, verifier, budget })
      continue
    }

    let decision: AIDataControlDecision
    let admission: AIDataControlAdmission
    try {
      const result = await options.controller.decide({ state, observation })
      budget = withControllerUsage(budget, result)
      decision = normalizeAIDataControlDecision(runtime, decisionValue(result.value), {
        maxOperations: state.budget.limits.maxOperationsPerDecision,
      })
      admission = admitAIDataControlDecision(runtime, {
        goal: state.binding.goal,
        budget: observationBudget,
        catalog: state.binding.catalog,
        graph: canonicalGraph,
        verifier,
        observation,
        decision,
      }, { decisionLimits: { maxOperations: state.budget.limits.maxOperationsPerDecision } })
      await options.admissionValidation?.validate({
        state,
        graph: canonicalGraph,
        observation,
        decision,
        admission,
      })
    } catch (error) {
      if (!(error instanceof AIDataControlProtocolError)
        && !(error instanceof AIDataAutonomousControllerOutputError)
        && !(error instanceof AIDataAutonomousAdmissionValidationError)) throw error
      const invalid = invalidOutputAdmission(state, observation, error)
      decision = invalid.decision
      admission = invalid.admission
    }
    await options.checkpoint.commit({ observation, decision, admission, verifier, budget })
  }
}
