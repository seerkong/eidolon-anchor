import { describe, expect, it } from "bun:test"
import { AgentEventGraph, createActor, createVM, ensureVmRuntimeContext, hydrateVM, serializeVM } from "@cell/ai-core-logic"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { aiAgentCooperativeStep } from "@cell/ai-organ-logic/exec/AiAgentExecutor"
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver"
import { maybeStartThreadGoalContinuation } from "@cell/ai-organ-logic/goals/ThreadGoalRuntime"
import { createMockProcessStream } from "./__test_support__/mockProcessStream"
import {
  accountThreadGoalUsage,
  buildGoalContinuationPrompt,
  getThreadGoal,
  setThreadGoal,
  updateThreadGoalStatus,
} from "@cell/ai-organ-logic/goals/ThreadGoalManager"

describe("thread goal runtime", () => {
  it("persists thread goals through vm snapshots", () => {
    const actor = createActor({ key: "main" })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      outerCtx: { metadata: { sessionId: "persisted-goal-test" } },
    })

    const created = setThreadGoal({ vm, objective: "finish persisted objective", tokenBudget: 100 })
    expect(created.ok).toBe(true)
    const snapshot = serializeVM(vm)
    expect(snapshot.sessionState?.threadGoal?.objective).toBe("finish persisted objective")

    const restored = hydrateVM(snapshot, { main: actor })
    expect(getThreadGoal(restored)?.objective).toBe("finish persisted objective")
    expect(getThreadGoal(restored)?.tokenBudget).toBe(100)
  })

  it("exposes public model goal tools and keeps slash command handler internal", async () => {
    const actor = createActor({ key: "main" })
    const registry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      registries: { toolRegistry: registry },
      outerCtx: { metadata: { sessionId: "persisted-tool-goal-test" } },
    })

    const created = JSON.parse(String(await ToolFuncRegistry.call(registry, "create_goal", vm, actor, { objective: "ship goal" })))
    expect(created.ok).toBe(true)
    const read = JSON.parse(String(await ToolFuncRegistry.call(registry, "get_goal", vm, actor, {})))
    expect(read.goal.objective).toBe("ship goal")

    const rejected = JSON.parse(String(await ToolFuncRegistry.call(registry, "update_goal", vm, actor, { status: "paused" })))
    expect(rejected.ok).toBe(false)

    const publicNames = new Set(composeToolRegistry({ includeInternalOnly: false }).list().map((tool) => tool.schema.function.name))
    expect(publicNames).toContain("get_goal")
    expect(publicNames).toContain("create_goal")
    expect(publicNames).toContain("update_goal")
    expect(publicNames).not.toContain("GoalCommand")
  })

  it("accounts usage and applies token budget limits", () => {
    const actor = createActor({ key: "main" })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      outerCtx: { metadata: { sessionId: "persisted-budget-goal-test" } },
    })
    setThreadGoal({ vm, objective: "bounded work", tokenBudget: 5 })

    accountThreadGoalUsage({ vm, tokenDelta: 3, timeDeltaSeconds: 2 })
    expect(getThreadGoal(vm)?.tokensUsed).toBe(3)
    expect(getThreadGoal(vm)?.timeUsedSeconds).toBe(2)
    expect(getThreadGoal(vm)?.status).toBe("active")

    accountThreadGoalUsage({ vm, tokenDelta: 2 })
    expect(getThreadGoal(vm)?.status).toBe("budget_limited")
  })

  it("requires explicit edit before slash set replaces an existing goal", async () => {
    const registry = composeToolRegistry({ includeInternalOnly: true })
    const actor = createActor({ key: "main" })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      registries: { toolRegistry: registry },
      outerCtx: { metadata: { sessionId: "persisted-goal-replace-test" } },
    })

    const created = JSON.parse(String(await ToolFuncRegistry.call(registry, "GoalCommand", vm, actor, {
      command: "set",
      objective: "original objective",
    })))
    expect(created.ok).toBe(true)

    const rejected = JSON.parse(String(await ToolFuncRegistry.call(registry, "GoalCommand", vm, actor, {
      command: "set",
      objective: "accidental replacement",
    })))
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toBe("goal_already_exists")
    expect(getThreadGoal(vm)?.objective).toBe("original objective")

    const edited = JSON.parse(String(await ToolFuncRegistry.call(registry, "GoalCommand", vm, actor, {
      command: "edit",
      objective: "confirmed replacement",
    })))
    expect(edited.ok).toBe(true)
    expect(getThreadGoal(vm)?.objective).toBe("confirmed replacement")
  })

  it("requires three repeated blocked updates before marking a goal blocked", () => {
    const actor = createActor({ key: "main" })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      outerCtx: { metadata: { sessionId: "persisted-blocked-goal-test" } },
    })
    setThreadGoal({ vm, objective: "needs external service" })
    const goalRuntime = ensureVmRuntimeContext(vm).threadGoalRuntime

    goalRuntime.turnSequence = 1
    expect(updateThreadGoalStatus({ vm, status: "blocked", reason: "service down", modelUpdate: true }).ok).toBe(false)
    expect(updateThreadGoalStatus({ vm, status: "blocked", reason: "service down", modelUpdate: true }).ok).toBe(false)
    expect(getThreadGoal(vm)?.blockedTurnCount).toBe(1)
    goalRuntime.turnSequence = 2
    expect(updateThreadGoalStatus({ vm, status: "blocked", reason: "service down", modelUpdate: true }).ok).toBe(false)
    expect(getThreadGoal(vm)?.blockedTurnCount).toBe(2)
    goalRuntime.turnSequence = 3
    const final = updateThreadGoalStatus({ vm, status: "blocked", reason: "service down", modelUpdate: true })
    expect(final.ok).toBe(true)
    expect(getThreadGoal(vm)?.status).toBe("blocked")
  })

  it("requires an evidence audit before model completion", () => {
    const actor = createActor({ key: "main" })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      outerCtx: { metadata: { sessionId: "persisted-complete-goal-test" } },
    })
    setThreadGoal({ vm, objective: "finish the audit-sensitive goal" })

    const missingAudit = updateThreadGoalStatus({ vm, status: "complete", modelUpdate: true })
    expect(missingAudit.ok).toBe(false)
    expect((missingAudit as { ok: false; error: string }).error).toBe("complete_audit_required")
    expect(getThreadGoal(vm)?.status).toBe("active")

    const completed = updateThreadGoalStatus({
      vm,
      status: "complete",
      reason: "Verified all requirements in the goal objective are satisfied.",
      modelUpdate: true,
    })
    expect(completed.ok).toBe(true)
    expect(getThreadGoal(vm)?.status).toBe("complete")
    expect(getThreadGoal(vm)?.completionAudit).toContain("Verified all requirements")
  })

  it("rejects goal mutations for ephemeral threads", () => {
    const actor = createActor({ key: "main" })
    const vm = createVM({ controlActorKey: "main", actors: { main: actor }, outerCtx: { metadata: { ephemeral: true } } })

    const created = setThreadGoal({ vm, objective: "should not persist" })
    expect(created.ok).toBe(false)
    expect((created as { ok: false; error: string }).error).toBe("thread_goal_requires_persisted_thread")
    expect(getThreadGoal(vm)).toBeNull()
  })

  it("emits user-visible goal update notices", () => {
    const actor = createActor({ key: "main" })
    const eventBus = new AgentEventGraph()
    const events: any[] = []
    const subscription = eventBus.addConsumer((event) => events.push(event))
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      eventBus,
      outerCtx: { metadata: { sessionId: "persisted-visible-goal-test" } },
    })

    setThreadGoal({ vm, objective: "visible objective", tokenBudget: 1 })
    updateThreadGoalStatus({ vm, status: "paused" })
    updateThreadGoalStatus({ vm, status: "active" })
    accountThreadGoalUsage({ vm, tokenDelta: 1 })

    subscription.unsubscribe()
    const notices = events.filter((event) => event.event_type === "semantic_notice").map((event) => String(event.message))
    expect(notices.some((message) => message.includes("Thread goal created") && message.includes("visible objective"))).toBe(true)
    expect(notices.some((message) => message.includes("Thread goal status:paused"))).toBe(true)
    expect(notices.some((message) => message.includes("Thread goal budget_limited"))).toBe(true)
  })

  it("accounts goal usage in cooperative turns", async () => {
    const registry = composeToolRegistry({ includeInternalOnly: true })
    const actor = createActor({
      key: "main",
      llmClient: {
        type: "openai" as const,
        async createStream() {
          async function* stream() {
            yield { ok: true }
          }
          return { stream: stream() }
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async () => ({ role: "assistant", content: "goal progress completed" })),
      },
    })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      registries: { toolRegistry: registry },
      outerCtx: { metadata: { sessionId: "persisted-cooperative-goal-test" } },
    })
    setThreadGoal({ vm, objective: "make progress in cooperative executor" })

    const fiberId = `${actor.key}:${actor.id}`
    const messages: any[] = [{ role: "user", content: "start" }]
    let state: any
    const runStep = () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor,
      messages,
      state,
      setState: (next) => {
        state = next
      },
      resumeFiber: () => {},
    })

    expect((await runStep()).kind).toBe("yield")
    expect((await runStep()).kind).toBe("yield")
    expect((await runStep()).kind).toBe("suspend")
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect((await runStep()).kind).toBe("suspend")

    expect(getThreadGoal(vm)?.tokensUsed).toBeGreaterThan(0)
  })

  it("injects goal continuation as runtime internal context instead of human input", () => {
    const actor = createActor({ key: "main" })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      outerCtx: { metadata: { sessionId: "persisted-goal-continuation-test" } },
    })
    const created = setThreadGoal({ vm, objective: "continue safely" })
    expect(created.ok).toBe(true)

    const fiberId = `${actor.key}:${actor.id}`
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }],
      runStep: async () => ({ kind: "suspend", reason: "idle_external" }),
    })
    driver.suspendFiber(fiberId, 1, "idle_external")

    const started = maybeStartThreadGoalContinuation({ vm, driver, now: 2, mainFiberId: fiberId })
    expect(started).toBe(true)
    expect(actor.peekMailbox("humanInput")).toEqual([])
    expect(actor.peekMailbox("heartbeat")).toEqual([
      {
        heartbeatKind: "runtime_internal_context",
        source: "goal",
        text: buildGoalContinuationPrompt(getThreadGoal(vm)!),
      },
    ])
    expect((actor.peekMailbox("heartbeat")[0] as any).text).toContain("<runtime_internal_context source=\"goal\">")
    expect((actor.peekMailbox("heartbeat")[0] as any).text).not.toContain("<codex_internal_context")
  })

  it("keeps real user input and pending goal continuation in separate priority queues", () => {
    const actor = createActor({ key: "main" })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      outerCtx: { metadata: { sessionId: "persisted-goal-preempt-test" } },
    })
    setThreadGoal({ vm, objective: "continue safely" })

    const fiberId = `${actor.key}:${actor.id}`
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }],
      runStep: async () => ({ kind: "suspend", reason: "idle_external" }),
    })
    driver.suspendFiber(fiberId, 1, "idle_external")
    expect(maybeStartThreadGoalContinuation({ vm, driver, now: 2, mainFiberId: fiberId })).toBe(true)
    expect(ensureVmRuntimeContext(vm).threadGoalRuntime.continuationInFlight).toBe(true)

    driver.emitFiberSignal({
      fiberId,
      signalKind: "mailbox_enqueue",
      mailbox: { kind: "humanInput", payload: "请取消当前的goal" },
      idempotencyKey: `${fiberId}:humanInput:test`,
      createdAt: 3,
    })

    expect(actor.peekMailbox("heartbeat")).toEqual([
      {
        heartbeatKind: "runtime_internal_context",
        source: "goal",
        text: buildGoalContinuationPrompt(getThreadGoal(vm)!),
      },
    ])
    expect(actor.peekMailbox("humanInput")).toEqual(["请取消当前的goal"])
    expect(ensureVmRuntimeContext(vm).threadGoalRuntime.continuationInFlight).toBe(true)
  })

  it("does not enqueue heartbeat continuation while wake mailbox work is pending", () => {
    const pendingByMailbox = {
      control: { kind: "cancel_requested" },
      toolResult: { toolCallId: "call-1", content: "tool result" },
      asyncCompletion: { kind: "llm_done", opId: "llm:1", msg: { role: "assistant", content: "done" } },
      childDone: { childActorKey: "child", outputText: "done" },
      memberCoordination: { from: "member", text: "<coordination />", ts: 1 },
      humanInput: "user first",
      memberChatInbox: { from: "member", text: "member first", ts: 1 },
      heartbeat: { heartbeatKind: "runtime_internal_context", source: "test", text: "wake" },
    } as const

    for (const [mailbox, payload] of Object.entries(pendingByMailbox)) {
      const actor = createActor({ key: "main", id: `actor-${mailbox}` })
      const vm = createVM({
        controlActorKey: "main",
        actors: { main: actor },
        outerCtx: { metadata: { sessionId: `pending-${mailbox}` } },
      })
      setThreadGoal({ vm, objective: "continue safely" })
      actor.send(mailbox as any, payload as any)

      const fiberId = `${actor.key}:${actor.id}`
      const driver = createAiAgentOrchestratorDriver({
        fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }],
        runStep: async () => ({ kind: "suspend", reason: "idle_external" }),
      })
      driver.suspendFiber(fiberId, 1, "idle_external")

      expect(maybeStartThreadGoalContinuation({ vm, driver, now: 2, mainFiberId: fiberId })).toBe(false)
      expect(ensureVmRuntimeContext(vm).threadGoalRuntime.continuationInFlight).toBe(false)
      expect(actor.peekMailbox("heartbeat").filter((entry: any) => entry?.source === "goal")).toEqual([])
    }
  })
})
