import { expect, test } from "bun:test"
import { createActor } from "../../cell/packages/ai-core-logic/src/runtime/actor"
import { createVM } from "../../cell/packages/ai-core-logic/src/runtime/runtime"
import { appendLiveHistoryMessageToConversationDomainRuntime, ensureVmConversationDomainRuntime } from "../../cell/packages/ai-organ-logic/src/conversationCapsule/coreLogic"
import { createPublicHistoryReader } from "../../cell/packages/ai-runtime-host-capsule/src/publicHistory"
import { createPublicMessageRead, measurePublicMessage, readPublicMessageBytes } from "../../cell/packages/ai-runtime-host-support/src/publicMessageCodec"
import type { HostRequest, ObservationPayloads } from "../../cell/packages/ai-runtime-host-contract/src"

const request = (principalId = "caller"): HostRequest => ({ principal: { principalId, grantsVersion: "v1" }, requestId: "trace" })
test("public tool outcome survives full and truncated reads without guessing over explicit facts", () => {
  for (const [content, metadata, failed] of [
    ["plain failed result".repeat(2000), { isError: true }, true],
    ["Error: literal successful output".repeat(2000), { isError: false }, false],
    ["Error: legacy failed output", undefined, true],
  ] as const) {
    const read = createPublicMessageRead({ recordId: "record", message: { role: "tool", toolCallId: "call", content, resultMetadata: metadata } })
    const total = measurePublicMessage(read)
    const full = JSON.parse(new TextDecoder().decode(readPublicMessageBytes(read, 0, total)))
    expect(full.parts[0].isError).toBe(failed)
    expect(read.preview(4096, total).preview.parts[0]).toMatchObject({ kind: "tool_result", toolCallId: "call", isError: failed })
  }
})
function fixture(limits?: Parameters<typeof createPublicHistoryReader>[0]["limits"]) {
  const actor = createActor({ key: "main" }); const vm = createVM({ controlActorKey: actor.key, actors: { main: actor }, outerCtx: { metadata: { sessionId: "s" } } })
  const owner = ensureVmConversationDomainRuntime(vm); let time = 0; let grant = "v1"; let allowed = true; let id = 0
  const commits: ObservationPayloads["history.committed"][] = []; const resets: string[] = []
  const reader = createPublicHistoryReader({ vm, sessionId: "s", epoch: "epoch", limits,
    authorization: { permits: () => allowed, currentGrantsVersion: () => grant }, identity: { newId: () => `id-${++id}`, now: () => time },
    onCommitted: value => commits.push(value), onHistoryReset: actorId => resets.push(actorId), onError: error => { throw error },
  })
  const append = (text: string, messageId: string) => appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: actor.key, actorId: actor.id, message: { role: "assistant", content: text, messageId } })
  return { actor, vm, owner, reader, append, commits, resets, advance(ms: number) { time += ms }, revoke() { grant = "v2"; allowed = false } }
}

