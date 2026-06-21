/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { useGraphSignal } from "depa-data-graph-solid"
import { onMount, type JSX } from "solid-js"
import { ArgsProvider } from "../src/providers/args"
import { ExitProvider } from "../src/providers/exit"
import { KVProvider } from "../src/providers/kv"
import { KeybindProvider } from "../src/providers/keybind"
import { RuntimeClientProvider } from "../src/providers/runtime-client"
import { ThemeProvider } from "../src/providers/theme"
import type { TuiA1Selection } from "../src/app/tui_a1/data"
import { TuiA1StateProvider, useTuiA1State } from "../src/app/tui_a1/state/state-context"
import type { Route } from "../src/app/tui_a1/route/route"
import { RouteProvider } from "../src/app/tui_a1/route/route-context"
import { LocalProvider, useLocal } from "../src/app/tui_a1/state/local-context"
import { SyncProvider } from "../src/app/tui_a1/state/sync-context"
import { DialogAgent } from "../src/app/tui_a1/system/agent/agent-dialog"
import { DialogProvider as DialogConnectProvider } from "../src/app/tui_a1/system/provider/provider-dialog"
import { DialogSessionList } from "../src/app/tui_a1/system/session/session-list-dialog"
import { DialogStatus } from "../src/app/tui_a1/system/status/status-dialog"
import { DialogProvider, useDialog } from "../src/ui/dialog/context"
import { Toast, ToastProvider } from "../src/ui/toast/toast"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"
import type { TuiRuntimeSdk } from "@terminal/core/AIAgent"

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
const mockSelection: TuiA1Selection = {
  agent: "build",
  providerID: "eidolon",
  modelID: "shell-default",
}

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

function countOccurrences(input: string, search: string) {
  return input.split(search).length - 1
}

function displayWidth(text: string) {
  let width = 0
  for (const char of text) {
    width += char.codePointAt(0)! > 0xff ? 2 : 1
  }
  return width
}

function findSpanOnLine(setup: Awaited<ReturnType<typeof testRender>>, lineContains: string, text: string) {
  const frame = setup.captureSpans()
  for (const [lineIndex, line] of frame.lines.entries()) {
    const lineText = line.spans.map((span) => span.text).join("")
    if (!lineText.includes(lineContains)) continue
    let x = 0
    for (const span of line.spans) {
      const offset = span.text.indexOf(text)
      if (offset >= 0) {
        return {
          x: x + displayWidth(span.text.slice(0, offset)),
          y: lineIndex,
        }
      }
      x += span.width ?? displayWidth(span.text)
    }
  }
  throw new Error(`Unable to find ${text} on line containing ${lineContains}`)
}

async function clickSpanOnLine(setup: Awaited<ReturnType<typeof testRender>>, lineContains: string, text: string) {
  const span = findSpanOnLine(setup, lineContains, text)
  const x = span.x + Math.max(1, Math.floor(displayWidth(text) / 2))
  await setup.mockMouse.click(x, span.y)
}

function OpenDialogOnMount(props: { render: () => JSX.Element }) {
  const dialog = useDialog()

  onMount(() => {
    dialog.replace(props.render)
  })

  return <box width="100%" height="100%" />
}

function SetModelOnMount(props: { providerID: string; modelID: string }) {
  const local = useLocal()

  onMount(() => {
    local.model.set({ providerID: props.providerID, modelID: props.modelID }, { recent: true })
  })

  return <box width="100%" height="100%" />
}

function GraphDebug() {
  const { stateGraph } = useTuiA1State()
  const route = useGraphSignal<Route, undefined>(stateGraph.graph, "route")
  const selection = useGraphSignal<TuiA1Selection, undefined>(stateGraph.graph, "selection")

  return (
    <text>
      {(() => {
        const currentRoute = route()
        return (
          (currentRoute.type === "session" ? `route:session:${currentRoute.sessionID}` : "route:home") +
          ` selection:${selection().agent}:${selection().providerID}/${selection().modelID}` +
          ` source:${selection().modelSource ?? "none"}`
        )
      })()}
    </text>
  )
}

