import { describe, expect, it } from "bun:test"
import { __resetSessionUlidForTest, makeSessionKey, makeSessionUlid } from "@terminal/core/AIAgent"

describe("session/message ULID ordering", () => {
  it("is monotonic within the same millisecond", () => {
    __resetSessionUlidForTest()
    const now = 1_777_000_000_000
    const a = makeSessionUlid(now)
    const b = makeSessionUlid(now)
    const c = makeSessionUlid(now)
    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
  })

  it("formats session keys as timestamp plus ulid", () => {
    __resetSessionUlidForTest()
    const key = makeSessionKey(new Date(2026, 3, 19, 12, 34, 56).getTime())
    expect(key).toMatch(/^20260419123456__[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})
