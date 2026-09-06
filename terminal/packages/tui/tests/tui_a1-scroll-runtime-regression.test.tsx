/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Event, Message, MessageWithParts, Part, TuiRuntimeSdk } from "@terminal/core/AIAgent"
import { TuiA1View } from "../src/app/tui_a1"
import { TuiA1StateProvider, useTuiA1State } from "../src/app/tui_a1/state/state-context"
import type { TuiA1StateGraph } from "../src/app/tui_a1/graph"

type PageInput = { page?: boolean; cursor?: string | null; after?: string | null; limit?: number }
const sessionID = "scroll-host-regression"
const PAGE_DOWN = "\x1b[6~"

function entry(index: number, text = `ROW-${index}\nBODY-${index}\nEND-${index}`, role: "assistant" | "user" = "assistant"): MessageWithParts {
  const id = `message-${index}`
  const info = {
    id, sessionID, role, time: { created: 1_000 + index, completed: 1_001 + index },
    agent: "build", providerID: "deepseek", modelID: "deepseek-v4-pro", mode: "build",
    path: { cwd: process.cwd(), root: process.cwd() }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
  } as Message
  return { info, parts: [{ id: `${id}-text`, sessionID, messageID: id, type: "text", text } as Part] }
}

// This is the SDK effect boundary, not a replacement for any production module.
// The source retains plain data only and does not implement window/follow/layout policy.
function source(count: number, tailLines = 2) {
  const entries = Array.from({ length: count }, (_, index) => entry(index))
  if (tailLines > 2) entries[count - 1] = entry(count - 1,
    `ROW-${count - 1}\n${Array.from({ length: tailLines }, (_, line) => `LONG-${line}`).join("\n")}\nEND-${count - 1}`)
  const calls: PageInput[] = []
  const listeners = new Set<(event: Event) => void>()
  const boundaries = new Map<string, number>()
  let snapshot = "snapshot-1"
  let staleNext = false
  let prompts = 0
  const emit = (event: Event) => { for (const listener of listeners) listener(event) }
  const cursor = (offset: number) => {
    const value = `${snapshot}:opaque-boundary:${offset}`
    boundaries.set(value, offset)
    return value
  }
  const runtime = {
    url: "controlled-scroll-source",
    client: {
      app: { agents: async () => ({ data: [{ name: "build" }] }) },
      config: { get: async () => ({ data: { model: "deepseek/deepseek-v4-pro" } }) },
      session: {
        list: async () => ({ data: [{ id: sessionID, title: "Scroll regression" }] }),
        get: async () => ({ data: { id: sessionID, title: "Scroll regression" } }),
        status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
        userInputs: async () => ({ data: [] }),
        messages: async (input: PageInput = {}) => {
          calls.push({ ...input })
          if (staleNext && (input.cursor || input.after)) {
            staleNext = false
            return { data: [], page: { status: "stale_cursor", snapshotId: snapshot, startCursor: null,
              endCursor: null, hasPreviousPage: false, hasNextPage: false, observedBytes: 0, sourceBytes: 65_536 } }
          }
          const boundary = input.after ?? input.cursor
          if (boundary && !boundaries.has(boundary)) throw new Error(`Unknown test source cursor: ${boundary}`)
          const limit = input.limit ?? 40
          const boundaryOffset = input.cursor ? boundaries.get(input.cursor)! : entries.length
          const start = input.after ? boundaries.get(input.after)! : Math.max(0, boundaryOffset - limit)
          const end = input.after ? Math.min(entries.length, start + limit) : boundaryOffset
          return { data: entries.slice(start, end), page: { status: "ok", snapshotId: snapshot,
            startCursor: start > 0 ? cursor(start) : null, endCursor: end > 0 ? cursor(end) : null,
            hasPreviousPage: start > 0, hasNextPage: end < entries.length, observedBytes: 4_096, sourceBytes: 65_536 } }
        },
        prompt: async (input: { parts: Array<{ text?: string }> }) => {
          prompts += 1
          const user = entry(entries.length, input.parts.map((part) => part.text ?? "").join(""), "user")
          const assistant = entry(entries.length + 1, "LIVE-ASSISTANT\nLIVE-END")
          entries.push(user, assistant)
          for (const message of [user, assistant]) {
            emit({ type: "message.updated", properties: { info: message.info } } as Event)
            for (const part of message.parts) emit({ type: "message.part.updated", properties: { part } } as Event)
          }
          emit({ type: "session.status", properties: { sessionID, status: { type: "idle" } } } as Event)
          return { data: undefined }
        },
      },
      tui: { openSessions: async () => ({ data: undefined }) },
    },
    event: { on: (listener: (event: Event) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      emit, listen: () => () => {}, subscribe: async function* () {} },
  } as unknown as TuiRuntimeSdk
  return { runtime, calls, entries, prompts: () => prompts, staleNext: () => { staleNext = true },
    replaceTail: () => { snapshot = "snapshot-2"; entries.push(entry(entries.length, "REFRESHED-TAIL")) } }
}

async function mount(data: ReturnType<typeof source>) {
  let scrollbox!: ScrollBoxRenderable
  const setup = await testRender(() => <TuiA1View directory={process.cwd()} runtime={data.runtime}
    sessionID={sessionID} onScrollboxReady={(value) => { scrollbox = value }} />,
  { width: 120, height: 40, kittyKeyboard: true })
  const settle = async (cycles = 6) => { for (let i = 0; i < cycles; i++) { await Bun.sleep(0); await setup.renderOnce() } }
  await settle()
  expect(scrollbox).toBeTruthy()
  expect(data.calls.some((call) => call.page)).toBe(true)
  return { ...setup, scrollbox, settle, history: () => setup.captureCharFrame().split("COMPOSER")[0]! }
}

async function browseToFirst(ui: Awaited<ReturnType<typeof mount>>, data: ReturnType<typeof source>) {
  for (let i = 0; i < 8; i++) {
    await ui.mockInput.pressKey("HOME")
    await ui.settle()
  }
  expect(data.calls.filter((call) => call.cursor).length).toBeGreaterThanOrEqual(5)
  expect(ui.history()).toContain("ROW-0")
}

async function clickText(ui: Awaited<ReturnType<typeof mount>>, text: string) {
  const lines = ui.captureCharFrame().split("\n")
  const y = lines.findIndex(line => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  await ui.mockMouse.click(lines[y]!.indexOf(text) + 2, y)
  await ui.settle()
}

describe("P4 true TuiA1View scroll regressions", () => {
  it("retains every think/content card in a forty-source-message page with missing display time", async () => {
    const data = source(40)
    for (let index = 0; index < 40; index++) {
      const message = data.entries[index]!
      message.info.time = { created: 0, completed: 1 }
      message.info.historyOrder = [0, index]
      message.parts = [
        { id: `reasoning-${index}`, messageID: message.info.id, sessionID, type: "reasoning", text: `THINK-${index}` } as Part,
        { id: `answer-${index}`, messageID: message.info.id, sessionID, type: "text", text: `ANSWER-${index}` } as Part,
      ]
    }
    const ui = await mount(data)
    try {
      expect(ui.history()).toContain("ANSWER-39")
      await ui.mockInput.pressKey("HOME"); await ui.settle()
      const seen = new Set<string>()
      for (let step = 0; step < 24; step++) {
        for (const match of ui.history().matchAll(/(?:THINK|ANSWER)-\d+/g)) seen.add(match[0])
        await ui.mockInput.pressKey(PAGE_DOWN); await ui.settle(2)
      }
      expect(seen.size).toBe(80)
      expect([...seen].slice(0, 4)).toEqual(["THINK-0", "ANSWER-0", "THINK-1", "ANSWER-1"])
    } finally { ui.renderer.destroy() }
  })

  it("tool expansion survives virtual unmount and can collapse with full-row geometry", async () => {
    const data = source(40)
    const last = data.entries[39]!
    const output = Array.from({ length: 80 }, (_, index) => `OUTPUT-${index}`).join("\n")
    last.parts = [{ id: "tool-last", sessionID, messageID: last.info.id, type: "tool", tool: "bash", callID: "tool-call",
      state: { status: "completed", input: { command: "echo fixture" }, output, metadata: { output }, time: { start: 1, end: 2 } } } as Part]
    const ui = await mount(data)
    try {
      const collapsedHeight = ui.scrollbox.scrollHeight
      await clickText(ui, "Click to expand")
      await ui.settle()
      expect(ui.history()).toContain("OUTPUT-79")
      expect(ui.scrollbox.scrollHeight).toBeGreaterThan(collapsedHeight + 50)
      await ui.mockInput.pressKey("HOME"); await ui.settle()
      expect(ui.history()).toContain("ROW-0")
      await ui.mockInput.pressKey("END"); await ui.settle()
      expect(ui.history()).toContain("OUTPUT-79")
      await clickText(ui, "Click to collapse")
      expect(ui.scrollbox.scrollHeight).toBeLessThan(collapsedHeight + 5)
      expect(ui.history()).toContain("Click to expand")
    } finally { ui.renderer.destroy() }
  })

  it("nonempty text selection suppresses follow during a live update until explicit End", async () => {
    const data = source(40)
    const ui = await mount(data)
    try {
      let selected = true
      Object.defineProperty(ui.renderer, "getSelection", { configurable: true,
        value: () => selected ? { getSelectedText: () => "selected history" } : undefined })
      const before = ui.scrollbox.scrollTop
      const updated = entry(40, Array.from({ length: 120 }, (_, i) => `SELECT-LIVE-${i}`).join("\n"))
      data.runtime.event.emit({ type: "message.updated", properties: { info: updated.info } } as Event)
      data.runtime.event.emit({ type: "message.part.updated", properties: { part: updated.parts[0] } } as Event)
      await ui.settle()
      expect(ui.scrollbox.scrollTop).toBe(before)
      selected = false
      await ui.mockInput.pressKey("END"); await ui.settle()
      expect(ui.history()).toContain("SELECT-LIVE-119")
    } finally { ui.renderer.destroy() }
  })

  it("a late old-session page cannot enter the newly selected source", async () => {
    const data = source(80)
    const original = data.runtime.client.session.messages
    let release!: () => void
    let pending = false
    data.runtime.client.session.messages = (async (input: PageInput & { sessionID?: string }) => {
      if (input.sessionID === "session-new") return { data: [{ ...entry(999, "NEW-SOURCE-ONLY"), info: { ...entry(999).info, sessionID: "session-new" } }],
        page: { status: "ok", snapshotId: "new-snapshot", startCursor: null, endCursor: null, hasPreviousPage: false, hasNextPage: false } }
      if (input.cursor) { pending = true; await new Promise<void>(resolve => { release = resolve }) }
      return original(input as never)
    }) as typeof original
    let graph!: TuiA1StateGraph
    const App = () => { graph = useTuiA1State().stateGraph; return <TuiA1View directory={process.cwd()} runtime={data.runtime} sessionID={sessionID} /> }
    const setup = await testRender(() => <TuiA1StateProvider runtimeEnabled sessionID={sessionID}><App /></TuiA1StateProvider>,
      { width: 120, height: 40, kittyKeyboard: true })
    const settle = async () => { for (let i = 0; i < 8; i++) await setup.renderOnce() }
    try {
      await settle()
      await setup.mockInput.pressKey("HOME"); await settle()
      expect(pending).toBe(true)
      graph.setRoute({ type: "session", sessionID: "session-new" })
      await settle()
      expect(setup.captureCharFrame()).toContain("NEW-SOURCE-ONLY")
      release(); await settle()
      expect(setup.captureCharFrame()).toContain("NEW-SOURCE-ONLY")
      expect(setup.captureCharFrame()).not.toContain("ROW-0")
    } finally { release?.(); setup.renderer.destroy() }
  })

  for (const lines of [120, 800]) {
    it(`P4_RED_NATIVE_${lines}: native coordinates remount long-tail history without a key handler`, async () => {
      const ui = await mount(source(40, lines))
      try {
        ui.scrollbox.scrollTo(0)
        await ui.settle(2)
        expect(ui.scrollbox.scrollTop).toBe(0)
        expect(ui.history(), `P4_RED_NATIVE_${lines}: native top must display history, not only spacers`).toContain("ROW-0")
        const slider = ui.scrollbox.verticalScrollBar.slider
        await ui.mockMouse.drag(slider.x, slider.y, slider.x, slider.y + slider.height - 1)
        await ui.settle(2)
        expect(ui.history()).toMatch(/ROW-|LONG-|END-/)
        await ui.mockInput.pressKey("END")
        await ui.settle()
        expect(ui.history()).toContain("END-39")
        expect(ui.history().split("END-39")[1]).toContain("╰")
      } finally { ui.renderer.destroy() }
    })
  }

  it("P4_RED_BROWSE_SUBMIT: submission restores evicted live tail", async () => {
    const data = source(240)
    const ui = await mount(data)
    try {
      await browseToFirst(ui, data)
      await ui.mockMouse.click(8, 35)
      await ui.mockInput.typeText("LIVE-USER")
      await ui.mockInput.pressKey("RETURN")
      await ui.settle(10)
      expect(data.prompts()).toBe(1)
      expect(ui.history(), "P4_RED_BROWSE_SUBMIT: new assistant must be visible after submit from evicted pages").toContain("LIVE-ASSISTANT")
      expect(ui.history()).toContain("LIVE-USER")
      expect(ui.history()).toContain("LIVE-END")
    } finally { ui.renderer.destroy() }
  })

  it("P4_RED_STALE_END: End refreshes stale cursor even with cached tail", async () => {
    const data = source(80)
    const ui = await mount(data)
    try {
      data.staleNext()
      await ui.mockInput.pressKey("HOME")
      await ui.settle()
      expect(data.calls.some((call) => call.cursor)).toBe(true)
      const latestCalls = data.calls.filter((call) => !call.cursor && !call.after).length
      data.replaceTail()
      await ui.mockInput.pressKey("END")
      await ui.settle()
      expect(data.calls.filter((call) => !call.cursor && !call.after).length,
        "P4_RED_STALE_END: End must reload latest after stale while cached tail exists").toBeGreaterThan(latestCalls)
      expect(ui.history()).toContain("REFRESHED-TAIL")
    } finally { ui.renderer.destroy() }
  })

  it("P4_RED_FORWARD_REVISIT: downward browsing rereads evicted adjacent newer pages", async () => {
    const data = source(240)
    const ui = await mount(data)
    try {
      await browseToFirst(ui, data)
      const visited: string[] = []
      for (let i = 0; i < 14; i++) {
        ui.scrollbox.scrollTo(1e9)
        await ui.mockInput.pressKey(PAGE_DOWN)
        await ui.settle()
        visited.push(ui.history())
      }
      expect(data.calls.some((call) => call.after), "P4_RED_FORWARD_REVISIT: page-down must request the adjacent newer opaque boundary").toBe(true)
      expect(visited.some(frame => frame.includes("END-199"))).toBe(true)
      expect(ui.history()).toContain("END-239")
    } finally { ui.renderer.destroy() }
  })
})
