/** @jsxImportSource @opentui/solid */
import { render } from "@opentui/solid"
import { parseModelRef, type TuiRuntimeSdk } from "@terminal/core/AIAgent"
import type { Args } from "../../providers/args"
import { RuntimeClientProvider, useRuntimeClient } from "../../providers/runtime-client"
import {
  configureTuiStreamDiagnostics,
  flushTuiStreamDiagnostics,
  traceStreamDiagnosticSession,
} from "../../support/util/stream-diagnostics"
import { restoreTuiTerminalModes } from "../../support/util/terminal-restore"
import { defaultTuiA1Selection, type TuiA1Selection } from "./data"
import { TuiA1Shell } from "./shell"
import type { AttachmentResolverPort } from "@cell/ai-core-contract"

type TuiA1Input = {
  args: Partial<Args>
  directory?: string
  isAttachmentFile?: (candidate: string) => boolean
  attachmentResolver?: AttachmentResolverPort
  onExit?: () => Promise<void>
}

export function createTuiA1CleanupGate(cleanup: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    pending ??= cleanup()
    return pending
  }
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
    providerID: parsedModel?.providerID ?? "",
    modelID: parsedModel?.modelID ?? "",
    modelSource: parsedModel ? "cli-arg" : undefined,
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
  let keepAlive: ReturnType<typeof setInterval> | undefined
  let resolveDestroyed: (() => void) | undefined
  const destroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve
  })

  const cleanupAfterDestroy = createTuiA1CleanupGate(async () => {
    if (keepAlive) {
      clearInterval(keepAlive)
      keepAlive = undefined
    }
    await runtimeForCleanup?.client.instance.dispose().catch(() => {})
    await flushTuiStreamDiagnostics().catch(() => {})
    await input.onExit?.().catch(() => {})
    restoreTuiTerminalModes()
    resolveDestroyed?.()
  })

  function TuiA1RuntimeRoot() {
    const runtime = useRuntimeClient()
    runtimeForCleanup = runtime as unknown as TuiRuntimeSdk
    return (
      <TuiA1Shell
        args={input.args}
        continueSession={input.args.continue}
        directory={directory}
        initialPrompt={input.args.prompt}
        isAttachmentFile={input.isAttachmentFile}
        attachmentResolver={input.attachmentResolver}
        onExit={cleanupAfterDestroy}
        selection={selection}
        selectionOverride={selectionOverride}
        sessionID={input.args.sessionID}
        scrollMode={prefersAlternateScroll ? "alternate" : "mouse"}
      />
    )
  }

  try {
    keepAlive = setInterval(() => {}, 1000)
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
          void cleanupAfterDestroy()
        },
      } as Parameters<typeof render>[1]),
    )
    await destroyed
  } finally {
    if (keepAlive) {
      clearInterval(keepAlive)
      keepAlive = undefined
    }
    restoreTuiTerminalModes()
  }
}
