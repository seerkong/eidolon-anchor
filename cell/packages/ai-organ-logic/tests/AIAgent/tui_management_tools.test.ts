import { describe, expect, it } from "bun:test"

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import {
  AI_AGENT_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_NAMES,
  AI_AGENT_COORDINATION_STATUSES,
} from "@cell/ai-core-logic"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM, ensureVmRuntimeContext, ensureVmSessionState } from "@cell/ai-core-logic/runtime/runtime"
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph"
import { createAiAgentOrchestratorDriverWithCooperative, getMemberManager } from "@cell/ai-organ-logic"
import { createAutonomousHolonController } from "@cell/ai-organ-logic/organization/AutonomousHolonController"
import { getCoordinationEngine } from "@cell/ai-organ-logic/coordination/CoordinationEngine"
import { TaskTreeManager } from "@cell/ai-organ-logic/plan/TaskTreeManager"

function makeMockAdapter() {
  return {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield { ok: true }
      }
      return { stream: stream() }
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0))
  }
}

describe("TUI management tools", () => {
  it("supports member create/list/assign through tools", async () => {
    const adapter = makeMockAdapter()
    const recorded: any[] = []
    const control = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (_vm, actor) => {
          recorded.push(actor.messages)
          return { role: "assistant", content: "ok" }
        },
      },
    })

    const bus = new AgentEventGraph()
    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: control.key,
      actors: { [control.key]: control },
      eventBus: bus,
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
    })

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${control.key}:${control.id}`, vm, actor: control, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const controller = createAutonomousHolonController({ driver, vm, controlActor: control, members: getMemberManager() })
    const runtimeContext = ensureVmRuntimeContext(vm)
    runtimeContext.driver = driver

    const members = getMemberManager()
    members.__resetForTest?.()

    const spawned = JSON.parse(String(await toolRegistry.call("MemberCreate", vm, control, {
      name: "alice",
      agent_type: "code",
      prompt: "hello alice",
    })))
    expect(spawned.ok).toBe(true)
    expect(spawned.member_id).toBeTruthy()
    const memberId = spawned.memberId ?? spawned.member_id
    expect(typeof memberId).toBe("string")

    const listed = JSON.parse(String(await toolRegistry.call("MemberList", vm, control, {})))
    expect(listed.ok).toBe(true)
    expect(Array.isArray(listed.members)).toBe(true)
    expect(listed.members.some((t: any) => t.member_id === spawned.member_id)).toBe(true)

    await toolRegistry.call("MemberAssign", vm, control, { target: memberId, content: "ping" })
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 })
    await flushMicrotasks()

    const spawned2 = JSON.parse(String(await toolRegistry.call("MemberCreate", vm, control, {
      name: "bob",
      agent_type: "code",
      prompt: "hello bob",
    })))
    const listedAgain = JSON.parse(String(await toolRegistry.call("MemberList", vm, control, {})))
    expect(listedAgain.members.some((t: any) => t.member_id === (spawned2.memberId ?? spawned2.member_id))).toBe(true)
  })

  it("resolves MemberAssign target by member name as well as member_id", async () => {
    const adapter = makeMockAdapter()
    const control = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: control.key,
      actors: { [control.key]: control },
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
    })

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${control.key}:${control.id}`, vm, actor: control, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const members = getMemberManager()
    members.__resetForTest?.()
    const controller = createAutonomousHolonController({ driver, vm, controlActor: control, members: members })
    const runtimeContext2 = ensureVmRuntimeContext(vm)
    runtimeContext2.driver = driver

    const spawned = JSON.parse(String(await toolRegistry.call("MemberCreate", vm, control, {
      name: "Alice",
      agent_type: "code",
      prompt: "you are alice",
    })))

    const sent = JSON.parse(String(await toolRegistry.call("MemberAssign", vm, control, { target: "Alice", content: "ping" })))
    expect(sent.ok).toBe(true)
    expect(sent.member_id).toBeTruthy()
    expect(sent.member_id).toBe(spawned.memberId ?? spawned.member_id)
  })

  it("emits a control-visible member completion quote after MemberAssign work finishes", async () => {
    const adapter = makeMockAdapter()
    const events: any[] = []
    const bus = new AgentEventGraph()
    bus.addConsumer((event) => events.push(event))

    const control = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (_vm, actor) => {
          if (String(actor.key).startsWith("member:")) {
            return { role: "assistant", content: "worker finished summary" }
          }
          return { role: "assistant", content: "control ok" }
        },
      },
    })

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: control.key,
      actors: { [control.key]: control },
      eventBus: bus,
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
    })

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${control.key}:${control.id}`, vm, actor: control, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const members = getMemberManager()
    members.__resetForTest?.()
    const controller = createAutonomousHolonController({ driver, vm, controlActor: control, members: members })
    const runtimeContext3 = ensureVmRuntimeContext(vm)
    runtimeContext3.driver = driver

    await toolRegistry.call("MemberCreate", vm, control, {
      name: "Alice",
      agent_type: "code",
      prompt: "you are Alice",
    })
    await toolRegistry.call("MemberAssign", vm, control, { target: "Alice", content: "ping" })
    await driver.tickUntilBlocked({ now: Date.now(), maxTicks: 120, maxWallMs: 2000 })
    await flushMicrotasks()

    expect(
      events.some(
        (event) => (event as any)?.event_type === "semantic_quote" && String((event as any)?.text ?? "").includes("Member Alice finished"),
      ),
    ).toBe(true)
  })

  it("supports shutdown tool and autonomous holon runtime control with member-first setup", async () => {
    const adapter = makeMockAdapter()
    const control = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (_vm, actor) => {
          if (String(actor.key).startsWith("member:")) {
            const lastUser = (actor.messages as any[]).filter((m) => m?.role === "user").slice(-1)[0]
            const text = String(lastUser?.content ?? "")
            const match = text.match(/TASK_ID=([^\n]+)/)
            if (match?.[1]) {
              TaskTreeManager.apply(actor.taskTree, { op: "update_status", task_id: match[1], status: "completed" })
            }
          }
          return { role: "assistant", content: "ok" }
        },
      },
    })

    TaskTreeManager.apply(control.taskTree, {
      op: "replace_root",
      tasks: [{ content: "do collective work", status: "pending", activeForm: "main" }],
    })

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: control.key,
      actors: { [control.key]: control },
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
    })

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${control.key}:${control.id}`, vm, actor: control, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const members = getMemberManager()
    members.__resetForTest?.()
    const controller = createAutonomousHolonController({ driver, vm, controlActor: control, members: members })
    const runtimeContext4 = ensureVmRuntimeContext(vm)
    runtimeContext4.driver = driver

    const autoMate = members.createMember({
      vm,
      driver,
      controlActor: control,
      name: "worker-auto",
      role: "worker",
      agentType: "code",
      systemPrompt: ["work from the board"],
      lane: "autonomous_holon",
      shareTaskTree: true,
    })

    controller.start({ idleTimeoutMs: 1000, tickIntervalMs: 10 })
    expect(controller.status().enabled).toBe(true)

    await controller.tick()
    const status = controller.status()
    expect(status.enabled).toBe(true)

    const shut = JSON.parse(String(await toolRegistry.call("ShutdownRequest", vm, control, { member_id: autoMate.memberId, reason: "done" })))
    expect(shut.ok).toBe(true)
    expect(shut.member_id).toBe(autoMate.memberId)
    expect(shut.status).toBe("pending")

    const shutdownStatusBeforeExit = JSON.parse(String(await toolRegistry.call("ShutdownStatus", vm, control, { request_id: shut.request_id })))
    expect(shutdownStatusBeforeExit.ok).toBe(true)
    expect(shutdownStatusBeforeExit.status).toBe("pending")

    const rosterAfterShutdownRequest = JSON.parse(String(await toolRegistry.call("MemberList", vm, control, {})))
    const requestedEntry = members.listMembers({ vm }).find((t) => t.memberId === autoMate.memberId)
    expect(rosterAfterShutdownRequest.ok).toBe(true)
    expect(requestedEntry?.memberId).toBe(autoMate.memberId)

    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 120, maxWallMs: 2000 })
    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 120, maxWallMs: 2000 })
    await flushMicrotasks()

    const shutdownStatus = JSON.parse(String(await toolRegistry.call("ShutdownStatus", vm, control, { request_id: shut.request_id })))
    expect(shutdownStatus.ok).toBe(true)
    expect(shutdownStatus.status).toBe("completed")

    const protocolStatus = JSON.parse(String(await toolRegistry.call("CoordinationStatus", vm, control, { request_id: shut.request_id })))
    expect(protocolStatus.ok).toBe(true)
    expect(protocolStatus.coordination).toBe("shutdown")
  })

  it("supports autonomous holon assign by natural-language task description", async () => {
    const adapter = makeMockAdapter()
    const events: any[] = []
    const control = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (_vm, actor) => {
          if (String(actor.key).startsWith("member:")) {
            const lastUser = (actor.messages as any[]).filter((m) => m?.role === "user").slice(-1)[0]
            const text = String(lastUser?.content ?? "")
            const match = text.match(/TASK_ID=([^\n]+)/)
            if (match?.[1]) {
              TaskTreeManager.apply(actor.taskTree, { op: "update_status", task_id: match[1], status: "completed" })
            }
          }
          return { role: "assistant", content: "ok" }
        },
      },
    })

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const bus = new AgentEventGraph()
    bus.addConsumer((event) => events.push(event))
    const vm = createVM({
      controlActorKey: control.key,
      actors: { [control.key]: control },
      eventBus: bus,
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
    })

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${control.key}:${control.id}`, vm, actor: control, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const members = getMemberManager()
    members.__resetForTest?.()
    const controller = createAutonomousHolonController({ driver, vm, controlActor: control, members: members })
    const runtimeContext = ensureVmRuntimeContext(vm)
    runtimeContext.driver = driver

    const autoMate = members.createMember({
      vm,
      driver,
      controlActor: control,
      name: "worker-auto",
      role: "worker",
      agentType: "code",
      systemPrompt: ["work from the board"],
      lane: "autonomous_holon",
      shareTaskTree: true,
    })
    const holon = JSON.parse(String(await toolRegistry.call("HolonCreate", vm, control, {
      governance: "autonomous",
      name: "research",
    })))
    expect(holon.ok).toBe(true)
    await toolRegistry.call("HolonAdd", vm, control, { holon: holon.holon_id, member: autoMate.memberId })

    controller.start({ idleTimeoutMs: 1000, tickIntervalMs: 10 })
    const dispatched = JSON.parse(String(await toolRegistry.call("HolonAssign", vm, control, {
      target: holon.holon_id,
      content: "scan the current project and explain what it does",
      mode: "final",
    })))

    expect(dispatched.ok).toBe(true)
    expect(typeof dispatched.task_id).toBe("string")

    await controller.tick()
    await flushMicrotasks()

    expect(
      events.some(
        (event) => (event as any)?.event_type === "semantic_quote" && String((event as any)?.text ?? "").includes(`Holon assigned ${dispatched.task_id}`),
      ),
    ).toBe(true)
    expect(
      events.some(
        (event) => (event as any)?.event_type === "semantic_quote" && String((event as any)?.text ?? "").includes("Member worker-auto finished"),
      ),
    ).toBe(true)

    const collectiveActor = vm.actors[`holon:${holon.holon_id}`]
    expect(collectiveActor?.holonState?.governance === "autonomous"
      ? collectiveActor.holonState.tasks?.[dispatched.task_id]
      : undefined).toMatchObject({
      content: "scan the current project and explain what it does",
      status: "completed",
    })
  })

  it("supports member create followed by collective create/add through the new tool surface", async () => {
    const adapter = makeMockAdapter()
    const control = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const toolRegistry = composeToolRegistry()
    const vm = createVM({
      controlActorKey: control.key,
      actors: { [control.key]: control },
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
    })

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${control.key}:${control.id}`, vm, actor: control, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const members = getMemberManager()
    members.__resetForTest?.()
    const controller = createAutonomousHolonController({ driver, vm, controlActor: control, members: members })
    const runtimeContext = ensureVmRuntimeContext(vm)
    runtimeContext.driver = driver

    const spawned = JSON.parse(String(await toolRegistry.call("MemberCreate", vm, control, {
      name: "code-worker",
      agent_type: "code",
      prompt: "",
    })))
    expect(spawned.ok).toBe(true)

    const collective = JSON.parse(String(await toolRegistry.call("HolonCreate", vm, control, {
      governance: "autonomous",
      name: "research",
    })))
    expect(collective.ok).toBe(true)
    expect(collective.governance).toBe("autonomous")

    const added = JSON.parse(String(await toolRegistry.call("HolonAdd", vm, control, {
      holon: collective.holon_id,
      member: spawned.member_id,
    })))
    expect(added.ok).toBe(true)
    expect(added.member_ids).toContain(spawned.member_id)
  })

  it("reports coordination from actor-owned state and pending per-actor mailboxes", async () => {
    const adapter = makeMockAdapter()
    const control = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: control.key,
      actors: { [control.key]: control },
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
    })

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${control.key}:${control.id}`, vm, actor: control, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const members = getMemberManager()
    members.__resetForTest?.()
    const controller = createAutonomousHolonController({ driver, vm, controlActor: control, members })
    const runtimeContext = ensureVmRuntimeContext(vm)
    runtimeContext.driver = driver

    const worker = members.createMember({
      vm,
      driver,
      controlActor: control,
      name: "worker-owned-coordination",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are worker"],
    })

    worker.actor.shutdownCoordination = {
      requestId: "req-owned-shutdown",
      kind: "shutdown_done",
      status: "completed",
      updatedAt: 123,
    }

    const ownedStatus = JSON.parse(String(await toolRegistry.call("CoordinationStatus", vm, control, { request_id: "req-owned-shutdown" })))
    expect(ownedStatus.ok).toBe(true)
    expect(ownedStatus.coordination).toBe("shutdown")
    expect(ownedStatus.kind).toBe("shutdown_done")
    expect(ownedStatus.status).toBe("completed")
    expect(ownedStatus.actor_key).toBe(worker.actorKey)
    expect(ownedStatus.truth_source).toBe("actor_owned")
    expect(ownedStatus.degraded).toBe(false)

    const shutdownStatus = JSON.parse(String(await toolRegistry.call("ShutdownStatus", vm, control, { request_id: "req-owned-shutdown" })))
    expect(shutdownStatus.ok).toBe(true)
    expect(shutdownStatus.status).toBe("completed")
    expect(shutdownStatus.actor_key).toBe(worker.actorKey)
    expect(shutdownStatus.truth_source).toBe("actor_owned")

    const outbound = getCoordinationEngine().makeOutbound({
      coordination: AI_AGENT_COORDINATION_NAMES.planApproval,
      kind: AI_AGENT_COORDINATION_KINDS.planRequest,
      payload: { plan: "pending mailbox" },
    })
    worker.actor.send("coordination", {
      from: control.key,
      text: outbound.text,
      ts: Date.now(),
    } as any)

    const pendingStatus = JSON.parse(String(await toolRegistry.call("CoordinationStatus", vm, control, { request_id: outbound.request_id })))
    expect(pendingStatus.ok).toBe(true)
    expect(pendingStatus.coordination).toBe("plan_approval")
    expect(pendingStatus.status).toBe("pending")
    expect(pendingStatus.actor_key).toBe(worker.actorKey)
    expect(pendingStatus.truth_source).toBe("pending_mailbox")
    expect(pendingStatus.degraded).toBe(false)
  })
})
