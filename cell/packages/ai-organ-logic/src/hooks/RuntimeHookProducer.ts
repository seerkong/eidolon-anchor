import type {
  RuntimeHookDefinition,
  RuntimeHookEffect,
  RuntimeHookInvocationContext,
} from "@cell/ai-core-contract"
import {
  ensureVmRuntimeContext,
  getControlActor,
  type AiAgentVm,
} from "@cell/ai-core-logic/runtime/runtime"
import { hasPendingAiAgentWakeMailbox, listPendingAiAgentWakeMailboxes } from "@cell/ai-core-logic/runtime/actor"
import type { AiAgentOrchestratorDriver } from "../OrchestratorDriver"
import {
  createRuntimeHookDispatcher,
  type RuntimeHookHandlerComponent,
} from "./RuntimeHookDispatcher"

const runtimeLifecycleActiveGuardKeys = new Set<string>()
const idleHookDiagnosticThrottle = new Map<string, number>()
const IDLE_HOOK_DIAGNOSTIC_THROTTLE_MS = 5000

export type RuntimeLifecycleHookParams = {
  vm: AiAgentVm
  driver: AiAgentOrchestratorDriver
  definitions: readonly RuntimeHookDefinition[]
  handlers: Readonly<Record<string, RuntimeHookHandlerComponent | undefined>>
  context: RuntimeHookInvocationContext
  now: number
  budgetMs?: number
  maxHooks?: number
  beforeHook?: (definition: RuntimeHookDefinition) => boolean | Promise<boolean>
}

function resolveFiberId(
  driver: AiAgentOrchestratorDriver,
  effect: Extract<RuntimeHookEffect, { type: "mailbox_enqueue" | "resume_fiber" }>,
): string | null {
  if (effect.fiberId) return effect.fiberId

  const fibers = driver.inspectRuntime?.().fibers ?? {}
  for (const [fiberId, ctx] of Object.entries(fibers as Record<string, any>)) {
    const actor = ctx?.actor
    if (!actor) continue
    if (effect.actorId && actor.id === effect.actorId) return fiberId
    if (effect.actorName && (actor.key === effect.actorName || actor.identity?.name === effect.actorName)) return fiberId
  }

  return null
}

function emitHookDiagnostic(vm: AiAgentVm, payload: unknown): void {
  if (isDurableHookDiagnosticNoise(payload)) return
  vm.effects.orchestrationHistory?.appendEvent({
    stream: "runtime_hook_event",
    kind: "hook_dispatch_report",
    payload: payload as Record<string, unknown>,
  })
}

function makeIdleHookDiagnosticSignature(report: {
  point?: unknown
  actorId?: unknown
  actorName?: unknown
  traceId?: unknown
  finalAction?: unknown
  payload?: unknown
  steps?: unknown
}): string {
  const payload = report.payload && typeof report.payload === "object" ? report.payload as Record<string, unknown> : {}
  const pending = Array.isArray(payload.pendingMailboxes) ? payload.pendingMailboxes.map(String).sort().join(",") : ""
  const statuses = Array.isArray(report.steps)
    ? report.steps.map((step) => {
        if (!step || typeof step !== "object") return "unknown"
        const item = step as { hookName?: unknown; status?: unknown; message?: unknown }
        return `${String(item.hookName ?? "")}:${String(item.status ?? "")}:${String(item.message ?? "")}`
      }).join("|")
    : ""
  return [
    String(report.point ?? ""),
    String(report.actorId ?? report.actorName ?? ""),
    String(report.traceId ?? ""),
    String(report.finalAction ?? ""),
    pending,
    statuses,
  ].join("::")
}

function isDurableHookDiagnosticNoise(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false
  const report = payload as {
    point?: unknown
    finalAction?: unknown
    effects?: unknown
    steps?: unknown
    actorId?: unknown
    actorName?: unknown
    traceId?: unknown
    payload?: unknown
  }
  if (report.point !== "actor.idle.before") return false
  if (Array.isArray(report.effects) && report.effects.length > 0) return false
  const steps = Array.isArray(report.steps) ? report.steps : []
  const isNoOpObservation = steps.every((step) => {
    if (!step || typeof step !== "object") return false
    const status = (step as { status?: unknown }).status
    const action = (step as { action?: unknown }).action
    return status === "matched" && (action === undefined || action === "continue")
  })
  if (report.finalAction === "continue" && isNoOpObservation) return true

  const hasOnlyStaleSkips = steps.length > 0 && steps.every((step) => {
    if (!step || typeof step !== "object") return false
    const status = (step as { status?: unknown }).status
    const message = (step as { message?: unknown }).message
    return status === "skipped" && message === "runtime hook dispatch stopped because lifecycle state is no longer current"
  })
  if (!hasOnlyStaleSkips) return false

  const signature = makeIdleHookDiagnosticSignature(report)
  const now = Date.now()
  const last = idleHookDiagnosticThrottle.get(signature) ?? 0
  idleHookDiagnosticThrottle.set(signature, now)
  return now - last < IDLE_HOOK_DIAGNOSTIC_THROTTLE_MS
}

