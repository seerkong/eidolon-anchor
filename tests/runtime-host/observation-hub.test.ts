import { expect, test } from "bun:test"
import { captureObservation, closeObservations, createObservationState, preflightObservation, publishObservation, resetObservationHistory, revalidateObservations, seedObservationHistory, type ObservationRuntime } from "../../cell/packages/ai-runtime-host-logic/src/observations"
import { createObservationCursorEffects, createObservationQueueEffects } from "../../cell/packages/ai-runtime-host-support/src"
import type { ActorSummary, HostRequest, ObservationFrame, SessionSnapshot } from "../../cell/packages/ai-runtime-host-contract/src"

const actor = (id: string): ActorSummary => ({ actorId: id, displayName: id, executionKind: "interactive", runtimeState: "idle", allowedActions: ["observe", "read_history", "send_text", "cancel_turn", "answer_question"], capabilities: { textInput: true, cancelTurn: true, questionnaireAnswer: true } })
const request = (id = "caller"): HostRequest => ({ principal: { principalId: id, grantsVersion: "v1" }, requestId: "request" })
const message = (id: string, text = "hello") => ({ messageId: id, role: "assistant" as const, preview: { parts: [{ kind: "text" as const, text }], startOffset: 0, totalBytes: text.length, truncated: false } })
function fixture(limits: ObservationRuntime["limits"] = {}) {
  let time = 0; let grants = "v1"
  const denied = new Set<string>()
  const runtime: ObservationRuntime = { sessionId: "session", epoch: "epoch", state: createObservationState(), limits,
    identity: { now: () => time, newId: () => "id" }, cursors: createObservationCursorEffects(), queues: createObservationQueueEffects(),
    authorization: { currentGrantsVersion: () => grants, permits: (_principal, target) => !(target.kind === "actor" && denied.has(`${target.actorId}/${target.action}`)) },
  }
  for (const id of ["A", "B", "C"]) publishObservation(runtime, { kind: "actor.created", payload: actor(id) })
  return { runtime, denied, advance(ms: number) { time += ms }, revoke() { grants = "v2" } }
}
async function snapshot(it: AsyncIterator<ObservationFrame>): Promise<SessionSnapshot> { const frame = (await it.next()).value; expect(frame.kind).toBe("snapshot"); return frame.payload }

