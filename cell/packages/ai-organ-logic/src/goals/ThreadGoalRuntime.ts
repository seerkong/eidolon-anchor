import { ensureVmRuntimeContext, getControlActor, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import type { AiAgentOrchestratorDriver } from "../OrchestratorDriver"
import { buildGoalContinuationPrompt, getThreadGoal } from "./ThreadGoalManager"

export function maybeStartThreadGoalContinuation(params: {
  vm: AiAgentVm
  driver: AiAgentOrchestratorDriver
  now: number
  mainFiberId?: string
}): boolean {
  const runtime = ensureVmRuntimeContext(params.vm)
  if (runtime.interactiveTurnActive) return false
  const goal = getThreadGoal(params.vm)
  if (!goal || goal.status !== "active") return false
  const goalRuntime = runtime.threadGoalRuntime
  if (goalRuntime.continuationInFlight) return false
  const actor = getControlActor(params.vm)
  if (!actor) return false
  if (actor.hasPending("humanInput") || actor.hasPending("memberInbox") || actor.hasPending("control")) return false
  const fiberId = params.mainFiberId ?? `${actor.key}:${actor.id}`
  const fiber = (params.driver.getState().fibers as any)?.[fiberId]
  if (!fiber || (fiber.status !== "suspended" && fiber.status !== "ready")) return false

  params.driver.emitFiberSignal({
    fiberId,
    signalKind: "mailbox_enqueue",
    mailbox: { kind: "humanInput", payload: buildGoalContinuationPrompt(goal) },
    idempotencyKey: `${fiberId}:threadGoal:${goal.goalId ?? "active"}:${params.now}`,
    createdAt: params.now,
  })
  goalRuntime.continuationInFlight = true
  goalRuntime.continuationTurns = (goalRuntime.continuationTurns ?? 0) + 1
  goalRuntime.lastContinuationAt = params.now
  goal.lastContinuationAt = params.now
  return true
}
