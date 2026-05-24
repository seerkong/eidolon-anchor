import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { For, createMemo, onMount } from "solid-js"
import { useTheme } from "../../../../providers/theme"
import { useKeybind } from "../../../../providers/keybind"
import { DialogHeader, useDialog } from "../../../../ui/dialog/context"
import { Keybind } from "../../../../support/util/keybind"
import { shortcutCatalog, type ShortcutCategory } from "./shortcut-catalog"

type ShortcutRow = {
  id: string
  label: string
  detail: string
  keys: string
}

type ShortcutSection = {
  category: ShortcutCategory
  entries: ShortcutRow[]
}

const categoryOrder: ShortcutCategory[] = [
  "System",
  "Session",
  "History",
  "Composer",
  "Models",
  "File Picker",
  "Terminal",
]

function byCategoryOrder(left: ShortcutSection, right: ShortcutSection) {
  return categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category)
}

export function DialogShortcuts() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()
  let scroll: ScrollBoxRenderable | undefined

  const formatBindings = (configKey: string) => {
    const entries = keybind.all[configKey] ?? []
    const leader = keybind.all["leader"]?.[0]
    if (entries.length === 0) return "unbound"
    return entries
      .map((entry) => {
        const rendered = Keybind.toString(entry)
        if (!leader) return rendered
        return rendered.replace("<leader>", Keybind.toString(leader))
      })
      .join(" / ")
  }

  const sections = createMemo<ShortcutSection[]>(() => {
    const grouped = new Map<ShortcutCategory, ShortcutRow[]>()

    for (const item of shortcutCatalog) {
      const keys = item.keybind ? formatBindings(item.keybind) : item.combos?.join(" / ") ?? "unbound"
      if (keys === "unbound") continue
      const list = grouped.get(item.category) ?? []
      list.push({
        id: item.id,
        label: item.label,
        detail: item.detail,
        keys,
      })
      grouped.set(item.category, list)
    }

    return [...grouped.entries()]
      .map(([category, entries]) => ({ category, entries }))
      .sort(byCategoryOrder)
  })

  onMount(() => {
    dialog.setSize("xlarge")
  })

  useKeyboard((evt) => {
    if (evt.name === "escape" || evt.name === "return" || evt.name === "linefeed" || evt.name === "kpenter") {
      evt.preventDefault()
      evt.stopPropagation()
      dialog.clear()
      return
    }
    if (evt.name === "up") {
      evt.preventDefault()
      scroll?.scrollBy(-1)
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      scroll?.scrollBy(1)
      return
    }
    if (evt.name === "pageup") {
      evt.preventDefault()
      scroll?.scrollBy(-Math.max(6, Math.floor((scroll?.height ?? 12) / 2)))
      return
    }
    if (evt.name === "pagedown") {
      evt.preventDefault()
      scroll?.scrollBy(Math.max(6, Math.floor((scroll?.height ?? 12) / 2)))
      return
    }
    if (evt.name === "home") {
      evt.preventDefault()
      scroll?.scrollTo(0)
      return
    }
    if (evt.name === "end") {
      evt.preventDefault()
      scroll?.scrollTo(scroll?.scrollHeight ?? 0)
    }
  })

  return (
    <box flexDirection="column" height="100%" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <DialogHeader title="Shortcuts" showClose={false} />

      <text fg={theme.textMuted}>Browse the active key bindings by category. Use mouse wheel or ↑↓ / PgUp PgDn to scroll.</text>

      <box flexGrow={1} minHeight={0}>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => {
          scroll = value
        }}
        height="100%"
        scrollY={true}
        scrollX={false}
        paddingRight={1}
        scrollbarOptions={{ visible: false }}
      >
        <box flexDirection="column" gap={1} paddingBottom={1}>
          <For each={sections()}>
            {(section) => (
              <box flexDirection="column" gap={1}>
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                  {section.category}
                </text>
                <For each={section.entries}>
                  {(entry) => (
                    <box flexDirection="column" paddingLeft={1}>
                      <box flexDirection="row" justifyContent="space-between" gap={2}>
                        <text fg={theme.text}>
                          <b>{entry.label}</b>
                        </text>
                        <text fg={theme.secondary}>{entry.keys}</text>
                      </box>
                      <text fg={theme.textMuted} wrapMode="word">
                        {entry.detail}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
      </box>

      <box flexDirection="row" justifyContent="flex-end">
        <text
          fg={theme.secondary}
          attributes={TextAttributes.BOLD}
          onMouseUp={(evt) => {
            evt.stopPropagation()
            dialog.clear()
          }}
        >
          [关闭(esc)]
        </text>
      </box>
    </box>
  )
}
