/** @jsxImportSource @opentui/solid */
import type { TuiRuntimeSdk } from "@terminal/core/AIAgent"
import type { Args } from "../../providers/args"
import { ArgsProvider } from "../../providers/args"
import { ExitProvider } from "../../providers/exit"
import { KeybindProvider } from "../../providers/keybind"
import { KVProvider } from "../../providers/kv"
import { RuntimeClientProvider, useRuntimeClient } from "../../providers/runtime-client"
import { ThemeProvider } from "../../providers/theme"
import { DialogProvider, useDialog } from "../../ui/dialog/context"
import { CommandProvider } from "../../ui/primitives/dialog-command"
import { Toast, ToastProvider } from "../../ui/toast/toast"
import { TuiA1CommandPaletteSurface } from "./command-palette"
import { FrecencyProvider } from "./perf/frecency"
import { RouteProvider } from "./route/route-context"
import { LocalProvider } from "./state/local-context"
import { SyncProvider } from "./state/sync-context"
import { TuiA1StateProvider } from "./state/state-context"
import { PromptHistoryProvider } from "./features/composer/model/prompt-history"
import {
  DialogQuestionnaireCenter,
  TuiA1View,
  type TuiA1ViewProps,
} from "./view"

export type TuiA1ShellProps = Omit<TuiA1ViewProps, "runtime"> & {
  args?: Partial<Args>
  onExit?: () => Promise<void>
}

function TuiA1ShellBody(props: TuiA1ShellProps & { runtime: TuiRuntimeSdk }) {
  const dialog = useDialog()

  return (
    <>
      <TuiA1CommandPaletteSurface />
      <TuiA1View
        {...props}
        runtime={props.runtime}
        onOpenQuestionnaires={(center) => {
          dialog.replace(() => <DialogQuestionnaireCenter entries={center.entries} />)
        }}
      />
      <Toast />
    </>
  )
}

export function TuiA1Shell(props: TuiA1ShellProps) {
  const runtime = useRuntimeClient()
  const args = props.args ?? {}

  return (
    <ArgsProvider
      agent={args.agent}
      continue={args.continue}
      model={args.model}
      prompt={args.prompt}
      sessionID={args.sessionID}
    >
      <ExitProvider onExit={props.onExit}>
        <KVProvider>
          <ToastProvider>
            <SyncProvider>
              <ThemeProvider mode="dark">
                <KeybindProvider>
                  <TuiA1StateProvider
                    runtimeEnabled={true}
                    initialMessages={props.initialMessages}
                    initialPrompt={props.initialPrompt}
                    selection={props.selection}
                    sessionID={props.sessionID}
                  >
                    <RouteProvider>
                      <LocalProvider>
                        <PromptHistoryProvider>
                          <FrecencyProvider>
                            <DialogProvider>
                              <CommandProvider>
                                <TuiA1ShellBody {...props} runtime={runtime as unknown as TuiRuntimeSdk} />
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
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  )
}

export function TuiA1RuntimeClientShell(props: TuiA1ShellProps & { directory: string }) {
  return (
    <RuntimeClientProvider url="local-runtime" directory={props.directory}>
      <TuiA1Shell {...props} />
    </RuntimeClientProvider>
  )
}
