import { describe, expect, it } from "bun:test"
import { scheduleRenderableFocus } from "../src/ui/renderable-lifecycle"

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

describe("renderable lifecycle", () => {
  it("does not focus a renderable destroyed before the deferred callback", async () => {
    let focusCalls = 0
    const target = {
      isDestroyed: false,
      focus() {
        focusCalls += 1
      },
    }

    scheduleRenderableFocus(() => target)
    target.isDestroyed = true
    await tick()

    expect(focusCalls).toBe(0)
  })

  it("supports explicit cancellation when a dialog unmounts", async () => {
    let focusCalls = 0
    const cancel = scheduleRenderableFocus(() => ({
      isDestroyed: false,
      focus() {
        focusCalls += 1
      },
    }))

    cancel()
    await tick()

    expect(focusCalls).toBe(0)
  })
})
