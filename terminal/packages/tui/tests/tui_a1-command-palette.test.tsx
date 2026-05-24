/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { ArgsProvider } from "../src/providers/args"
import { ExitProvider } from "../src/providers/exit"
import { KVProvider } from "../src/providers/kv"
import { KeybindProvider } from "../src/providers/keybind"
import { RuntimeClientProvider } from "../src/providers/runtime-client"
import { ThemeProvider } from "../src/providers/theme"
import { CommandProvider } from "../src/ui/primitives/dialog-command"
import { TuiA1CommandPaletteSurface } from "../src/app/tui_a1/command-palette"
import { SyncProvider } from "../src/app/tui_a1/state/sync-context"
import { DialogProvider } from "../src/ui/dialog/context"
import { Toast, ToastProvider } from "../src/ui/toast/toast"

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

function renderCommandPaletteHarness() {
  return (
    <ArgsProvider>
      <ExitProvider onExit={async () => {}}>
        <KVProvider>
          <RuntimeClientProvider url="mock">
            <ToastProvider>
              <SyncProvider>
                <ThemeProvider mode="dark">
                  <KeybindProvider>
                    <DialogProvider>
                      <CommandProvider>
                        <TuiA1CommandPaletteSurface />
                        <Toast />
                        <box width="100%" height="100%" />
                      </CommandProvider>
                    </DialogProvider>
                  </KeybindProvider>
                </ThemeProvider>
              </SyncProvider>
            </ToastProvider>
          </RuntimeClientProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  )
}

async function renderSettled(setup: Awaited<ReturnType<typeof testRender>>) {
  await setup.renderOnce()
  await tick()
  await setup.renderOnce()
  await tick()
  await setup.renderOnce()
}

function captureText(setup: Awaited<ReturnType<typeof testRender>>) {
  const frame = setup.captureSpans()
  return frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
}

function countOccurrences(input: string, search: string) {
  return input.split(search).length - 1
}

describe("tui_a1 command palette", () => {
  it("opens from command_list and exposes the first system actions", async () => {
    const setup = await testRender(() => renderCommandPaletteHarness(), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup)

      setup.mockInput.pressKey("p", { ctrl: true })
      await renderSettled(setup)

      const text = captureText(setup)
      expect(text).toContain("Commands")
      expect(text).toContain("Sessions")
      expect(text).toContain("Connect Provider")
      expect(text).toContain("Models")
      expect(text).toContain("Agents")
      expect(text).toContain("MCP Servers")
      expect(text).toContain("Status")
      expect(text).toContain("Shortcuts")
      expect(text).toContain("Help")
      expect(text).toContain("ctrl+x l")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("routes palette selection and direct shortcuts through the same status surface", async () => {
    const setup = await testRender(() => renderCommandPaletteHarness(), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup)

      setup.mockInput.pressKey("p", { ctrl: true })
      await renderSettled(setup)
      await setup.mockInput.typeText("status")
      await renderSettled(setup)
      setup.mockInput.pressEnter()
      await renderSettled(setup)

      const paletteText = captureText(setup)
      expect(paletteText).toContain("Status")
      expect(paletteText).toContain("System Facts")
      expect(paletteText).toContain("Surface Shortcuts")
      expect(paletteText).toContain("Connected Services")
      expect(countOccurrences(paletteText, "[关闭(esc)]")).toBe(1)

      setup.mockInput.pressEscape()
      await renderSettled(setup)

      setup.mockInput.pressKey("x", { ctrl: true })
      await renderSettled(setup)
      setup.mockInput.pressKey("s")
      await renderSettled(setup)

      const shortcutText = captureText(setup)
      expect(shortcutText).toContain("Status")
      expect(shortcutText).toContain("System Facts")
      expect(shortcutText).toContain("Surface Shortcuts")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("opens help with the polished guidance sections", async () => {
    const setup = await testRender(() => renderCommandPaletteHarness(), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup)

      setup.mockInput.pressKey("p", { ctrl: true })
      await renderSettled(setup)
      await setup.mockInput.typeText("help")
      await renderSettled(setup)
      setup.mockInput.pressEnter()
      await renderSettled(setup)

      const text = captureText(setup)
      expect(text).toContain("Help")
      expect(text).toContain("Prompt and history")
      expect(text).toContain("Tip of the moment")
      expect(text).toContain("使用说明")
      expect(text).not.toContain("焦点:历史")
      expect(text).not.toContain("焦点:输入")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("opens the categorized shortcut overview from the palette", async () => {
    const setup = await testRender(() => renderCommandPaletteHarness(), {
      width: 120,
      height: 140,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup)

      setup.mockInput.pressKey("p", { ctrl: true })
      await renderSettled(setup)
      await setup.mockInput.typeText("shortcuts")
      await renderSettled(setup)
      setup.mockInput.pressEnter()
      await renderSettled(setup)

      const text = captureText(setup)
      expect(text).toContain("Shortcuts")
      expect(text).toContain("System")
      expect(text).toContain("Composer")
      expect(text).toContain("Clear input")
      expect(text).toContain("ctrl+shift+l")
      expect(countOccurrences(text, "[关闭(esc)]")).toBe(1)

      setup.mockInput.pressKey("END")
      await renderSettled(setup)

      const bottomText = captureText(setup)
      expect(bottomText).toContain("ctrl+o")
    } finally {
      setup.renderer.destroy()
    }
  })
})
