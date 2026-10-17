import { createHash } from "node:crypto"

/** Byte codec effects only; resource identity, lifecycle and budgets belong to logic. */
export function createAttachmentByteEffects() {
  return {
    digest: (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    encodeBase64: (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64"),
    decodeBase64(data: string): Uint8Array {
      if (!data || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("attachment_invalid_base64")
      const bytes = Buffer.from(data, "base64")
      if (bytes.toString("base64") !== data) throw new Error("attachment_invalid_base64")
      return bytes
    },
  }
}
