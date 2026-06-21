/** @jsxImportSource @opentui/solid */
// Sessions is intentionally a custom dense surface rather than a generic DialogSelect.
// Keep vertical chrome, padding, hover color, and per-row metadata extremely compact so
// users can scan many sessions at once without scrolling.
import { InputRenderable, RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { Session, SessionUpgradeDryRunResult } from "@terminal/core/AIAgent"
import { useDialog } from "../../../../ui/dialog/context"
import { DialogAlert } from "../../../../ui/dialog/alert"
import { DialogConfirm } from "../../../../ui/dialog/confirm"
import { useRoute } from "../../route/route-context"
import { useSync } from "../../state/sync-context"
import { createEffect, createMemo, createResource, createSignal, For, on, onMount, Show } from "solid-js"
import { Locale } from "../../../../support/util/locale"
import { useTheme } from "../../../../providers/theme"
import { useRuntimeClient } from "../../../../providers/runtime-client"
import { DialogSessionRename } from "./session-rename-dialog"
import { useKV } from "../../../../providers/kv"
import { createDebouncedSignal } from "../../../../support/util/signal"
import "opentui-spinner/solid"

const SESSION_TIME_WIDTH = 18
const SESSION_INSET = 1
const SESSION_ACTION_WIDTH = 40

function sortSessionsByUpdated(sessions: Session[]) {
  return [...sessions].sort((a, b) => b.time.updated - a.time.updated)
}

type SessionOption = {
  id: string
  name: string
  input: string
  output: string
  created: string
  updated: string
  deleting: boolean
  working: boolean
  upgrading: boolean
}

function compactPreview(text: string | undefined, fallback: string, limit: number) {
  return Locale.truncate((text ?? "").replace(/\s+/g, " ").trim() || fallback, limit)
}

function compactRaw(text: string | undefined) {
  return (text ?? "").replace(/\s+/g, " ").trim()
}

function moveIndex(current: number, direction: number, total: number) {
  if (total <= 0) return 0
  let next = current + direction
  if (next < 0) next = total - 1
  if (next >= total) next = 0
  return next
}

function formatUpgradeBlockers(result: SessionUpgradeDryRunResult) {
  if (result.blockers.length === 0) return result.classification
  return result.blockers
    .slice(0, 3)
    .map((blocker) => {
      const reason = typeof blocker.reason === "string" ? blocker.reason : "unknown"
      const headId = typeof blocker.headId === "string" ? `:${blocker.headId}` : ""
      const effectId = typeof blocker.effectId === "string" ? `:${blocker.effectId}` : ""
      return `${reason}${headId}${effectId}`
    })
    .join(", ")
}

export function DialogSessionList() {
  const dialog = useDialog()
  const sync = useSync()
  const { theme } = useTheme()
  const route = useRoute()
  const sdk = useRuntimeClient()
  const kv = useKV()
  const dimensions = useTerminalDimensions()

  const [deleted, setDeleted] = createSignal<Set<string>>(new Set())
  const [selected, setSelected] = createSignal(0)
  const [filter, setFilter] = createSignal("")
  const [search, setSearch] = createDebouncedSignal("", 150)
  const [upgradingSessionID, setUpgradingSessionID] = createSignal<string | null>(null)

  const [searchResults] = createResource(search, async (query) => {
    if (!query) return undefined
    const result = await sdk.client.session.list({ search: query, limit: 30 })
    return result.data ?? []
  })

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

  const sessions = createMemo(() => (searchResults() ?? sync.data.session).filter((session) => !deleted().has(session.id)))
  const dialogTextWidth = createMemo(() => Math.max(20, Math.floor(dimensions().width * 0.9) - SESSION_INSET * 2))
  const previewLimit = createMemo(() => Math.max(16, dialogTextWidth() - SESSION_TIME_WIDTH - 1))
  const titleLimit = createMemo(() => Math.max(8, dialogTextWidth() - SESSION_ACTION_WIDTH - 16))
  const topLevelSessions = createMemo(() =>
    sortSessionsByUpdated(sync.data.session.filter((x) => x.parentID === undefined)),
  )

  const options = createMemo<SessionOption[]>(() =>
    sortSessionsByUpdated(sessions().filter((x) => x.parentID === undefined))
      .map((x) => {
        const status = sync.data.session_status?.[x.id]
        const initialMessage = compactRaw(x.preview?.initialUserMessage)
        const latestMessage = compactRaw(x.preview?.latestMessage)
        return {
          id: x.id,
          name: compactPreview(x.title, "Untitled", titleLimit()),
          input: Locale.truncate(initialMessage || "(No user message yet)", previewLimit()),
          output: latestMessage && latestMessage !== initialMessage ? Locale.truncate(latestMessage, previewLimit()) : "-",
          created: Locale.todayTimeOrDateTime(x.time.created),
          updated: Locale.todayTimeOrDateTime(x.time.updated),
          deleting: false,
          working: status?.type === "busy" || upgradingSessionID() === x.id,
          upgrading: upgradingSessionID() === x.id,
        }
      }),
  )

  const active = createMemo(() => options()[selected()])

  let input: InputRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined

  function scrollToSelected() {
    const option = active()
    if (!option) return
    scroll?.scrollChildIntoView(option.id)
  }

  function move(direction: number) {
    setSelected((current) => moveIndex(current, direction, options().length))
    queueMicrotask(scrollToSelected)
  }

  function confirmUpgrade(option: SessionOption, result: SessionUpgradeDryRunResult) {
    return new Promise<boolean>((resolve) => {
      dialog.replace(
        () => (
          <DialogConfirm
            title="升级旧会话"
            message={`会话 ${option.id} 缺少 runtime-control checkpoint。升级后将写入不可降级恢复标记，然后加载会话。Heads: ${Object.keys(result.plannedHeads).length}`}
            confirmLabel="[升级并加载]"
            cancelLabel="[取消]"
            onConfirm={() => resolve(true)}
            onCancel={() => resolve(false)}
          />
        ),
        () => resolve(false),
      )
    })
  }

  async function ensureSessionUpgradeReady(option: SessionOption) {
    setUpgradingSessionID(option.id)
    try {
      const dryRun = await sdk.client.session.upgradeDryRun({ sessionID: option.id })
      const result = dryRun.data
      if (!result) {
        await DialogAlert.show(dialog, "无法检查会话", "升级检查没有返回结果。")
        return false
      }
      if (result.upgraded || (result.hasCheckpoint && result.classification === "clean")) {
        return true
      }
      if (!result.canUpgrade) {
        await DialogAlert.show(dialog, "无法升级会话", formatUpgradeBlockers(result))
        return false
      }

      const confirmed = await confirmUpgrade(option, result)
      if (!confirmed) {
        dialog.replace(() => <DialogSessionList />)
        return false
      }

      const applied = await sdk.client.session.upgradeApply({ sessionID: option.id })
      if (applied.data?.status === "applied" || applied.data?.status === "already_upgraded") {
        return true
      }
      await DialogAlert.show(dialog, "无法升级会话", applied.data ? formatUpgradeBlockers(applied.data.dryRun) : "升级没有返回结果。")
      return false
    } catch (error) {
      await DialogAlert.show(dialog, "无法升级会话", error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setUpgradingSessionID(null)
    }
  }

  async function selectOption(option = active()) {
    if (!option) return
    if (!(await ensureSessionUpgradeReady(option))) return
    route.navigate({
      type: "session",
      sessionID: option.id,
    })
    dialog.clear()
  }

  function clearSearch() {
    setFilter("")
    setSearch("")
    setSelected(0)
    scroll?.scrollTo(0)
    if (input) input.value = ""
    input?.focus()
  }

  async function forkOption(option: SessionOption) {
    const result = await sdk.client.session.fork({
      sessionID: option.id,
    })
    if (!result.data) return
    route.navigate({
      type: "session",
      sessionID: result.data.id,
    })
    dialog.clear()
  }

  function renameOption(option: SessionOption) {
    dialog.replace(() => <DialogSessionRename session={option.id} />)
  }

  async function deleteOption(option = active()) {
    if (!option) return
    const deletingCurrent = currentSessionID() === option.id
    const fallback = topLevelSessions().find((session) => session.id !== option.id)

    await sdk.client.session.delete({
      sessionID: option.id,
    })
    setDeleted((current) => new Set([...current, option.id]))
    setSelected((current) => Math.min(current, Math.max(0, options().length - 2)))
    if (deletingCurrent) {
      route.navigate(
        fallback
          ? {
              type: "session",
              sessionID: fallback.id,
            }
          : {
              type: "home",
            },
      )
    }
  }

  createEffect(
    on(options, (list) => {
      if (selected() >= list.length) setSelected(Math.max(0, list.length - 1))
    }),
  )

  createEffect(
    on(currentSessionID, (id) => {
      if (!id) return
      const index = options().findIndex((option) => option.id === id)
      if (index >= 0) setSelected(index)
    }),
  )

  useKeyboard((event) => {
    if (event.name === "up" || (event.ctrl && event.name === "p")) {
      event.preventDefault()
      move(-1)
      return
    }
    if (event.name === "down" || (event.ctrl && event.name === "n")) {
      event.preventDefault()
      move(1)
      return
    }
    if (event.name === "pageup") {
      event.preventDefault()
      move(-8)
      return
    }
    if (event.name === "pagedown") {
      event.preventDefault()
      move(8)
      return
    }
    if (event.name === "return" || event.name === "linefeed" || event.name === "kpenter") {
      event.preventDefault()
      void selectOption()
      return
    }
    if (event.ctrl && event.name === "d") {
      event.preventDefault()
      void deleteOption()
      return
    }
    if (event.ctrl && event.name === "r") {
      event.preventDefault()
      const option = active()
      if (option) renameOption(option)
      return
    }
  })

  onMount(() => {
    dialog.setSize("large")
    dialog.setPaddingTop(0)
    setTimeout(() => input?.focus(), 1)
  })

  const rowBackground = (option: SessionOption, isActive: boolean) => {
    if (option.deleting) return theme.error
    if (isActive) return theme.backgroundElement
    return RGBA.fromInts(0, 0, 0, 0)
  }

  const rowPrimary = (isActive: boolean) => (isActive ? theme.text : theme.textMuted)
  const rowSecondary = (isActive: boolean) => (isActive ? theme.secondary : theme.textMuted)
  const actionText = (isActive: boolean) => (isActive ? theme.text : theme.secondary)

  return (
    <box flexDirection="column" height="100%" paddingTop={0} paddingBottom={0}>
      <box paddingLeft={SESSION_INSET} paddingRight={SESSION_INSET} height={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Sessions
        </text>
      </box>
      <box height={1} />
      <box paddingLeft={SESSION_INSET} paddingRight={SESSION_INSET} flexDirection="row" height={1}>
        <box flexGrow={1}>
          <input
            onInput={(value) => {
              setFilter(value)
              setSearch(value)
              setSelected(0)
              scroll?.scrollTo(0)
            }}
            focusedBackgroundColor={theme.backgroundPanel}
            cursorColor={theme.primary}
            focusedTextColor={theme.textMuted}
            ref={(value) => {
              input = value
            }}
            placeholder="Search"
          />
        </box>
        <text
          fg={theme.secondary}
          attributes={TextAttributes.BOLD}
          onMouseUp={(evt) => {
            evt.stopPropagation()
            clearSearch()
          }}
        >
          [清空]
        </text>
      </box>
      <box height={1} />
      <box flexGrow={1} minHeight={0}>
        <Show
          when={options().length > 0}
          fallback={
            <box height="100%" paddingLeft={SESSION_INSET} paddingRight={SESSION_INSET}>
              <text fg={theme.textMuted}>No sessions found{filter() ? ` for ${filter()}` : ""}</text>
            </box>
          }
        >
          <scrollbox
            ref={(value: ScrollBoxRenderable) => {
              scroll = value
            }}
            height="100%"
            paddingLeft={SESSION_INSET}
            paddingRight={SESSION_INSET}
            scrollbarOptions={{ visible: false }}
          >
            <For each={options()}>
              {(option, index) => {
                const isActive = createMemo(() => index() === selected())
                const isCurrent = createMemo(() => option.id === currentSessionID())
                return (
                  <box
                    id={option.id}
                    flexDirection="column"
                    height={3}
                    backgroundColor={rowBackground(option, isActive())}
                    paddingLeft={0}
                    paddingRight={0}
                    onMouseOver={() => {
                      setSelected(index())
                    }}
                  >
                    <box flexDirection="row" height={1}>
                      <Show when={option.working}>
                        <box flexShrink={0} width={1}>
                          <Show when={kv.get("animations_enabled", true)} fallback={<text fg={rowSecondary(isActive())}>⋯</text>}>
                            <spinner frames={spinnerFrames} interval={80} color={theme.primary} />
                          </Show>
                        </box>
                      </Show>
                      <text flexGrow={1} fg={rowPrimary(isActive())} attributes={isActive() ? TextAttributes.BOLD : undefined} overflow="hidden">
                        {isCurrent() && !option.working ? "● " : ""}{option.id} {option.name}
                      </text>
                      <box flexShrink={0} width={SESSION_ACTION_WIDTH} flexDirection="row" justifyContent="flex-end" gap={1}>
                        <text
                          fg={actionText(isActive())}
                          attributes={TextAttributes.BOLD}
                          onMouseUp={(evt) => {
                            evt.stopPropagation()
                            void selectOption(option)
                          }}
                        >
                          [加载]
                        </text>
                        <text
                          fg={actionText(isActive())}
                          attributes={TextAttributes.BOLD}
                          onMouseUp={(evt) => {
                            evt.stopPropagation()
                            void forkOption(option)
                          }}
                        >
                          [分叉会话]
                        </text>
                        <text
                          fg={actionText(isActive())}
                          attributes={TextAttributes.BOLD}
                          onMouseUp={(evt) => {
                            evt.stopPropagation()
                            renameOption(option)
                          }}
                        >
                          [重命名]
                        </text>
                        <text
                          fg={actionText(isActive())}
                          attributes={TextAttributes.BOLD}
                          onMouseUp={(evt) => {
                            evt.stopPropagation()
                            void deleteOption(option)
                          }}
                        >
                          [删除]
                        </text>
                      </box>
                    </box>
                    <box flexDirection="row" height={1} onMouseUp={() => void selectOption(option)}>
                      <text flexGrow={1} fg={rowSecondary(isActive())} overflow="hidden">
                        {option.input}
                      </text>
                      <box flexShrink={0} width={SESSION_TIME_WIDTH} flexDirection="row" justifyContent="flex-end">
                        <text fg={rowSecondary(isActive())} overflow="hidden">{option.created}</text>
                      </box>
                    </box>
                    <box flexDirection="row" height={1} onMouseUp={() => void selectOption(option)}>
                      <text flexGrow={1} fg={rowSecondary(isActive())} overflow="hidden">
                        {option.output}
                      </text>
                      <box flexShrink={0} width={SESSION_TIME_WIDTH} flexDirection="row" justifyContent="flex-end">
                        <text fg={rowSecondary(isActive())} overflow="hidden">{option.updated}</text>
                      </box>
                    </box>
                  </box>
                )
              }}
            </For>
          </scrollbox>
        </Show>
      </box>
      <box height={1} />
      <box flexShrink={0} flexDirection="row" justifyContent="flex-end" paddingLeft={SESSION_INSET} paddingRight={SESSION_INSET}>
        <text
          fg={theme.textMuted}
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
