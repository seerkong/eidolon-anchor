import { describe, expect, it } from "bun:test"
import { createHistoryRowAdapter, mergeHistoryMessages } from "../src/app/tui_a1/perf/history-source-adapter"
import { runtimeMessagesToTuiA1Messages, type TuiA1Message } from "../src/app/tui_a1/data"
import { createMessagePresentationStore } from "../src/app/tui_a1/features/message/model/presentation"
import { TuiA1StateGraph } from "../src/app/tui_a1/graph"
import type { Message } from "@terminal/core/AIAgent"
import { compareScrollOrder } from "depa-scroll-logic"

const message = (id: string, historyOrder?: readonly number[]): Extract<TuiA1Message, { kind: "assistant" }> => ({ id, kind: "assistant", text: id, createdAt: 0, historyOrder })
const runtimeMessage = (id: string, historyOrder: readonly [number, number]): Message => ({
  id, sessionID: "s", role: "assistant", agent: "code", time: { created: 0 }, historyOrder,
  modelID: "deepseek-v4-pro", providerID: "deepseek", mode: "build", path: { cwd: "/fixture", root: "/fixture" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const adapter = (limit?: number) => createHistoryRowAdapter({ width: () => 80, presentationRevision: () => 0, limit })

describe("history source order adapter", () => {
  it("ORDER_RED_LEGACY_TAIL: confirming a legacy tail does not move earlier observed live beyond it", () => {
    const source = adapter()
    const initial = Array.from({ length: 60 }, (_, index) => message(`row-${index}`))
    source.rows(initial)
    source.rows(initial.slice(20), "latest")
    expect(source.rows(initial).map(row => row.id)).toEqual(initial.map(row => row.id))
  })
  it("ORDER_RED_BATCH_BUDGET: current canonical page remains authoritative beyond metadata capacity", () => {
    const source = adapter(2)
    const rows = source.rows([message("z", [9, 2, 0]), message("m", [9, 1, 0]), message("a", [9, 0, 0])], "latest")
    expect(rows.map(row => row.id)).toEqual(["a", "m", "z"])
    expect(source.size()).toBe(2)
  })
  it("ORDER_RED_DURABLE_CONFIRMATION: a legacy source page supersedes provisional live positions", () => {
    const source = adapter()
    source.rows([message("old-first"), message("old-last")])
    const page = source.rows([message("old-first"), message("old-last"), message("new-tail")], "latest")
    expect(page.map(row => row.id)).toEqual(["old-first", "old-last", "new-tail"])
  })
  it("ORDER_RED_REBASE: unpersisted live follows a newly observed canonical generation", () => {
    const source = adapter()
    source.rows([message("old", [0, 90, 0])], "latest")
    const initial = source.rows([message("live")])[0]!
    const durable = source.rows([message("new-generation", [1, 0, 0])], "latest")[0]!
    const rebased = source.rows([message("live")])[0]!
    expect(compareScrollOrder(rebased.order, durable.order)).toBeGreaterThan(0)
    expect(rebased.contentRevision).not.toBe(initial.contentRevision)
  })
  it("ORDER_RED_WITNESS: canonical confirmation retains observed live siblings on the correct sides", () => {
    const source = adapter()
    source.rows([message("first"), message("middle"), message("last")])
    source.rows([message("middle", [3, 0, 0])], "latest")
    const confirmed = source.rows([message("last"), message("first"), message("middle", [3, 0, 0])])
    expect(confirmed.map(row => row.id)).toEqual(["first", "middle", "last"])
    expect(new Set(confirmed.map(row => JSON.stringify(row.order))).size).toBe(3)
  })
  it("ORDER_RED_EVICTION: reobserved mixed rows keep supplied source order after metadata eviction", () => {
    const source = adapter(4)
    source.rows([message("old-live"), message("new-live")])
    for (let index = 0; index < 8; index++) source.rows([message(`canonical-${index}`, [index, 0, 0])], "latest")
    const rows = source.rows([message("boundary", [8, 0, 0]), message("old-live"), message("new-live")])
    expect(rows.map(row => row.id)).toEqual(["boundary", "old-live", "new-live"])
    expect(source.size()).toBeLessThanOrEqual(4)
  })
  it("ORDER_RED_WITNESS_EVICTION: bounded live metadata retains its confirmed upper boundary", () => {
    const source = adapter(4)
    source.rows([message("first"), message("middle"), message("last")])
    const middle = source.rows([message("middle", [3, 0, 0])], "latest")[0]!
    for (let index = 0; index < 8; index++) {
      source.rows([message("first")])
      source.rows([message(`next-${index}`, [4, index, 0])], "latest")
    }
    const first = source.rows([message("first")])[0]!
    expect(compareScrollOrder(first.order, middle.order)).toBeLessThan(0)
    expect(source.size()).toBeLessThanOrEqual(4)
  })
  it("orders canonical tuples, not timestamps or IDs, without numeric packing", () => {
    const rows = adapter().rows([message("a", [2, 0, 0]), message("z", [1, 9007199254740990, 0]), message("m", [1, 4, 2]), message("n", [1, 4, 1])], "latest")
    expect(rows.map(row => row.id)).toEqual(["n", "m", "z", "a"])
  })
  it("legacy pages retain source array order in both directions and report compatibility", () => {
    const diagnostics: string[] = []
    const source = createHistoryRowAdapter({ width: () => 80, presentationRevision: () => 0, diagnostic: code => diagnostics.push(code) })
    const latest = source.rows([message("z-tail"), message("a-tail")], "latest")
    const earlier = source.rows([message("z-first"), message("a-first")], "earlier")
    expect(earlier.map(row => row.id)).toEqual(["z-first", "a-first"])
    expect((earlier.at(-1)!.order as number[])[1]).toBeLessThan((latest[0]!.order as number[])[1]!)
    expect(source.rows([message("z-tail"), message("a-tail")], "later").map(row => row.order)).toEqual(latest.map(row => row.order))
    expect(diagnostics).toEqual(["history_order_compatibility_page_sequence"])
  })
  it("merges live revisions without dropping persisted source order or duplicating IDs", () => {
    const merged = mergeHistoryMessages([message("same", [3, 4, 0])], [{ ...message("same"), text: "new live text" }, message("new")])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ historyOrder: [3, 4, 0], text: "new live text" })
  })
  it("order and presentation metadata remain bounded and source reset removes it", () => {
    const source = adapter(8)
    const presentation = createMessagePresentationStore(4)
    for (let index = 0; index < 1000; index++) {
      source.rows([message(`id-${index}`)])
      presentation.set(`id-${index}`, true)
    }
    expect(source.size()).toBe(8)
    expect(presentation.size()).toBe(4)
    expect(presentation.get("id-999")).toBe(true)
    source.clear(); presentation.clear()
    expect(source.size()).toBe(0)
    expect(presentation.size()).toBe(0)
  })
  it("multi-card projection preserves the declared history and part sequence", () => {
    const info = runtimeMessage("parent", [2, 10])
    const projected = runtimeMessagesToTuiA1Messages([info], { parent: [
      { type: "reasoning", id: "z-think", messageID: "parent", sessionID: "s", text: "think" },
      { type: "text", id: "a-text", messageID: "parent", sessionID: "s", text: "answer" },
    ] })
    expect(projected.map(row => row.historyOrder)).toEqual([[2, 10, 0], [2, 10, 1]])
    const rows = adapter().rows(projected)
    expect(rows.map(row => row.id)).toEqual(["parent"])
    expect(rows[0]!.payload.messages.map(message => message.id)).toEqual(["z-think", "parent"])
  })
  it("graph keeps proven order through live updates that omit historyOrder", () => {
    const graph = new TuiA1StateGraph({ initialMessages: [], sessionID: "s" })
    try {
      const first = runtimeMessage("z", [0, 0])
      const last = runtimeMessage("a", [0, 1])
      graph.hydrateRuntimeSession({ sessionID: "s", busy: false, messages: [last, first], partsByMessage: {} })
      graph.applyRuntimeMessageUpdated({ ...first, historyOrder: undefined, time: { created: 0, completed: 1 } })
      expect(graph.snapshot().runtimeMessages.z!.historyOrder).toEqual([0, 0])
      graph.applyRuntimeMessageUpdated({ ...first, historyOrder: [2, 4], time: { created: 0, completed: 1 } })
      expect(graph.snapshot().runtimeMessages.z!.historyOrder).toEqual([2, 4])
    } finally { graph.dispose() }
  })
})
