import { describe, expect, it } from "bun:test"
import {
  coalesceRuntimeEvents,
  nextRuntimeSubscribeRetryDelay,
  runRuntimeSubscribeFallback,
  waitForRuntimeSubscribeRetry,
} from "../src/providers/runtime-client"
import type { Event } from "@terminal/core/AIAgent"

describe("runtime client subscribe retry backoff", () => {
  it("resolves pending retry waits when aborted", async () => {
    const abort = new AbortController()
    const wait = waitForRuntimeSubscribeRetry(abort.signal, 10_000)

    abort.abort()

    const result = await Promise.race([
      wait.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ])

    expect(result).toBe("resolved")
  })

  it("resolves immediately when already aborted", async () => {
    const abort = new AbortController()
    abort.abort()

    const result = await Promise.race([
      waitForRuntimeSubscribeRetry(abort.signal, 10_000).then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ])

    expect(result).toBe("resolved")
  })

  it("backs off and retries when subscribe throws", async () => {
    const abort = new AbortController()
    const delays: number[] = []
    let attempts = 0

    await runRuntimeSubscribeFallback({
      signal: abort.signal,
      runtimeEvent: {
        async subscribe() {
          attempts += 1
          throw new Error("subscribe failed")
        },
      },
      handleEvent() {},
      flushPending() {},
      waitForRetry: async (_signal, delayMs) => {
        delays.push(delayMs)
        if (attempts >= 2) abort.abort()
      },
    })

    expect(attempts).toBe(2)
    expect(delays).toEqual([250, 500])
  })

  it("caps retry backoff", () => {
    expect(nextRuntimeSubscribeRetryDelay(0)).toBe(250)
    expect(nextRuntimeSubscribeRetryDelay(250)).toBe(500)
    expect(nextRuntimeSubscribeRetryDelay(2_000)).toBe(2_000)
  })

  it("keeps only the latest same-part update within a runtime event frame", () => {
    const update = (text: string): Event =>
      ({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "text",
            text,
          },
        },
      }) as Event
    const other: Event = {
      type: "session.status",
      properties: {
        sessionID: "ses_1",
        status: { type: "busy" },
      },
    } as Event

    const events = coalesceRuntimeEvents([update("a"), update("ab"), other, update("abc")])

    expect(events).toHaveLength(2)
    expect(events[0]).toBe(other)
    expect(events[1]).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          text: "abc",
        },
      },
    })
  })
})
