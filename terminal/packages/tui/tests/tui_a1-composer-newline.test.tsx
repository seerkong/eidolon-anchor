/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { RuntimeClientProvider } from "../src/providers/runtime-client"
import { TuiA1Shell } from "../src/app/tui_a1"

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

async function renderSettled(setup: Awaited<ReturnType<typeof testRender>>, passes = 3) {
  for (let index = 0; index < passes; index += 1) {
    await tick()
    await setup.renderOnce()
  }
}

describe("tuiA1 composer newline keybindings", () => {
  it("inserts a newline with ctrl+j without submitting in a legacy terminal", async () => {
    const setup = await testRender(
      () => (
        <RuntimeClientProvider url="mock">
          <TuiA1Shell directory={process.cwd()} sessionID="ses_1" />
        </RuntimeClientProvider>
      ),
      {
        width: 100,
        height: 32,
        kittyKeyboard: false,
      },
    )

    try {
      await renderSettled(setup)
      await setup.mockInput.typeText("first")
      setup.mockInput.pressKey("j", { ctrl: true })
      await setup.mockInput.typeText("second")
      await renderSettled(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain("first")
      expect(frame).toContain("second")
      expect(frame).not.toContain("firstsecond")
      expect(frame).toContain("12 chars · 0 parts")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("keeps shift+enter newline support with the enhanced keyboard protocol", async () => {
    const setup = await testRender(
      () => (
        <RuntimeClientProvider url="mock">
          <TuiA1Shell directory={process.cwd()} sessionID="ses_1" />
        </RuntimeClientProvider>
      ),
      {
        width: 100,
        height: 32,
        kittyKeyboard: true,
      },
    )

    try {
      await renderSettled(setup)
      await setup.mockInput.typeText("first")
      setup.mockInput.pressKey("RETURN", { shift: true })
      await setup.mockInput.typeText("second")
      await renderSettled(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain("first")
      expect(frame).toContain("second")
      expect(frame).not.toContain("firstsecond")
      expect(frame).toContain("12 chars · 0 parts")
    } finally {
      setup.renderer.destroy()
    }
  })
})
