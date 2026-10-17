export type GoalRecord = Readonly<{
  goalId: string
  objective: string
  status: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete"
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  completionAudit?: string
  blockedReason?: string
  suspensionReason?: "explicit_activation_required" | "runtime_restarted" | "cancelled" | "authorization_revoked" | "continuation_failed" | "checkpoint_failed" | "closed"
}>

export type SessionGoalView = Readonly<{
  scope: "session"
  controlActorId: string
  accounting: "session_estimate"
  record: GoalRecord | null
  resumeRequired: boolean
}>

export type GoalControlReceipt = Readonly<{ cleared: true } | { cleared: false; goalId: string; status: GoalRecord["status"] }>

type GoalTarget = { actorId: string; expectedGoalId: string | null }
export type GoalControl = GoalTarget & (
  | { operation: "set" | "edit"; objective: string; tokenBudget?: number }
  | { operation: "pause" | "resume" | "clear" }
)
