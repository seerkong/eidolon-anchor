import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import { getOrganizationManager } from "@cell/ai-organ-logic/organization/OrganizationManager"
import { buildAutonomousHolonEnvelope } from "@cell/ai-organ-logic/organization/autonomousHolonEnvelope"
import { getDriver } from "./_controlRuntime"
import { setTargetWatchState } from "./_formalTooling"
import { resolveActorSubject } from "./_resolveActorTarget"

function stripTypePrefix(value: string): string {
  const idx = value.indexOf(":")
  return idx < 0 ? value : value.slice(idx + 1)
}

function makeAutonomousHolonTaskId(existingTasks: Record<string, unknown> | undefined): string {
  const existingIds = new Set(Object.keys(existingTasks ?? {}))
  while (true) {
    const candidate = `task-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    if (!existingIds.has(candidate)) return candidate
  }
}

async function waitForAutonomousHolonTaskFinal(params: {
  runtime: AiAgentOneActorRuntime
  holonId: string
  taskId: string
}): Promise<{ ok: true; status: string; resultText: string | null } | { ok: false; status: string | null }> {
  const { runtime, taskId, holonId } = params
  const driver = getDriver(runtime.vm)
  const actorKey = getOrganizationManager().getHolonActorKey(holonId)
  if (!driver) {
    const currentTask = runtime.vm.actors[actorKey]?.identity?.kind === "holon" && runtime.vm.actors[actorKey]?.identity?.governance === "autonomous"
      ? runtime.vm.actors[actorKey]?.holonState?.governance === "autonomous"
        ? runtime.vm.actors[actorKey]?.holonState.tasks?.[taskId]
        : null
      : null
    return { ok: false, status: currentTask?.status ?? null }
  }

  const resolveCurrent = () => {
    const holonActor = runtime.vm.actors[actorKey]
    const task = holonActor?.identity?.kind === "holon" && holonActor.identity.governance === "autonomous"
      ? holonActor.holonState?.governance === "autonomous"
        ? holonActor.holonState.tasks?.[taskId]
        : null
      : null
    if (task?.status === "completed") {
      return {
        status: task.status,
        resultText: task.resultText ?? null,
      }
    }
    return null
  }

  const settled = await driver.waitForSignal({
    vm: runtime.vm,
    waiterKey: taskId,
    waiterStore: "autonomousHolonTaskSignals",
    resolveCurrent,
    maxTicks: 240,
    maxWallMs: 2000,
  })
  if (settled) {
    return {
      ok: true,
      status: settled.status,
      resultText: settled.resultText,
    }
  }

  const task = runtime.vm.actors[actorKey]?.identity?.kind === "holon" && runtime.vm.actors[actorKey]?.identity?.governance === "autonomous"
    ? runtime.vm.actors[actorKey]?.holonState?.governance === "autonomous"
      ? runtime.vm.actors[actorKey]?.holonState.tasks?.[taskId]
      : null
    : null
  if (task?.status === "completed") {
    return {
      ok: true,
      status: task.status,
      resultText: task.resultText ?? null,
    }
  }
  return {
    ok: false,
    status: task?.status ?? null,
  }
}

export async function queueAutonomousHolonAssign(params: {
  runtime: AiAgentOneActorRuntime
  target: string
  mode: "final" | "none" | "stream"
  content: string
}): Promise<string> {
  const target = String(params.target ?? "").trim()
  const resolvedTarget = stripTypePrefix(target)
  const mode = params.mode
  const content = String(params.content ?? "")
  const autonomousHolon = getOrganizationManager().resolveAutonomousHolon(params.runtime.vm, resolvedTarget)
  if (!autonomousHolon) {
    return JSON.stringify({ ok: false, error: "holon_not_found", target, target_type: "holon" })
  }

  if (autonomousHolon.memberIds.length === 0) {
    return JSON.stringify({ ok: false, error: "holon_has_no_members", target, target_type: "holon", holon_id: autonomousHolon.holonId })
  }

  const collectiveSubject = resolveActorSubject(params.runtime.vm, target)
  if (mode === "stream" && collectiveSubject) {
    setTargetWatchState({ vm: params.runtime.vm, targetQuery: target, target: collectiveSubject, watchState: "watched" })
  }

  const storedHolon = getOrganizationManager().resolveAutonomousHolon(params.runtime.vm, autonomousHolon.holonId) ?? autonomousHolon
  const holonActor = params.runtime.vm.actors[getOrganizationManager().getHolonActorKey(autonomousHolon.holonId)]
  const driver = getDriver(params.runtime.vm)
  if (holonActor?.identity?.kind !== "holon" || holonActor.identity.governance !== "autonomous" || !driver) {
    return JSON.stringify({ ok: false, error: "holon_actor_unavailable", target, target_type: "holon", holon_id: autonomousHolon.holonId })
  }
  const existingTasks = holonActor.holonState?.governance === "autonomous" ? holonActor.holonState.tasks : {}
  if (Object.keys(existingTasks).length >= 20) {
    return JSON.stringify({ ok: false, error: "holon_task_limit_reached", target, target_type: "holon", holon_id: autonomousHolon.holonId })
  }
  const taskId = makeAutonomousHolonTaskId(existingTasks)

  const now = Date.now()
  holonActor.holonState = {
    governance: "autonomous",
    holonId: autonomousHolon.holonId,
    name: holonActor.holonState?.governance === "autonomous" ? holonActor.holonState.name : autonomousHolon.name,
    memberIds: [...(holonActor.holonState?.governance === "autonomous" ? holonActor.holonState.memberIds : autonomousHolon.memberIds)],
    watchState: holonActor.holonState?.watchState ?? holonActor.watchState ?? storedHolon.watchState ?? "unwatched",
    taskOwnership: { ...((holonActor.holonState?.governance === "autonomous" ? holonActor.holonState.taskOwnership : {}) ?? {}) },
    tasks: {
      ...(holonActor.holonState?.governance === "autonomous" ? holonActor.holonState.tasks : {}),
      [taskId]: {
        taskId,
        initiatorActorKey: params.runtime.actor.key,
        initiatorActorId: params.runtime.actor.id,
        replyMode: mode,
        status: "pending",
        content,
        createdAt: holonActor.holonState?.governance === "autonomous" ? holonActor.holonState.tasks?.[taskId]?.createdAt ?? now : now,
        updatedAt: now,
      },
    },
  }

  const mailboxPayload = {
    from: params.runtime.actor.identity?.kind === "member" ? params.runtime.actor.identity.name : params.runtime.actor.key,
    text: buildAutonomousHolonEnvelope({
      kind: "assign",
      taskId,
      holonId: autonomousHolon.holonId,
      initiatorActorKey: params.runtime.actor.key,
      initiatorActorId: params.runtime.actor.id,
      replyMode: mode,
      content,
    }),
    ts: Date.now(),
  } as any
  driver.emitFiberSignal({
    fiberId: `${holonActor.key}:${holonActor.id}`,
    signalKind: "mailbox_enqueue",
    mailbox: { kind: "memberInbox", payload: mailboxPayload },
    idempotencyKey: `${holonActor.key}:${holonActor.id}:memberInbox:${taskId}`,
    createdAt: mailboxPayload.ts,
  })

  if (mode === "final") {
    const settled = await waitForAutonomousHolonTaskFinal({
      runtime: params.runtime,
      holonId: autonomousHolon.holonId,
      taskId,
    })
    if (!settled.ok) {
      return JSON.stringify({
        ok: false,
        error: "holon_final_not_settled",
        target,
        target_type: "holon",
        holon_id: autonomousHolon.holonId,
        task_id: taskId,
        status: settled.status ?? "pending",
      })
    }

    return JSON.stringify({
      ok: true,
      target,
      target_type: "holon",
      holon_id: autonomousHolon.holonId,
      name: autonomousHolon.name,
      member_ids: [...autonomousHolon.memberIds],
      reply_mode: mode,
      task_id: taskId,
      status: settled.status,
      completion_status: "settled",
      result_text: settled.resultText,
      watch_state: storedHolon.watchState ?? "unwatched",
    })
  }

  await driver.tickUntilBlocked({ now: Date.now(), maxTicks: 80, maxWallMs: 500 })

  return JSON.stringify({
    ok: true,
    target,
    target_type: "holon",
    holon_id: autonomousHolon.holonId,
    name: autonomousHolon.name,
    member_ids: [...autonomousHolon.memberIds],
    reply_mode: mode,
    task_id: taskId,
    status: holonActor.holonState?.governance === "autonomous" ? holonActor.holonState.tasks?.[taskId]?.status ?? "pending" : "pending",
    queued: true,
    stream_opened: mode === "stream",
    accepted: mode === "none",
    completion_status: mode === "none" ? "not_requested" : "streaming",
    watch_state: storedHolon.watchState ?? "unwatched",
  })
}
