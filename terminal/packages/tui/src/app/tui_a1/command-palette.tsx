/** @jsxImportSource @opentui/solid */
import { onCleanup, onMount, createMemo } from "solid-js"
import type { KeybindsConfig, Message, Part } from "@terminal/core/AIAgent"
import { COMMAND_ID, type CommandID } from "../../commands/catalog"
import { useExit } from "../../providers/exit"
import { useRuntimeClient } from "../../providers/runtime-client"
import { useCommandDialog, type CommandOption } from "../../ui/primitives/dialog-command"
import { useDialog } from "../../ui/dialog/context"
import { useToast } from "../../ui/toast/toast"
import { getCommandSlashSummary, getTuiA1SystemSurfaceEntries } from "./system/system-surface-registry"
import { DialogMessageList } from "./system/message/message-list-dialog"
import { DialogSessionRename } from "./system/session/session-rename-dialog"
import { useRoute } from "./route/route-context"
import { Clipboard } from "../../support/util/clipboard"
import { runtimeMessagesToTuiA1Messages } from "./data"

type TuiA1PaletteAction = {
  command: CommandID
  title: string
  category: string
  keybind?: keyof KeybindsConfig
  suggested?: boolean
  run: () => void | Promise<void>
}

function safeUseRoute() {
  try {
    return useRoute()
  } catch {
    return {
      data: { type: "home" as const },
      navigate() {},
    } as ReturnType<typeof useRoute>
  }
}

function transcriptText(messages: Array<{ info: Message; parts?: unknown[] }>) {
  return messages
    .map((entry) => {
      const parts = entry.parts ?? []
      const body = parts
        .map((part) => {
          if (!part || typeof part !== "object") return ""
          const value = part as Record<string, unknown>
          if (value["type"] === "text") return typeof value["text"] === "string" ? value["text"] : ""
          if (value["type"] === "tool") return `[tool ${String(value["tool"] ?? "call")}]`
          return ""
        })
        .filter(Boolean)
        .join("\n")
      return `${entry.info.role}: ${body}`.trim()
    })
    .filter(Boolean)
    .join("\n\n")
}

