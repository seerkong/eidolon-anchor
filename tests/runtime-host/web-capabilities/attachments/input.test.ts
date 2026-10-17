import { expect, test } from "bun:test"
import { createHostAttachmentStore } from "../../../../cell/packages/ai-runtime-host-logic/src/attachments"
import { prepareHostInput } from "../../../../cell/packages/ai-runtime-host-logic/src/structuredInput"
import { createAttachmentByteEffects } from "../../../../cell/packages/ai-runtime-host-support/src/attachmentBytes"
import { admitHostCommand, createCommandIndex, recordHostTurn, type CommandRuntime } from "../../../../cell/packages/ai-runtime-host-logic/src/commands"
import { parseCommandEnvelope, parseAttachmentOperation, parsePublicMessage, parseHistoryPage, type CommandReceipt, type CommandEnvelope } from "../../../../cell/packages/ai-runtime-host-contract/src"
import { createPublicMessageRead, measurePublicMessage, readPublicMessageBytes } from "../../../../cell/packages/ai-runtime-host-support/src/publicMessageCodec"

const bytes = createAttachmentByteEffects(), binding = { principalId: "p", grantsVersion: "1", sessionId: "s", actorId: "a", epoch: "e" }
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const image = { type: "image" as const, mime: "image/png" as const, dataUrl: `data:image/png;base64,${bytes.encodeBase64(png)}`, filename: "small.png" }
const command: CommandEnvelope = { commandId: "c", surfaceId: "web", expectedEpoch: "e", kind: "send_input", payload: { actorId: "a", parts: [{ type: "text", text: "inspect" }, image] } }
function fixture() {
  let id = 0
  const store = createHostAttachmentStore({ sessionId: "s", epoch: "e", effects: { ...bytes, now: () => 0, newId: () => `resource-${++id}` } })
  const upload = (text: string) => {
    const content = new TextEncoder().encode(text)
    const item = store.begin(binding, { uploadId: `upload-${id}`, filename: "notes.txt", mime: "text/plain", totalBytes: content.length, digest: bytes.digest(content) })
    return store.append(binding, item.attachmentId, 0, bytes.encodeBase64(content))
  }
  return { store, upload }
}

test("typed structured input bounds the complete envelope and forbids path/identity/provider escape fields", () => {
  expect(parseCommandEnvelope(command)).toEqual(command)
  for (const part of [{ type: "file_reference", path: "/private/file" }, { ...image, providerSecret: "hidden" }, { type: "attachment", attachmentId: "id", actorId: "other" }]) {
    expect(() => parseCommandEnvelope({ ...command, payload: { actorId: "a", parts: [part] } })).toThrow()
  }
  expect(() => parseCommandEnvelope({ ...command, payload: { actorId: "a", parts: Array.from({ length: 16 }, () => ({ type: "text", text: "x".repeat(65536) })) } })).toThrow()
  expect(() => parseAttachmentOperation({ kind: "begin", expectedEpoch: "e", uploadId: "id", filename: "f", mime: "application/pdf", totalBytes: 12, digest: "sha256:" + "a".repeat(64) })).toThrow()
})

test("ordered inline/ref input survives resource removal without retaining client-owned mutable parts", () => {
  const f = fixture(), ready = f.upload("saved notes"), inline = { type: "text" as const, text: "before" }
  const lease = prepareHostInput(f.store, binding, [inline, { type: "attachment", attachmentId: ready.attachmentId }, image, { type: "text", text: "after" }], bytes)
  lease.commit(); inline.text = "mutated"
  f.store.release(binding, ready.attachmentId)
  expect(lease.read()).toEqual([{ type: "text", text: "before" }, { type: "text", text: "saved notes", filename: "notes.txt", sourceDigest: bytes.digest(new TextEncoder().encode("saved notes")) },
    { ...image, sourceDigest: bytes.digest(png), size: png.length }, { type: "text", text: "after" }])
  expect(f.store.diagnostics().pinnedBytes).toBeGreaterThan(0)
  lease.release(); expect(f.store.diagnostics().pinnedBytes).toBe(0)
  expect(() => prepareHostInput(f.store, binding, [], bytes)).toThrow("attachment_invalid_parts")
  expect(() => prepareHostInput(f.store, binding, [{ type: "text", text: "" }], bytes)).toThrow("input_empty")
  expect(() => prepareHostInput(f.store, binding, [{ type: "text", text: "x".repeat(65536) }, { type: "text", text: "y" }], bytes)).toThrow("input_text_too_large")
  expect(() => prepareHostInput(f.store, binding, [{ ...image, filename: "../private" }], bytes)).toThrow("attachment_invalid_metadata")
  expect(() => prepareHostInput(f.store, binding, [{ ...image, dataUrl: "https://private/image" }], bytes)).toThrow("attachment_invalid_data_url")
  expect(() => prepareHostInput(f.store, binding, [{ ...image, dataUrl: "data:image/png;base64,eA==" }], bytes)).toThrow("attachment_mime_mismatch")
})

