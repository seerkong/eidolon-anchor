/** @jsxImportSource @opentui/solid */
import { useTheme } from "../../../../providers/theme"
import { useSync } from "../../state/sync-context"
import { useGraphSignal } from "depa-data-graph-solid"
import { For, Match, Show, Switch, createMemo, type JSX } from "solid-js"
import { useKeybind } from "../../../../providers/keybind"
import { useTuiA1StateOptional } from "../../state/state-context"
import type { TuiA1Selection } from "../../data"
import type { Route } from "../../route/route"
import {
  getCommandSlashSummary,
  getTuiA1ManagementSurfaceEntries,
} from "../system-surface-registry"
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { DialogHeader, useDialog } from "../../../../ui/dialog/context"

export type DialogStatusProps = {}

type PluginRow = {
  name: string
  version?: string
}

function Section(props: { title: string; children: JSX.Element }) {
  const { theme } = useTheme()

  return (
    <box flexDirection="column">
      <text fg={theme.text}>
        <b>{props.title}</b>
      </text>
      <box flexDirection="column" paddingLeft={1}>
        {props.children}
      </box>
    </box>
  )
}

export function DialogStatus() {
  const dialog = useDialog()
  const sync = useSync()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const tuiA1State = useTuiA1StateOptional()
  const route = tuiA1State
    ? useGraphSignal<Route, undefined>(tuiA1State.stateGraph.graph, "route")
    : (() => undefined)
  const selection = tuiA1State
    ? useGraphSignal<TuiA1Selection, undefined>(tuiA1State.stateGraph.graph, "selection")
    : (() => undefined)

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))
  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp))
  const connectedMcpCount = createMemo(() => mcpEntries().filter(([, item]) => item.status === "connected").length)
  const configTheme = createMemo(() => sync.data.config.theme || "eidolon-flat")
  const defaultModel = createMemo(() => sync.data.config.model || "not configured")
  const surfaceEntries = createMemo(() => getTuiA1ManagementSurfaceEntries())
  const scrollAcceleration = createMemo(() =>
    sync.data.config.tui?.scroll_acceleration?.enabled === false ? "disabled" : "enabled",
  )
  const shortcutRows = createMemo(() => [
    { label: "Commands", key: keybind.print("command_list"), detail: "open all available actions" },
    { label: "Status", key: keybind.print("status_view"), detail: "open this system facts surface" },
    ...surfaceEntries().map((entry) => ({
      label: entry.title,
      key: entry.keybind ? keybind.print(entry.keybind) : getCommandSlashSummary(entry.command) || entry.command,
      detail: entry.detail,
    })),
  ])
  const currentRoute = createMemo(() => route())
  const currentSelection = createMemo(() => selection())
  const currentSession = createMemo(() => {
    const value = currentRoute()
    if (!value || value.type !== "session") return undefined
    return sync.session.get(value.sessionID)
  })
  const currentSessionLabel = createMemo(() => {
    const value = currentRoute()
    if (!value) return "Unavailable outside tui_a1 shell"
    if (value.type !== "session") return "Home"
    return currentSession()?.title ?? value.sessionID
  })
  const currentSelectionLabel = createMemo(() => {
    const value = currentSelection()
    if (!value) return defaultModel()
    return `${value.agent} · ${value.providerID}/${value.modelID}`
  })

  const plugins = createMemo(() => {
    const list = sync.data.config.plugin ?? []
    const result: PluginRow[] = list.flatMap((value): PluginRow[] => {
      if (typeof value !== "string") return []
      if (value.startsWith("file://")) {
        const path = value.substring("file://".length)
        const parts = path.split("/")
        const filename = parts.pop() || path
        if (!filename.includes(".")) return [{ name: filename }]
        const basename = filename.split(".")[0]
        if (basename === "index") {
          const dirname = parts.pop()
          const name = dirname || basename
          return [{ name }]
        }
        return [{ name: basename }]
      }
      const index = value.lastIndexOf("@")
      if (index <= 0) return [{ name: value, version: "latest" }]
      const name = value.substring(0, index)
      const version = value.substring(index + 1)
      return [{ name, version }]
    })
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  })

  let scroll: ScrollBoxRenderable | undefined

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
  })

  return (
    <box height="100%" flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <DialogHeader title="Status" showClose={false} />
      <box flexGrow={1} minHeight={0}>
        <scrollbox
          ref={(value: ScrollBoxRenderable) => {
            scroll = value
          }}
          height="100%"
          scrollY={true}
          scrollX={false}
          scrollbarOptions={{ visible: false }}
        >
          <box flexDirection="column">
            <Section title="System Facts">
              <text fg={theme.text}>
                Runtime <span style={{ fg: theme.textMuted }}>· {sync.data.status}</span>
              </text>
              <text fg={theme.text}>
                Theme <span style={{ fg: theme.textMuted }}>· {configTheme()}</span>
              </text>
              <text fg={theme.text}>
                Default model <span style={{ fg: theme.textMuted }}>· {defaultModel()}</span>
              </text>
              <text fg={theme.text}>
                Scroll acceleration <span style={{ fg: theme.textMuted }}>· {scrollAcceleration()}</span>
              </text>
              <Show when={sync.data.path.directory}>
                <text fg={theme.text}>
                  Workspace <span style={{ fg: theme.textMuted }}>{sync.data.path.directory}</span>
                </text>
              </Show>
            </Section>
            <Section title="Current Surface State">
              <text fg={theme.text}>
                Session <span style={{ fg: theme.textMuted }}>· {currentSessionLabel()}</span>
              </text>
              <text fg={theme.text}>
                Selection <span style={{ fg: theme.textMuted }}>· {currentSelectionLabel()}</span>
              </text>
            </Section>
            <Section title="Surface Shortcuts">
              <For each={shortcutRows()}>
                {(item) => (
            <text fg={theme.text}>
              <b>{item.label}</b> <span style={{ fg: theme.textMuted }}>{item.key || "unbound"} · {item.detail}</span>
            </text>
                )}
              </For>
            </Section>
            <Section title="Connected Services">
              <text fg={theme.text}>
                MCP <span style={{ fg: theme.textMuted }}>· {connectedMcpCount()}/{mcpEntries().length || 0} connected</span>
              </text>
              <text fg={theme.text}>
                Formatters <span style={{ fg: theme.textMuted }}>· {enabledFormatters().length} enabled</span>
              </text>
              <text fg={theme.text}>
                Plugins <span style={{ fg: theme.textMuted }}>· {plugins().length} loaded</span>
              </text>
            </Section>
            <Show when={mcpEntries().length > 0} fallback={<text fg={theme.textMuted}>No MCP servers configured</text>}>
              <Section title="MCP Detail">
                <For each={mcpEntries()}>
                  {([key, item]) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: (
                      {
                        connected: theme.success,
                        failed: theme.error,
                        disabled: theme.textMuted,
                        needs_auth: theme.warning,
                        needs_client_registration: theme.error,
                      } as Record<string, typeof theme.success>
                    )[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{key}</b>{" "}
                  <span style={{ fg: theme.textMuted }}>
                    <Switch fallback={item.status}>
                      <Match when={item.status === "connected"}>Connected</Match>
                      <Match when={item.status === "failed" && item}>{(val: () => { error?: string }) => val().error}</Match>
                      <Match when={item.status === "disabled"}>Disabled in configuration</Match>
                      <Match when={(item.status as string) === "needs_auth"}>Needs authentication (run: eidolon mcp auth {key})</Match>
                      <Match when={(item.status as string) === "needs_client_registration" && item}>
                        {(val: () => { error?: string }) => val().error}
                      </Match>
                    </Switch>
                  </span>
                </text>
              </box>
                  )}
                </For>
              </Section>
            </Show>
            <Show when={enabledFormatters().length > 0} fallback={<text fg={theme.textMuted}>No formatters enabled</text>}>
              <Section title="Formatter Detail">
                <For each={enabledFormatters()}>
                  {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                </text>
              </box>
                  )}
                </For>
              </Section>
            </Show>
            <Show when={plugins().length > 0} fallback={<text fg={theme.textMuted}>No plugins loaded</text>}>
              <Section title="Plugin Detail">
                <For each={plugins()}>
                  {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                  {item.version && <span style={{ fg: theme.textMuted }}> @{item.version}</span>}
                </text>
              </box>
                  )}
                </For>
              </Section>
            </Show>
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