export function TuiA1CommandPaletteSurface() {
  const dialog = useDialog()
  const command = useCommandDialog()
  const runtime = useRuntimeClient()
  const toast = useToast()
  const route = safeUseRoute()
  const exit = useExit()

  const activeSessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)

  const withSession = async (run: (sessionID: string) => Promise<void> | void) => {
    const sessionID = activeSessionID()
    if (!sessionID) {
      toast.show({ message: "No active session", variant: "warning" })
      return
    }
    await run(sessionID)
  }

  const actions = createMemo<TuiA1PaletteAction[]>(() =>
    [
      ...getTuiA1SystemSurfaceEntries().map((entry) => ({
        command: entry.command,
        title: entry.title,
        category: entry.category,
        keybind: entry.keybind,
        suggested: entry.suggested,
        run: () => dialog.replace(entry.render),
      })),
      {
        command: COMMAND_ID.SessionNew,
        title: "New session",
        category: "Session",
        keybind: "session_new",
        run: async () => {
          const created = await runtime.client.session.create({})
          if (created.data?.id) {
            route.navigate({ type: "session", sessionID: created.data.id })
          }
        },
      },
      {
        command: COMMAND_ID.SessionRename,
        title: "Rename session",
        category: "Session",
        run: () => withSession((sessionID) => dialog.replace(() => <DialogSessionRename session={sessionID} />)),
      },
      {
        command: COMMAND_ID.SessionTimeline,
        title: "Session timeline",
        category: "Session",
        keybind: "session_timeline",
        run: () =>
          withSession(async (sessionID) => {
            const result = await runtime.client.session.messages({ sessionID })
            const entries = result.data ?? []
            dialog.replace(() => (
              <DialogMessageList
                messages={runtimeMessagesToTuiA1Messages(
                  entries.map((entry) => entry.info),
                  Object.fromEntries(entries.map((entry) => [entry.info.id, (entry.parts ?? []) as Part[]])),
                )}
                sessionID={sessionID}
              />
            ))
          }),
      },
      {
        command: COMMAND_ID.SessionFork,
        title: "Fork session",
        category: "Session",
        run: () =>
          withSession(async (sessionID) => {
            const result = await runtime.client.session.fork({ sessionID })
            if (result.data?.id) {
              route.navigate({ type: "session", sessionID: result.data.id })
            }
          }),
      },
      {
        command: COMMAND_ID.SessionCompact,
        title: "Compact session",
        category: "Session",
        keybind: "session_compact",
        run: () =>
          withSession(async (sessionID) => {
            const result = await runtime.client.session.summarize({ sessionID })
            const payload = result.data as { ok?: boolean; message?: string } | undefined
            toast.show({
              message: payload?.message || (payload?.ok === false ? "Session compact failed" : "Session compacted"),
              variant: payload?.ok === false ? "error" : "success",
            })
          }),
      },
      {
        command: COMMAND_ID.SessionCopy,
        title: "Copy session transcript",
        category: "Session",
        run: () =>
          withSession(async (sessionID) => {
            const result = await runtime.client.session.messages({ sessionID })
            await Clipboard.copy(transcriptText(result.data ?? []))
            toast.show({ message: "Copied session transcript", variant: "success" })
          }),
      },
      {
        command: COMMAND_ID.SessionExport,
        title: "Export transcript",
        category: "Session",
        keybind: "session_export",
        run: () => toast.show({ message: "Transcript export is not available in this TUI yet", variant: "warning" }),
      },
      {
        command: COMMAND_ID.SessionUndo,
        title: "Undo last turn",
        category: "Session",
        run: () =>
          withSession(async (sessionID) => {
            const result = await runtime.client.session.messages({ sessionID })
            const messages = (result.data ?? []).map((entry) => entry.info)
            const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user")
            const cutoff = messages[lastUserIndex - 1]
            if (!cutoff) {
              toast.show({ message: "Nothing to undo", variant: "info" })
              return
            }
            await runtime.client.session.revert({ sessionID, messageID: cutoff.id })
          }),
      },
      {
        command: COMMAND_ID.SessionRedo,
        title: "Redo last undo",
        category: "Session",
        run: () => withSession((sessionID) => runtime.client.session.unrevert({ sessionID })),
      },
      {
        command: COMMAND_ID.SessionToggleThinking,
        title: "Toggle thinking visibility",
        category: "Session",
        run: () => toast.show({ message: "Thinking visibility toggle is not available in this TUI yet", variant: "warning" }),
      },
      {
        command: COMMAND_ID.AppExit,
        title: "Exit app",
        category: "System",
        keybind: "app_exit",
        run: () => exit(),
      },
    ],
  )

  onMount(() => {
    command.register(() =>
      actions().map<CommandOption>((item) => ({
        value: item.command,
        title: item.title,
        category: item.category,
        description: getCommandSlashSummary(item.command),
        keybind: item.keybind,
        suggested: item.suggested,
        onSelect: () => {
          Promise.resolve(item.run()).catch(toast.error)
        },
      })),
    )

    const unsubscribeCommand = runtime.event.on("tui.command.execute", (event) => {
      const commandID = event.properties?.command
      if (typeof commandID !== "string") return
      command.trigger(commandID)
    })

    const unsubscribeToast = runtime.event.on("tui.toast.show", (event) => {
      const input = event.properties
      if (!input || typeof input.message !== "string") return
      toast.show({
        title: typeof input.title === "string" ? input.title : undefined,
        message: input.message,
        variant:
          input.variant === "success" || input.variant === "warning" || input.variant === "error" ? input.variant : "info",
        duration: typeof input.duration === "number" ? input.duration : undefined,
      })
    })

    onCleanup(() => {
      unsubscribeCommand()
      unsubscribeToast()
    })
  })

  return null
}
