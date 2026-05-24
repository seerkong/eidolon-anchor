import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../providers/theme"
import { DialogHeader, useDialog } from "./context"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "../../providers/keybind"
import { Tips } from "../primitives/tips"

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()

  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") {
      dialog.clear()
    }
  })

  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <DialogHeader title="Help" showClose={false} />
      <box paddingBottom={1} flexDirection="column" gap={1}>
        <text fg={theme.text}>
          <b>Core surfaces</b>
        </text>
        <text fg={theme.textMuted}>
          Press {keybind.print("command_list")} to open the command palette for sessions, models, providers, MCP and system actions.
        </text>
        <text fg={theme.textMuted}>
          Use {keybind.print("status_view")} or /status for system facts, {keybind.print("session_list")} or /session for saved sessions, and {keybind.print("model_list")} or /models for model selection.
        </text>
        <text fg={theme.textMuted}>
          Use {keybind.print("shortcuts_view")} or /shortcuts for the categorized key binding guide, and use the bottom bar 使用说明 button when you want to inspect everything without leaving the shell.
        </text>
        <text fg={theme.textMuted}>
          Use {keybind.print("theme_list")} or /theme to adjust appearance, and /help or the command palette to reopen this guide.
        </text>
      </box>
      <box paddingBottom={1} flexDirection="column" gap={1}>
        <text fg={theme.text}>
          <b>Prompt and history</b>
        </text>
        <text fg={theme.textMuted}>Use /actor, /member and /holon for the current shortcut command families.</text>
        <text fg={theme.textMuted}>Press shift+enter to insert a newline without sending the prompt, and use ctrl+shift+l to clear the current draft.</text>
        <text fg={theme.textMuted}>Use PageUp / PageDown / Home / End to browse history, then click the composer to return input focus without losing draft text.</text>
      </box>
      <box paddingBottom={1} flexDirection="column" gap={1}>
        <text fg={theme.text}>
          <b>Tip of the moment</b>
        </text>
        <Tips />
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <text
          fg={theme.secondary}
          attributes={TextAttributes.BOLD}
          onMouseUp={(evt) => {
            evt.stopPropagation()
            dialog.clear()
          }}
        >
          [确认]
        </text>
      </box>
    </box>
  )
}
