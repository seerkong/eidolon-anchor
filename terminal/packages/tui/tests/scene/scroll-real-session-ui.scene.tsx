/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Event, MessageWithParts, Part } from "@terminal/core/AIAgent"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createTuiRuntimeClient } from "../../src/runtime/client/TuiRuntimeClient"
import { TuiA1View } from "../../src/app/tui_a1"

const directory = process.env.EIDOLON_SCROLL_SCENE_DIRECTORY
const sessionID = process.env.EIDOLON_SCROLL_SCENE_SESSION_ID
if (!directory || !sessionID) throw new Error("Real scene requires EIDOLON_SCROLL_SCENE_DIRECTORY and EIDOLON_SCROLL_SCENE_SESSION_ID; no synthetic fallback")
if (!resolve(directory).includes("/.tmp/scroll-scene-")) throw new Error("Real scene must be an isolated .tmp/scroll-scene-* copy")
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

test("real session copy renders native history traversal, End and controlled live submission", async () => {
  const sdk = createTuiRuntimeClient({ mode: "local-runtime", directory })
  // These are execution effect boundaries. Durable history, projection, SDK
  // catalog, events, cards and the complete production scroll closure are real.
  sdk.client.actor.surface = async () => ({ data: null })
  const files = ["history.xnl", "history.index.json", "session.index.json"].map(name => join(directory!, ".eidolon", "sessions", sessionID!, "conversation", name))
  const before = await Promise.all(files.map(async file => hash(await readFile(file))))
  const read = sdk.client.session.messages.bind(sdk.client.session)
  const calls: Array<{ direction: string; ids: string[]; earlier: boolean; later: boolean; observedBytes?: number; limit?: number }> = []
  sdk.client.session.messages = async input => {
    const result = await read(input)
    calls.push({ direction: input?.after ? "later" : input?.cursor ? "earlier" : "latest", ids: result.data?.map(row => row.info.id) ?? [], earlier: !!result.page?.hasPreviousPage, later: !!result.page?.hasNextPage, observedBytes: result.page?.observedBytes, limit: input?.limit })
    return result
  }
  const tail = await read({ sessionID, page: true, limit: 40 })
  expect(tail.page?.status).toBe("ok")
  expect(tail.data!.length).toBeGreaterThan(0)
  let head = tail
  for (let i = 0; head.page?.hasPreviousPage && i < 2000; i++) {
    const cursor = head.page.startCursor
    head = await read({ sessionID, page: true, limit: 40, cursor })
    expect(head.page?.status).toBe("ok")
    expect(head.page?.startCursor, "opaque before cursor must advance").not.toBe(cursor)
  }
  expect(head.page?.hasPreviousPage).toBe(false)
  // Derive short literal probes from real text, without publishing its body.
  const probes = (row: MessageWithParts) => row.parts.filter(part => part.type === "text" || part.type === "reasoning").flatMap(part => (part as { text: string }).text.split("\n")).map(line => line.replace(/^[#*>`\s-]+/, "").trim()).filter(line => line.length >= 5).map(line => line.slice(0, 18))
  const firstProbes = probes(head.data![0]!)
  const tailRow = tail.data!.at(-1)!
  const tailProbes = probes(tailRow).slice(-1)
  expect(firstProbes.length).toBeGreaterThan(0)
  expect(tailProbes.length).toBeGreaterThan(0)
  let scrollbox!: ScrollBoxRenderable
  const mountStarted = performance.now()
  let beaconTicks = 0, maxBeaconGapMs = 0, lastBeacon = performance.now()
  const beacon = setInterval(() => { const now = performance.now(); maxBeaconGapMs = Math.max(maxBeaconGapMs, now - lastBeacon); lastBeacon = now; beaconTicks++ }, 5)
  const ui = await testRender(() => <TuiA1View directory={directory!} runtime={sdk} sessionID={sessionID!} onScrollboxReady={value => { scrollbox = value }} />, { width: 140, height: 45, kittyKeyboard: true })
  const settle = async (cycles = 8) => { for (let i = 0; i < cycles; i++) { await Bun.sleep(0); await ui.renderOnce() } }
  const history = () => ui.captureCharFrame().split("COMPOSER")[0]!
  const contains = (tokens: string[]) => tokens.some(token => history().includes(token))
  const until = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 15_000
    while (!predicate() && Date.now() < deadline) await settle(2)
    expect(predicate(), label).toBe(true)
  }
  let up = 0, down = 0
  const model = tailRow.info.role === "assistant" ? tailRow.info.modelID : ""
  let modelVisible = false
  const observeModel = () => { if (model && history().includes(model)) modelVisible = true }
  try {
    await until(() => calls.length > 0 && contains(tailProbes), "initial real page must complete and render")
    await settle()
    await Bun.write(join(directory!, "ui-initial-private.txt"), history())
    console.log(JSON.stringify({ stage: "initial", initialMs: performance.now() - mountStarted, beaconTicks, maxBeaconGapMs, calls: calls.length, tailParts: tailRow.parts.map(p => p.type), tailProbeCount: tailProbes.length, top: scrollbox.scrollTop, height: scrollbox.scrollHeight }))
    expect(contains(tailProbes), "real tail body must appear in rendered frame").toBe(true)
    observeModel()
    for (; up < 2000; up++) {
      scrollbox.scrollTo(0)
      await settle()
      observeModel()
      if (calls.some(call => call.direction === "earlier" && !call.earlier) && contains(firstProbes)) break
    }
    expect(contains(firstProbes), "native scroll must render the real first message").toBe(true)
    expect(calls.some(call => call.direction === "earlier" && !call.earlier), "native upward exhausted").toBe(true)
    console.log(JSON.stringify({ stage: "first", up, calls: calls.length, top: scrollbox.scrollTop, height: scrollbox.scrollHeight }))
    let stalled = 0, previousPosition = ""
    for (; down < 20000; down++) {
      scrollbox.scrollBy(Math.max(1, scrollbox.height - 4))
      await settle(3)
      observeModel()
      const position = `${scrollbox.scrollTop}:${scrollbox.scrollHeight}:${calls.length}`
      stalled = position === previousPosition ? stalled + 1 : 0
      previousPosition = position
      if (stalled > 300) break
      if (calls.some(call => call.direction === "later" && !call.later) && contains(tailProbes) && scrollbox.scrollTop >= scrollbox.scrollHeight - scrollbox.height - 1) break
    }
    await Bun.write(join(directory!, "ui-down-private.txt"), history())
    console.log(JSON.stringify({ stage: "down", down, calls: calls.length, lastCalls: calls.slice(-4).map(call => ({ ...call, ids: [call.ids[0], call.ids.at(-1)] })), model, modelVisible, top: scrollbox.scrollTop, height: scrollbox.scrollHeight, budgetError: history().includes("Composite history read exceeds byte budget") }))
    expect(calls.some(call => call.direction === "later"), "native downward must read later pages").toBe(true)
    const downReachedTail = contains(tailProbes) && scrollbox.scrollTop >= scrollbox.scrollHeight - scrollbox.height - 1
    scrollbox.scrollTo(0); await settle()
    await ui.mockInput.pressKey("END"); await settle()
    await until(() => contains(tailProbes), "End must render real tail")
    expect(modelVisible, "real message model label must be rendered during traversal").toBe(true)

    const emit = (index: number, text: string, role: "user" | "assistant" = "assistant") => {
      const id = `scene-controlled-${index}`
      const info = { ...tailRow.info, id, sessionID: sessionID!, role, historyOrder: undefined, time: { created: Date.now() + index, completed: Date.now() + index + 1 } } as MessageWithParts["info"]
      const part = { id: `${id}-text`, sessionID: sessionID!, messageID: id, type: "text", text } as Part
      sdk.event.emit({ type: "message.updated", properties: { info } } as Event)
      sdk.event.emit({ type: "message.part.updated", properties: { part } } as Event)
      return { info, parts: [part] }
    }
    scrollbox.scrollTo(0); await settle()
    const readingTop = scrollbox.scrollTop
    const readingFrame = hash(history())
    emit(1, "SCENE-LIVE-APPEND")
    await settle()
    expect(scrollbox.scrollTop).toBe(readingTop)
    expect(hash(history()), "live append must preserve the real history reading frame").toBe(readingFrame)
    await ui.mockInput.pressKey("END")
    await until(() => history().includes("SCENE-LIVE-APPEND"), "End must reveal legal live projection")
    scrollbox.scrollTo(0); await settle()
    let prompts = 0
    sdk.client.session.prompt = async input => {
      prompts++
      emit(2, input.parts?.filter(part => part.type === "text").map(part => (part as { text: string }).text).join("") ?? "", "user")
      const assistant = emit(3, "SCENE-LIVE-REPLY")
      sdk.event.emit({ type: "session.status", properties: { sessionID: sessionID!, status: { type: "idle" } } } as Event)
      return { data: assistant }
    }
    await ui.mockMouse.click(8, 40)
    await ui.mockInput.typeText("SCENE-SUBMITTED-USER")
    await ui.mockInput.pressKey("RETURN")
    await until(() => prompts === 1 && history().includes("SCENE-LIVE-REPLY"), "submit from browse must reveal new assistant")
    expect(history().includes("SCENE-SUBMITTED-USER")).toBe(true)
    console.log(JSON.stringify({ scene: "real-session-ui", firstId: head.data![0]!.info.id, tailId: tailRow.info.id, tailModel: tailRow.info.role === "assistant" ? tailRow.info.modelID : null, up, down, pageCalls: calls.length, directions: [...new Set(calls.map(call => call.direction))], frameHash: hash(history()), fileHashes: before }))
    expect(downReachedTail, "continuous native downward traversal must recover real tail").toBe(true)
  } finally {
    clearInterval(beacon)
    ui.renderer.destroy()
    await sdk.client.instance.dispose()
    expect(await Promise.all(files.map(async file => hash(await readFile(file))))).toEqual(before)
  }
}, 600_000)
