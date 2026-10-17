import { expect, test } from "bun:test"
import { createHostAttachmentStore, type AttachmentBinding } from "../../../../cell/packages/ai-runtime-host-logic/src/attachments"
import { createAttachmentByteEffects } from "../../../../cell/packages/ai-runtime-host-support/src/attachmentBytes"

const binding: AttachmentBinding = { principalId: "owner", grantsVersion: "1", sessionId: "s", actorId: "a", epoch: "e" }
const bytes = createAttachmentByteEffects()
function fixture(limits = {}) {
  let now = 1000, id = 0
  const store = createHostAttachmentStore({ sessionId: "s", epoch: "e", effects: { ...bytes, now: () => now, newId: () => `attachment-${++id}` }, limits })
  const begin = (uploadId: string, value: Uint8Array, mime: "text/plain" | "image/png" | "image/jpeg" | "image/webp" = "text/plain", who = binding) => store.begin(who, {
    uploadId, filename: mime === "text/plain" ? "notes.txt" : "image.png", mime, totalBytes: value.byteLength, digest: bytes.digest(value),
  })
  const text = new TextEncoder().encode("UTF-8 文件正文")
  const upload = (id: string, value = text) => { const item = begin(id, value); return store.append(binding, item.attachmentId, 0, bytes.encodeBase64(value)) }
  return { store, begin, upload, text, advance(ms: number) { now += ms } }
}

test("begin and chunk retries keep identity, reject mutation/gaps, and only complete validated content becomes ready", () => {
  const f = fixture(), content = f.text, begin = f.begin("upload", content)
  expect(f.begin("upload", content)).toEqual(begin)
  expect(() => f.store.begin(binding, { uploadId: "upload", filename: "changed.txt", mime: "text/plain", totalBytes: content.length, digest: bytes.digest(content) })).toThrow("attachment_identity_conflict")
  const first = bytes.encodeBase64(content.slice(0, 4))
  expect(f.store.append(binding, begin.attachmentId, 0, first).state).toBe("uploading")
  expect(f.store.append(binding, begin.attachmentId, 0, first).uploadedBytes).toBe(4)
  expect(() => f.store.append(binding, begin.attachmentId, 0, bytes.encodeBase64(new Uint8Array([1, 2, 3, 4])))).toThrow("attachment_chunk_conflict")
  expect(() => f.store.append(binding, begin.attachmentId, 5, first)).toThrow("attachment_offset_mismatch")
  expect(() => f.store.prepareReferences(binding, [begin.attachmentId])).toThrow("attachment_not_ready")
  const last = bytes.encodeBase64(content.slice(4))
  const ready = f.store.append(binding, begin.attachmentId, 4, last)
  expect(ready).toMatchObject({ state: "ready", uploadedBytes: content.length, digest: bytes.digest(content) })
  expect(f.store.append(binding, begin.attachmentId, 4, last)).toEqual(ready)
  const lease = f.store.prepareReferences(binding, [begin.attachmentId]); lease.commit()
  expect(lease.read()).toEqual([{ type: "text", filename: "notes.txt", text: "UTF-8 文件正文", sourceDigest: bytes.digest(content) }])
  lease.release(); lease.release()
  expect(f.store.diagnostics().pinnedBytes).toBe(0)
})

test("references cannot cross actor/principal/grant/session/epoch and display filenames never become paths", () => {
  const f = fixture(), ready = f.upload("u")
  for (const who of [{ ...binding, actorId: "b" }, { ...binding, principalId: "other" }, { ...binding, grantsVersion: "2" }, { ...binding, sessionId: "other" }, { ...binding, epoch: "old" }]) {
    expect(() => f.store.prepareReferences(who, [ready.attachmentId])).toThrow()
    expect(() => f.store.release(who, ready.attachmentId)).toThrow()
  }
  for (const filename of ["/private/file", "../notes", "dir\\notes", "", "nul\0name"]) expect(() => f.store.begin(binding, { uploadId: filename || "empty", filename, mime: "text/plain", totalBytes: 1, digest: bytes.digest(new Uint8Array([1])) })).toThrow()
  expect(f.store.diagnostics().activeResources).toBe(1)
})

test("invalid digest, UTF-8, image MIME and base64 fail closed and release staging capacity", () => {
  for (const [value, mime] of [[new Uint8Array([0xff]), "text/plain"], [new Uint8Array([0]), "text/plain"], [new Uint8Array([1, 2, 3]), "image/png"]] as const) {
    const f = fixture(), item = f.begin("bad", value, mime)
    expect(() => f.store.append(binding, item.attachmentId, 0, bytes.encodeBase64(value))).toThrow()
    expect(f.store.diagnostics().stagedBytes).toBe(0)
  }
  const f = fixture(), item = f.begin("bad-digest", new Uint8Array([65]))
  expect(() => f.store.append(binding, item.attachmentId, 0, bytes.encodeBase64(new Uint8Array([66])))).toThrow("attachment_digest_mismatch")
  expect(() => f.begin("bad-digest", new Uint8Array([65]))).toThrow("attachment_failed")
  const good = f.begin("valid", f.text)
  for (const data of ["%%%", "", "YQ", "YQ==\n"]) expect(() => f.store.append(binding, good.attachmentId, 0, data)).toThrow("attachment_invalid_base64")
  expect(f.store.diagnostics().stagedBytes).toBe(f.text.length)
})

