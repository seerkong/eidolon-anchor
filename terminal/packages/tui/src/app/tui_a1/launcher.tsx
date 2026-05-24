import { render } from "@opentui/solid"
import { parseModelRef, type TuiRuntimeSdk } from "@terminal/core/AIAgent"
import type { Args } from "../../providers/args"
import { RuntimeClientProvider, useRuntimeClient } from "../../providers/runtime-client"
import {
  configureTuiStreamDiagnostics,
  flushTuiStreamDiagnostics,
  traceStreamDiagnosticSession,
} from "../../support/util/stream-diagnostics"
import { defaultTuiA1Selection, type TuiA1Selection } from "./data"
import { TuiA1Shell } from "./shell"

type TuiA1Input = {
  args: Partial<Args>
  directory?: string
  onExit?: () => Promise<void>
}

export async function tuiA1Tui(input: TuiA1Input) {
  const directory = input.directory ?? process.cwd()
  const scrollModeOverride = process.env.EIDOLON_TUI_SCROLL_MODE
  const prefersAlternateScroll =
    scrollModeOverride === "alternate" ||
    (scrollModeOverride !== "mouse" &&
      (process.env.TERM_PROGRAM === "iTerm.app" || Boolean(process.env.ITERM_SESSION_ID)))
  const parsedModel = parseModelRef(input.args.model)
  const selection: TuiA1Selection = {
    agent: input.args.agent?.trim() || defaultTuiA1Selection.agent,
    providerID: parsedModel?.providerID || defaultTuiA1Selection.providerID,
    modelID: parsedModel?.modelID || defaultTuiA1Selection.modelID,
  }
  const selectionOverride = {
    agent: Boolean(input.args.agent?.trim()),
    model: Boolean(parsedModel),
  }

  configureTuiStreamDiagnostics({
    workDir: directory,
    sessionID: input.args.sessionID,
  })
  if (input.args.sessionID) {
    traceStreamDiagnosticSession(input.args.sessionID, {
      source: "tui_a1.start",
    })
  }

  let runtimeForCleanup: TuiRuntimeSdk | undefined

  function TuiA1RuntimeRoot() {
    const runtime = useRuntimeClient()
    runtimeForCleanup = runtime as unknown as TuiRuntimeSdk
    return (
      <TuiA1Shell
        args={input.args}
        continueSession={input.args.continue}
        directory={directory}
        initialPrompt={input.args.prompt}
        onExit={input.onExit}
        selection={selection}
        selectionOverride={selectionOverride}
        sessionID={input.args.sessionID}
        scrollMode={prefersAlternateScroll ? "alternate" : "mouse"}
      />
    )
  }

  await render(
    () => (
      <RuntimeClientProvider url="local-runtime" directory={directory}>
        <TuiA1RuntimeRoot />
      </RuntimeClientProvider>
    ),
    ({
      targetFps: 30,
      exitOnCtrlC: true,
      useAlternateScreen: true,
      useMouse: true,
      useKittyKeyboard: {},
      onDestroy: () => {
        void runtimeForCleanup?.client.instance.dispose()
        void flushTuiStreamDiagnostics()
        void input.onExit?.()
      },
    } as Parameters<typeof render>[1]),
  )
}