test("structured input shares turn/control capacity and releases its lease when cancelled before deferred delivery", async () => {
  const f = fixture(), ready = f.upload("never delivered"), jobs: Array<() => Promise<void>> = []
  let executed = 0, releases = 0
  const runtime: CommandRuntime = { sessionId: "s", epoch: "e", index: createCommandIndex(), identity: { now: () => 0, newId: () => "turn" },
    authorization: { permits: () => true, currentGrantsVersion: () => "1" }, effects: {
      digest: value => bytes.digest(new TextEncoder().encode(value)),
      actor: actorId => ({ actorId, displayName: "A", executionKind: "interactive", runtimeState: "idle", allowedActions: ["send_input"], capabilities: { textInput: true, cancelTurn: true, questionnaireAnswer: true } }),
      preflight(value) {
        if (value.kind !== "send_input") throw new Error("unexpected input")
        const lease = prepareHostInput(f.store, binding, value.payload.parts, bytes)
        return { commit: () => lease.commit(), release() { releases++; lease.release() } }
      }, execute: async () => { executed++ }, defer: job => jobs.push(job), publishCommand() {},
    } }
  const request = { principal: { principalId: "p", grantsVersion: "1" }, requestId: "r" }
  const input = { ...command, payload: { actorId: "a", parts: [{ type: "attachment" as const, attachmentId: ready.attachmentId }] } }
  const receipt = admitHostCommand(runtime, request, input, { receipts: 2, identities: 2, terminalTtlMs: 100 }) as CommandReceipt
  expect(receipt.turnId).toBe("turn"); expect(runtime.index.reserved).toBe(1)
  expect(admitHostCommand(runtime, request, input)).toEqual(receipt)
  expect(() => admitHostCommand(runtime, request, { ...input, commandId: "overflow" }, { receipts: 2, identities: 2, terminalTtlMs: 100 })).toThrow("command_capacity")
  recordHostTurn(runtime, { actorId: "a", turnId: "turn", state: "cancelled", canCancel: false, pendingQuestionIds: [] })
  for (const job of jobs) await job()
  expect(executed).toBe(0); expect(releases).toBe(1); expect(f.store.diagnostics().pinnedBytes).toBe(0)
})

test("public history keeps typed file/image metadata, excludes private extras and can retrieve a large image after a bounded preview", () => {
  const large = `data:image/png;base64,${bytes.encodeBase64(new Uint8Array(200000))}`
  const source = { recordId: "m", message: { role: "user", content: [{ type: "text", text: "notes", filename: "notes.txt", sourceDigest: "sha256:" + "a".repeat(64), path: "/private" },
    { type: "image", mime: "image/png", dataUrl: large, filename: "image.png", size: 200000, providerToken: "SECRET" }] } }
  const read = createPublicMessageRead(source), size = measurePublicMessage(read), preview = read.preview(4096, size)
  expect(preview.preview.truncated).toBe(true)
  expect(preview.preview.parts).toEqual([{ kind: "text", text: "notes", filename: "notes.txt", sourceDigest: "sha256:" + "a".repeat(64) }, { kind: "image", mime: "image/png", filename: "image.png", size: 200000 }])
  const full = JSON.parse(new TextDecoder().decode(readPublicMessageBytes(read, 0, size)))
  expect(full.parts[1].dataUrl).toBe(large)
  expect(JSON.stringify(full)).not.toContain("SECRET"); expect(JSON.stringify(full)).not.toContain("/private")
  expect(parsePublicMessage(full)).toEqual(full)
  expect(() => parseHistoryPage({ actorId: "a", epoch: "e", historyRevision: "r", messages: [{ messageId: "m", role: "user", preview: { parts: full.parts, startOffset: 0, totalBytes: size, truncated: false } }] })).toThrow()
  expect(() => parsePublicMessage({ ...full, path: "/private" })).toThrow()
  expect(() => parsePublicMessage({ ...full, parts: [{ kind: "text", text: "x".repeat(16 * 1024 * 1024) }] })).toThrow()
})
