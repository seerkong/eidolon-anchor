import { describe, expect, test } from "bun:test"
import {
  captureAndSubscribeConversationHistory,
  createConversationDomainRuntime,
  appendLiveHistoryMessageToConversationDomainRuntime,
  ensureVmConversationDomainRuntime,
} from "../../cell/packages/ai-organ-logic/src/conversationCapsule/coreLogic"
import { createActor } from "../../cell/packages/ai-core-logic/src/runtime/actor"
import { createVM } from "../../cell/packages/ai-core-logic/src/runtime/runtime"
import type { ConversationHistoryRuntimeState } from "../../cell/packages/ai-organ-logic/src/conversation/ConversationDomainRuntimeTypes"

function history(count: number): Record<string, ConversationHistoryRuntimeState> {
  return { actor: { sessionId: "s", actorKey: "a", actorId: "a-id", generations: [], updatedAt: String(count) } }
}

describe("conversation owner history read fence", () => {
  test("real history commit is captured at its owner revision and later append preserves the captured view", () => {
    const actor = createActor({ key: "main" })
    const vm = createVM({ controlActorKey: actor.key, actors: { main: actor }, outerCtx: { metadata: { sessionId: "fence-session" } } })
    const runtime = ensureVmConversationDomainRuntime(vm)
    const revisions: number[] = []
    appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: actor.key, actorId: actor.id, message: { role: "user", content: "first" } })
    const lease = captureAndSubscribeConversationHistory(runtime, (event) => revisions.push(event.revision), () => {})
    const key = "fence-session::main"
    expect(lease.snapshot.value[key].generations[0].messages).toHaveLength(1)
    appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: actor.key, actorId: actor.id, message: { role: "assistant", content: "second" } })
    expect(lease.snapshot.value[key].generations[0].messages).toHaveLength(1)
    expect(runtime.historyStateSignal.get()[key].generations[0].messages).toHaveLength(2)
    expect(revisions).toEqual([lease.snapshot.revision + 1])
    lease.unsubscribe()
  })
  test("capture inside a mutation notification sees that revision once and receives all later revisions", () => {
    const runtime = createConversationDomainRuntime()
    const events: number[] = []
    let captured = 0
    let unsubscribe = () => {}
    const reentrant = runtime.historyStateSignal.subscribe(() => {
      reentrant.unsubscribe()
      const lease = captureAndSubscribeConversationHistory(runtime, (event) => events.push(event.revision), () => {})
      captured = lease.snapshot.revision
      expect(lease.snapshot.value.actor.updatedAt).toBe("1")
      unsubscribe = lease.unsubscribe
      runtime.historyStateSignal.set(history(2))
    })
    runtime.historyStateSignal.set(history(1))
    expect(captured).toBe(1)
    expect(events).toEqual([2])
    runtime.historyStateSignal.set(history(3))
    expect(events).toEqual([2, 3])
    unsubscribe()
    runtime.historyStateSignal.set(history(4))
    expect(events).toEqual([2, 3])
  })

  test("a reader reentering the owner cannot make another reader see reversed revisions", () => {
    const runtime = createConversationDomainRuntime()
    const first: number[] = []
    const second: number[] = []
    const lease = captureAndSubscribeConversationHistory(runtime, (event) => {
      first.push(event.revision)
      if (event.revision === 1) runtime.historyStateSignal.set(history(2))
    }, () => {})
    const other = captureAndSubscribeConversationHistory(runtime, (event) => second.push(event.revision), () => {})
    runtime.historyStateSignal.set(history(1))
    expect(lease.snapshot.revision).toBe(0)
    expect(lease.snapshot.value).toEqual({})
    expect(first).toEqual([1, 2])
    expect(second).toEqual([1, 2])
    lease.unsubscribe()
    other.unsubscribe()
  })

  test("failed observer is detached and cannot prevent the owner or other subscribers progressing", () => {
    const runtime = createConversationDomainRuntime()
    const errors: unknown[] = []
    const revisions: number[] = []
    captureAndSubscribeConversationHistory(runtime, () => { throw new Error("closed transport") }, (error) => errors.push(error))
    const live = captureAndSubscribeConversationHistory(runtime, (event) => revisions.push(event.revision), () => {})
    runtime.historyStateSignal.set(history(1))
    runtime.historyStateSignal.set(history(2))
    expect(errors).toHaveLength(1)
    expect(revisions).toEqual([1, 2])
    expect(runtime.historyStateSignal.get().actor.updatedAt).toBe("2")
    live.unsubscribe()
  })
})
