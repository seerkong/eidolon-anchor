export type AttachmentBinding = Readonly<{ principalId: string; grantsVersion: string; sessionId: string; actorId: string; epoch: string }>
type Mime = "text/plain" | "image/png" | "image/jpeg" | "image/webp"
type Metadata = Readonly<{ uploadId: string; filename: string; mime: Mime; totalBytes: number; digest: string }>
type ResolvedAttachment = Readonly<
  | { type: "text"; text: string; filename: string; sourceDigest: string }
  | { type: "image"; mime: Mime; dataUrl: string; filename: string; sourceDigest: string; size: number }
>
type Effects = Readonly<{
  now(): number; newId(): string; digest(bytes: Uint8Array): string
  encodeBase64(bytes: Uint8Array): string; decodeBase64(data: string): Uint8Array
}>
type Limits = { imageBytes: number; textBytes: number; stagedBytes: number; pinnedBytes: number; inputBytes: number; resourcesPerActor: number; identities: number; chunkBytes: number; chunks: number; parts: number; ttlMs: number; retentionMs: number }
const defaultLimits: Limits = { imageBytes: 2 * 1024 * 1024, textBytes: 256 * 1024, stagedBytes: 16 * 1024 * 1024, pinnedBytes: 16 * 1024 * 1024,
  inputBytes: 4 * 1024 * 1024, resourcesPerActor: 16, identities: 256, chunkBytes: 32 * 1024, chunks: 256, parts: 16, ttlMs: 5 * 60 * 1000, retentionMs: 60 * 60 * 1000 }
export const hostAttachmentLimits = Object.freeze({ imageBytes: defaultLimits.imageBytes, textBytes: defaultLimits.textBytes, chunkBytes: defaultLimits.chunkBytes,
  inputBytes: defaultLimits.inputBytes, parts: defaultLimits.parts, ttlMs: defaultLimits.ttlMs })
type State = "uploading" | "ready" | "released" | "expired" | "failed"
type Record = {
  attachmentId: string; binding: AttachmentBinding; metadata: Metadata; fingerprint: string; identityKey: string
  state: State; expiresAt: number; retainUntil: number; uploadedBytes: number; pins: number; charged: boolean
  chunks: Map<number, { size: number; digest: string; bytes?: Uint8Array }>; part?: ResolvedAttachment
}
export class AttachmentStoreFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
const fail = (status: number, code: string): never => { throw new AttachmentStoreFailure(status, code) }
const terminal = (state: State) => state === "released" || state === "expired" || state === "failed"
const keyOf = (binding: AttachmentBinding) => JSON.stringify([binding.principalId, binding.grantsVersion, binding.sessionId, binding.actorId, binding.epoch])
const boundedString = (value: unknown, max = 256): value is string => typeof value === "string" && !!value && new TextEncoder().encode(value).byteLength <= max && !/[\0\r\n]/.test(value)
export function identifyAttachmentImageMime(bytes: Uint8Array): Mime | undefined {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 12 && [0x52, 0x49, 0x46, 0x46].every((byte, index) => bytes[index] === byte)
    && [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[index + 8] === byte)) return "image/webp"
  return undefined
}

