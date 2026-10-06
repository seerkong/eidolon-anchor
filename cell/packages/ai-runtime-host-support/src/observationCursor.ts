import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { ObservationCursorBinding, ObservationCursorEffects } from "@cell/ai-runtime-host-contract"

function scope(binding: ObservationCursorBinding): string {
  return createHash("sha256").update(JSON.stringify([binding.epoch, binding.principalId, binding.grantsVersion, [...new Set(binding.actors)].sort()])).digest("base64url")
}

export function createObservationCursorEffects(): ObservationCursorEffects {
  const secret = randomBytes(32)
  const signature = (value: string): Buffer => createHmac("sha256", secret).update(value).digest()
  return {
    issue(binding, seq) {
      if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("invalid_observation_sequence")
      const value = Buffer.from(JSON.stringify([scope(binding), seq])).toString("base64url")
      return `${value}.${signature(value).toString("base64url")}`
    },
    read(binding, cursor) {
      if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) return undefined
      const [value, mac] = cursor.split(".")
      const actual = Buffer.from(mac, "base64url")
      const expected = signature(value)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
      try {
        const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
        if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== scope(binding) || !Number.isSafeInteger(parsed[1]) || parsed[1] < 0) return undefined
        return parsed[1]
      } catch { return undefined }
    },
  }
}