test("public codec streams escaped Unicode and tool input without internal fields or whole-message serialization", () => {
  const secret = "SHOULD_NOT_LEAK"
  const source = { recordId: "record", sourceRecords: [{ payload: secret }], message: { messageId: "message", role: "assistant", content: 'hi\\\n"😀'.repeat(2000), reasoningContent: "reason", toolCalls: [{ id: "tool", name: "read", input: { path: "x", nested: ["中文", { value: true }] } }], resultMetadata: { secret }, raw: secret, provider: secret } }
  const read = createPublicMessageRead(source); const total = measurePublicMessage(read)
  const chunks = [...read.encode()]; expect(Math.max(...chunks.map(c => c.length))).toBeLessThan(13000)
  const decoded = JSON.parse(new TextDecoder().decode(readPublicMessageBytes(read, 0, total)))
  expect(decoded).toEqual({ messageId: "message", role: "assistant", parts: [{ kind: "text", text: source.message.content }, { kind: "reasoning", text: "reason" }, { kind: "tool_call", toolCallId: "tool", name: "read", input: JSON.stringify(source.message.toolCalls[0].input) }] })
  expect(JSON.stringify(decoded)).not.toContain(secret)
})
test("real owner fence drives commits, empty actor snapshot, fixed history pages and append-stable content refs", () => {
  const f = fixture(); expect(f.reader.snapshot(f.actor.id).messages).toEqual([])
  f.append("first", "one"); f.append("second", "two"); f.append("third", "three")
  expect(f.commits.map(c => c.message.messageId)).toEqual(["one", "two", "three"]); expect(f.resets).toEqual([])
  const page = f.reader.history(request(), f.actor.id, { limit: 2 })
  expect(page.messages.map(m => m.messageId)).toEqual(["two", "three"]); expect(page.nextCursor).toBeTruthy()
  f.append("fourth", "four")
  const older = f.reader.history(request(), f.actor.id, { before: page.nextCursor, limit: 2 })
  expect(older.historyRevision).toBe(page.historyRevision); expect(older.messages.map(m => m.messageId)).toEqual(["one"])
  const content = f.reader.content(request(), f.actor.id, { messageId: "two", historyRevision: page.historyRevision })
  expect(JSON.parse(Buffer.from(content.data, "base64").toString()).parts[0].text).toBe("second")
  expect(() => f.reader.history(request("other"), f.actor.id, { before: page.nextCursor })).toThrow("history_cursor_expired")
  f.reader.close(); expect(f.reader.diagnostics().views).toBe(0)
})
test("large message content is reconstructed from bounded encoded responses, with UTF8 boundaries and base64 overhead", () => {
  const f = fixture(); const text = '😀中文\\"\n'.repeat(50000); f.append(text, "large")
  const page = f.reader.history(request(), f.actor.id); expect(page.messages[0].preview.truncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify({ ...page, requestId: "trace" }))).toBeLessThanOrEqual(1024 * 1024)
  let cursor: string | undefined; let offset = 0; const pieces: Buffer[] = []
  do {
    const chunk = f.reader.content(request(), f.actor.id, { messageId: "large", historyRevision: page.historyRevision, cursor, maxBytes: 32768 })
    expect(Buffer.byteLength(JSON.stringify({ ...chunk, requestId: "trace" }))).toBeLessThanOrEqual(32768)
    expect(chunk.offsetBytes).toBe(offset); const bytes = Buffer.from(chunk.data, "base64"); expect(bytes.length).toBeGreaterThan(0)
    pieces.push(bytes); offset += bytes.length; cursor = chunk.nextCursor
    if (!cursor) expect(offset).toBe(chunk.totalBytes)
  } while (cursor)
  expect(JSON.parse(Buffer.concat(pieces).toString()).parts[0].text).toBe(text)
  f.reader.close()
})
test("content cursor binds message, principal, grants, revision and hard expiry without sliding TTL", () => {
  const f = fixture(); f.append("x".repeat(10000), "large")
  const page = f.reader.history(request(), f.actor.id); const first = f.reader.content(request(), f.actor.id, { messageId: "large", historyRevision: page.historyRevision, maxBytes: 2048 })
  expect(first.nextCursor).toBeTruthy()
  expect(() => f.reader.content(request("other"), f.actor.id, { messageId: "large", historyRevision: page.historyRevision, cursor: first.nextCursor })).toThrow("content_cursor_expired")
  expect(() => f.reader.content(request(), f.actor.id, { messageId: "another", historyRevision: page.historyRevision, cursor: first.nextCursor })).toThrow("content_cursor_expired")
  f.advance(119000); f.reader.content(request(), f.actor.id, { messageId: "large", historyRevision: page.historyRevision, cursor: first.nextCursor })
  f.advance(1001); expect(() => f.reader.content(request(), f.actor.id, { messageId: "large", historyRevision: page.historyRevision, cursor: first.nextCursor })).toThrow("content_cursor_expired")
  f.revoke(); expect(() => f.reader.history(request(), f.actor.id)).toThrow("forbidden"); f.reader.close()
})
test("owner rewind invalidates old revision instead of copying or pinning removed messages", () => {
  const f = fixture(); f.append("secret old", "old"); const page = f.reader.history(request(), f.actor.id)
  const current = f.owner.historyStateSignal.get(); const key = Object.keys(current)[0]
  f.owner.historyStateSignal.set({ [key]: { ...current[key], generations: [], activeGenerationId: null } })
  expect(f.resets).toEqual([f.actor.id])
  expect(() => f.reader.content(request(), f.actor.id, { messageId: "old", historyRevision: page.historyRevision })).toThrow("content_cursor_expired")
  expect(f.reader.snapshot(f.actor.id).messages).toEqual([]); f.reader.close()
})
test("view count eviction, byte capacity, too-small response and unknown actor are explicit", () => {
  const f = fixture({ views: 2 }); f.append("a".repeat(1000), "a")
  const first = f.reader.history(request(), f.actor.id); const chunk = f.reader.content(request(), f.actor.id, { messageId: "a", historyRevision: first.historyRevision, maxBytes: 1024 })
  f.append("b", "b"); f.reader.history(request(), f.actor.id); f.append("c", "c"); f.reader.history(request(), f.actor.id)
  expect(f.reader.diagnostics().views).toBeLessThanOrEqual(2)
  expect(() => f.reader.content(request(), f.actor.id, { messageId: "a", historyRevision: first.historyRevision, cursor: chunk.nextCursor })).toThrow("content_cursor_expired")
  const latest = f.reader.history(request(), f.actor.id)
  expect(() => f.reader.content(request(), f.actor.id, { messageId: "c", historyRevision: latest.historyRevision, maxBytes: 1 })).toThrow("response_too_large")
  expect(() => f.reader.history(request(), "unknown")).toThrow("actor_not_found")
  f.reader.close()
  const tiny = fixture({ viewBytes: 1 }); expect(() => tiny.reader.capture(tiny.actor.id)).toThrow("history_capacity"); tiny.reader.close()
})