/** Scoped staged resources only. Committed Conversation assets have their existing durable owner. */
export function createHostAttachmentStore(options: { sessionId: string; epoch: string; effects: Effects; limits?: Partial<Limits> }) {
  const limits = { ...defaultLimits, ...options.limits }, effects = options.effects
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0) || limits.retentionMs < limits.ttlMs) throw new Error("invalid_attachment_limits")
  const records = new Map<string, Record>(), identities = new Map<string, Record>()
  let closed = false, pinnedBytes = 0
  const stagedBytes = () => [...records.values()].reduce((sum, record) => sum + (record.charged ? record.metadata.totalBytes : 0), 0)
  function reclaim(record: Record) {
    if (record.pins || !terminal(record.state)) return
    record.charged = false; record.chunks.clear(); record.part = undefined
  }
  function sweep() {
    const now = effects.now()
    for (const record of records.values()) {
      if (record.expiresAt <= now && !terminal(record.state)) record.state = "expired"
      reclaim(record)
      if (!record.pins && terminal(record.state) && record.retainUntil <= now) { records.delete(record.attachmentId); identities.delete(record.identityKey) }
    }
  }
  function check(binding: AttachmentBinding) {
    if (closed) fail(409, "attachment_store_closed")
    if (binding.sessionId !== options.sessionId || binding.epoch !== options.epoch) fail(409, "attachment_epoch_expired")
    if (!Object.values(binding).every(value => boundedString(value))) fail(400, "attachment_invalid_binding")
    sweep()
  }
  function find(binding: AttachmentBinding, attachmentId: string): Record {
    check(binding)
    const record = records.get(attachmentId)
    if (!record || keyOf(record.binding) !== keyOf(binding)) return fail(404, "attachment_not_found")
    return record
  }
  function requireLive(record: Record) {
    if (terminal(record.state)) fail(410, `attachment_${record.state}`)
  }
  function view(record: Record) {
    return { attachmentId: record.attachmentId, epoch: options.epoch, state: record.state, filename: record.metadata.filename, mime: record.metadata.mime,
      uploadedBytes: record.uploadedBytes, totalBytes: record.metadata.totalBytes, expiresAt: record.expiresAt,
      ...(record.state === "ready" ? { digest: record.metadata.digest } : {}) }
  }
  function materialize(record: Record): ResolvedAttachment {
    const bytes = new Uint8Array(record.metadata.totalBytes)
    for (const [offset, chunk] of record.chunks) bytes.set(chunk.bytes!, offset)
    if (effects.digest(bytes) !== record.metadata.digest) return fail(422, "attachment_digest_mismatch")
    const { filename, digest: sourceDigest, mime } = record.metadata
    if (mime === "text/plain") {
      if (bytes.includes(0)) return fail(422, "attachment_invalid_utf8")
      let text: string
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { return fail(422, "attachment_invalid_utf8") }
      return Object.freeze({ type: "text", filename, sourceDigest, text })
    }
    if (identifyAttachmentImageMime(bytes) !== mime) return fail(422, "attachment_mime_mismatch")
    return Object.freeze({ type: "image", filename, sourceDigest, mime, dataUrl: `data:${mime};base64,${effects.encodeBase64(bytes)}`, size: bytes.length })
  }
  return {
    begin(binding: AttachmentBinding, input: Metadata) {
      check(binding)
      if (!boundedString(input.uploadId) || !boundedString(input.filename) || /[/\\]/.test(input.filename)
        || !["text/plain", "image/png", "image/jpeg", "image/webp"].includes(input.mime) || !/^sha256:[a-f0-9]{64}$/.test(input.digest)
        || !Number.isSafeInteger(input.totalBytes) || input.totalBytes <= 0) return fail(400, "attachment_invalid_metadata")
      if (input.totalBytes > (input.mime === "text/plain" ? limits.textBytes : limits.imageBytes)) return fail(413, "attachment_too_large")
      const metadata = { uploadId: input.uploadId, filename: input.filename, mime: input.mime, totalBytes: input.totalBytes, digest: input.digest }
      const identityKey = JSON.stringify([keyOf(binding), input.uploadId]), fingerprint = JSON.stringify(metadata), old = identities.get(identityKey)
      if (old) { if (old.fingerprint !== fingerprint) return fail(409, "attachment_identity_conflict"); requireLive(old); return view(old) }
      if (identities.size >= limits.identities) return fail(429, "attachment_identity_capacity")
      if ([...records.values()].filter(record => record.binding.actorId === binding.actorId && !terminal(record.state)).length >= limits.resourcesPerActor
        || stagedBytes() + input.totalBytes > limits.stagedBytes) return fail(429, "attachment_capacity")
      const attachmentId = effects.newId()
      if (!boundedString(attachmentId) || records.has(attachmentId)) return fail(503, "attachment_identity_unavailable")
      const now = effects.now(), record: Record = { attachmentId, binding: Object.freeze({ ...binding }), metadata: Object.freeze(metadata), fingerprint, identityKey,
        state: "uploading", expiresAt: now + limits.ttlMs, retainUntil: now + limits.retentionMs, uploadedBytes: 0, pins: 0, charged: true, chunks: new Map() }
      records.set(attachmentId, record); identities.set(identityKey, record)
      return view(record)
    },
    append(binding: AttachmentBinding, attachmentId: string, offset: number, data: string) {
      const record = find(binding, attachmentId); requireLive(record)
      if (typeof data !== "string" || data.length > Math.ceil(limits.chunkBytes / 3) * 4) return fail(413, "attachment_chunk_too_large")
      let bytes: Uint8Array
      try { bytes = new Uint8Array(effects.decodeBase64(data)) } catch { return fail(400, "attachment_invalid_base64") }
      if (!bytes.length) return fail(400, "attachment_invalid_base64")
      if (bytes.length > limits.chunkBytes) return fail(413, "attachment_chunk_too_large")
      if (!Number.isSafeInteger(offset) || offset < 0) return fail(400, "attachment_offset_mismatch")
      const digest = effects.digest(bytes), old = record.chunks.get(offset)
      if (old) { if (old.size !== bytes.length || old.digest !== digest) return fail(409, "attachment_chunk_conflict"); return view(record) }
      if (record.state !== "uploading" || offset !== record.uploadedBytes) return fail(409, "attachment_offset_mismatch")
      if (record.chunks.size >= limits.chunks) return fail(429, "attachment_chunk_capacity")
      if (offset + bytes.length > record.metadata.totalBytes) return fail(413, "attachment_declared_size_exceeded")
      record.chunks.set(offset, { bytes, size: bytes.length, digest }); record.uploadedBytes += bytes.length
      if (record.uploadedBytes === record.metadata.totalBytes) {
        try { record.part = materialize(record); record.state = "ready"; for (const chunk of record.chunks.values()) delete chunk.bytes }
        catch (error) { record.state = "failed"; reclaim(record); throw error }
      }
      return view(record)
    },
    release(binding: AttachmentBinding, attachmentId: string) {
      const record = find(binding, attachmentId)
      if (record.state !== "released") { requireLive(record); record.state = "released"; reclaim(record) }
      return view(record)
    },
    prepareReferences(binding: AttachmentBinding, attachmentIds: readonly string[], inlineBytes = 0) {
      check(binding)
      if ((!attachmentIds.length && !inlineBytes) || attachmentIds.length > limits.parts || !Number.isSafeInteger(inlineBytes) || inlineBytes < 0) return fail(400, "attachment_invalid_parts")
      const selected = attachmentIds.map(id => { const record = find(binding, id); requireLive(record); if (record.state !== "ready") return fail(409, "attachment_not_ready"); return record })
      const charge = selected.reduce((sum, record) => sum + record.metadata.totalBytes, inlineBytes)
      if (charge > limits.inputBytes) return fail(413, "attachment_input_capacity")
      const unique = [...new Set(selected)]
      let committed = false, released = false
      return {
        commit() {
          if (released) return fail(409, "attachment_lease_released")
          if (committed) return
          check(binding)
          for (const record of unique) requireLive(record)
          if (pinnedBytes + charge > limits.pinnedBytes) return fail(429, "attachment_pin_capacity")
          for (const record of unique) record.pins++
          pinnedBytes += charge; committed = true
        },
        read(): readonly ResolvedAttachment[] {
          if (closed) return fail(409, "attachment_store_closed")
          if (!committed || released) return fail(409, "attachment_lease_not_active")
          return Object.freeze(selected.map(record => record.part!))
        },
        release() {
          if (released) return
          released = true
          if (!committed || closed) return
          pinnedBytes -= charge
          for (const record of unique) { record.pins--; reclaim(record) }
          sweep()
        },
      }
    },
    diagnostics() { sweep(); return { stagedBytes: stagedBytes(), pinnedBytes, identities: identities.size, activeResources: [...records.values()].filter(record => !terminal(record.state)).length, closed } },
    close() {
      if (closed) return
      closed = true
      for (const record of records.values()) { record.state = "released"; record.pins = 0; reclaim(record) }
      records.clear(); identities.clear(); pinnedBytes = 0
    },
  }
}
