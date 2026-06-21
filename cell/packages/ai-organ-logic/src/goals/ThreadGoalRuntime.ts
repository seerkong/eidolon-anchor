import { ensureVmRuntimeContext, getControlActor, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import { hasPendingAiAgentWakeMailbox } from "@cell/ai-core-logic/runtime/actor"
import type { AiAgentOrchestratorDriver } from "../OrchestratorDriver"
import { buildGoalContinuationPrompt, getThreadGoal } from "./ThreadGoalManager"
import { createRuntimeHookHandlerComponent, type RuntimeHookHandlerComponent } from "../hooks/RuntimeHookDispatcher"

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
  if (hasPendingAiAgentWakeMailbox(actor)) return false
  const fiberId = params.mainFiberId ?? `${actor.key}:${actor.id}`
  const fiber = (params.driver.getState().fibers as any)?.[fiberId]
  if (!fiber || (fiber.status !== "suspended" && fiber.status !== "ready")) return false

  params.driver.emitFiberSignal({
    fiberId,
    signalKind: "mailbox_enqueue",
    mailbox: {
      kind: "heartbeat",
      payload: {
        heartbeatKind: "runtime_internal_context",
        source: "goal",
        text: buildGoalContinuationPrompt(goal),
      },
    },
    idempotencyKey: `${fiberId}:threadGoal:${goal.goalId ?? "active"}:${params.now}`,
    createdAt: params.now,
  })
  goalRuntime.continuationInFlight = true
  goalRuntime.continuationTurns = (goalRuntime.continuationTurns ?? 0) + 1
  goalRuntime.lastContinuationAt = params.now
  goal.lastContinuationAt = params.now
  return true
}

export function createGoalContinuationHookHandlerComponent(): RuntimeHookHandlerComponent {
  return createRuntimeHookHandlerComponent({
    coreLogic: async (runtime) => {
      const vm = runtime.data?.vm as AiAgentVm | undefined
      const driver = runtime.data?.driver as AiAgentOrchestratorDriver | undefined
      const now = typeof runtime.data?.now === "number" ? runtime.data.now : Date.now()
      if (!vm || !driver) return { action: "continue" }

      const runtimeContext = ensureVmRuntimeContext(vm)
      if (runtimeContext.interactiveTurnActive) return { action: "continue" }
      const goal = getThreadGoal(vm)
      if (!goal || goal.status !== "active") return { action: "continue" }
      const goalRuntime = runtimeContext.threadGoalRuntime
      if (goalRuntime.continuationInFlight) return { action: "continue" }
      const actor = getControlActor(vm)
      if (!actor) return { action: "continue" }
      if (hasPendingAiAgentWakeMailbox(actor)) return { action: "continue" }

      const payload = runtime.context.payload as { mainFiberId?: string } | undefined
      const fiberId = payload?.mainFiberId ?? `${actor.key}:${actor.id}`
      const fiber = (driver.getState().fibers as any)?.[fiberId]
      if (!fiber || (fiber.status !== "suspended" && fiber.status !== "ready")) return { action: "continue" }

      goalRuntime.continuationInFlight = true
      goalRuntime.continuationTurns = (goalRuntime.continuationTurns ?? 0) + 1
      goalRuntime.lastContinuationAt = now
      goal.lastContinuationAt = now

      return {
        action: "stop",
        metadata: {
          source: "goal",
          goalId: goal.goalId,
        },
        effects: [
          {
            type: "mailbox_enqueue",
            fiberId,
            mailbox: "heartbeat",
            payload: {
              heartbeatKind: "runtime_internal_context",
              source: "goal",
              text: buildGoalContinuationPrompt(goal),
            },
          },
        ],
      }
    },
  })
}
