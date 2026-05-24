import { onCleanup, onMount, createMemo } from "solid-js"
import type { KeybindsConfig } from "@terminal/core/AIAgent"
import { type CommandID } from "../../commands/catalog"
import { useRuntimeClient } from "../../providers/runtime-client"
import { useCommandDialog, type CommandOption } from "../../ui/primitives/dialog-command"
import { useDialog } from "../../ui/dialog/context"
import { useToast } from "../../ui/toast/toast"
import { getCommandSlashSummary, getTuiA1SystemSurfaceEntries } from "./system/system-surface-registry"

type TuiA1PaletteAction = {
  command: CommandID
  title: string
  category: string
  keybind?: keyof KeybindsConfig
  suggested?: boolean
  run: () => void
}

export function TuiA1CommandPaletteSurface() {
  const dialog = useDialog()
  const command = useCommandDialog()
  const runtime = useRuntimeClient()
  const toast = useToast()

  const actions = createMemo<TuiA1PaletteAction[]>(() =>
    getTuiA1SystemSurfaceEntries().map((entry) => ({
      command: entry.command,
      title: entry.title,
      category: entry.category,
      keybind: entry.keybind,
      suggested: entry.suggested,
      run: () => dialog.replace(entry.render),
    })),
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
          item.run()
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
