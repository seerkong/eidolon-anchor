import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export function createHistoryCursorEffects() {
  const secret = randomBytes(32)
  const sign = (value: string) => createHmac("sha256", secret).update(value).digest()
  return {
    seal(value: unknown): string { const body = Buffer.from(JSON.stringify(value)).toString("base64url"); return `${body}.${sign(body).toString("base64url")}` },
    open(cursor: string): unknown {
      if (cursor.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) return undefined
      const [body, mac] = cursor.split("."); const actual = Buffer.from(mac, "base64url"); const expected = sign(body)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
      try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) } catch { return undefined }
    },
    base64: (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64"),
  }
}
