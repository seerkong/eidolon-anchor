/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
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
import { __setRuntimeBridgeFactoryForTest, createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"
import { flushTuiStreamDiagnostics } from "../src/support/util/stream-diagnostics"

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

async function renderSettled(setup: Awaited<ReturnType<typeof testRender>>, passes = 4) {
  for (let index = 0; index < passes; index += 1) {
    await tick()
    await setup.renderOnce()
  }
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

describe("tui stream diagnostics", () => {
  it("captures the full runtime-provider-tuiA1 stream path", async () => {
    const previous = process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS
    process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS = "1"
    const directory = await mkdtemp(join(tmpdir(), "eidolon-tui-stream-path-"))
    const sessionID = "ses_stream_path"
    const text = "x".repeat(1200)

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(_input, opts) {
        await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
        for (let index = 0; index < text.length; index += 40) {
          void opts?.onChunk?.(text.slice(index, index + 40))
        }
        return text
      },
      async abort() {},
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
        await renderSettled(setup, 6)
        await runtime.client.session.prompt({
          sessionID: activeSessionID,
          parts: [{ id: "input", type: "text", text: "stream path" } as any],
        })
        await renderSettled(setup, 30)
      } finally {
        setup.renderer.destroy()
      }

      await flushTuiStreamDiagnostics()
      const diagnostics = await readFile(
        join(directory, ".eidolon", "sessions", activeSessionID, "diagnostics", "tui-stream.jsonl"),
        "utf8",
      )

      expect(diagnostics).toContain("runtime.emit")
      expect(diagnostics).toContain("provider.receive")
      expect(diagnostics).toContain("provider.flush")
      expect(diagnostics).toContain("tui_a1.receive")
      expect(diagnostics).toContain("tui_a1.project")
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
      if (previous === undefined) delete process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS
      else process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS = previous
      await rm(directory, { recursive: true, force: true })
    }
  })
})
