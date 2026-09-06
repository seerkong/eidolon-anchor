import { expect, test } from "bun:test"
import type { PageRequest, SourceIdentity } from "depa-scroll-contract"
import { createSyntheticSource } from "../src/source"

const identity: SourceIdentity = { sourceId: "source", actorId: "actor", sourceEpoch: 1, generation: 1 }
const request = (direction: PageRequest["direction"] = "latest", cursor: string | null = null): PageRequest => ({
  direction, cursor, limit: 40,
  token: { ...identity, windowRevision: 0, snapshot: null, requestId: 1, intentRevision: 0 },
})
const signal = () => new AbortController().signal

test("100k logical rows generate only requested bodies and expose reversible opaque pages", async () => {
  const source = createSyntheticSource({ identity, count: 100_000, shape: "log" })
  expect(source.stats().generatedRows).toBe(0)
  const latest = await source.loadPage(request(), signal())
  expect(latest.rows.length).toBe(40)
  expect(latest.rows.at(-1)?.order).toBe(99_999)
  const earlier = await source.loadPage(request("earlier", latest.before), signal())
  expect(earlier.rows.at(-1)?.order).toBe(99_959)
  const later = await source.loadPage(request("later", earlier.after), signal())
  expect(later.rows).toEqual(latest.rows)
  expect(source.stats().generatedRows).toBe(120)
  expect(source.stats().retainedBodies).toBe(0)
  expect(source.stats().observedBytes).toBeGreaterThan(0)
})

test("latest includes live append and revision published before invocation", async () => {
  const source = createSyntheticSource({ identity, count: 10, shape: "chat" })
  const appended = source.append()
  const revised = source.revise(appended.order, { streamLines: 12, completed: true })
  const latest = await source.loadPage(request(), signal())
  expect(latest.rows.at(-1)).toEqual(revised)
  expect(latest.rows.at(-1)?.payload.body).toContain("stream-11")
  expect(latest.rows.at(-1)?.contentRevision).not.toBe(appended.contentRevision)
})

test("controlled completion snapshots source at invocation and supports abort", async () => {
  const source = createSyntheticSource({ identity, count: 10, shape: "log" })
  source.inject({ type: "controlled-delay" })
  const pending = source.loadPage(request(), signal())
  source.append()
  expect(source.stats().pendingRequests).toBe(1)
  expect(source.stats().retainedBodies).toBe(10)
  source.release()
  expect((await pending).rows.at(-1)?.order).toBe(9)
  expect(source.stats().retainedBodies).toBe(0)
  source.inject({ type: "timeout" })
  const controller = new AbortController()
  const cancelled = source.loadPage(request(), controller.signal)
  controller.abort()
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" })
  expect(source.stats().pendingRequests).toBe(0)
})

test("faults are typed, one-shot, and nonprogress and filtered-empty pages are reproducible", async () => {
  const source = createSyntheticSource({ identity, count: 100, shape: "log" })
  const latest = await source.loadPage(request(), signal())
  for (const [type, code] of [["reject", "rejected"], ["stale", "stale_cursor"], ["budget", "budget"]] as const) {
    source.inject({ type })
    await expect(source.loadPage(request(), signal())).rejects.toMatchObject({ code })
    expect((await source.loadPage(request(), signal())).rows.length).toBe(40)
  }
  source.inject({ type: "nonprogress" })
  const stuck = await source.loadPage(request("earlier", latest.before), signal())
  expect(stuck.before).toBe(latest.before)
  expect(stuck.hasEarlier).toBe(true)
  source.inject({ type: "empty" })
  expect((await source.loadPage(request("earlier", latest.before), signal())).rows).toEqual([])
})

test("source identity invalidates cross-generation cursors and page work yields", async () => {
  const source = createSyntheticSource({ identity, count: 100, shape: "chat" })
  let completed = false
  const pending = source.loadPage(request(), signal()).then(page => { completed = true; return page })
  expect(completed).toBe(false)
  const latest = await pending
  const wrong = { ...request("earlier", latest.before), token: { ...request().token, generation: 2 } }
  await expect(source.loadPage(wrong, signal())).rejects.toMatchObject({ code: "stale_cursor" })
  expect(latest.rows.some(row => row.payload.kind === "markdown")).toBe(true)
  expect(latest.rows.some(row => row.payload.kind === "code")).toBe(true)
  expect(latest.rows.some(row => row.payload.kind === "tool")).toBe(true)
})

test("live revision metadata and request diagnostics remain bounded", async () => {
  const source = createSyntheticSource({ identity, count: 1_000, shape: "log", maxOverrides: 4, maxTrace: 3 })
  for (let i = 0; i < 4; i++) source.revise(i, { streamLines: i })
  expect(() => source.revise(4, { streamLines: 1 })).toThrow("revision budget")
  for (let i = 0; i < 10; i++) await source.loadPage(request(), signal())
  expect(source.stats().revisionEntries).toBe(4)
  expect(source.trace().length).toBe(3)
})
