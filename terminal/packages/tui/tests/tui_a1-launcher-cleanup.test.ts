import { describe, expect, it } from "bun:test"

import { createTuiA1CleanupGate } from "../src/app/tui_a1/launcher"

describe("tui_a1 launcher cleanup", () => {
  it("shares one awaited cleanup across renderer destruction and the exit provider", async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let cleanupCalls = 0
    let completed = false
    const cleanup = createTuiA1CleanupGate(async () => {
      cleanupCalls += 1
      await barrier
      completed = true
    })

    const fromRenderer = cleanup()
    const fromExitProvider = cleanup()
    expect(fromRenderer).toBe(fromExitProvider)
    expect(cleanupCalls).toBe(1)
    expect(completed).toBe(false)

    release()
    await fromExitProvider
    expect(completed).toBe(true)
  })
})
