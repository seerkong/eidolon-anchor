import { describe, expect, it } from "bun:test"
import { TuiA1StateGraph } from "../src/app/tui_a1/graph"
import { defaultTuiA1Selection } from "../src/app/tui_a1/data"

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

describe("TuiA1StateGraph noop updates", () => {
  it("keeps the snapshot stable for identical selection merges", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
    })

    const initial = graph.snapshot()
    graph.mergeSelection({
      agent: initial.selection.agent,
      providerID: initial.selection.providerID,
      modelID: initial.selection.modelID,
    })

    expect(graph.snapshot()).toBe(initial)
  })

  it("keeps the snapshot stable for identical runtime message updates", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
    })

    const message = {
      id: "msg-1",
      sessionID: "ses_1",
      role: "assistant" as const,
      time: { created: 1, completed: 2 },
      agent: "build",
      mode: "assist",
      providerID: "openai",
      modelID: "gpt-5.4",
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      finish: "stop" as const,
    }

    graph.applyRuntimeMessageUpdated(message)
    const afterFirst = graph.snapshot()
    graph.applyRuntimeMessageUpdated(message)

    expect(graph.snapshot()).toBe(afterFirst)
  })

  it("does not replace the snapshot for no-op updates", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
    })

    const initial = graph.snapshot()
    graph.mergeSelection({
      agent: defaultTuiA1Selection.agent,
      providerID: defaultTuiA1Selection.providerID,
      modelID: defaultTuiA1Selection.modelID,
    })

    expect(graph.snapshot()).toBe(initial)
  })

  it("bounds runtime message and part projection caches", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
    })

    for (let index = 0; index < 105; index += 1) {
      const id = `msg-${index.toString().padStart(3, "0")}`
      graph.applyRuntimeMessageUpdated(runtimeMessage(id, index))
      graph.applyRuntimePartUpdated(runtimeTextPart(id, index))
    }

    const snapshot = graph.snapshot()
    expect(Object.keys(snapshot.runtimeMessages).length).toBe(100)
    expect(Object.keys(snapshot.runtimeParts).length).toBe(100)
    expect(snapshot.runtimeMessages["msg-000"]).toBeUndefined()
    expect(snapshot.runtimeParts["msg-000"]).toBeUndefined()
    expect(snapshot.runtimeMessages["msg-104"]).toBeDefined()
    expect(snapshot.runtimeParts["msg-104"]).toBeDefined()
  })

  it("does not recreate part buckets for evicted runtime messages", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
      selection: defaultTuiA1Selection,
    })

    for (let index = 0; index < 105; index += 1) {
      const id = `msg-${index.toString().padStart(3, "0")}`
      graph.applyRuntimeMessageUpdated(runtimeMessage(id, index))
      graph.applyRuntimePartUpdated(runtimeTextPart(id, index))
    }

    graph.applyRuntimePartUpdated(runtimeTextPart("msg-000", 200))

    const snapshot = graph.snapshot()
    expect(Object.keys(snapshot.runtimeParts).length).toBe(100)
    expect(snapshot.runtimeParts["msg-000"]).toBeUndefined()
  })
})
