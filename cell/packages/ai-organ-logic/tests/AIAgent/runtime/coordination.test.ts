import { describe, expect, it } from "bun:test"

import {
  AI_AGENT_PLAN_APPROVAL_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_DECISIONS,
  AI_AGENT_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_NAMES,
  AI_AGENT_COORDINATION_STATUSES,
  AI_AGENT_SHUTDOWN_COORDINATION_KINDS,
  ACTOR_ASSIGN_MODES,
  ACTOR_EXECUTION_KINDS,
  ACTOR_WATCH_STATES,
  isAiAgentCoordinationDecision,
  isAiAgentCoordinationKind,
  isAiAgentCoordinationName,
  isAiAgentCoordinationStatus,
  isActorAssignMode,
  isActorExecutionKind,
  isActorWatchState,
} from "@cell/ai-core-logic"

const joinTokens = (...parts: string[]) => parts.join("")

describe("AIAgent shared actor coordination model", () => {
  it("exposes the formal execution kinds", () => {
    expect(ACTOR_EXECUTION_KINDS).toEqual(["control", "delegate", "detached"])
    expect(isActorExecutionKind("control")).toBe(true)
    expect(isActorExecutionKind(joinTokens("pri", "mary"))).toBe(false)
  })

  it("exposes the formal assign modes", () => {
    expect(ACTOR_ASSIGN_MODES).toEqual(["final", "none", "stream"])
    expect(isActorAssignMode("final")).toBe(true)
    expect(isActorAssignMode("stream")).toBe(true)
    expect(isActorAssignMode("dispatch")).toBe(false)
  })

  it("exposes the formal watch states", () => {
    expect(ACTOR_WATCH_STATES).toEqual(["unwatched", "watched"])
    expect(isActorWatchState("watched")).toBe(true)
    expect(isActorWatchState("idle")).toBe(false)
  })

  it("exposes the formal member coordination constants", () => {
    expect(AI_AGENT_COORDINATION_NAMES).toEqual({
      shutdown: "shutdown",
      planApproval: "plan_approval",
    })
    expect(AI_AGENT_COORDINATION_KINDS).toEqual({
      shutdownRequest: "shutdown_request",
      shutdownResponse: "shutdown_response",
      shutdownDone: "shutdown_done",
      planRequest: "plan_request",
      planReview: "plan_review",
      planDone: "plan_done",
    })
    expect(AI_AGENT_COORDINATION_STATUSES).toEqual({
      pending: "pending",
      approved: "approved",
      rejected: "rejected",
      completed: "completed",
    })
    expect(AI_AGENT_COORDINATION_DECISIONS).toEqual({
      approve: "approve",
      reject: "reject",
    })
    expect(AI_AGENT_PLAN_APPROVAL_COORDINATION_KINDS.review).toBe(AI_AGENT_COORDINATION_KINDS.planReview)
    expect(AI_AGENT_SHUTDOWN_COORDINATION_KINDS.response).toBe(AI_AGENT_COORDINATION_KINDS.shutdownResponse)
    expect(isAiAgentCoordinationName(AI_AGENT_COORDINATION_NAMES.shutdown)).toBe(true)
    expect(isAiAgentCoordinationKind(AI_AGENT_COORDINATION_KINDS.planDone)).toBe(true)
    expect(isAiAgentCoordinationStatus(AI_AGENT_COORDINATION_STATUSES.completed)).toBe(true)
    expect(isAiAgentCoordinationDecision(AI_AGENT_COORDINATION_DECISIONS.reject)).toBe(true)
    expect(isAiAgentCoordinationName(joinTokens("plan", "_approval_v2"))).toBe(false)
  })
})
