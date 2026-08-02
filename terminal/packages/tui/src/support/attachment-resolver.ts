import { createHash } from "node:crypto"
import { statSync } from "node:fs"
import { open, realpath } from "node:fs/promises"
import path from "node:path"

import type { AttachmentResolverPort } from "@cell/ai-core-contract"
import type {
  InputContentPart,
  InputFileReferenceContentPart,
} from "@shared/composer"

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024

export type LocalAttachmentResolverOptions = Readonly<{
  maxImageBytes?: number
  maxTextBytes?: number
}>

function safeLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  if (
    bytes.length >= 6
    && bytes[0] === 0x47
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39)
    && bytes[5] === 0x61
  ) return "image/gif"
  if (
    bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50
  ) return "image/webp"
  return undefined
}

function decodeUtf8Text(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function attachmentLabel(reference: InputFileReferenceContentPart): string {
  return path.basename(reference.filename || reference.path) || "attachment"
}

function attachmentError(label: string, reason: string): Error {
  // Errors can reach semantic diagnostics and logs, so never include the
  // absolute source path carried by the local-only reference.
  return new Error(`attachment_${reason}:${label}`)
}

async function readBoundedFile(filePath: string, maxBytes: number, label: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, "r")
  } catch {
    throw attachmentError(label, "unreadable")
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw attachmentError(label, "not_file")
    if (metadata.size > maxBytes) throw attachmentError(label, "too_large")

    // Read at most maxBytes + 1 from the opened handle. The extra byte makes
    // growth between stat and read fail closed without allocating the file's
    // reported size or relying on an unbounded readFile call.
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) throw attachmentError(label, "too_large")
    return buffer.subarray(0, offset)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("attachment_")) throw error
    throw attachmentError(label, "unreadable")
  } finally {
    await handle.close().catch(() => {})
  }
}

export function isLocalAttachmentFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

export function createLocalAttachmentResolver(
  options: LocalAttachmentResolverOptions = {},
): AttachmentResolverPort {
  const maxImageBytes = safeLimit(options.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES)
  const maxTextBytes = safeLimit(options.maxTextBytes, DEFAULT_MAX_TEXT_BYTES)

  return {
    async resolve(reference: InputFileReferenceContentPart): Promise<Exclude<InputContentPart, InputFileReferenceContentPart>> {
      const label = attachmentLabel(reference)
      let resolvedPath: string
      try {
        resolvedPath = await realpath(reference.path)
      } catch {
        throw attachmentError(label, "unreadable")
      }
      const bytes = await readBoundedFile(resolvedPath, Math.max(maxImageBytes, maxTextBytes), label)
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
      const imageMime = sniffImageMime(bytes)
      if (imageMime) {
        if (bytes.byteLength > maxImageBytes) throw attachmentError(label, "too_large")
        return {
          type: "image",
          mime: imageMime,
          dataUrl: `data:${imageMime};base64,${bytes.toString("base64")}`,
          filename: label,
          sourceDigest: digest,
          size: bytes.byteLength,
        }
      }

      if (bytes.byteLength > maxTextBytes) throw attachmentError(label, "too_large")
      const text = decodeUtf8Text(bytes)
      if (text === undefined) throw attachmentError(label, "unsupported_binary")
      return {
        type: "text",
        text,
        filename: label,
        sourceDigest: digest,
      }
    },
  }
}
