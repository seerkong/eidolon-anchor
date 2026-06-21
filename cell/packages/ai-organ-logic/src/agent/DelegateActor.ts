import { createActor, type AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { ensureVmRuntimeContext, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import { createAiAgentOrchestratorDriverWithCooperative } from "../OrchestratorDriver"
import { seedConversationDomainFromActorSeedMessages } from "../exec/AiAgentExecutor"
import {
  DETACHED_ACTOR_KINDS,
  DETACHED_ACTOR_STATUSES,
  type DetachedActorKind,
  getDetachedActorRegistry,
} from "../detached/DetachedActorRegistry"
import { normalizeDelegateRunMode } from "@cell/ai-organ-contract/agent/DelegateRunMode"
import { resolveDelegateLane } from "../lane/AiAgentLane"
import { resolveDelegateWorkload } from "../lane/AiAgentWorkload"
import { getActorWorkContext } from "../runtime/ContextControlPlane"
import { TASK_PHASES } from "@cell/ai-core-contract/runtime/ContextControl"

function makeTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export async function spawnChildExecutionActor(
  vm: AiAgentVm,
  parentActor: AiAgentActor,
  params: {
    description: string
    prompt: string
    agentType: string
    mode?: "sync_wait" | "detached"
    toolCallId?: string
    detachedActorKind?: DetachedActorKind
  },
): Promise<string> {
  const config = AgentRegistry.get(vm.registries.agentRegistry, params.agentType)
  if (!config) {
    throw new Error(`Unknown agent type '${params.agentType}'`)
  }

  const allowedTools = config.tools === "*" ? [] : [...config.tools]

  const buildSystemMessages = vm.callbacks.buildSystemMessages
  const systemMessages = buildSystemMessages
    ? buildSystemMessages(config.prompt)
        .filter((m: any) => m?.role === "system")
        .map((m: any) => ({ role: "system" as const, content: String(m.content ?? "") }))
    : config.prompt.map((p) => ({ role: "system" as const, content: p }))

  const shouldStopAfterSingleTool =
    params.detachedActorKind === DETACHED_ACTOR_KINDS.bash
    || params.detachedActorKind === DETACHED_ACTOR_KINDS.toolCall

  const parentWorkContext = getActorWorkContext(parentActor)
  const actor = createActor({
    key: `${parentActor.key}:${params.agentType}:${Date.now()}`,
    type: normalizeDelegateRunMode(params.mode) === "detached" ? "detached" : "delegate",
    agentName: params.agentType,
    llmClient: parentActor.llmClient,
    modelConfig: parentActor.modelConfig,
    systemPrompts: systemMessages.map((m) => m.content),
    messages: [...systemMessages, { role: "user", content: params.prompt }],
    ctrlOptions: shouldStopAfterSingleTool
      ? {
          stopAfterFirstTool: true,
          exitAfterToolResult: true,
        }
      : undefined,
    toolPolicy: {
      allowedTools,
      enabledToolKeys: parentActor.toolPolicy.enabledToolKeys,
      disabledToolKeys: parentActor.toolPolicy.disabledToolKeys,
      computedDisabledTools: parentActor.toolPolicy.computedDisabledTools,
    },
    callbacks: {
      buildToolset: parentActor.callbacks.buildToolset,
      processStream: parentActor.callbacks.processStream,
    },
    workContext: {
      ...parentWorkContext,
      taskPhase: TASK_PHASES.normal,
      workModeSource: "parent_delegate",
      taskPhaseSource: "delegate_start",
      workModeUpdatedAt: parentWorkContext.workModeUpdatedAt,
      taskPhaseUpdatedAt: new Date().toISOString(),
      lastTrigger: "delegate_start",
    },
  })
  vm.actors[actor.key] = actor
  if (!vm.actorRuntime.has(actor.key)) {
    vm.actorRuntime.register(actor.key, actor)
  }
  // Seed prompt into the conversation domains through the semantic injection
  // chain so the child's first provider materialization carries it (the raw
  // seed array is only the compatibility mirror).
  seedConversationDomainFromActorSeedMessages({ vm, actor, seedMessages: actor.messages })
  let cleanupMode: "immediate" | "orchestrator_managed" | "retain" = "immediate"
  try {
    const mode = normalizeDelegateRunMode(params.mode)
    const orch = ensureVmRuntimeContext(vm).currentOrchestrator

    // If an orchestrator is active for this VM, spawn a child execution actor/fiber
    // and let the parent fiber decide whether to wait.
    if (orch?.spawnFiber && typeof orch.spawnFiber === "function" && typeof orch.parentFiberId === "string") {
      const childFiberId = `${actor.key}:${actor.id}`
      const messages = [...actor.messages]

      const taskId = mode === "detached" ? makeTaskId() : ""
      const taskKind = mode === "detached"
        ? (params.detachedActorKind ?? DETACHED_ACTOR_KINDS.delegate)
        : DETACHED_ACTOR_KINDS.delegate
      if (mode === "detached") {
        actor.detachedTask = {
          taskId,
          kind: taskKind,
          status: DETACHED_ACTOR_STATUSES.pending,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          toolCallId: typeof params.toolCallId === "string" ? params.toolCallId : undefined,
          parentFiberId: orch.parentFiberId,
          childFiberId,
        }
        const registry = getDetachedActorRegistry(vm)
        registry.create({
          taskId,
          kind: taskKind,
          status: DETACHED_ACTOR_STATUSES.pending,
          toolCallId: typeof params.toolCallId === "string" ? params.toolCallId : undefined,
          parentFiberId: orch.parentFiberId,
          childFiberId,
          childActorKey: actor.key,
          childActorId: actor.id,
        })
      }

      orch.spawnFiber({
        fiberId: childFiberId,
        vm,
        actor,
        messages,
        basePriority: 1,
        parentFiberId: orch.parentFiberId,
        kind: DETACHED_ACTOR_KINDS.delegate as any,
        lane: resolveDelegateLane(parentActor, mode),
        workload: resolveDelegateWorkload(parentActor, {
          mode,
          detachedActorKind: params.detachedActorKind,
        }),
        onDone: {
          parentFiberId: orch.parentFiberId,
          mode,
          toolCallId: typeof params.toolCallId === "string" ? params.toolCallId : undefined,
          taskId: taskId || undefined,
          taskKind: mode === "detached" ? taskKind : undefined,
        },
      })

      cleanupMode = mode === "detached" ? "retain" : "orchestrator_managed"

      if (mode === "sync_wait") {
        return "WAIT_FOR_CHILD_DONE"
      }

      return JSON.stringify({ task_id: taskId, status: DETACHED_ACTOR_STATUSES.pending })
    }

    // Run the delegate actor immediately in an isolated driver.
    const fiberId = `${actor.key}:${actor.id}`
    const messages = [...actor.messages]

      const driver = createAiAgentOrchestratorDriverWithCooperative({
        fibers: [{ fiberId, vm, actor, messages, basePriority: 1 }],
        options: {
          agingStep: 0,
          defaultSuspendPolicy: "continue_others",
        },
      })

    const now = Date.now()
    driver.resumeFiber(fiberId, now)
    await driver.tickUntilBlocked({ now, maxTicks: 500 })

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as any
      if (msg?.role === "assistant") {
        return msg.content ?? "(no content)"
      }
    }
    return "(delegate actor returned no text)"
  } finally {
    if (cleanupMode === "immediate") {
      delete vm.actors[actor.key]
      if (vm.actorRuntime.has(actor.key)) {
        vm.actorRuntime.unregister(actor.key)
      }
    }
  }
}