function renderSurfaceHarness(dialogRender: () => JSX.Element, options?: { sessionID?: string; selection?: TuiA1Selection; client?: TuiRuntimeSdk }) {
  const sessionID = options?.sessionID ?? "ses_1"
  const selection = options?.selection ?? mockSelection

  return (
    <ArgsProvider continue={true} sessionID={sessionID}>
      <ExitProvider onExit={async () => {}}>
        <KVProvider>
          <RuntimeClientProvider url="mock" client={options?.client}>
            <ToastProvider>
              <SyncProvider>
                <ThemeProvider mode="dark">
                  <KeybindProvider>
                    <TuiA1StateProvider runtimeEnabled={true} selection={selection} sessionID={sessionID}>
                      <RouteProvider>
                        <LocalProvider>
                          <DialogProvider>
                            <OpenDialogOnMount render={dialogRender} />
                            <GraphDebug />
                            <Toast />
                          </DialogProvider>
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

function HomeSessionSurface() {
  const { stateGraph } = useTuiA1State()
  const dialog = useDialog()

  onMount(() => {
    stateGraph.setRoute({ type: "home" })
    dialog.replace(() => <DialogSessionList />)
  })

  return <box width="100%" height="100%" />
}

describe("tui_a1 system surfaces", () => {
  it("routes the active session back home after deleting it from the session surface", async () => {
    const setup = await testRender(() => renderSurfaceHarness(() => <DialogSessionList />), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 6)
      expect(captureText(setup)).toContain("Mock Session")

      setup.mockInput.pressKey("d", { ctrl: true })
      await renderSettled(setup, 2)
      setup.mockInput.pressKey("d", { ctrl: true })
      await renderSettled(setup, 6)
      setup.mockInput.pressEscape()
      await renderSettled(setup, 2)

      const text = captureText(setup)
      expect(text).toContain("route:home")
      expect(text).toContain("selection:build:eidolon/shell-default")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("continues from provider authentication into the provider model surface", async () => {
    const setup = await testRender(() => renderSurfaceHarness(() => <DialogConnectProvider />), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 6)
      expect(captureText(setup)).toContain("Connect a provider")

      setup.mockInput.pressEnter()
      await renderSettled(setup, 4)
      expect(captureText(setup)).toContain("API key")

      await setup.mockInput.typeText("sk-test")
      await renderSettled(setup, 2)
      setup.mockInput.pressEnter()
      await renderSettled(setup, 8)

      const text = captureText(setup)
      expect(text).toContain("Eidolon Starter")
      expect(text).toContain("Shell Default")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("writes agent changes back into the graph-backed current selection", async () => {
    const setup = await testRender(() => renderSurfaceHarness(() => <DialogAgent />), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 6)
      expect(captureText(setup)).toContain("Implement code changes and complete the task")

      setup.mockInput.pressArrow("down")
      await renderSettled(setup, 2)
      setup.mockInput.pressEnter()
      await renderSettled(setup, 4)

      const text = captureText(setup)
      expect(text).toContain("selection:plan:eidolon/shell-default")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("marks explicit model selections as user-explicit even when the model id is unchanged", async () => {
    const setup = await testRender(
      () => renderSurfaceHarness(() => <SetModelOnMount providerID="eidolon" modelID="shell-default" />),
      {
        width: 120,
        height: 40,
        kittyKeyboard: true,
      },
    )

    try {
      await renderSettled(setup, 6)

      expect(captureText(setup)).toContain("selection:build:eidolon/shell-default source:user-explicit")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("shows the current agent first in the selector list", async () => {
    const setup = await testRender(
      () =>
        renderSurfaceHarness(() => <DialogAgent />, {
          selection: {
            agent: "plan",
            providerID: "eidolon",
            modelID: "shell-default",
          },
        }),
      {
        width: 120,
        height: 40,
        kittyKeyboard: true,
      },
    )

    try {
      await renderSettled(setup, 6)

      const text = captureText(setup)
      expect(text.indexOf("plan")).toBeLessThan(text.indexOf("build"))
    } finally {
      setup.renderer.destroy()
    }
  })

  it("shows the same management surfaces in status that the palette exposes", async () => {
    const setup = await testRender(() => renderSurfaceHarness(() => <DialogStatus />), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 6)

      const text = captureText(setup)
      expect(text).toContain("Current Surface State")
      expect(text).toContain("Mock Session")
      expect(text).toContain("build · eidolon/shell-default")
      expect(text).toContain("Sessions")
      expect(text).toContain("Connect Provider")
      expect(text).toContain("/connect")
      expect(text).toContain("Models")
      expect(text).toContain("Agents")
      expect(text).toContain("MCP Servers")
      expect(text).toContain("/mcp")
      expect(text).toContain("Shortcuts")
      expect(text).toContain("Appearance")
      expect(countOccurrences(text, "[关闭(esc)]")).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("loads a session from the load button on the session surface", async () => {
    const setup = await testRender(() => renderSurfaceHarness(() => <HomeSessionSurface />), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 8)
      const initial = captureText(setup)
      expect(initial).toContain("route:home")
      expect(initial).toContain("Mock Session")

      await clickSpanOnLine(setup, "Mock Session", "[加载]")
      await renderSettled(setup, 6)

      const text = captureText(setup)
      expect(text).toContain("route:session:ses_1")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("confirms and applies runtime-control upgrade before loading an old session", async () => {
    const runtime = createTuiRuntimeClient({ mode: "mock" })
    const calls: string[] = []
    const client: TuiRuntimeSdk = {
      ...runtime,
      client: {
        ...runtime.client,
        session: {
          ...runtime.client.session,
          upgradeDryRun: async ({ sessionID } = {}) => {
            calls.push(`dry-run:${sessionID}`)
            return {
              data: {
                status: "dry_run",
                mode: "file-store",
                upgraded: false,
                hasCheckpoint: false,
                classification: "pending",
                blockers: [{ reason: "missing_commit_marker" }],
                canUpgrade: true,
                plannedHeads: { runtime_snapshot: 3 },
                upgrade: null,
                checkpointMarker: null,
              },
            }
          },
          upgradeApply: async ({ sessionID } = {}) => {
            calls.push(`apply:${sessionID}`)
            return {
              data: {
                status: "applied",
                mode: "file-store",
                dryRun: {
                  status: "dry_run",
                  mode: "file-store",
                  upgraded: false,
                  hasCheckpoint: false,
                  classification: "pending",
                  blockers: [{ reason: "missing_commit_marker" }],
                  canUpgrade: true,
                  plannedHeads: { runtime_snapshot: 3 },
                  upgrade: null,
                  checkpointMarker: null,
                },
                verification: {
                  classification: "clean",
                  blockers: [],
                },
              },
            }
          },
        },
      },
    }
    const setup = await testRender(() => renderSurfaceHarness(() => <HomeSessionSurface />, { client }), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 8)
      await clickSpanOnLine(setup, "Mock Session", "[加载]")
      await renderSettled(setup, 4)

      expect(captureText(setup)).toContain("升级旧会话")

      setup.mockInput.pressArrow("left")
      await renderSettled(setup, 1)
      setup.mockInput.pressEnter()
      await renderSettled(setup, 8)

      const text = captureText(setup)
      expect(text).toContain("route:session:ses_1")
      expect(calls).toEqual(["dry-run:ses_1", "apply:ses_1"])
    } finally {
      setup.renderer.destroy()
    }
  })
})
