import { expect, test } from "bun:test"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { spawnChildExecutionActor } from "@cell/ai-organ-logic/agent/DelegateActor"
import { createInteractiveActor } from "@cell/ai-organ-logic/runtime/InteractiveActor"
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import { createHostActorLifecycle, hostActorExecutionKind } from "../../cell/packages/ai-runtime-host-capsule/src/actorLifecycle"
import { createObservationState, captureObservation, publishObservation, type ObservationRuntime } from "../../cell/packages/ai-runtime-host-logic/src/observations"
import { createObservationCursorEffects, createObservationQueueEffects } from "../../cell/packages/ai-runtime-host-support/src"
import type { ActorSummary } from "../../cell/packages/ai-runtime-host-contract/src"

const view = (actorId: string): ActorSummary => ({ actorId, displayName: actorId, executionKind: "delegate", runtimeState: "idle", allowedActions: ["observe"], capabilities: { textInput: false, cancelTurn: false, questionnaireAnswer: false } })
function fixture(count = 1, maxActors = 64) {
  const parent = createActor({ key: "main", id: "parent", modelConfig: { model: "mock" },
    llmClient: { type: "openai", async createStream() { return { stream: (async function* () { yield {} })() } } },
    callbacks: { buildToolset: () => [], processStream: async (vm, actor) => {
      const message = { role: "assistant" as const, content: "child done" }
      appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: actor.key, actorId: actor.id, message }); return message
    } } })
  const actors = { main: parent } as Record<string, typeof parent>
  for (let i = 1; i < count; i++) actors[`seed:${i}`] = createActor({ key: `seed:${i}`, id: `seed:${i}` })
  const vm = createVM({ controlActorKey: parent.key, actors, registries: { toolRegistry: composeToolRegistry(), agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["Return report"] } } as any) } })
  const observations: ObservationRuntime = { sessionId: "s", epoch: "e", state: createObservationState(), authorization: { permits: () => true, currentGrantsVersion: () => "1" }, identity: { now: Date.now, newId: () => "id" }, cursors: createObservationCursorEffects(), queues: createObservationQueueEffects() }
  const actorViews = new Map<string, ActorSummary>()
  const registerView = (actor: typeof parent) => { const summary = view(actor.id); publishObservation(observations, { kind: "actor.created", payload: summary }); actorViews.set(actor.id, summary) }
  for (const actor of Object.values(vm.actors)) registerView(actor)
  const lifecycle = createHostActorLifecycle({ vm, observations, actorViews, maxActors })
  vm.effects.actorRegistration = { beforeRegister: lifecycle.beforeRegister }
  return { vm, parent, observations, actorViews, lifecycle, registerView }
}

test("actual delegate, detached and interactive registration reject the 65th actor without registry writes", async () => {
  const f = fixture(64); let childKey = ""
  for (const mode of ["sync_wait", "detached"] as const) {
    await expect(spawnChildExecutionActor(f.vm, f.parent, { description: "overflow", prompt: "run", agentType: "code", mode,
      validateBeforeRegistration: actor => { childKey = actor.key } })).rejects.toMatchObject({ status: 429, error: { code: "actor_capacity" } })
    expect(f.vm.actors[childKey]).toBeUndefined(); expect(f.vm.actorRuntime.has(childKey)).toBe(false)
  }
  let spawned = false
  expect(() => createInteractiveActor({ vm: f.vm, driver: { spawnFiber() { spawned = true } } as any, newId: () => "overflow", now: Date.now }, {})).toThrow("actor_capacity")
  expect(spawned).toBe(false); expect(f.vm.actors["interactive:overflow"]).toBeUndefined(); expect(f.vm.actorRuntime.has("interactive:overflow")).toBe(false)
  expect(Object.keys(f.vm.actors)).toHaveLength(64)
})

test("actual immediate delegates retire after owner cleanup and can reuse capacity repeatedly", async () => {
  const f = fixture(1, 2)
  for (let index = 0; index < 4; index++) {
    let childId = ""
    const result = await spawnChildExecutionActor(f.vm, f.parent, { description: "report", prompt: "run", agentType: "code", mode: "sync_wait",
      onActorCreated: actor => { childId = actor.id; f.registerView(actor) } })
    expect(result).toBe("child done")
    expect(f.lifecycle.reconcile()).toEqual([childId]); expect(f.actorViews.has(childId)).toBe(false)
    expect(Object.keys(f.vm.actors)).toEqual(["main"])
  }
})

test("retirement protects active caller controls and resets existing observers once the turn terminates", async () => {
  const f = fixture(); publishObservation(f.observations, { kind: "actor.created", payload: view("gone") }); f.actorViews.set("gone", view("gone"))
  publishObservation(f.observations, { kind: "turn.updated", payload: { actorId: "gone", turnId: "t", state: "running", canCancel: true, pendingQuestionIds: [] } })
  const sub = captureObservation(f.observations, { principal: { principalId: "p", grantsVersion: "1" }, requestId: "r" }, { actors: ["parent"] })
  const it = sub.frames[Symbol.asyncIterator](); await it.next()
  expect(f.lifecycle.reconcile()).toEqual([])
  publishObservation(f.observations, { kind: "turn.updated", payload: { actorId: "gone", turnId: "t", state: "succeeded", canCancel: false, pendingQuestionIds: [] } })
  expect(f.lifecycle.reconcile()).toEqual(["gone"]); expect((await it.next()).done).toBe(true)
  expect(f.observations.state.ring).toEqual([])
})

test("unknown kinds are unsupported and organization creation is denied before registration", () => {
  const f = fixture()
  expect(() => hostActorExecutionKind({ type: "legacy" as any })).toThrow("unsupported_actor_kind")
  expect(hostActorExecutionKind({ type: "detached" })).toBe("detached")
  expect(() => f.lifecycle.beforeRegister({ actorId: "org", actorKey: "org", actorType: "delegate", identity: { kind: "member" } })).toThrow("organization_creation_unsupported")
  expect(f.vm.actors.org).toBeUndefined(); expect(f.vm.actorRuntime.has("org")).toBe(false)
})
