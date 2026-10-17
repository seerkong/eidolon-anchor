import type { HostInputPart } from "@cell/ai-runtime-host-contract"
import { AttachmentStoreFailure, identifyAttachmentImageMime, type AttachmentBinding, createHostAttachmentStore } from "./attachments"

type Store = ReturnType<typeof createHostAttachmentStore>
type ByteEffects = { decodeBase64(data: string): Uint8Array; digest(bytes: Uint8Array): string }
const fail = (status: number, code: string): never => { throw new AttachmentStoreFailure(status, code) }

/** Preserve ordered parts and immutable resource pins through asynchronous actor preparation. */
export function prepareHostInput(store: Store, binding: AttachmentBinding, parts: readonly HostInputPart[], bytes: ByteEffects) {
  if (!parts.length || parts.length > 16) return fail(400, "attachment_invalid_parts")
  let inlineBytes = 0, inlineTextBytes = 0
  const normalized = parts.map(part => {
    if (part.type === "attachment") return part
    if (part.filename !== undefined && (!part.filename || /[/\\\0\r\n]/.test(part.filename) || new TextEncoder().encode(part.filename).byteLength > 256)) return fail(400, "attachment_invalid_metadata")
    if (part.type === "text") {
      const size = new TextEncoder().encode(part.text).byteLength
      inlineBytes += size; inlineTextBytes += size
      if (inlineTextBytes > 64 * 1024) return fail(413, "input_text_too_large")
      return Object.freeze({ ...part })
    }
    const prefix = `data:${part.mime};base64,`
    if (!part.dataUrl.startsWith(prefix)) return fail(400, "attachment_invalid_data_url")
    let decoded: Uint8Array
    try { decoded = bytes.decodeBase64(part.dataUrl.slice(prefix.length)) } catch { return fail(400, "attachment_invalid_base64") }
    if (decoded.byteLength > 96 * 1024) return fail(413, "inline_image_too_large")
    if (identifyAttachmentImageMime(decoded) !== part.mime) return fail(422, "attachment_mime_mismatch")
    inlineBytes += decoded.byteLength
    return Object.freeze({ ...part, sourceDigest: bytes.digest(decoded), size: decoded.byteLength })
  })
  if (!inlineBytes && !normalized.some(part => part.type === "attachment")) return fail(400, "input_empty")
  const lease = store.prepareReferences(binding, parts.filter(part => part.type === "attachment").map(part => part.attachmentId), inlineBytes)
  return {
    commit: () => lease.commit(),
    release: () => lease.release(),
    read() {
      const references = lease.read(); let index = 0
      return normalized.map(part => part.type === "attachment" ? references[index++]! : part)
    },
  }
}
