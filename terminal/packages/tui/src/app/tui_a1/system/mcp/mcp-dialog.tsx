import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../../state/local-context"
import { useSync } from "../../state/sync-context"
import { map, pipe, entries, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "../../../../ui/dialog/select"
import { useTheme } from "../../../../providers/theme"
import { Keybind } from "../../../../support/util/keybind"
import { TextAttributes } from "@opentui/core"
import { useToast } from "../../../../ui/toast/toast"

function Status(props: { enabled: boolean; loading: boolean }) {
  const { theme } = useTheme()
  if (props.loading) {
    return <span style={{ fg: theme.textMuted }}>⋯ Loading</span>
  }
  if (props.enabled) {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Enabled</span>
  }
  return <span style={{ fg: theme.textMuted }}>○ Disabled</span>
}

export function DialogMcp() {
  const local = useLocal()
  const sync = useSync()
  const toast = useToast()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)

  const options = createMemo(() => {
    // Track sync data and loading state to trigger re-render when they change
    const mcpData = sync.data.mcp
    const loadingMcp = loading()

    return pipe(
      mcpData ?? {},
      entries(),
      sortBy(([name]) => name),
      map(([name, status]) => ({
        value: name,
        title: name,
        description: status.status === "failed" ? "failed" : status.status,
        footer: <Status enabled={local.mcp.isEnabled(name)} loading={loadingMcp === name} />,
        category: undefined,
      })),
    )
  })

  const runAction = async (name: string, action: () => Promise<unknown>, successMessage: string) => {
    if (loading() !== null) return
    setLoading(name)
    try {
      await action()
      toast.show({
        message: successMessage,
        variant: "success",
        duration: 2500,
      })
    } catch (error) {
      toast.show({
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
        duration: 3000,
      })
    } finally {
      setLoading(null)
    }
  }

  const keybinds = createMemo(() => [
    {
      keybind: Keybind.parse("space")[0],
      title: "toggle",
      onTrigger: async (option: DialogSelectOption<string>) => {
        await runAction(
          option.value,
          () => local.mcp.toggle(option.value),
          local.mcp.isEnabled(option.value) ? `Disabled ${option.value}` : `Enabled ${option.value}`,
        )
      },
    },
    {
      keybind: Keybind.parse("ctrl+r")[0],
      title: "reconnect",
      onTrigger: async (option: DialogSelectOption<string>) => {
        await runAction(option.value, () => local.mcp.reconnect(option.value), `Reconnected ${option.value}`)
      },
    },
  ])

  return (
    <DialogSelect
      ref={setRef}
      title="MCP Servers"
      options={options()}
      keybind={keybinds()}
      onSelect={() => {}}
    />
  )
}
