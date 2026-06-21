/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ArgsProvider } from "../src/providers/args"
import { ExitProvider } from "../src/providers/exit"
import { KVProvider } from "../src/providers/kv"
import { KeybindProvider } from "../src/providers/keybind"
import { RuntimeClientProvider } from "../src/providers/runtime-client"
import { ThemeProvider } from "../src/providers/theme"
import { CommandProvider } from "../src/ui/primitives/dialog-command"
import { DialogProvider } from "../src/ui/dialog/context"
import { ToastProvider } from "../src/ui/toast/toast"
import { FrecencyProvider } from "../src/app/tui_a1/perf/frecency"
import { PromptHistoryProvider } from "../src/app/tui_a1/features/composer/model/prompt-history"
import { RouteProvider } from "../src/app/tui_a1/route/route-context"
import { LocalProvider } from "../src/app/tui_a1/state/local-context"
import { SyncProvider } from "../src/app/tui_a1/state/sync-context"
import { TuiA1StateProvider } from "../src/app/tui_a1/state/state-context"
import { TuiA1View } from "../src/app/tui_a1"
import { __setRuntimeBridgeFactoryForTest, createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function renderHarness(runtime: ReturnType<typeof createTuiRuntimeClient>, directory: string, sessionID: string) {
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
                                  <TuiA1View directory={directory} runtime={runtime} sessionID={sessionID} />
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

describe("session interrupt keybind", () => {
  it("calls session abort after double escape even when the view is idle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eidolon-tui-interrupt-idle-"))
    const sessionID = "ses_interrupt_idle"
    let aborted = 0

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        return "ok"
      },
      async abort() {
        aborted += 1
      },
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
    }))

    try {
      const runtime = createTuiRuntimeClient({ mode: "local-runtime", directory })
      const created = await runtime.client.session.create({ sessionID } as any)
      const activeSessionID = created.data?.id ?? sessionID
      const setup = await testRender(() => renderHarness(runtime, directory, activeSessionID), {
        width: 120,
        height: 36,
        kittyKeyboard: true,
      })

      try {
        await renderSettled(setup, 8)
        expect(aborted).toBe(0)

        setup.mockInput.pressEscape()
        await renderSettled(setup, 2)
        expect(aborted).toBe(0)

        setup.mockInput.pressEscape()
        await renderSettled(setup, 4)
        expect(aborted).toBe(1)
      } finally {
        setup.renderer.destroy()
      }
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("calls session abort after double escape while a turn is busy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eidolon-tui-interrupt-"))
    const sessionID = "ses_interrupt"
    const turn = deferred<string>()
    let aborted = 0

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        return await turn.promise
      },
      async abort() {
        aborted += 1
      },
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
    }))

    try {
      const runtime = createTuiRuntimeClient({ mode: "local-runtime", directory })
      const created = await runtime.client.session.create({ sessionID } as any)
      const activeSessionID = created.data?.id ?? sessionID
      const setup = await testRender(() => renderHarness(runtime, directory, activeSessionID), {
        width: 120,
        height: 36,
        kittyKeyboard: true,
      })

      try {
        await renderSettled(setup, 8)
        const prompt = runtime.client.session.prompt({
          sessionID: activeSessionID,
          parts: [{ id: "input", type: "text", text: "busy turn" } as any],
        })
        await renderSettled(setup, 8)

        setup.mockInput.pressEscape()
        await renderSettled(setup, 2)
        expect(aborted).toBe(0)

        setup.mockInput.pressEscape()
        await renderSettled(setup, 4)
        expect(aborted).toBe(1)

        turn.resolve("done")
        await prompt
      } finally {
        setup.renderer.destroy()
      }
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("replaces the runtime preparing label once the session is busy", async () => {
    const runtime = createTuiRuntimeClient({ mode: "mock" })
    const created = await runtime.client.session.create({ sessionID: "ses_running_status" } as any)
    const sessionID = created.data?.id ?? "ses_running_status"
    const originalPrompt = runtime.client.session.prompt.bind(runtime.client.session)
    runtime.client.session.prompt = (async () => {
      runtime.event.emit({ type: "session.status", properties: { sessionID, status: { type: "busy" } } } as any)
      return new Promise(() => {})
    }) as typeof runtime.client.session.prompt

    const setup = await testRender(() => renderHarness(runtime, process.cwd(), sessionID), {
      width: 120,
      height: 36,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 8)
      await setup.mockInput.typeText("busy turn")
      setup.mockInput.pressEnter()
      await renderSettled(setup, 8)

      const text = captureText(setup)
      expect(text).not.toContain("正在准备运行环境...")
      expect(text).toContain("正在处理...")
    } finally {
      runtime.client.session.prompt = originalPrompt
      setup.renderer.destroy()
    }
  })
})
