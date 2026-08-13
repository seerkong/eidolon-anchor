import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"

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
}

const SIMPLE_PROGRESS_OUTCOMES: Readonly<Record<string, string>> = {
  WorkflowOpenAuthoringSession: "workspace_opened",
  WorkflowCreateBundle: "workspace_changed",
  WorkflowPatchBundle: "workspace_changed",
  WorkflowPublishAuthoringSession: "published",
  WorkflowMaterialBind: "materials_bound",
  WorkflowCreateInstance: "prepared",
  WorkflowCreateInstanceFromPrebuilt: "prepared",
  WorkflowRun: "running",
  WorkflowResume: "running",
  WorkflowResolve: "running",
  WorkflowReject: "running",
  WorkflowApplyGraphPatch: "running",
  WorkflowResult: "result",
}

function workspaceOperationIsProgress(args: unknown): boolean {
  const operation = String(record(args)?.operation ?? "")
  return ["write", "mkdir", "move", "delete", "apply_patch", "patch"].includes(operation)
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
  const isProofTool = input.toolName === "WorkflowValidateAuthoringSession"
    || input.toolName === "WorkflowDryRunAuthoringSession"

  if (isProofTool && input.isError) {
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

  let outcome = SIMPLE_PROGRESS_OUTCOMES[input.toolName]
  if (input.toolName === "WorkflowWorkspace" && workspaceOperationIsProgress(input.args)) outcome = "workspace_changed"
  if (isProofTool && !input.isError) outcome = "proof"
  if (!outcome || input.isError) return

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
