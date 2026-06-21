import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import {
  AI_AGENT_COORDINATION_DECISIONS,
  AI_AGENT_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_NAMES,
} from "@cell/ai-core-logic"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import { getCoordinationEngine } from "@cell/ai-organ-logic/coordination/CoordinationEngine"
import { getControlRuntimeContext } from "../_controlRuntime"
import type { PlanReviewInnerConfig, PlanReviewInnerInput, PlanReviewInnerOutput, PlanReviewInnerRuntime } from "./InnerTypes"

export const makePlanReviewOuterComputed = stdMakeNullOuterComputed
export const makePlanReviewInnerRuntime = stdMakeIdentityInnerRuntime
export const makePlanReviewInnerInput = stdMakeIdentityInnerInput
export const makePlanReviewInnerConfig = stdMakeIdentityInnerConfig
export const makePlanReviewOuterOutput = stdMakeIdentityOuterOutput

type PlanReviewTarget =
  | { kind: "member"; actor: AiAgentActor; memberId: string }
  | { kind: "actor"; actor: AiAgentActor }

function resolveMemberTarget(
  runtime: PlanReviewInnerRuntime,
  actor: AiAgentActor,
): PlanReviewTarget | null {
  if (actor.identity?.kind !== "member") {
    return { kind: "actor", actor }
  }
  const member = getControlRuntimeContext(runtime.vm, runtime.actor).members.findByActor({
    actorKey: actor.key,
    actorId: actor.id,
  })
  if (!member) {
    return { kind: "actor", actor }
  }
  return { kind: "member", actor, memberId: member.memberId }
}

function findActorOwnedTarget(runtime: PlanReviewInnerRuntime, requestId: string): PlanReviewTarget | null {
  for (const actor of Object.values(runtime.vm.actors)) {
    if (actor.planApproval?.requestId !== requestId) continue
    return resolveMemberTarget(runtime, actor)
  }
  return null
}

function findPendingMailboxTarget(runtime: PlanReviewInnerRuntime, requestId: string): PlanReviewTarget | null {
  const engine = getCoordinationEngine()
  for (const actor of Object.values(runtime.vm.actors)) {
    for (const mailboxTag of ["memberCoordination", "memberChatInbox"] as const) {
      for (const pending of actor.peekMailbox(mailboxTag) as Array<{ text?: string }>) {
        const env = engine.parseEnvelopeText(String(pending?.text ?? ""))
        if (!env || env.request_id !== requestId || env.coordination !== AI_AGENT_COORDINATION_NAMES.planApproval) {
          continue
        }
        return resolveMemberTarget(runtime, actor)
      }
    }
  }
  return null
}

function findLegacyMetadataTarget(runtime: PlanReviewInnerRuntime, lastFrom: string | undefined): PlanReviewTarget | null {
  if (!lastFrom) return null
  const member = getControlRuntimeContext(runtime.vm, runtime.actor).members
    .listRosterRecords()
    .find((entry) => entry.name === lastFrom || entry.memberId === lastFrom || entry.actorKey === lastFrom)
  if (!member) return null
  const actor = runtime.vm.actors[member.actorKey]
  if (!actor) return null
  return { kind: "member", actor, memberId: member.memberId }
}

export const planReviewCoreLogic: StdInnerLogic<PlanReviewInnerRuntime, PlanReviewInnerInput, PlanReviewInnerConfig, PlanReviewInnerOutput> = async (runtime, input) => {
  const { members, driver } = getControlRuntimeContext(runtime.vm, runtime.actor)
  const requestId = String(input?.request_id ?? "")
  const engine = getCoordinationEngine()
  const rec = engine.get(runtime.vm, requestId)
  if (!rec) return JSON.stringify({ ok: false, error: "not_found" })
  const outbound = engine.makeOutbound({
    coordination: AI_AGENT_COORDINATION_NAMES.planApproval,
    kind: AI_AGENT_COORDINATION_KINDS.planReview,
    request_id: requestId,
    payload: {
      decision: input?.approve === false ? AI_AGENT_COORDINATION_DECISIONS.reject : AI_AGENT_COORDINATION_DECISIONS.approve,
      feedback: typeof input?.feedback === "string" ? input.feedback : "",
    },
  })
  const target =
    findActorOwnedTarget(runtime, requestId)
    ?? findPendingMailboxTarget(runtime, requestId)
    ?? findLegacyMetadataTarget(runtime, rec.last_from)

  if (!target) {
    return JSON.stringify({
      ok: false,
      error: "coordination_owner_not_found",
      request_id: requestId,
      status: rec.status,
    })
  }

  if (target?.kind === "member") {
    members.sendMessage({ to: target.memberId, from: runtime.actor.key, text: outbound.text })
  } else {
    const now = Date.now()
    driver.emitFiberSignal({
      fiberId: `${target.actor.key}:${target.actor.id}`,
      signalKind: "mailbox_enqueue",
      mailbox: {
        kind: "memberCoordination",
        payload: { from: runtime.actor.key, text: outbound.text, ts: now } as any,
      },
      idempotencyKey: `${target.actor.key}:${target.actor.id}:memberCoordination:${requestId}:${now}`,
      createdAt: now,
    })
  }
  return JSON.stringify({
    ok: true,
    request_id: requestId,
    target_member_id: target?.kind === "member" ? target.memberId : null,
    queued: true,
    status: rec.status,
  })
}
