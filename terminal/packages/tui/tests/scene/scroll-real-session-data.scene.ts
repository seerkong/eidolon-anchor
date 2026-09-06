import { expect, test } from "bun:test"
import { join } from "node:path"
import { createLocalFileConversationProjectionReadPort } from "@cell/ai-support/conversation/LocalFileConversationProjectionReadPort"
import { fingerprintScene } from "../../../../../scripts/scroll-scene-copy"

const directory = process.env.EIDOLON_SCROLL_SCENE_DIRECTORY
const sessionID = process.env.EIDOLON_SCROLL_SCENE_SESSION_ID
if (!directory || !sessionID) throw new Error("Run the explicit isolated scene verifier; missing scene directory/session ID")
const sessionDir = join(directory, ".eidolon/sessions", sessionID)

test("real scene bounded page traversal matches the canonical reference and never changes files", async () => {
  const before = await fingerprintScene(sessionDir)
  const port = createLocalFileConversationProjectionReadPort()
  const session = await port.loadSessionProjection({ sessionDir })
  const target = { sessionDir, actorKey: session.activeActorKey! }
  // Full materialization is a test oracle only, outside the measured production
  // page path. Store IDs/hashes, not user text, in diagnostics or committed files.
  const reference = await port.loadHistoryProjection(target)
  const digest = (message: unknown) => Bun.hash(JSON.stringify(message)).toString(16)
  const expected = reference.messages.map(message => [message.messageId, digest(message)])
  expect(expected.length).toBeGreaterThan(40)
  let ticks = 0
  let previousTick = performance.now()
  let maxPauseMs = 0
  const beacon = setInterval(() => {
    const now = performance.now()
    maxPauseMs = Math.max(maxPauseMs, now - previousTick)
    previousTick = now
    ticks++
  }, 5)
  const preparationStart = performance.now()
  const preparation = await port.loadHistoryPageIndexProjection(target)
  const preparationMs = performance.now() - preparationStart
  const durations: number[] = []
  let maxBytes = 0
  const read = async (query: { before?: string | null; after?: string | null } = {}) => {
    const start = performance.now()
    const page = await port.loadHistoryPageProjection(target, { limit: 40, ...query })
    durations.push(performance.now() - start)
    expect(page.status).toBe("ok")
    expect(page.messages.length).toBeLessThanOrEqual(40)
    expect(page.observedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    maxBytes = Math.max(maxBytes, page.observedBytes)
    return page
  }
  try {
    let page = await read()
    const backward = page.messages.map(message => [message.messageId, digest(message)])
    const boundaries = new Set<string>()
    while (page.pageInfo.hasPreviousPage) {
      const cursor = page.pageInfo.startCursor!
      expect(boundaries.has(cursor)).toBe(false)
      boundaries.add(cursor)
      page = await read({ before: cursor })
      backward.unshift(...page.messages.map(message => [message.messageId, digest(message)]))
      expect(backward.length).toBeLessThanOrEqual(expected.length)
    }
    console.info(JSON.stringify({ scope: "real-session-copy-comparison", expected: expected.length,
      actual: backward.length, expectedUnique: new Set(expected.map(row => row[0])).size,
      actualUnique: new Set(backward.map(row => row[0])).size,
      missing: expected.filter(row => !backward.some(other => other[0] === row[0])).length,
      firstMismatch: backward.findIndex((row, index) => JSON.stringify(row) !== JSON.stringify(expected[index])),
      expectedFirst: expected.slice(0, 4), actualFirst: backward.slice(0, 4),
      sameMultiset: digest(backward.map(row => JSON.stringify(row)).sort()) === digest(expected.map(row => JSON.stringify(row)).sort()) }))
    expect(digest(backward)).toBe(digest(expected))
    const forward = page.messages.map(message => [message.messageId, digest(message)])
    boundaries.clear()
    while (page.pageInfo.hasNextPage) {
      const cursor = page.pageInfo.endCursor!
      expect(boundaries.has(cursor)).toBe(false)
      boundaries.add(cursor)
      page = await read({ after: cursor })
      forward.push(...page.messages.map(message => [message.messageId, digest(message)]))
      expect(forward.length).toBeLessThanOrEqual(expected.length)
    }
    expect(digest(forward)).toBe(digest(expected))
    expect(ticks).toBeGreaterThan(0)
    expect((await fingerprintScene(sessionDir)).digest).toBe(before.digest)
    console.info(JSON.stringify({ scope: "real-session-copy-data", messages: expected.length,
      reads: durations.length, maxObservedBytes: maxBytes, firstPageMs: durations[0],
      p95PageMs: durations.toSorted((a, b) => a - b)[Math.floor(durations.length * .95)],
      preparationObservedBytes: preparation.observedBytes, preparationMs,
      maxBeaconIntervalMs: maxPauseMs, beaconTicks: ticks, unchanged: true }))
  } finally { clearInterval(beacon) }
}, 120_000)
