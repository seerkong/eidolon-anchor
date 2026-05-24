export const ACTOR_ORGANIZATION_KINDS = ["member", "holon"] as const
export type ActorOrganizationKind = (typeof ACTOR_ORGANIZATION_KINDS)[number]

export const ACTOR_HOLON_GOVERNANCE_KINDS = ["autonomous", "leader_led"] as const
export type ActorHolonGovernanceKind = (typeof ACTOR_HOLON_GOVERNANCE_KINDS)[number]

export const ACTOR_EXECUTION_KINDS = ["primary", "delegate", "detached"] as const
export type ActorExecutionKind = (typeof ACTOR_EXECUTION_KINDS)[number]

export const ACTOR_ASSIGN_MODES = ["final", "none", "stream"] as const
export type ActorAssignMode = (typeof ACTOR_ASSIGN_MODES)[number]

export const ACTOR_WATCH_STATES = ["unwatched", "watched"] as const
export type ActorWatchState = (typeof ACTOR_WATCH_STATES)[number]

export const AI_AGENT_COORDINATION_ENVELOPE = {
  type: "rad_member_coordination",
  version: 1,
} as const

export const AI_AGENT_COORDINATION_NAMES = {
  shutdown: "shutdown",
  planApproval: "plan_approval",
} as const

export type AiAgentCoordinationName =
  (typeof AI_AGENT_COORDINATION_NAMES)[keyof typeof AI_AGENT_COORDINATION_NAMES]

export const AI_AGENT_COORDINATION_KINDS = {
  shutdownRequest: "shutdown_request",
  shutdownResponse: "shutdown_response",
  shutdownDone: "shutdown_done",
  planRequest: "plan_request",
  planReview: "plan_review",
  planDone: "plan_done",
} as const

export type AiAgentCoordinationKind =
  (typeof AI_AGENT_COORDINATION_KINDS)[keyof typeof AI_AGENT_COORDINATION_KINDS]

export const AI_AGENT_PLAN_APPROVAL_COORDINATION_KINDS = {
  request: AI_AGENT_COORDINATION_KINDS.planRequest,
  review: AI_AGENT_COORDINATION_KINDS.planReview,
  done: AI_AGENT_COORDINATION_KINDS.planDone,
} as const

export type AiAgentPlanApprovalCoordinationKind =
  (typeof AI_AGENT_PLAN_APPROVAL_COORDINATION_KINDS)[keyof typeof AI_AGENT_PLAN_APPROVAL_COORDINATION_KINDS]

export const AI_AGENT_SHUTDOWN_COORDINATION_KINDS = {
  request: AI_AGENT_COORDINATION_KINDS.shutdownRequest,
  response: AI_AGENT_COORDINATION_KINDS.shutdownResponse,
  done: AI_AGENT_COORDINATION_KINDS.shutdownDone,
} as const

export type AiAgentShutdownCoordinationKind =
  (typeof AI_AGENT_SHUTDOWN_COORDINATION_KINDS)[keyof typeof AI_AGENT_SHUTDOWN_COORDINATION_KINDS]

export const AI_AGENT_COORDINATION_STATUSES = {
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
  completed: "completed",
} as const

export type AiAgentCoordinationStatus =
  (typeof AI_AGENT_COORDINATION_STATUSES)[keyof typeof AI_AGENT_COORDINATION_STATUSES]

export const AI_AGENT_COORDINATION_DECISIONS = {
  approve: "approve",
  reject: "reject",
} as const

export type AiAgentCoordinationDecision =
  (typeof AI_AGENT_COORDINATION_DECISIONS)[keyof typeof AI_AGENT_COORDINATION_DECISIONS]

function includesConstValue<T extends Record<string, string>>(constants: T, value: unknown): value is T[keyof T] {
  return typeof value === "string" && Object.values(constants).includes(value)
}

export function isActorAssignMode(value: unknown): value is ActorAssignMode {
  return typeof value === "string" && (ACTOR_ASSIGN_MODES as readonly string[]).includes(value)
}

export function isActorExecutionKind(value: unknown): value is ActorExecutionKind {
  return typeof value === "string" && (ACTOR_EXECUTION_KINDS as readonly string[]).includes(value)
}

export function isActorHolonGovernanceKind(value: unknown): value is ActorHolonGovernanceKind {
  return typeof value === "string" && (ACTOR_HOLON_GOVERNANCE_KINDS as readonly string[]).includes(value)
}

export function isActorWatchState(value: unknown): value is ActorWatchState {
  return typeof value === "string" && (ACTOR_WATCH_STATES as readonly string[]).includes(value)
}

export function isAiAgentCoordinationName(value: unknown): value is AiAgentCoordinationName {
  return includesConstValue(AI_AGENT_COORDINATION_NAMES, value)
}

export function isAiAgentCoordinationKind(value: unknown): value is AiAgentCoordinationKind {
  return includesConstValue(AI_AGENT_COORDINATION_KINDS, value)
}

export function isAiAgentCoordinationStatus(value: unknown): value is AiAgentCoordinationStatus {
  return includesConstValue(AI_AGENT_COORDINATION_STATUSES, value)
}

export function isAiAgentCoordinationDecision(value: unknown): value is AiAgentCoordinationDecision {
  return includesConstValue(AI_AGENT_COORDINATION_DECISIONS, value)
}
