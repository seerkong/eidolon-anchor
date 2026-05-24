/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSpy } from "@opentui/core/testing"
import { DialogPrompt } from "../src/ui/dialog/prompt"
import { DialogProvider } from "../src/ui/dialog/context"
import { ThemeProvider } from "../src/providers/theme"
import { KeybindProvider } from "../src/providers/keybind"
import { RuntimeClientProvider } from "../src/providers/runtime-client"
import { SyncProvider } from "../src/app/tui_a1/state/sync-context"
import { KVProvider } from "../src/providers/kv"
import { ExitProvider } from "../src/providers/exit"
import { ArgsProvider } from "../src/providers/args"
import { ToastProvider } from "../src/ui/toast/toast"

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

const renderDialog = (onConfirm: (value: string) => void) => (
  <ArgsProvider>
    <ExitProvider onExit={async () => {}}>
      <KVProvider>
        <ToastProvider>
          <RuntimeClientProvider url="mock">
            <SyncProvider>
              <ThemeProvider mode="dark">
                <KeybindProvider>
                  <DialogProvider>
                    <DialogPrompt title="Authorization" placeholder="Code" onConfirm={onConfirm} />
                  </DialogProvider>
                </KeybindProvider>
              </ThemeProvider>
            </SyncProvider>
          </RuntimeClientProvider>
        </ToastProvider>
      </KVProvider>
    </ExitProvider>
  </ArgsProvider>
)

describe("DialogPrompt", () => {
  it("submits on Enter", async () => {
    const onConfirm = createSpy()
    const { mockInput, renderOnce, renderer } = await testRender(() => renderDialog(onConfirm), { kittyKeyboard: true })

    try {
    await renderOnce()
    await tick(10)
    await renderOnce()
    await tick(10)
    await renderOnce()
    await mockInput.typeText("abc")
    await tick(20)
    await renderOnce()
    await tick(20)
    await renderOnce()
    mockInput.pressKey("RETURN")
    await tick(50)
    await renderOnce()


      expect(onConfirm.callCount()).toBe(1)
      expect(onConfirm.calledWith("abc")).toBe(true)
    } finally {
      renderer.destroy()
    }
  })
})