test("capture register barrier queues reentrant commit after its exact snapshot sequence", async () => {
  const { runtime } = fixture(); const queues = runtime.queues; let once = false
  runtime.queues = { ...queues, frameBytes(frame) {
    if (frame.kind === "snapshot" && !once) { once = true; publishObservation(runtime, { kind: "history.committed", payload: { actorId: "A", historyRevision: "r1", message: message("m1") } }) }
    return queues.frameBytes(frame)
  } }
  const sub = captureObservation(runtime, request(), { actors: ["A"] }); const it = sub.frames[Symbol.asyncIterator]()
  const initial = await snapshot(it); expect(initial.seq).toBe(3); expect(initial.histories).toEqual([])
  const live = (await it.next()).value; expect(live.kind).toBe("history.committed"); expect(live.seq).toBe(4)
  expect(runtime.state.projection.histories.get("A")?.messages.map(m => m.messageId)).toEqual(["m1"])
  sub.close()
})
test("publication updates projection before fanout and reentrant fanout preserves all subscriber order", async () => {
  const { runtime } = fixture(); const queues = runtime.queues; let once = false
  runtime.queues = { ...queues, create(close) { const queue = queues.create(close); return { ...queue, push(frame, lane) {
    if (frame.kind === "history.committed" && !once) {
      once = true; expect(runtime.state.projection.histories.get("A")?.messages[0].messageId).toBe("m1")
      publishObservation(runtime, { kind: "history.committed", payload: { actorId: "A", historyRevision: "r2", message: message("m2") } })
    }
    return queue.push(frame, lane)
  } } } }
  const subscriptions = [captureObservation(runtime, request(), { actors: ["A"] }), captureObservation(runtime, request("other"), { actors: ["A"] })]
  const readers = subscriptions.map(s => s.frames[Symbol.asyncIterator]()); for (const it of readers) await snapshot(it)
  publishObservation(runtime, { kind: "history.committed", payload: { actorId: "A", historyRevision: "r1", message: message("m1") } })
  for (const it of readers) expect([(await it.next()).value.seq, (await it.next()).value.seq]).toEqual([4, 5])
  closeObservations(runtime)
})
test("caller controls follow admission principal outside display scope without history or answer schema leaks", async () => {
  const { runtime, denied } = fixture(); denied.add("A/answer_question"); denied.add("C/read_history")
  const turn = { actorId: "A", turnId: "t1", state: "waiting_input" as const, canCancel: true, pendingQuestionIds: ["q1"] }
  publishObservation(runtime, { kind: "command.updated", principalId: "caller", payload: { commandId: "cmd", epoch: "epoch", state: "applied", turnId: "t1", associatedTurn: turn } })
  publishObservation(runtime, { kind: "question.updated", payload: { actorId: "A", turnId: "t1", questionnaireId: "q1", state: "pending", canAnswer: true, schema: { title: "secret", questions: [{ id: "q", prompt: "private" }] } } })
  seedObservationHistory(runtime, { actorId: "C", historyRevision: "r1", messages: [message("old")], historyWindowTruncated: false })
  const mine = captureObservation(runtime, request(), { actors: ["C"] }); const it = mine.frames[Symbol.asyncIterator](); const initial = await snapshot(it)
  expect(initial.callerControls).toEqual({ commandIds: ["cmd"], turnIds: ["t1"], questionnaireIds: ["q1"] }); expect(initial.histories).toEqual([])
  expect(initial.questions[0].schema).toBeUndefined(); expect(initial.questions[0].canAnswer).toBe(false)
  const other = captureObservation(runtime, request("other"), { actors: ["C"] }); const third = await snapshot(other.frames[Symbol.asyncIterator]())
  expect(third.commands).toEqual([]); expect(third.turns).toEqual([]); expect(third.questions).toEqual([])
  publishObservation(runtime, { kind: "turn.updated", payload: { ...turn, state: "succeeded", canCancel: false, pendingQuestionIds: [] } })
  expect((await it.next()).value.payload.state).toBe("succeeded")
  expect(runtime.state.projection.commands.size).toBe(0); expect(runtime.state.projection.questions.size).toBe(0)
  closeObservations(runtime)
})
test("replay uses bounded session order, tolerates filtered gaps, and resets expired or mismatched cursors", async () => {
  const f = fixture({ ringCount: 2, ringTtlMs: 10 }); const { runtime } = f
  const first = captureObservation(runtime, request(), { actors: ["A"] }); const cursor = (await snapshot(first.frames[Symbol.asyncIterator]())).cursor; first.close()
  publishObservation(runtime, { kind: "actor.updated", payload: { ...actor("B"), runtimeState: "running" } })
  publishObservation(runtime, { kind: "actor.updated", payload: { ...actor("A"), runtimeState: "running" } })
  const resume = captureObservation(runtime, request(), { actors: ["A"], after: cursor }); const live = (await resume.frames[Symbol.asyncIterator]().next()).value
  expect(live.kind).toBe("actor.updated"); expect(live.seq).toBe(5); resume.close()
  f.advance(11)
  const expired = captureObservation(runtime, request(), { actors: ["A"], after: cursor }); const e = expired.frames[Symbol.asyncIterator](); expect((await e.next()).value.kind).toBe("reset_required"); expect((await snapshot(e)).seq).toBe(5)
  const other = captureObservation(runtime, request("other"), { actors: ["A"], after: live.cursor }); expect((await other.frames[Symbol.asyncIterator]().next()).value.kind).toBe("reset_required")
  closeObservations(runtime)
})
test("grant changes terminate buffered frames and explicit revocation wakes blocked readers", async () => {
  const f = fixture(); const sub = captureObservation(f.runtime, request(), { actors: ["A"] }); const it = sub.frames[Symbol.asyncIterator]()
  await snapshot(it); const waiting = it.next(); f.revoke(); revalidateObservations(f.runtime)
  expect((await waiting).done).toBe(true); expect(f.runtime.state.observers.size).toBe(0)
  expect(() => captureObservation(f.runtime, request(), { actors: ["missing"] })).toThrow("actor_not_found")
  expect(() => captureObservation(f.runtime, request(), { actors: ["A"] })).toThrow("forbidden")
})
test("snapshot history and pending have independent budgets and retain identity/truncation", async () => {
  const { runtime } = fixture({ historyBytes: 300, pendingBytes: 300 })
  seedObservationHistory(runtime, { actorId: "A", historyRevision: "r", pageCursor: "previous", messages: [message("old", "x".repeat(500)), message("new", "small")], historyWindowTruncated: false })
  publishObservation(runtime, { kind: "stream.updated", payload: { actorId: "A", turnId: "t", attemptId: "attempt", messageId: "stream", revision: 1, preview: message("m", "x".repeat(1000)).preview } })
  const sub = captureObservation(runtime, request(), { actors: ["A"] }); const initial = await snapshot(sub.frames[Symbol.asyncIterator]())
  expect(initial.histories[0].messages.map(m => m.messageId)).toEqual(["new"]); expect(initial.histories[0].historyWindowTruncated).toBe(true); expect(initial.histories[0].pageCursor).toBe("previous")
  expect(initial.pendingStreams[0].messageId).toBe("stream"); expect(initial.pendingStreams[0].preview.truncated).toBe(true)
  sub.close()
})
test("schema and metadata failures do not partially publish, assign seq or mutate projection", () => {
  const { runtime } = fixture(); const seq = runtime.state.seq
  expect(() => publishObservation(runtime, { kind: "actor.updated", payload: { ...actor("A"), displayName: "x".repeat(2100) } })).toThrow()
  expect(runtime.state.seq).toBe(seq); expect(runtime.state.projection.actors.get("A")?.displayName).toBe("A")
  expect(() => publishObservation(runtime, { kind: "question.updated", payload: { actorId: "A", turnId: "t", questionnaireId: "q", state: "pending", canAnswer: true, schema: { title: "x".repeat(66000), questions: [] } } })).toThrow()
  expect(runtime.state.seq).toBe(seq); expect(runtime.state.projection.questions.size).toBe(0)
})
test("snapshot capacity is HTTP failure before stream and slow subscriber closes without sequence loss for peers", async () => {
  const { runtime } = fixture({ snapshotBytes: 10 })
  expect(() => captureObservation(runtime, request(), { actors: ["A"] })).toThrow("snapshot_capacity"); expect(runtime.state.observers.size).toBe(0)
  runtime.limits = {}; runtime.queues = createObservationQueueEffects({ liveBytes: 2048, liveCount: 1, snapshotBytes: 8 * 1024 * 1024, frameBytes: 1024 * 1024 })
  const slow = captureObservation(runtime, request(), { actors: ["A"] }); const fast = captureObservation(runtime, request("fast"), { actors: ["A"] }); const it = fast.frames[Symbol.asyncIterator](); await snapshot(it)
  for (let i = 0; i < 3; i++) { publishObservation(runtime, { kind: "actor.updated", payload: actor("A") }); expect((await it.next()).value.seq).toBe(4 + i) }
  expect((await slow.frames[Symbol.asyncIterator]().next()).done).toBe(true); expect(runtime.state.observers.size).toBe(1); closeObservations(runtime)
})

