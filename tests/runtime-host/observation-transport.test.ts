import { describe, expect, test } from "bun:test"
import { createObservationCursorEffects, createObservationQueueEffects } from "../../cell/packages/ai-runtime-host-support/src"
import type { ObservationFrame } from "../../cell/packages/ai-runtime-host-contract/src"

const binding = { epoch: "epoch", principalId: "p", grantsVersion: "1", actors: ["b", "a"] }
const event = (seq: number): ObservationFrame => ({ kind: "turn.updated", epoch: "epoch", seq, cursor: `c${seq}`, payload: { actorId: "a", turnId: "t", state: "running", canCancel: true, pendingQuestionIds: [] } })

describe("observation cursor and transport effects", () => {
  test("cursor is authenticated and bound to epoch, caller, grants and canonical display scope", () => {
    const effects = createObservationCursorEffects()
    const cursor = effects.issue(binding, 42)
    expect(effects.read({ ...binding, actors: ["a", "b", "a"] }, cursor)).toBe(42)
    for (const change of [{ epoch: "next" }, { principalId: "other" }, { grantsVersion: "2" }, { actors: ["a"] }]) expect(effects.read({ ...binding, ...change }, cursor)).toBeUndefined()
    expect(effects.read(binding, `${cursor.slice(0, -4)}xxxx`)).toBeUndefined()
    expect(createObservationCursorEffects().read(binding, cursor)).toBeUndefined()
    expect(effects.read(binding, "x".repeat(5000))).toBeUndefined()
  })
  test("large bootstrap has an independent budget and buffered live events retain order", async () => {
    const effects = createObservationQueueEffects()
    let closed = 0
    const queue = effects.create(() => closed++)
    const snapshot: ObservationFrame = { kind: "snapshot", requestId: "request", payload: {
      sessionId: "s", epoch: "epoch", seq: 1, cursor: "c1", actors: [], histories: [], pendingStreams: [], commands: [], turns: [],
      questions: Array.from({ length: 64 }, (_, index) => ({ actorId: `a${index}`, turnId: `t${index}`, questionnaireId: `q${index}`, state: "pending", canAnswer: true, schema: { title: "Q", questions: [{ id: "q", prompt: "x".repeat(45000) }] } })),
      callerControls: { commandIds: [], turnIds: [], questionnaireIds: [] }, checkpoint: { state: "saved" },
    } }
    expect(effects.frameBytes(snapshot)).toBeGreaterThan(2 * 1024 * 1024)
    expect(queue.push(snapshot, "bootstrap")).toBe(true)
    expect(queue.push(event(2), "live")).toBe(true)
    expect(queue.push(event(3), "live")).toBe(true)
    const reader = queue.frames[Symbol.asyncIterator]()
    expect((await reader.next()).value.kind).toBe("snapshot")
    expect((await reader.next()).value.seq).toBe(2)
    expect((await reader.next()).value.seq).toBe(3)
    const pending = reader.next()
    queue.close()
    expect((await pending).done).toBe(true)
    await reader.return?.()
    expect(closed).toBe(1)
  })
  test("slow consumer overflow closes the lease instead of silently dropping a frame", async () => {
    const effects = createObservationQueueEffects({ liveBytes: 10000, liveCount: 1, snapshotBytes: 10000, frameBytes: 10000 })
    let closed = 0
    const queue = effects.create(() => closed++)
    expect(queue.push(event(1), "live")).toBe(true)
    expect(queue.push(event(2), "live")).toBe(false)
    expect(queue.isClosed()).toBe(true)
    expect((await queue.frames[Symbol.asyncIterator]().next()).done).toBe(true)
    expect(closed).toBe(1)
    expect(queue.push(event(3), "live")).toBe(false)
  })
})