function buildIdleHookDiagnosticPayload(params: {
  actor: ReturnType<typeof getControlActor>
  driver: AiAgentOrchestratorDriver
  fiberId: string
}): Record<string, unknown> {
  const stateFiber = (params.driver.getState().fibers as any)?.[params.fiberId]
  const runtimeFiber = (params.driver.inspectRuntime().fibers as any)?.[params.fiberId]
  const execState = runtimeFiber?.execState
  return {
    mainFiberId: params.fiberId,
    pendingMailboxes: params.actor ? listPendingAiAgentWakeMailboxes(params.actor) : [],
    fiberStatus: stateFiber?.status ?? null,
    waitingReason: stateFiber?.waitingReason ?? null,
    cooperativePhase: typeof execState?.phase === "string" ? execState.phase : null,
    cooperativeInflightKind: typeof execState?.inflight?.kind === "string" ? execState.inflight.kind : null,
    cooperativeInflightOpId: typeof execState?.inflight?.opId === "string" ? execState.inflight.opId : null,
  }
}

function applyHookEffect(params: {
  vm: AiAgentVm
  driver: AiAgentOrchestratorDriver
  effect: RuntimeHookEffect
  context: RuntimeHookInvocationContext
  now: number
  index: number
}): void {
  switch (params.effect.type) {
    case "mailbox_enqueue": {
      const fiberId = resolveFiberId(params.driver, params.effect)
      if (!fiberId) return
      params.driver.emitFiberSignal({
        fiberId,
        signalKind: "mailbox_enqueue",
        signalClass: "wake",
        mailbox: {
          kind: params.effect.mailbox as any,
          payload: params.effect.payload as any,
        },
        idempotencyKey: `${fiberId}:hook:${params.context.point}:${params.effect.mailbox}:${params.now}:${params.index}`,
        createdAt: params.now,
      })
      return
    }
    case "resume_fiber": {
      const fiberId = resolveFiberId(params.driver, params.effect)
      if (!fiberId) return
      params.driver.resumeFiber(fiberId, params.now)
      return
    }
    case "emit_diagnostic": {
      params.vm.effects.orchestrationHistory?.appendEvent({
        stream: "runtime_hook_event",
        kind: params.effect.eventType ?? "hook_diagnostic",
        payload: params.effect.payload as Record<string, unknown>,
      })
      return
    }
    case "request_snapshot":
      params.vm.effects.orchestrationHistory?.appendEvent({
        stream: "runtime_hook_event",
        kind: "hook_snapshot_requested",
        payload: {
          reason: params.effect.reason ?? null,
          point: params.context.point,
        },
      })
      return
  }
}

export async function runRuntimeLifecycleHook(
  params: RuntimeLifecycleHookParams,
) {
  const dispatcher = createRuntimeHookDispatcher({
    handlers: params.handlers,
    activeGuardKeys: runtimeLifecycleActiveGuardKeys,
  })
  const output = await dispatcher.dispatch({
    definitions: params.definitions,
    context: params.context,
    budgetMs: params.budgetMs,
    maxHooks: params.maxHooks,
    runtimeData: {
      vm: params.vm,
      driver: params.driver,
      now: params.now,
    },
    beforeHook: params.beforeHook,
    afterHook: ({ result, stepIndex }) => {
      for (const [effectIndex, effect] of (result.effects ?? []).entries()) {
        applyHookEffect({
          vm: params.vm,
          driver: params.driver,
          effect,
          context: params.context,
          now: params.now,
          index: stepIndex + effectIndex,
        })
      }
    },
  })

  emitHookDiagnostic(params.vm, output.report)

  return output
}

export async function runActorIdleBeforeLifecycleHook(params: Omit<RuntimeLifecycleHookParams, "context"> & {
  mainFiberId?: string
}): Promise<Awaited<ReturnType<typeof runRuntimeLifecycleHook>> | null> {
  const actor = getControlActor(params.vm)
  if (!actor) return null
  const fiberId = params.mainFiberId ?? `${actor.key}:${actor.id}`
  const context: RuntimeHookInvocationContext = {
    point: "actor.idle.before",
    sessionId: String(params.vm.outerCtx?.metadata?.sessionId ?? ""),
    actorId: actor.id,
    actorName: actor.key,
    actorKind: "main",
    traceId: fiberId,
    tags: ["goal", "coding"],
    payload: buildIdleHookDiagnosticPayload({ actor, driver: params.driver, fiberId }),
  }
  const refreshIdlePayload = () => {
    context.payload = buildIdleHookDiagnosticPayload({ actor, driver: params.driver, fiberId })
  }
  const isStillIdle = () => {
    refreshIdlePayload()
    const runtime = ensureVmRuntimeContext(params.vm)
    if (runtime.interactiveTurnActive) return false
    if (hasPendingAiAgentWakeMailbox(actor)) return false
    const fiber = (params.driver.getState().fibers as any)?.[fiberId]
    return !!fiber && (fiber.status === "suspended" || fiber.status === "ready")
  }

  return await runRuntimeLifecycleHook({
    ...params,
    beforeHook: params.beforeHook ?? (() => isStillIdle()),
    context,
  })
}
