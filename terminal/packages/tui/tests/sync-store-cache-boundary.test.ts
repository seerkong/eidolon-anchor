import { describe, expect, it } from "bun:test"
import { createStore } from "solid-js/store"
import { applySyncEvent, createInitialSyncStore, syncSessionData } from "../src/app/tui_a1/state/sync-store"

function runtimeMessage(id: string, created: number) {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant" as const,
    time: { created, completed: created + 1 },
    agent: "build",
    mode: "assist",
    providerID: "openai",
    modelID: "gpt-5.4",
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    finish: "stop" as const,
  }
}

function runtimeTextPart(messageID: string, created: number) {
  return {
    id: `part-${messageID}`,
    sessionID: "ses_1",
    messageID,
    type: "text" as const,
    text: `text ${created}`,
    time: { start: created, end: created + 1 },
  }
}

function createHarness() {
  const [store, setStore] = createStore(createInitialSyncStore())
  const runtimeClient = {} as any
  const bootstrap = async () => {}

  return {
    store,
    setStore,
    dispatch(event: { type: string; properties: Record<string, unknown> }) {
      applySyncEvent({ event, store, setStore, runtimeClient, bootstrap })
    },
  }
}

describe("sync store cache boundaries", () => {
  it("prunes part buckets when old cached messages are evicted", () => {
    const harness = createHarness()

    for (let index = 0; index < 105; index += 1) {
      const id = `msg-${index.toString().padStart(3, "0")}`
      harness.dispatch({ type: "message.updated", properties: { info: runtimeMessage(id, index) } })
      harness.dispatch({ type: "message.part.updated", properties: { part: runtimeTextPart(id, index) } })
    }

    expect(harness.store.message.ses_1.length).toBe(100)
    expect(Object.keys(harness.store.part).length).toBe(100)
    expect(harness.store.part["msg-004"]).toBeUndefined()
    expect(harness.store.part["msg-005"]).toBeDefined()
    expect(harness.store.part["msg-104"]).toBeDefined()
  })

  it("removes parts when a message is removed", () => {
    const harness = createHarness()

    harness.dispatch({ type: "message.updated", properties: { info: runtimeMessage("msg-001", 1) } })
    harness.dispatch({ type: "message.part.updated", properties: { part: runtimeTextPart("msg-001", 1) } })
    harness.dispatch({ type: "message.removed", properties: { sessionID: "ses_1", messageID: "msg-001" } })

    expect(harness.store.message.ses_1).toEqual([])
    expect(harness.store.part["msg-001"]).toBeUndefined()
  })

  it("does not recreate parts for messages outside the retained cache", () => {
    const harness = createHarness()

    for (let index = 0; index < 101; index += 1) {
      const id = `msg-${index.toString().padStart(3, "0")}`
      harness.dispatch({ type: "message.updated", properties: { info: runtimeMessage(id, index) } })
      harness.dispatch({ type: "message.part.updated", properties: { part: runtimeTextPart(id, index) } })
    }

    harness.dispatch({ type: "message.part.updated", properties: { part: runtimeTextPart("msg-000", 200) } })

    expect(harness.store.part["msg-000"]).toBeUndefined()
  })

  it("prunes stale part buckets when full session sync replaces the message cache", async () => {
    const harness = createHarness()

    for (let index = 0; index < 3; index += 1) {
      const id = `msg-${index.toString().padStart(3, "0")}`
      harness.dispatch({ type: "message.updated", properties: { info: runtimeMessage(id, index) } })
      harness.dispatch({ type: "message.part.updated", properties: { part: runtimeTextPart(id, index) } })
    }

    await syncSessionData({
      sessionID: "ses_1",
      store: harness.store,
      setStore: harness.setStore,
      fullSyncedSessions: new Set(),
      runtimeClient: {
        client: {
          session: {
            get: async () => ({ data: { id: "ses_1", title: "Session" } }),
            messages: async () => ({
              data: [
                { info: runtimeMessage("msg-001", 1), parts: [runtimeTextPart("msg-001", 1)] },
                { info: runtimeMessage("msg-002", 2), parts: [runtimeTextPart("msg-002", 2)] },
              ],
            }),
            todo: async () => ({ data: [] }),
            diff: async () => ({ data: [] }),
          },
        },
      } as any,
    })

    expect(harness.store.message.ses_1.map((message) => message.id)).toEqual(["msg-001", "msg-002"])
    expect(harness.store.part["msg-000"]).toBeUndefined()
    expect(harness.store.part["msg-001"]).toBeDefined()
    expect(harness.store.part["msg-002"]).toBeDefined()
  })
})
