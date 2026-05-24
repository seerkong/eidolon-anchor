/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import type { TuiRuntimeSdk } from "@terminal/core/AIAgent"
import { ArgsProvider } from "../src/providers/args"
import { ExitProvider } from "../src/providers/exit"
import { KVProvider } from "../src/providers/kv"
import { KeybindProvider } from "../src/providers/keybind"
import { RuntimeClientProvider } from "../src/providers/runtime-client"
import { ThemeProvider } from "../src/providers/theme"
import { CommandProvider } from "../src/ui/primitives/dialog-command"
import { TuiA1View } from "../src/app/tui_a1"
import { FrecencyProvider } from "../src/app/tui_a1/perf/frecency"
import { PromptHistoryProvider } from "../src/app/tui_a1/features/composer/model/prompt-history"
import { RouteProvider } from "../src/app/tui_a1/route/route-context"
import { LocalProvider } from "../src/app/tui_a1/state/local-context"
import { SyncProvider } from "../src/app/tui_a1/state/sync-context"
import { TuiA1StateProvider } from "../src/app/tui_a1/state/state-context"
import { DialogProvider } from "../src/ui/dialog/context"
import { ToastProvider } from "../src/ui/toast/toast"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

async function renderSettled(setup: Awaited<ReturnType<typeof testRender>>, passes = 4) {
  for (let index = 0; index < passes; index += 1) {
    await tick()
    await setup.renderOnce()
  }
}

function captureText(setup: Awaited<ReturnType<typeof testRender>>) {
  const frame = setup.captureSpans()
  return frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
}

function displayWidth(text: string) {
  let width = 0
  for (const char of text) {
    width += char.codePointAt(0)! > 0xff ? 2 : 1
  }
  return width
}

function findSpanByText(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  const frame = setup.captureSpans()
  for (const [lineIndex, line] of frame.lines.entries()) {
    let x = 0
    for (const span of line.spans) {
      const offset = span.text.indexOf(text)
      if (offset >= 0) {
        return {
          ...span,
          x: x + displayWidth(span.text.slice(0, offset)),
          y: lineIndex,
        }
      }
      x += span.width ?? displayWidth(span.text)
    }
  }
  throw new Error(`Unable to find span containing ${text}`)
}

async function clickSpanByText(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  const span = findSpanByText(setup, text) as { x: number; y: number }
  const x = span.x + Math.max(1, Math.floor(displayWidth(text) / 2))
  await setup.mockMouse.click(x, span.y)
}

async function createSeededRuntime() {
  const runtime = createTuiRuntimeClient({ mode: "mock" })
  const created = await runtime.client.session.create({})
  const sessionID = created.data!.id

  await runtime.client.session.prompt({
    sessionID,
    parts: [{ id: "part-older", type: "text", text: "older question" } as any],
  })
  await tick(120)
  await runtime.client.session.prompt({
    sessionID,
    parts: [{ id: "part-newer", type: "text", text: "newer question" } as any],
  })
  await tick(120)

  return { runtime, sessionID }
}

function renderMessageListHarness(runtime: TuiRuntimeSdk, sessionID: string) {
  return (
    <ArgsProvider continue={true} sessionID={sessionID}>
      <ExitProvider onExit={async () => {}}>
        <KVProvider>
          <RuntimeClientProvider url="mock" client={runtime}>
            <ToastProvider>
              <SyncProvider>
                <ThemeProvider mode="dark">
                  <KeybindProvider>
                    <TuiA1StateProvider runtimeEnabled={true} sessionID={sessionID}>
                      <RouteProvider>
                        <LocalProvider>
                          <PromptHistoryProvider>
                            <FrecencyProvider>
                              <DialogProvider>
                                <CommandProvider>
                                  <TuiA1View directory={process.cwd()} runtime={runtime} sessionID={sessionID} />
                                </CommandProvider>
                              </DialogProvider>
                            </FrecencyProvider>
                          </PromptHistoryProvider>
                        </LocalProvider>
                      </RouteProvider>
                    </TuiA1StateProvider>
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

describe("message list dialog", () => {
  it("opens from the bottom bar and shows in-memory messages in newest-first order", async () => {
    const { runtime, sessionID } = await createSeededRuntime()
    const setup = await testRender(() => renderMessageListHarness(runtime, sessionID), {
      width: 130,
      height: 44,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 8)

      await clickSpanByText(setup, "[消息列表]")
      await renderSettled(setup, 4)

      const text = captureText(setup)
      const dialogText = text.slice(text.indexOf("消息列表"))
      expect(text).toContain("消息列表")
      expect(dialogText).toContain("newer question")
      expect(dialogText).toContain("older question")
      expect(dialogText.indexOf("newer question")).toBeLessThan(dialogText.indexOf("older question"))
      expect(text).toContain("[分叉会话]")
      expect(text).toContain("[回退至此]")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("forks the active session from the selected message", async () => {
    const { runtime, sessionID } = await createSeededRuntime()
    const setup = await testRender(() => renderMessageListHarness(runtime, sessionID), {
      width: 130,
      height: 44,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 8)
      await clickSpanByText(setup, "[消息列表]")
      await renderSettled(setup, 4)

      await clickSpanByText(setup, "[分叉会话]")
      await renderSettled(setup, 6)

      const sessions = await runtime.client.session.list()
      const forked = sessions.data?.filter((session) => session.id !== sessionID).at(-1)
      expect(forked).toBeDefined()

      const messages = await runtime.client.session.messages({ sessionID: forked!.id })
      const messageText = JSON.stringify(messages.data)
      expect(messageText).toContain("newer question")
      expect(messageText).not.toContain("收到：newer question")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("reverts the active session to the selected message", async () => {
    const { runtime, sessionID } = await createSeededRuntime()
    const setup = await testRender(() => renderMessageListHarness(runtime, sessionID), {
      width: 130,
      height: 44,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 8)
      await clickSpanByText(setup, "[消息列表]")
      await renderSettled(setup, 4)

      await clickSpanByText(setup, "[回退至此]")
      await renderSettled(setup, 6)

      const session = await runtime.client.session.get({ sessionID })
      const messages = await runtime.client.session.messages({ sessionID })
      const messageText = JSON.stringify(messages.data)
      expect(session.data?.revert?.messageID).toBeDefined()
      expect(messageText).toContain("newer question")
      expect(messageText).not.toContain("收到：newer question")

      await clickSpanByText(setup, "[消息列表]")
      await renderSettled(setup, 4)
      const dialogText = captureText(setup).slice(captureText(setup).indexOf("消息列表"))
      expect(dialogText).toContain("newer question")
      expect(dialogText).not.toContain("收到：newer question")
    } finally {
      setup.renderer.destroy()
    }
  })
})
