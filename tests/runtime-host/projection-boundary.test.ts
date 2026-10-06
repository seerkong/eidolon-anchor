import { expect, test } from "bun:test"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM, ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime"
import { buildRuntimeSemanticBase } from "../../cell/packages/ai-core-logic/src/stream/runtime/SemanticRuntimeSupport"
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import { createShellRuntimeFacade } from "../../cell/packages/ai-organ-logic/src/runtime/ShellRuntimeFacade"
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver"
import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager"
import { getOrganizationManager } from "@cell/ai-organ-logic/organization/OrganizationManager"
import { isWatchedOrganizationProjection } from "../../terminal/packages/organ/src/AIAgent/OrganizationWatchProjection"

const eventFor = (actor: { key: string; id: string }): SemanticEvent => ({
  ...buildRuntimeSemanticBase({ agentKey: actor.key, agentActorId: actor.id }, 1), event_type: "semantic_content_start",
})

test("generic projection needs only actor identity/watch data, never organization state", () => {
  const control = createActor({ key: "main" }), observed = createActor({ key: "other" }); observed.watchState = "watched"
  const vm = createVM({ controlActorKey: control.key, actors: { main: control, other: observed } })
  // Every organization resolver reads session state; the generic projection must not touch it.
  Object.defineProperty(vm, "sessionState", { get() { throw new Error("organization state must not be read") } })
  const facade = createShellRuntimeFacade()
  expect(facade.routeProjectionEvent({ vm, controlActor: control, event: eventFor(control) })).toEqual({ visibleInTurn: true, notifyAsync: false })
  expect(facade.routeProjectionEvent({ vm, controlActor: control, event: eventFor(observed) })).toEqual({ visibleInTurn: true, notifyAsync: true })
  observed.watchState = "unwatched"
  expect(facade.routeProjectionEvent({ vm, controlActor: control, event: eventFor(observed) })).toEqual({ visibleInTurn: false, notifyAsync: false })
});

test("TUI opt-in projection retains watched organization and member visibility", () => {
  const control = createActor({ key: "main" })
  const vm = createVM({ controlActorKey: control.key, actors: { main: control } })
  const driver = createAiAgentOrchestratorDriver({ fibers: [{ fiberId: `${control.key}:${control.id}`, vm, actor: control, messages: [], basePriority: 1 }] })
  ensureVmRuntimeContext(vm).driver = driver
  const member = getMemberManager().createMember({ vm, driver, controlActor: control, name: "alice", role: "worker", agentType: "code" })
  const manager = getOrganizationManager()
  const holon = manager.createHolon(vm, "autonomous", "research")
  manager.addHolonMember(vm, holon.holonId, member.memberId)
  manager.setHolonWatchState(vm, holon.holonId, "watched")
  const facade = createShellRuntimeFacade({ additionalWatchedProjection: isWatchedOrganizationProjection })
  expect(facade.routeProjectionEvent({ vm, controlActor: control, event: eventFor({ key: `holon:${holon.holonId}`, id: holon.holonId }) })).toEqual({ visibleInTurn: true, notifyAsync: true })
  expect(facade.routeProjectionEvent({ vm, controlActor: control, event: eventFor(member.actor) })).toEqual({ visibleInTurn: true, notifyAsync: true })
  expect(createShellRuntimeFacade().routeProjectionEvent({ vm, controlActor: control, event: eventFor(member.actor) }).visibleInTurn).toBe(false)
  manager.setHolonWatchState(vm, holon.holonId, "unwatched")
  expect(facade.routeProjectionEvent({ vm, controlActor: control, event: eventFor(member.actor) }).visibleInTurn).toBe(false)
  const other = getMemberManager().createMember({ vm, driver, controlActor: control, name: "bob", role: "worker", agentType: "code" })
  const led = manager.createHolon(vm, "leader_led", "delivery")
  manager.addHolonMember(vm, led.holonId, member.memberId)
  manager.addHolonMember(vm, led.holonId, other.memberId)
  manager.appointHolonLeader(vm, led.holonId, member.memberId)
  manager.setHolonWatchState(vm, led.holonId, "watched")
  expect(facade.routeProjectionEvent({ vm, controlActor: control, event: eventFor(member.actor) }).visibleInTurn).toBe(true)
  expect(facade.routeProjectionEvent({ vm, controlActor: control, event: eventFor(other.actor) }).visibleInTurn).toBe(false)
});