test("maximum question schema pool fits independent bootstrap while live remains separately bounded", async () => {
  const { runtime } = fixture()
  for (let i = 0; i < 64; i++) {
    publishObservation(runtime, { kind: "question.updated", payload: { actorId: "A", turnId: `t${i}`, questionnaireId: `q${i}`, state: "pending", canAnswer: true,
      schema: { title: "Choose", questions: [{ id: "q", prompt: "x".repeat(65000) }] } } })
  }
  const sub = captureObservation(runtime, request(), { actors: ["A"] }); const it = sub.frames[Symbol.asyncIterator]()
  publishObservation(runtime, { kind: "actor.updated", payload: { ...actor("A"), runtimeState: "running" } })
  const initial = await snapshot(it)
  expect(initial.questions).toHaveLength(64)
  expect(runtime.queues.frameBytes({ kind: "snapshot", requestId: "r", payload: initial })).toBeGreaterThan(4 * 1024 * 1024 - 65536)
  expect(runtime.queues.frameBytes({ kind: "snapshot", requestId: "r", payload: initial })).toBeLessThan(8 * 1024 * 1024)
  expect((await it.next()).value.kind).toBe("actor.updated")
  expect(() => publishObservation(runtime, { kind: "question.updated", payload: { actorId: "A", turnId: "overflow", questionnaireId: "overflow", state: "pending", canAnswer: true } })).toThrow("question_capacity")
  sub.close()
})
test("oversize live event produces a terminal protocol frame without committing an invalid cursor", async () => {
  const { runtime } = fixture({ frameBytes: 400 })
  const sub = captureObservation(runtime, request(), { actors: ["A"] }); const it = sub.frames[Symbol.asyncIterator](); await snapshot(it)
  publishObservation(runtime, { kind: "history.committed", payload: { actorId: "A", historyRevision: "r", message: message("large", "x".repeat(1000)) } })
  const error = (await it.next()).value
  expect(error).toEqual({ kind: "protocol.error", code: "frame_too_large", requestId: "request", retryable: false })
  expect((await it.next()).done).toBe(true)
})
test("capture gate drains queued publications before publications they reentrantly enqueue", async () => {
  const { runtime } = fixture(); const original = runtime.queues; let captured = false; let nested = false
  const publish = (id: string) => publishObservation(runtime, { kind: "history.committed", payload: { actorId: "A", historyRevision: id, message: message(id) } })
  runtime.queues = { ...original, frameBytes(frame) {
    if (frame.kind === "snapshot" && !captured) { captured = true; publish("one"); publish("two") }
    return original.frameBytes(frame)
  }, create(close) { const queue = original.create(close); return { ...queue, push(frame, lane) {
    if (frame.kind === "history.committed" && !nested) { nested = true; publish("three") }
    return queue.push(frame, lane)
  } } } }
  const sub = captureObservation(runtime, request(), { actors: ["A"] }); const it = sub.frames[Symbol.asyncIterator](); await snapshot(it)
  expect([(await it.next()).value.payload.message.messageId, (await it.next()).value.payload.message.messageId, (await it.next()).value.payload.message.messageId]).toEqual(["one", "two", "three"])
  sub.close()
})
test("batch preflight is inert and history pressure evicts display rows before rejecting controls", () => {
  const { runtime } = fixture({ metadataBytes: 1800 })
  for (let i = 0; i < 50; i++) publishObservation(runtime, { kind: "history.committed", payload: { actorId: "A", historyRevision: `r${i}`, message: message(`m${i}`) } })
  expect(runtime.state.projection.histories.get("A")!.messages.length).toBeLessThan(50)
  expect(runtime.state.projection.histories.get("A")!.historyWindowTruncated).toBe(true)
  const seq = runtime.state.seq
  const turn = { actorId: "A", turnId: "t", state: "waiting_input" as const, canCancel: true, pendingQuestionIds: ["q"] }
  preflightObservation(runtime, [{ kind: "turn.updated", payload: turn }, { kind: "question.updated", payload: { actorId: "A", turnId: "t", questionnaireId: "q", state: "pending", canAnswer: true } }])
  expect(runtime.state.seq).toBe(seq); expect(runtime.state.projection.turns.size).toBe(0); expect(runtime.state.projection.questions.size).toBe(0)
})
test("owner history reset invalidates replay and replaces the derived window without duplicate commits", async () => {
  const { runtime } = fixture(); const first = captureObservation(runtime, request(), { actors: ["A"] }); const it = first.frames[Symbol.asyncIterator](); const initial = await snapshot(it)
  resetObservationHistory(runtime, { actorId: "A", historyRevision: "rewound", messages: [], historyWindowTruncated: false })
  expect((await it.next()).done).toBe(true)
  const next = captureObservation(runtime, request(), { actors: ["A"], after: initial.cursor }); const r = next.frames[Symbol.asyncIterator]()
  expect((await r.next()).value.kind).toBe("reset_required"); expect((await snapshot(r)).histories[0].historyRevision).toBe("rewound")
  next.close()
})
test("valid ring cursor with too much bootstrap backlog resets instead of repeatedly overflowing", async () => {
  const { runtime } = fixture(); const first = captureObservation(runtime, request(), { actors: ["A"] }); const initial = await snapshot(first.frames[Symbol.asyncIterator]()); first.close()
  for (let i = 0; i < 1001; i++) publishObservation(runtime, { kind: "actor.updated", payload: actor("A") })
  const next = captureObservation(runtime, request(), { actors: ["A"], after: initial.cursor }); const it = next.frames[Symbol.asyncIterator]()
  expect((await it.next()).value.kind).toBe("reset_required"); expect((await snapshot(it)).seq).toBe(1004); next.close()
})