test("release and TTL preserve already accepted pins, forbid new pins, and reclaim after final unpin", () => {
  const f = fixture({ ttlMs: 100, retentionMs: 1000 }), ready = f.upload("u")
  const first = f.store.prepareReferences(binding, [ready.attachmentId]), second = f.store.prepareReferences(binding, [ready.attachmentId]); first.commit(); second.commit()
  expect(f.store.release(binding, ready.attachmentId).state).toBe("released")
  expect(f.store.release(binding, ready.attachmentId).state).toBe("released")
  expect(() => f.store.prepareReferences(binding, [ready.attachmentId])).toThrow("attachment_released")
  f.advance(101)
  expect(first.read()[0].type).toBe("text"); first.release()
  expect(f.store.diagnostics().stagedBytes).toBe(f.text.length)
  expect(second.read()[0].type).toBe("text"); second.release()
  expect(f.store.diagnostics()).toMatchObject({ stagedBytes: 0, pinnedBytes: 0, identities: 1 })
  expect(() => f.upload("u")).toThrow("attachment_released")
  f.advance(1000); expect(f.store.diagnostics().identities).toBe(0)
  const another = f.upload("v"), lease = f.store.prepareReferences(binding, [another.attachmentId]); lease.commit()
  f.advance(101); expect(lease.read()[0].type).toBe("text")
  expect(() => f.store.prepareReferences(binding, [another.attachmentId])).toThrow("attachment_expired")
  lease.release(); expect(f.store.diagnostics().stagedBytes).toBe(0)
})

test("declared staging, actor count, tombstones, per-command and total pin budgets are bounded before effects", () => {
  const f = fixture({ stagedBytes: 20, resourcesPerActor: 1, identities: 2, pinnedBytes: 12, inputBytes: 10, textBytes: 20 })
  const content = new TextEncoder().encode("12345678"), one = f.upload("one", content)
  expect(() => f.begin("two", content)).toThrow("attachment_capacity")
  expect(() => f.store.prepareReferences(binding, [one.attachmentId, one.attachmentId])).toThrow("attachment_input_capacity")
  const lease = f.store.prepareReferences(binding, [one.attachmentId]); lease.commit()
  const other = f.store.prepareReferences(binding, [one.attachmentId])
  expect(() => other.commit()).toThrow("attachment_pin_capacity")
  lease.release(); other.release(); f.store.release(binding, one.attachmentId)
  const two = f.upload("two", content); f.store.release(binding, two.attachmentId)
  expect(() => f.begin("three", content)).toThrow("attachment_identity_capacity")
  expect(f.store.diagnostics()).toMatchObject({ stagedBytes: 0, pinnedBytes: 0, identities: 2 })
  f.store.close(); f.store.close(); expect(() => f.begin("four", content)).toThrow("attachment_store_closed")
})

test("accepted PNG reference materializes as actual InputContent image, and close releases all owner resources", () => {
  const f = fixture(), png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), begin = f.begin("png", png, "image/png")
  f.store.append(binding, begin.attachmentId, 0, bytes.encodeBase64(png))
  const lease = f.store.prepareReferences(binding, [begin.attachmentId]); lease.commit()
  expect(lease.read()).toEqual([{ type: "image", mime: "image/png", dataUrl: `data:image/png;base64,${bytes.encodeBase64(png)}`, filename: "image.png", sourceDigest: bytes.digest(png), size: png.length }])
  f.store.close(); expect(() => lease.read()).toThrow("attachment_store_closed"); lease.release()
  expect(f.store.diagnostics()).toMatchObject({ stagedBytes: 0, pinnedBytes: 0, identities: 0 })
})

test("uncommitted leases and failed appends are atomic; partial uploads expire without reopening their identity", () => {
  const f = fixture({ ttlMs: 100, retentionMs: 1000, stagedBytes: 12, textBytes: 12, chunkBytes: 4, chunks: 2 })
  const eight = new TextEncoder().encode("12345678"), item = f.begin("partial", eight)
  expect(() => f.begin("budget", eight, "text/plain", { ...binding, actorId: "b" })).toThrow("attachment_capacity")
  expect(() => f.begin("large", new Uint8Array(13))).toThrow("attachment_too_large")
  expect(() => f.store.append(binding, item.attachmentId, 0, bytes.encodeBase64(eight))).toThrow("attachment_chunk_too_large")
  expect(f.begin("partial", eight).uploadedBytes).toBe(0)
  f.store.append(binding, item.attachmentId, 0, bytes.encodeBase64(eight.slice(0, 4)))
  expect(() => f.store.append(binding, item.attachmentId, 4, bytes.encodeBase64(new Uint8Array(5)))).toThrow("attachment_chunk_too_large")
  expect(f.begin("partial", eight).uploadedBytes).toBe(4)
  f.advance(101)
  expect(() => f.begin("partial", eight)).toThrow("attachment_expired")
  expect(f.store.diagnostics()).toMatchObject({ stagedBytes: 0, identities: 1 })
  const one = new Uint8Array([65]), ready = f.begin("ready", one)
  f.store.append(binding, ready.attachmentId, 0, bytes.encodeBase64(one))
  const pending = f.store.prepareReferences(binding, [ready.attachmentId])
  f.store.release(binding, ready.attachmentId)
  expect(() => pending.commit()).toThrow("attachment_released")
  pending.release(); expect(f.store.diagnostics().pinnedBytes).toBe(0)
  const cancelled = f.store.prepareReferences(binding, [], 4); cancelled.release()
  expect(() => cancelled.commit()).toThrow("attachment_lease_released")
})
