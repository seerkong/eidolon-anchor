import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import {
  parseWorkflowDomainProgressFact,
  type WorkflowDomainProgressTransition,
} from "./WorkflowDomainProgress"

export const DEFAULT_WORKFLOW_ACTOR_BUDGET = Object.freeze({
  stageDeadlineMs: 180_000,
  maxNoProgressTurns: 4,
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

export function isWorkflowActor(actor: Pick<AiAgentActor, "agentName">): boolean {
  return actor.agentName === "workflow"
}

function ensureProgress(actor: AiAgentActor, now: number, config: WorkflowActorBudgetConfig) {
  if (!actor.workflowProgress) {
    actor.workflowProgress = {
      stageStartedAt: now,
      deadlineAt: now + config.stageDeadlineMs,
      turnsSinceProgress: 0,
      maxNoProgressTurns: config.maxNoProgressTurns,
      proofRepairAttempts: 0,
      maxProofRepairAttempts: config.maxProofRepairAttempts,
      lastProgressAt: now,
    }
  }
  return actor.workflowProgress
}

const WORKFLOW_PROGRESS_PROMPT_MARKER = "<!-- eidolon:workflow-progress-budget -->"

function exposeProgressBudget(actor: AiAgentActor): void {
  if (!actor.workflowProgress) return
  actor.systemPrompts = actor.systemPrompts.filter((prompt) => !prompt.startsWith(WORKFLOW_PROGRESS_PROMPT_MARKER))
  const progress = actor.workflowProgress
  const remaining = Math.max(0, progress.maxNoProgressTurns - progress.turnsSinceProgress)
  actor.systemPrompts.push([
    WORKFLOW_PROGRESS_PROMPT_MARKER,
    "<workflow_progress_budget>",
    `stage: ${progress.stageId ?? "unselected"}`,
    `turns_without_progress: ${progress.turnsSinceProgress}`,
    `remaining_no_progress_turns: ${remaining}`,
    "progress_facts: workspace revision, proof, lifecycle/waiting receipt, or runtime result",
    "instruction: Read-only context and tool discovery do not reset this budget. When one or fewer turns remain, use already loaded facts to produce the next valid progress fact; if that is impossible, return a typed waiting or failure receipt instead of continuing inspection.",
    "</workflow_progress_budget>",
  ].join("\n"))
}

export function enterWorkflowActorStage(input: {
  actor: AiAgentActor
  stageId: string
  now?: number
  config: WorkflowActorBudgetConfig
}): void {
  if (!isWorkflowActor(input.actor)) return
  const now = input.now ?? Date.now()
  const current = ensureProgress(input.actor, now, input.config)
  if (current.stageId === input.stageId) return
  input.actor.workflowProgress = {
    stageId: input.stageId,
    stageStartedAt: now,
    deadlineAt: now + input.config.stageDeadlineMs,
    turnsSinceProgress: 0,
    maxNoProgressTurns: input.config.maxNoProgressTurns,
    proofRepairAttempts: 0,
    maxProofRepairAttempts: input.config.maxProofRepairAttempts,
    lastProgressAt: now,
    lastOutcome: "stage_selected",
  }
}

export function beginWorkflowActorTurn(input: {
  actor: AiAgentActor
  now?: number
  config: WorkflowActorBudgetConfig
}): void {
  if (!isWorkflowActor(input.actor)) return
  const now = input.now ?? Date.now()
  const progress = ensureProgress(input.actor, now, input.config)
  if (now >= progress.deadlineAt) {
    throw new WorkflowActorBudgetError(
      "workflow_stage_deadline",
      `stage=${progress.stageId ?? "unselected"} exceeded deadline; lastOutcome=${progress.lastOutcome ?? "none"}`,
    )
  }
  progress.turnsSinceProgress += 1
  if (progress.turnsSinceProgress > progress.maxNoProgressTurns) {
    throw new WorkflowActorBudgetError(
      "workflow_no_progress",
      `stage=${progress.stageId ?? "unselected"} produced no workspace/proof/lifecycle/result progress for ${progress.turnsSinceProgress} turns`,
    )
  }
  exposeProgressBudget(input.actor)
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
  toolName: string
  args?: unknown
  outputText?: string
  isError: boolean
  now?: number
  config: WorkflowActorBudgetConfig
}): void {
  if (!isWorkflowActor(input.actor)) return
  const now = input.now ?? Date.now()
  const progress = ensureProgress(input.actor, now, input.config)
  const failed = input.isError || outputIndicatesFailure(input.outputText)
  const isProofTool = input.toolName === "WorkflowValidateAuthoringSession"
    || input.toolName === "WorkflowDryRunAuthoringSession"

  if (isProofTool && failed) {
    progress.proofRepairAttempts += 1
    progress.lastDiagnostic = input.outputText
    if (progress.proofRepairAttempts > progress.maxProofRepairAttempts) {
      throw new WorkflowActorBudgetError(
        "workflow_proof_repair_exhausted",
        `stage=${progress.stageId ?? "testing"} exhausted ${progress.maxProofRepairAttempts} proof repair attempts; workspace is preserved`,
      )
    }
    return
  }

  const fact = failed ? undefined : parseWorkflowDomainProgressFact(input.outputText)
  if (!fact) return
  const outcome = PROGRESS_OUTCOME_BY_TRANSITION[fact.transition]

  progress.turnsSinceProgress = 0
  progress.lastProgressAt = now
  progress.lastOutcome = outcome
  progress.lastDiagnostic = undefined
  if (outcome === "proof") progress.proofRepairAttempts = 0
}

export async function runWithinWorkflowStageDeadline<T>(input: {
  actor: AiAgentActor
  abortController: AbortController
  run: () => Promise<T>
  now?: () => number
}): Promise<T> {
  if (!isWorkflowActor(input.actor) || !input.actor.workflowProgress) return input.run()
  const now = input.now?.() ?? Date.now()
  const remaining = input.actor.workflowProgress.deadlineAt - now
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
