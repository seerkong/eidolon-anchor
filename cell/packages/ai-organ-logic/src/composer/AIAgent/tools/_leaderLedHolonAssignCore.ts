import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import { getOrganizationManager, writeHolonGovernance } from "@cell/ai-organ-logic/organization/OrganizationManager"
import { buildLeaderLedHolonEnvelope } from "@cell/ai-organ-logic/organization/leaderLedHolonEnvelope"
import { getDriver } from "./_controlRuntime"
import { resolveActorSubject } from "./_resolveActorTarget"
import { setTargetWatchState } from "./_formalTooling"

function makeRouteId(): string {
  return `route-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function waitForLeaderLedHolonRouteFinal(params: {
  runtime: AiAgentOneActorRuntime
  holonId: string
  routeId: string
}): Promise<{ ok: true; resultText: string | null } | { ok: false }> {
  const driver = getDriver(params.runtime.vm)
  const actorKey = getOrganizationManager().getHolonActorKey(params.holonId)
  if (!driver) {
    return { ok: false }
  }

  const resolveCurrent = () => {
    const holonActor = params.runtime.vm.actors[actorKey]
    const route = holonActor?.identity?.kind === "holon" && holonActor.identity.governance === "leader_led"
      ? holonActor.holonState?.governance === "leader_led"
        ? holonActor.holonState.routes?.[params.routeId]
        : null
      : null
    if (route?.status === "completed") {
      return { resultText: route.resultText ?? null }
    }
    return null
  }

  const settled = await driver.waitForSignal({
    vm: params.runtime.vm,
    waiterKey: params.routeId,
    waiterStore: "leaderLedHolonRouteSignals",
    resolveCurrent,
    maxTicks: 240,
    maxWallMs: 2000,
  })
  if (settled) {
    return { ok: true, resultText: settled.resultText }
  }

  const holonActorAfterTick = params.runtime.vm.actors[actorKey]
  const route = holonActorAfterTick?.identity?.kind === "holon" && holonActorAfterTick.identity.governance === "leader_led"
    ? holonActorAfterTick.holonState?.governance === "leader_led"
      ? holonActorAfterTick.holonState.routes?.[params.routeId]
      : null
    : null
  if (route?.status === "completed") {
    return { ok: true, resultText: route.resultText ?? null }
  }
  return { ok: false }
}

export async function queueLeaderLedHolonAssign(params: {
  runtime: AiAgentOneActorRuntime
  target: string
  mode: "final" | "none" | "stream"
  content: string
}): Promise<string> {
  const target = String(params.target ?? "").trim()
  const leaderLedHolon = getOrganizationManager().resolveLeaderLedHolon(params.runtime.vm, target)
  if (!leaderLedHolon) {
    return JSON.stringify({ ok: false, error: "holon_not_found", target, target_type: "holon" })
  }
  if (!leaderLedHolon.leaderMemberId) {
    return JSON.stringify({ ok: false, error: "holon_has_no_leader", target, target_type: "holon", holon_id: leaderLedHolon.holonId })
  }

  const holonActor = params.runtime.vm.actors[getOrganizationManager().getHolonActorKey(leaderLedHolon.holonId)]
  const driver = getDriver(params.runtime.vm)
  if (holonActor?.identity?.kind !== "holon" || holonActor.identity.governance !== "leader_led" || !driver) {
    return JSON.stringify({ ok: false, error: "holon_actor_unavailable", target, target_type: "holon", holon_id: leaderLedHolon.holonId })
  }

  const routeId = makeRouteId()
  const now = Date.now()
  writeHolonGovernance(holonActor, {
    governance: "leader_led",
    holonId: leaderLedHolon.holonId,
    name: holonActor.holonState?.governance === "leader_led" ? holonActor.holonState.name : leaderLedHolon.name,
    memberIds: [...(holonActor.holonState?.governance === "leader_led" ? holonActor.holonState.memberIds : leaderLedHolon.memberIds)],
    leaderMemberId: holonActor.holonState?.governance === "leader_led" ? holonActor.holonState.leaderMemberId ?? leaderLedHolon.leaderMemberId ?? null : leaderLedHolon.leaderMemberId ?? null,
    watchState: holonActor.holonState?.watchState ?? holonActor.watchState ?? leaderLedHolon.watchState ?? "unwatched",
    routes: {
      ...(holonActor.holonState?.governance === "leader_led" ? holonActor.holonState.routes : {}),
      [routeId]: {
        routeId,
        initiatorActorKey: params.runtime.actor.key,
        initiatorActorId: params.runtime.actor.id,
        leaderMemberId: leaderLedHolon.leaderMemberId,
        replyMode: params.mode,
        status: "pending",
        createdAt: holonActor.holonState?.governance === "leader_led" ? holonActor.holonState.routes?.[routeId]?.createdAt ?? now : now,
        updatedAt: now,
      },
    },
  })
  const mailboxPayload = {
    from: params.runtime.actor.identity?.kind === "member" ? params.runtime.actor.identity.name : params.runtime.actor.key,
    text: buildLeaderLedHolonEnvelope({
      kind: "assign",
      routeId,
      holonId: leaderLedHolon.holonId,
      initiatorActorKey: params.runtime.actor.key,
      initiatorActorId: params.runtime.actor.id,
      replyMode: params.mode,
      content: params.content,
    }),
    ts: Date.now(),
  } as any
  driver.emitFiberSignal({
    fiberId: `${holonActor.key}:${holonActor.id}`,
    signalKind: "mailbox_enqueue",
    mailbox: { kind: "memberChatInbox", payload: mailboxPayload },
    idempotencyKey: `${holonActor.key}:${holonActor.id}:memberChatInbox:${routeId}`,
    createdAt: mailboxPayload.ts,
  })

  const formationSubject = resolveActorSubject(params.runtime.vm, target)
  if (params.mode === "stream" && formationSubject) {
    setTargetWatchState({ vm: params.runtime.vm, targetQuery: target, target: formationSubject, watchState: "watched" })
  }

  if (params.mode === "final") {
    const settled = await waitForLeaderLedHolonRouteFinal({
      runtime: params.runtime,
      holonId: leaderLedHolon.holonId,
      routeId,
    })
    if (!settled.ok) {
      return JSON.stringify({
        ok: false,
        error: "holon_final_not_settled",
        target,
        target_type: "holon",
        holon_id: leaderLedHolon.holonId,
        route_id: routeId,
      })
    }
    return JSON.stringify({
      ok: true,
      target,
      target_type: "holon",
      actor_key: holonActor.key,
      actor_id: holonActor.id,
      actor_type: holonActor.type,
      holon_id: leaderLedHolon.holonId,
      leader_member_id: leaderLedHolon.leaderMemberId,
      reply_mode: "final",
      completion_status: "settled",
      result_text: settled.resultText,
      route_id: routeId,
      watch_state: holonActor.watchState ?? leaderLedHolon.watchState ?? "unwatched",
    })
  }

  await driver.tickUntilBlocked({ now: Date.now(), maxTicks: 80, maxWallMs: 500 })

  return JSON.stringify({
    ok: true,
    target,
    target_type: "holon",
    actor_key: holonActor.key,
    actor_id: holonActor.id,
    actor_type: holonActor.type,
    holon_id: leaderLedHolon.holonId,
    leader_member_id: leaderLedHolon.leaderMemberId,
    reply_mode: params.mode,
    stream_opened: params.mode === "stream",
    accepted: params.mode === "none",
    completion_status: params.mode === "none" ? "not_requested" : "streaming",
    route_id: routeId,
    watch_state: holonActor.watchState ?? leaderLedHolon.watchState ?? "unwatched",
  })
}
