/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "../../providers/theme"

const MARK = [
  ["■ ■ ■ ■", "EIDOLON"],
  ["■ ■ ■ ■", "terminal shell"],
]

export function Logo() {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={0}>
      <For each={MARK}>
        {([icon, label], index) => (
          <box flexDirection="row" gap={2}>
            <text fg={index() === 0 ? theme.primary : theme.border} selectable={false}>
              {icon}
            </text>
            <text
              fg={index() === 0 ? theme.text : theme.textMuted}
              attributes={index() === 0 ? TextAttributes.BOLD : TextAttributes.NONE}
              selectable={false}
            >
              {label}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}
