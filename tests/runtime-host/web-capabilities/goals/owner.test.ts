import { expect, test } from "bun:test"
import { createActor, createVM, ensureVmRuntimeContext, serializeActor, serializeVM } from "@cell/ai-core-logic"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver"
import { maybeStartThreadGoalContinuation } from "@cell/ai-organ-logic/goals/ThreadGoalRuntime"
import { accountThreadGoalUsage, formatThreadGoalStatus, getThreadGoal, setThreadGoal, updateThreadGoalStatus } from "@cell/ai-organ-logic/goals/ThreadGoalManager"
import { quarantineWebExecutionOnRecovery } from "@cell/ai-organ-logic/persistence/ExecutionOriginRecovery"

function fixture() {
  const actor = createActor({ key: "main", id: "primary" })
  const registry = composeToolRegistry({ includeInternalOnly: true })
  const vm = createVM({ controlActorKey: actor.key, actors: { main: actor }, registries: { toolRegistry: registry }, outerCtx: { metadata: { sessionId: "session" } } })
  const activation = { source: "web" as const, sessionId: "session", actorId: actor.id, epoch: "epoch", principalId: "private-principal", grantsVersion: "private-grant", commandId: "private-command" }
  const fiberId = `${actor.key}:${actor.id}`
  const driver = createAiAgentOrchestratorDriver({ fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }], runStep: async () => ({ kind: "suspend", reason: "idle_external" }) })
  driver.suspendFiber(fiberId, 1, "idle_external")
  return { actor, vm, registry, activation, driver, fiberId }
}

test("Web goal policy records model-created goals paused and private activation never reaches model tool output", async () => {
  const { actor, vm, registry, activation } = fixture()
  ensureVmRuntimeContext(vm).threadGoalRuntime.requireExplicitActivation = true
  expect(setThreadGoal({ vm, objective: "字".repeat(6000) })).toMatchObject({ ok: false, error: "objective_too_large" })
  expect(setThreadGoal({ vm, objective: "bounded", tokenBudget: 1.2 })).toMatchObject({ ok: false, error: "invalid_token_budget" })
  const created = JSON.parse(String(await ToolFuncRegistry.call(registry, "create_goal", vm, actor, { objective: "user asked to track this", token_budget: 100 })))
  expect(created).toMatchObject({ ok: true, goal: { status: "paused", suspensionReason: "explicit_activation_required", tokenBudget: 100 } })
  expect(updateThreadGoalStatus({ vm, status: "active" })).toMatchObject({ ok: false, error: "explicit_activation_required" })
  expect(updateThreadGoalStatus({ vm, status: "active", activation }).ok).toBe(true)
  expect(updateThreadGoalStatus({ vm, status: "complete", modelUpdate: true, reason: "字".repeat(6000) })).toMatchObject({ ok: false, error: "goal_reason_too_large" })
  activation.epoch = "caller-mutated"
  expect(getThreadGoal(vm)!.activation!.epoch).toBe("epoch")
  for (const [name, input] of [["get_goal", {}], ["create_goal", { objective: "must not replace" }], ["GoalCommand", { command: "status" }], ["GoalCommand", { command: "set", objective: "must not replace" }], ["update_goal", { status: "blocked", reason: "only first blocker turn" }]] as const) {
    const output = String(await ToolFuncRegistry.call(registry, name, vm, actor, input))
    expect(output).not.toContain("activation")
    expect(output).not.toContain("private-principal")
    expect(output).not.toContain("private-grant")
  }
  expect(formatThreadGoalStatus(getThreadGoal(vm))).not.toContain("private-command")
  expect(updateThreadGoalStatus({ vm, status: "complete", modelUpdate: true })).toMatchObject({ ok: false, error: "complete_audit_required" })
  expect(updateThreadGoalStatus({ vm, status: "complete", modelUpdate: true, reason: "verified original objective" }).ok).toBe(true)
})

test("a Web goal can continue only through the injected admission and creates no untracked wake", () => {
  const { actor, vm, activation, driver, fiberId } = fixture()
  setThreadGoal({ vm, objective: "explicitly continue", activation })
  expect(maybeStartThreadGoalContinuation({ vm, driver, mainFiberId: fiberId, now: 2 })).toBe(false)
  expect(actor.peekMailbox("heartbeat")).toEqual([])
  expect(maybeStartThreadGoalContinuation({ vm, driver, now: 3, admit: () => false })).toBe(false)
  expect(ensureVmRuntimeContext(vm).threadGoalRuntime.continuationTurns).toBe(0)
  const admitted: unknown[] = []
  expect(maybeStartThreadGoalContinuation({ vm, driver, now: 4, admit: input => { admitted.push(input); return true } })).toBe(true)
  expect(admitted).toHaveLength(1)
  expect(admitted[0]).toMatchObject({ actorId: actor.id, fiberId, goal: { goalId: getThreadGoal(vm)!.goalId }, now: 4 })
  expect(actor.peekMailbox("heartbeat")).toEqual([])
  expect(actor.peekMailbox("humanInput")).toEqual([])
  expect(maybeStartThreadGoalContinuation({ vm, driver, now: 5, admit: () => { throw new Error("must not duplicate") } })).toBe(false)
})

test("Web goal recovery preserves objective, budget and counters, pauses activation and retires only goal wakes", () => {
  const { actor, vm, activation } = fixture()
  setThreadGoal({ vm, objective: "durable objective", activation, tokenBudget: 100 })
  accountThreadGoalUsage({ vm, tokenDelta: 7, timeDeltaSeconds: 4 })
  actor.send("heartbeat", { heartbeatKind: "runtime_internal_context", source: "goal", text: "retired wake" })
  actor.send("heartbeat", { heartbeatKind: "runtime_internal_context", source: "other", text: "unrelated" })
  actor.send("humanInput", "explicit input")
  const material = { vm: serializeVM(vm), actors: { main: serializeActor(actor) }, fibers: {} }
  quarantineWebExecutionOnRecovery(material)
  expect(material.vm.sessionState!.threadGoal).toMatchObject({ status: "paused", suspensionReason: "runtime_restarted", objective: "durable objective", tokenBudget: 100, tokensUsed: 7, timeUsedSeconds: 4 })
  expect(material.actors.main.mailboxes.heartbeat).toEqual([{ heartbeatKind: "runtime_internal_context", source: "other", text: "unrelated" }])
  expect(material.actors.main.mailboxes.humanInput).toEqual(["explicit input"])
  updateThreadGoalStatus({ vm, status: "active" }) // Explicit local adoption drops Web authorization.
  const local = { vm: serializeVM(vm), actors: { main: serializeActor(actor) }, fibers: {} }
  quarantineWebExecutionOnRecovery(local)
  expect(local.vm.sessionState!.threadGoal!.status).toBe("active")
  expect(local.vm.sessionState!.threadGoal).not.toHaveProperty("activation")
})
