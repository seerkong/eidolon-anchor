import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import type { ActorRuntimeFacetVmRuntime } from "@cell/ai-core-contract/runtime/ActorRuntimeFacet"
import {
  parseWorkflowDomainProgressFact,
  type WorkflowDomainProgressTransition,
} from "./WorkflowDomainProgress"
import {
  readWorkflowLifecycleFacet,
  replaceWorkflowLifecycleFacet,
  type WorkflowLifecycleDiagnosticEvidence,
  type WorkflowLifecycleFacetValue,
} from "./WorkflowLifecycleFacet"

export const DEFAULT_WORKFLOW_ACTOR_BUDGET = Object.freeze({
  stageDeadlineMs: 900_000,
  maxNoProgressTurns: 12,
  maxProofRepairAttempts: 3,
})

export type WorkflowActorBudgetConfig = Readonly<{
  stageDeadlineMs: number
  maxNoProgressTurns: number
  maxProofRepairAttempts: number
}>

export class WorkflowActorBudgetError extends Error {
  readonly code: "workflow_stage_deadline" | "workflow_no_progress" | "workflow_proof_repair_exhausted"

  constructor(code: WorkflowActorBudgetError["code"], message: string) {
    super(`${code}: ${message}`)
    this.name = "WorkflowActorBudgetError"
    this.code = code
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

export function resolveWorkflowActorBudgetConfig(outerCtx: unknown): WorkflowActorBudgetConfig {
  const metadata = record(record(outerCtx)?.metadata)
  const aiWorkflow = record(metadata?.aiWorkflow)
  const budget = record(aiWorkflow?.budget)
  return {
    stageDeadlineMs: positiveInteger(budget?.stageDeadlineMs, DEFAULT_WORKFLOW_ACTOR_BUDGET.stageDeadlineMs),
    maxNoProgressTurns: positiveInteger(budget?.maxNoProgressTurns, DEFAULT_WORKFLOW_ACTOR_BUDGET.maxNoProgressTurns),
    maxProofRepairAttempts: positiveInteger(budget?.maxProofRepairAttempts, DEFAULT_WORKFLOW_ACTOR_BUDGET.maxProofRepairAttempts),
  }
}

export function isWorkflowActor(actor: Pick<AiAgentActor, "runtimeFacets">): boolean {
  return readWorkflowLifecycleFacet(actor as Pick<AiAgentActor, "runtimeFacets">) !== undefined
}

function ensureProgress(actor: AiAgentActor): WorkflowLifecycleFacetValue | undefined {
  return readWorkflowLifecycleFacet(actor)
}

export function enterWorkflowActorStage(input: {
  actor: AiAgentActor
  runtime?: ActorRuntimeFacetVmRuntime
  expectedRevision?: number
  stageId: string
  now?: number
  config: WorkflowActorBudgetConfig
}): void {
  if (!isWorkflowActor(input.actor)) return
  const now = input.now ?? Date.now()
  const current = ensureProgress(input.actor)!
  if (current.stageId === input.stageId) return
  replaceWorkflowLifecycleFacet(input.actor, {
    ...current,
    stageId: input.stageId,
    stageStartedAt: now,
    deadlineAt: now + input.config.stageDeadlineMs,
    turnsSinceProgress: 0,
    maxNoProgressTurns: input.config.maxNoProgressTurns,
    proofRepairAttempts: 0,
    maxProofRepairAttempts: input.config.maxProofRepairAttempts,
    lastProgressAt: now,
    lastOutcome: "stage_selected",
    activeAuthoringSessionId: current.activeAuthoringSessionId,
    activeAuthoringRevision: current.activeAuthoringRevision,
  }, {
    runtime: input.runtime,
    actorKey: input.actor.key,
    expectedRevision: input.expectedRevision,
    reason: "workflow_stage_transition",
  })
}

export function beginWorkflowActorTurn(input: {
  actor: AiAgentActor
  runtime?: ActorRuntimeFacetVmRuntime
  expectedRevision?: number
  now?: number
  config: WorkflowActorBudgetConfig
}): void {
  if (!isWorkflowActor(input.actor)) return
  const now = input.now ?? Date.now()
  const progress = ensureProgress(input.actor)!
  if (now >= progress.deadlineAt) {
    throw new WorkflowActorBudgetError(
      "workflow_stage_deadline",
      `stage=${progress.stageId ?? "unselected"} exceeded deadline; lastOutcome=${progress.lastOutcome ?? "none"}`,
    )
  }
  const next = { ...progress, turnsSinceProgress: progress.turnsSinceProgress + 1 }
  if (next.turnsSinceProgress > next.maxNoProgressTurns) {
    throw new WorkflowActorBudgetError(
      "workflow_no_progress",
      `stage=${next.stageId ?? "unselected"} produced no workspace/proof/lifecycle/result progress for ${next.turnsSinceProgress} turns`,
    )
  }
  replaceWorkflowLifecycleFacet(input.actor, next, {
    runtime: input.runtime,
    actorKey: input.actor.key,
    expectedRevision: input.expectedRevision,
    reason: "workflow_turn_started",
  })
}

function outputIndicatesFailure(outputText: string | undefined): boolean {
  if (!outputText) return false
  try {
    const parsed = JSON.parse(outputText)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
    const descriptor = Object.getOwnPropertyDescriptor(parsed, "ok")
    return descriptor !== undefined && "value" in descriptor && descriptor.value === false
  } catch {
    return false
  }
}

const PROGRESS_OUTCOME_BY_TRANSITION: Readonly<Record<WorkflowDomainProgressTransition, string>> = {
  workspace_opened: "workspace_opened",
  workspace_revision_changed: "workspace_changed",
  candidate_diagnostic: "candidate_diagnostic",
  proof_prepared: "proof",
  lifecycle_completed: "lifecycle_changed",
  publication_created: "published",
  instance_prepared: "prepared",
  run_started: "running",
  run_advanced: "running",
  result_observed: "result",
}

export function recordWorkflowActorToolOutcome(input: {
  actor: AiAgentActor
  runtime?: ActorRuntimeFacetVmRuntime
  expectedRevision?: number
  toolName: string
  args?: unknown
  outputText?: string
  diagnosticEvidence?: WorkflowLifecycleDiagnosticEvidence
  isError: boolean
  now?: number
  config: WorkflowActorBudgetConfig
}): void {
  if (!isWorkflowActor(input.actor)) return
  const now = input.now ?? Date.now()
  const progress = ensureProgress(input.actor)!
  let next: WorkflowLifecycleFacetValue = { ...progress }
  const failed = input.isError || outputIndicatesFailure(input.outputText)
  const isProofTool = input.toolName === "WorkflowValidateAuthoringSession"
    || input.toolName === "WorkflowDryRunAuthoringSession"

  if (isProofTool && failed) {
    next = {
      ...next,
      proofRepairAttempts: next.proofRepairAttempts + 1,
      ...(input.diagnosticEvidence ? { lastDiagnosticEvidence: input.diagnosticEvidence } : {}),
    }
    replaceWorkflowLifecycleFacet(input.actor, next, {
      runtime: input.runtime,
      actorKey: input.actor.key,
      expectedRevision: input.expectedRevision,
      reason: "workflow_proof_failure",
    })
    if (next.proofRepairAttempts > next.maxProofRepairAttempts) {
      throw new WorkflowActorBudgetError(
        "workflow_proof_repair_exhausted",
        `stage=${next.stageId ?? "testing"} exhausted ${next.maxProofRepairAttempts} proof repair attempts; workspace is preserved`,
      )
    }
    return
  }

  const fact = failed ? undefined : parseWorkflowDomainProgressFact(input.outputText)
  if (!fact) return
  const outcome = PROGRESS_OUTCOME_BY_TRANSITION[fact.transition]

  if (fact.transition === "candidate_diagnostic") {
    next = {
      ...next,
      proofRepairAttempts: next.proofRepairAttempts + 1,
      ...(input.diagnosticEvidence ? { lastDiagnosticEvidence: input.diagnosticEvidence } : {}),
      turnsSinceProgress: 0,
      lastProgressAt: now,
      lastOutcome: outcome,
    }
    replaceWorkflowLifecycleFacet(input.actor, next, {
      runtime: input.runtime,
      actorKey: input.actor.key,
      expectedRevision: input.expectedRevision,
      reason: "workflow_candidate_diagnostic",
    })
    if (next.proofRepairAttempts > next.maxProofRepairAttempts) {
      throw new WorkflowActorBudgetError(
        "workflow_proof_repair_exhausted",
        `stage=${next.stageId ?? "coding"} exhausted ${next.maxProofRepairAttempts} candidate repair attempts`,
      )
    }
    return
  }

  const { lastDiagnosticEvidence: _diagnostic, ...withoutDiagnostic } = next
  next = { ...withoutDiagnostic, turnsSinceProgress: 0, lastProgressAt: now, lastOutcome: outcome }
  if (fact.owner === "workflow.authoring") {
    next = { ...next, activeAuthoringSessionId: fact.subjectId, activeAuthoringRevision: fact.revision }
  }
  if (outcome === "proof") next = { ...next, proofRepairAttempts: 0 }
  replaceWorkflowLifecycleFacet(input.actor, next, {
    runtime: input.runtime,
    actorKey: input.actor.key,
    expectedRevision: input.expectedRevision,
    reason: "workflow_progress_fact",
  })
}

export async function runWithinWorkflowStageDeadline<T>(input: {
  actor: AiAgentActor
  abortController: AbortController
  run: () => Promise<T>
  now?: () => number
}): Promise<T> {
  const progress = readWorkflowLifecycleFacet(input.actor)
  if (!progress) return input.run()
  const now = input.now?.() ?? Date.now()
  const remaining = progress.deadlineAt - now
  if (remaining <= 0) {
    throw new WorkflowActorBudgetError("workflow_stage_deadline", "provider request started after the stage deadline")
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      input.run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          input.abortController.abort("workflow_stage_deadline")
          reject(new WorkflowActorBudgetError("workflow_stage_deadline", "provider request exceeded the interactive stage deadline"))
        }, remaining)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
