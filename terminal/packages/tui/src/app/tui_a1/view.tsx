/** @jsxImportSource @opentui/solid */
import { InputRenderable, RGBA, TextAttributes, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useGraphSignal } from "depa-data-graph-solid"
import {
  makeMessageId,
  parseModelRef,
  type Event,
  type Message,
  type Part,
  type PermissionRequest,
  type QuestionAnswer,
  type QuestionRequest,
  type RuntimeUsage,
  type TuiRuntimeSdk,
  type UserInputHistoryEntry,
} from "@terminal/core/AIAgent"
import type {
  ActorConversationLaneData,
  ActorRuntimeLaneData,
  ActorSurfaceProjectionData,
} from "@cell/ai-core-contract/runtime/ActorSurface"
import { useExit } from "../../providers/exit"
import { useKeybind } from "../../providers/keybind"
import { MessageCards, frameLine } from "./features/message/cards"
import { sessionContext } from "./features/message/model/session-context"
import { BottomBar } from "./bottom-bar"
import { Composer } from "./features/composer/composer"
import { ApprovalPane } from "./features/approval/approval-pane"
import { formatQuestionAnswer } from "./features/approval/approval-utils"
import {
  attachSelectionToMessages,
  buildLocalReply,
  createRuntimePlaceholderMessages,
  defaultTuiA1Selection,
  type TuiA1Message,
  type TuiA1Selection,
  initialMessages,
} from "./data"
import { type TuiA1ProjectionSnapshot, type TuiA1QuestionnaireCenter, TuiA1StateGraph } from "./graph"
import { tuiA1Theme as theme } from "./theme"
import {
  handleHistoryWheelScroll,
  isNearHistoryBottom,
  scrollByLine,
  scrollByViewport,
  scrollToBottom,
  scrollToEdge,
} from "./perf/scroll-history"
import { DialogHeader, useDialog } from "../../ui/dialog/context"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog/select"
import { copyRendererSelection } from "../../ui/selection/copy"
import { DialogShortcuts } from "./system/shortcuts/shortcuts-dialog"
import { DialogSessionList } from "./system/session/session-list-dialog"
import { DialogMessageList } from "./system/message/message-list-dialog"
import { Keybind } from "../../support/util/keybind"
import { Locale } from "../../support/util/locale"
import { useTuiA1StateOptional } from "./state/state-context"
import { buildRuntimePromptParts } from "./features/composer/model/prompt-parts"
import type { PromptInfo } from "./features/composer/model/prompt-info"
import type { Route } from "./route/route"
import { useToast } from "../../ui/toast/toast"
import { resolveTuiBuiltinSlashCommand, SLASH_COMMANDS } from "../../commands/catalog"
export type TuiA1ScrollMode = "mouse" | "alternate"

export type TuiA1ViewProps = {
  continueSession?: boolean
  directory: string
  initialPrompt?: string
  initialMessages?: TuiA1Message[]
  onOpenQuestionnaires?: (center: TuiA1QuestionnaireCenter) => void
  onOpenMessageList?: () => void
  onOpenSessionList?: () => void
  onOpenUsage?: () => void
  onOpenFunctionMenu?: () => void
  runtime?: TuiRuntimeSdk
  selectionOverride?: {
    agent: boolean
    model: boolean
  }
  selection?: TuiA1Selection
  sessionID?: string
  scrollMode?: TuiA1ScrollMode
  onScrollboxReady?: (scrollbox: ScrollBoxRenderable) => void
}

type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>
type TuiA1FocusRegion = "composer" | "history"

function safeUseDialog() {
  try {
    return useDialog()
  } catch {
    return {
      clear() {},
      replace() {},
      setSize() {},
      stack: [],
    } as unknown as ReturnType<typeof useDialog>
  }
}

function safeUseExit() {
  try {
    return useExit()
  } catch {
    return async () => {}
  }
}

function safeUseToast() {
  try {
    return useToast()
  } catch {
    return {
      show() {},
      error() {},
    } as Pick<ReturnType<typeof useToast>, "show" | "error">
  }
}

function safeUseKeybind() {
  try {
    return useKeybind()
  } catch {
    return {
      match() {
        return false
      },
    } as Pick<ReturnType<typeof useKeybind>, "match">
  }
}

function createMessageID(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const SESSION_INTERRUPT_DOUBLE_PRESS_MS = 1000

const tuiA1AgentColors = [
  theme.secondary,
  theme.accent,
  theme.success,
  theme.warning,
  theme.primary,
  theme.error,
]

function createTuiA1AgentColor(name: string) {
  let hash = 0
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return tuiA1AgentColors[hash % tuiA1AgentColors.length] ?? RGBA.fromHex("#5ba8ff")
}

function formatCompactNumber(value: number): string {
  if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}m`
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
  return `${value}`
}

function formatTurnDuration(ms?: number): string {
  if (ms == null || ms < 0) return "--"
  if (ms < 1000) return "<1s"
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 || hours > 0) parts.push(`${minutes}min`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join(" ")
}

function estimateTuiA1Tokens(messages: TuiA1Message[]): number {
  const chars = messages.reduce((sum, message) => {
    if (message.kind === "tool") {
      if ("summary" in message) return sum + message.summary.length
      return sum + (message.output?.length ?? 0)
    }
    return sum + message.text.length
  }, 0)
  return Math.max(0, Math.round(chars / 4))
}

export function DialogQuestionnaireCenter(props: {
  entries: TuiA1QuestionnaireCenter["entries"]
}) {
  const [selected, setSelected] = createSignal<TuiA1QuestionnaireCenter["entries"][number]>()

  return (
    <Show
      when={selected()}
      fallback={<QuestionnaireHistoryList entries={props.entries} onSelect={setSelected} />}
    >
      {(entry: () => TuiA1QuestionnaireCenter["entries"][number]) => <QuestionnaireDetail entry={entry()} onBack={() => setSelected(undefined)} />}
    </Show>
  )
}

function summarizeBackendIdentity(lane: ActorConversationLaneData): string {
  const identity = lane.backendIdentity
  if (identity.kind === "member") return [identity.name, identity.role, identity.agentType].filter(Boolean).join(" · ")
  if (identity.kind === "holon") return [identity.name, identity.governance].filter(Boolean).join(" · ")
  if (identity.kind === "actor_definition") return identity.actorDefinitionName ?? identity.name ?? "actor definition"
  return identity.name ?? identity.agentName ?? identity.kind
}

function summarizeWorkContext(metadata?: Record<string, unknown>): string {
  const workContext = metadata?.workContext as { workMode?: unknown; taskPhase?: unknown } | undefined
  const workMode = typeof workContext?.workMode === "string" ? workContext.workMode : ""
  const taskPhase = typeof workContext?.taskPhase === "string" ? workContext.taskPhase : ""
  return workMode ? `mode: ${[workMode, taskPhase].filter(Boolean).join("/")}` : ""
}

function actorStatusText(status: string): string {
  switch (status) {
    case "waiting_for_human":
      return "等待用户"
    case "cancel_requested":
      return "取消中"
    case "running":
      return "运行中"
    case "idle":
      return "空闲"
    default:
      return status
  }
}

function QuestionnaireHistoryList(props: {
  entries: TuiA1QuestionnaireCenter["entries"]
  onSelect: (entry: TuiA1QuestionnaireCenter["entries"][number]) => void
}) {
  const dialog = useDialog()
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal(0)

  let input: InputRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined

  const cleanFilter = createMemo(() => filter().replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim().toLowerCase())

  const filtered = createMemo(() => {
    const needle = cleanFilter()
    const entries = props.entries
    if (!needle) return entries
    return entries.filter((entry) =>
      [entry.title, entry.summary, entry.status, entry.request.intro]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(needle)),
    )
  })

  const active = createMemo(() => filtered()[selected()])

  const statusLabel = (status: TuiA1QuestionnaireCenter["entries"][number]["status"]) => {
    switch (status) {
      case "pending":
        return "待处理"
      case "done":
        return "已完成"
      case "rejected":
        return "已拒绝"
    }
  }

  const statusColor = (status: TuiA1QuestionnaireCenter["entries"][number]["status"]) => {
    switch (status) {
      case "pending":
        return theme.warning
      case "done":
        return theme.success
      case "rejected":
        return theme.error
    }
  }

  const clearFilter = () => {
    setFilter("")
    setSelected(0)
    scroll?.scrollTo(0)
    if (input) input.value = ""
    input?.focus()
  }

  const move = (direction: number) => {
    const total = filtered().length
    if (total === 0) return
    setSelected((current) => {
      const next = current + direction
      if (next < 0) return total - 1
      if (next >= total) return 0
      return next
    })
    queueMicrotask(() => {
      const option = active()
      if (option) scroll?.scrollChildIntoView(option.id)
    })
  }

  const openActive = () => {
    const option = active()
    if (option) props.onSelect(option)
  }

  createEffect(() => {
    if (selected() >= filtered().length) setSelected(Math.max(0, filtered().length - 1))
  })

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
      openActive()
      return
    }
    if (event.ctrl && event.name === "l") {
      event.preventDefault()
      clearFilter()
    }
  })

  onMount(() => {
    dialog.setSize("large")
    dialog.setPaddingTop(0)
    setTimeout(() => input?.focus(), 1)
  })

  const rowBackground = (isActive: boolean) => (isActive ? theme.backgroundElement : RGBA.fromInts(0, 0, 0, 0))
  const rowPrimary = (isActive: boolean) => (isActive ? theme.text : theme.textMuted)
  const rowSecondary = (isActive: boolean) => (isActive ? theme.secondary : theme.textMuted)

  return (
    <box flexDirection="column" height="100%" paddingTop={0} paddingBottom={0}>
      <box paddingLeft={1} paddingRight={1} height={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          问卷
        </text>
      </box>
      <box height={1} />
      <box paddingLeft={1} paddingRight={1} flexDirection="row" height={1}>
        <box flexGrow={1}>
          <input
            onInput={(value) => {
              setFilter(value)
              setSelected(0)
              scroll?.scrollTo(0)
            }}
            focusedBackgroundColor={theme.backgroundPanel}
            cursorColor={theme.primary}
            focusedTextColor={theme.textMuted}
            placeholder="搜索问卷"
            ref={(value: InputRenderable) => {
              input = value
            }}
          />
        </box>
        <text
          flexShrink={0}
          fg={theme.secondary}
          attributes={TextAttributes.BOLD}
          onMouseUp={(event) => {
            event.stopPropagation()
            clearFilter()
          }}
        >
          [清空]
        </text>
      </box>
      <box height={1} />
      <box flexGrow={1} minHeight={0}>
        <Show
          when={filtered().length > 0}
          fallback={
            <box paddingLeft={1} paddingRight={1}>
              <text fg={theme.textMuted}>没有问卷</text>
            </box>
          }
        >
          <scrollbox
            ref={(value: ScrollBoxRenderable) => {
              scroll = value
            }}
            height="100%"
            scrollY={true}
            scrollX={false}
            scrollbarOptions={{ visible: false }}
          >
            <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1} paddingBottom={1}>
              <For each={filtered()}>
                {(entry, index) => {
                  const isActive = createMemo(() => index() === selected())
                  const rowFg = createMemo(() => rowPrimary(isActive()))
                  const metaFg = createMemo(() => rowSecondary(isActive()))
                  const rowProps = {
                    id: entry.id,
                    flexDirection: "column",
                    backgroundColor: rowBackground(isActive()),
                    onMouseEnter: () => {
                      setSelected(index())
                    },
                    onMouseUp: (event: { stopPropagation: () => void }) => {
                      event.stopPropagation()
                      props.onSelect(entry)
                    },
                  } as any
                  return (
                    <box {...rowProps}>
                      <box flexDirection="row" justifyContent="space-between" gap={1}>
                        <text fg={rowFg()} wrapMode="char">
                          <b>{entry.title}</b>
                        </text>
                        <text flexShrink={0} fg={statusColor(entry.status)}>
                          {statusLabel(entry.status)}
                        </text>
                      </box>
                      <box flexDirection="row" justifyContent="space-between" gap={1}>
                        <text fg={metaFg()} wrapMode="char">
                          {entry.answered}/{entry.total} · {entry.summary}
                        </text>
                        <text flexShrink={0} fg={theme.textMuted}>
                          {Locale.time(entry.updatedAt)}
                        </text>
                      </box>
                    </box>
                  )
                }}
              </For>
            </box>
          </scrollbox>
        </Show>
      </box>
      <box height={1} />
      <box paddingLeft={1} paddingRight={1} height={1} flexDirection="row" justifyContent="flex-end">
        <text
          fg={theme.secondary}
          attributes={TextAttributes.BOLD}
          onMouseUp={(event) => {
            event.stopPropagation()
            dialog.clear()
          }}
        >
          [关闭(esc)]
        </text>
      </box>
    </box>
  )
}

function QuestionnaireDetail(props: {
  entry: TuiA1QuestionnaireCenter["entries"][number]
  onBack: () => void
}) {
  useKeyboard((event) => {
    if (event.name === "left" || event.name === "backspace" || event.name === "escape") {
      event.preventDefault()
      event.stopPropagation()
      props.onBack()
    }
  })

  const statusLabel = createMemo(() => {
    switch (props.entry.status) {
      case "pending":
        return "Pending"
      case "done":
        return "Completed"
      case "rejected":
        return "Rejected"
    }
  })

  const statusColor = createMemo(() => {
    switch (props.entry.status) {
      case "pending":
        return theme.warning
      case "done":
        return theme.success
      case "rejected":
        return theme.error
    }
  })

  return (
    <box flexDirection="column" paddingLeft={4} paddingRight={4} paddingBottom={1} height="100%" gap={1}>
      <DialogHeader title="Questionnaire Detail" showClose={false} />

      <box flexDirection="column" gap={1} paddingBottom={1}>
        <text fg={theme.text}>
          <b>{props.entry.title}</b> <span style={{ fg: statusColor() }}>{statusLabel()}</span>
        </text>
        <text fg={theme.textMuted}>
          Updated {Locale.time(props.entry.updatedAt)} · Answered {props.entry.answered}/{props.entry.total}
        </text>
        <Show when={typeof props.entry.request.intro === "string" && props.entry.request.intro.trim()}>
          <text fg={theme.textMuted}>{props.entry.request.intro as string}</text>
        </Show>
        <text fg={theme.textMuted}>{props.entry.summary}</text>
      </box>

      <box flexGrow={1} minHeight={0}>
        <scrollbox height="100%" scrollY={true} scrollX={false} scrollbarOptions={{ visible: false }}>
          <box flexDirection="column" gap={1} paddingBottom={1}>
            <For each={props.entry.request.questions}>
              {(question, index) => {
                const answer = () => props.entry.answers[index()] ?? []
                const isPending = () => props.entry.status === "pending" && answer().length === 0
                return (
                  <box flexDirection="column" gap={1}>
                    <text fg={theme.text}>
                      <b>{question.header}</b> {question.question}
                    </text>
                    <For each={question.options}>
                      {(option) => {
                        const optionCode = typeof (option as unknown as { code?: string }).code === "string" ? (option as unknown as { code: string }).code : ""
                        const selected = answer().includes(option.label)
                        return (
                          <text fg={selected ? theme.success : theme.textMuted}>
                            {selected ? "●" : "○"} {optionCode ? `${optionCode}) ` : ""}{option.label}
                          </text>
                        )
                      }}
                    </For>
                    <Show when={question.helpText}>
                      <text fg={theme.textMuted}>{question.helpText}</text>
                    </Show>
                    <text fg={isPending() ? theme.warning : theme.textMuted}>
                      Answer: {isPending() ? "(pending)" : formatQuestionAnswer(answer())}
                    </text>
                  </box>
                )
              }}
            </For>

            <box flexDirection="column" gap={1} paddingTop={1}>
              <text fg={theme.text}>
                <b>Structured Answers</b>
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                {JSON.stringify(props.entry.structuredAnswers, null, 2)}
              </text>
            </box>
          </box>
        </scrollbox>
      </box>

      <box flexDirection="row" justifyContent="flex-end" paddingTop={1}>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.primary}
          onMouseUp={(evt) => {
            evt.stopPropagation()
            props.onBack()
          }}
        >
          <text fg={theme.selectedListItemText}>[返回]</text>
        </box>
      </box>
    </box>
  )
}

export function TuiA1View(props: TuiA1ViewProps) {
  const RUNTIME_PREPARING_STATUS_MESSAGE = "正在准备运行环境..."
  const RUNTIME_RUNNING_STATUS_MESSAGE = "正在处理..."
  const ACTOR_RUNNING_STATUS_MESSAGE = "正在等待 Actor 回复..."
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const dialog = safeUseDialog()
  const exit = safeUseExit()
  const toast = safeUseToast()
  const keybind = safeUseKeybind()
  const scrollMode = props.scrollMode ?? "mouse"
  const stateContext = useTuiA1StateOptional()
  const initialSelection = props.selection ?? defaultTuiA1Selection
  const fallbackStateGraph = stateContext
    ? undefined
    : new TuiA1StateGraph({
        composer: props.initialPrompt?.trim() ? { input: props.initialPrompt, parts: [] } : { input: "", parts: [] },
        initialMessages: props.runtime
          ? createRuntimePlaceholderMessages(initialSelection, true)
          : attachSelectionToMessages(props.initialMessages ?? initialMessages, initialSelection),
        route: props.sessionID ? { type: "session", sessionID: props.sessionID } : { type: "home" },
        selection: initialSelection,
        sessionID: props.sessionID,
      })
  const stateGraph = stateContext?.stateGraph ?? fallbackStateGraph!
  const messages = useGraphSignal<TuiA1Message[], undefined>(stateGraph.graph, "messages")
  const snapshot = useGraphSignal<TuiA1ProjectionSnapshot, undefined>(stateGraph.graph, "snapshot")
  const busy = useGraphSignal<boolean, undefined>(stateGraph.graph, "busy")
  const composer = useGraphSignal<PromptInfo, undefined>(stateGraph.graph, "composer")
  const route = useGraphSignal<Route, undefined>(stateGraph.graph, "route")
  const selection = useGraphSignal<TuiA1Selection, undefined>(stateGraph.graph, "selection")
  const sessionID = useGraphSignal<string | undefined, undefined>(stateGraph.graph, "sessionID")
  const activePermission = useGraphSignal<PermissionRequest | undefined, undefined>(stateGraph.graph, "activePermission")
  const activeQuestion = useGraphSignal<QuestionRequest | undefined, undefined>(stateGraph.graph, "activeQuestion")
  const composerBlocked = useGraphSignal<boolean, undefined>(stateGraph.graph, "composerBlocked")
  const questionnaireCenter = useGraphSignal<TuiA1QuestionnaireCenter, undefined>(stateGraph.graph, "questionnaireCenter")
  const actorSurface = useGraphSignal<ActorSurfaceProjectionData | null, undefined>(stateGraph.graph, "actorSurface")
  const selectionLabel = useGraphSignal<string, undefined>(stateGraph.graph, "selectionLabel")
  const [sessionLoadLabel, setSessionLoadLabel] = createSignal<string | undefined>()
  const [runtimeStatusLabel, setRuntimeStatusLabel] = createSignal<string | undefined>()
  let sessionLoadToken = 0
  const composerBlockLabel = createMemo(() => {
    const permission = activePermission()
    if (permission) return `permission required: ${permission.permission}`
    if (activeQuestion()) return "question required before submit"
    return undefined
  })
  const activePermissionCallID = createMemo(() => activePermission()?.tool?.callID)
  let textarea: TextareaRenderable | undefined
  let scrollbox: ScrollBoxRenderable | undefined
  const [autoFollowHistory, setAutoFollowHistory] = createSignal(true)
  const [focusRegion, setFocusRegion] = createSignal<TuiA1FocusRegion>("composer")
  const [now, setNow] = createSignal(Date.now())
  const [activeRoundStartedAt, setActiveRoundStartedAt] = createSignal<number | undefined>()
  const [lastRoundDurationMs, setLastRoundDurationMs] = createSignal<number | undefined>()
  const [maxRoundDurationMs, setMaxRoundDurationMs] = createSignal<number | undefined>()
  const timers = new Set<TimerHandle>()
  let bootstrapped = false
  let initialRuntimePromptSubmitted = false
  let runtimeUnsub: (() => void) | undefined
  let disposed = false
  let pendingScrollToBottom = false
  let pendingForcedScrollToBottom = false
  let actorRoundInFlight = false
  let lastSessionInterruptAt = 0
  let sessionInterruptInFlight = false

  const registerTimer = <T extends TimerHandle>(timer: T) => {
    timers.add(timer)
    return timer
  }

  const releaseTimer = (timer: TimerHandle) => {
    clearTimeout(timer)
    clearInterval(timer)
    timers.delete(timer)
  }

  const hasActiveSelection = () => Boolean(renderer.getSelection())
  const composerHasDraft = () => (textarea?.plainText ?? "").length > 0
  const historyFocused = () => focusRegion() === "history"
  const composerFocused = () => focusRegion() === "composer"
  const historyIndicatorColor = () => theme.userBorder
  const historyIndicatorText = () => {
    const width = Math.max(1, dimensions().width)
    return frameLine({
      leftCorner: "╭",
      rightCorner: "╮",
      leftLabel: "COMPOSER",
      width,
    })
  }
  const shouldRouteHistoryArrowKeys = () => historyFocused() || !composerHasDraft()
  const turnCount = createMemo(() => messages().filter((message) => message.kind === "user").length)
  const tokenUsageLabel = createMemo(() => {
    const activeSessionID = sessionID()
    const runtimeUsage = activeSessionID ? snapshot().runtimeUsage[activeSessionID] : undefined
    if (runtimeUsage && runtimeUsage.total_tokens > 0) {
      return `${runtimeUsage.is_estimated ? "~" : ""}${formatCompactNumber(runtimeUsage.total_tokens)} tok`
    }
    const runtimeMessages = Object.values(snapshot().runtimeMessages)
    const assistantMessages = runtimeMessages.filter(
      (message): message is Extract<Message, { role: "assistant" }> => message.role === "assistant",
    )
    if (assistantMessages.length > 0) {
      const total = assistantMessages.reduce((sum, message) => {
        const usage = message.tokens
        return sum + usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write
      }, 0)
      return `${formatCompactNumber(total)} tok`
    }
    return `~${formatCompactNumber(estimateTuiA1Tokens(messages()))} tok`
  })
  const currentUserInputHistory = createMemo(() => {
    const activeSessionID = sessionID()
    return activeSessionID ? snapshot().userInputHistory[activeSessionID] ?? [] : []
  })
  const currentRoundDurationMs = createMemo(() => {
    const startedAt = activeRoundStartedAt()
    if (startedAt == null) return lastRoundDurationMs()
    return Math.max(0, now() - startedAt)
  })
  const currentRoundDurationLabel = createMemo(() => formatTurnDuration(currentRoundDurationMs()))
  const maxRoundDurationLabel = createMemo(() => formatTurnDuration(maxRoundDurationMs()))
  const bottomBarMetricsLabel = createMemo(
    () => `${tokenUsageLabel()} · ${turnCount()}轮 · 本轮 ${currentRoundDurationLabel()} · 峰值 ${maxRoundDurationLabel()}`,
  )
  const startRoundTimer = (startedAt = Date.now()) => {
    setActiveRoundStartedAt(startedAt)
    setNow(Date.now())
  }
  const finishRoundTimer = (completedAt = Date.now()) => {
    const startedAt = activeRoundStartedAt()
    if (startedAt == null) return

    const durationMs = Math.max(0, completedAt - startedAt)
    setActiveRoundStartedAt(undefined)
    setLastRoundDurationMs(durationMs)
    setMaxRoundDurationMs((currentMax) => Math.max(currentMax ?? 0, durationMs))
    setNow(completedAt)
  }
  const questionnaireFooterLabel = createMemo(() => {
    const center = questionnaireCenter()
    return `问卷 ${center.doneCount}/${center.pendingCount}`
  })

  const showRuntimePreparingStatus = () => {
    setRuntimeStatusLabel(RUNTIME_PREPARING_STATUS_MESSAGE)
  }

  const showRuntimeRunningStatus = () => {
    setRuntimeStatusLabel(RUNTIME_RUNNING_STATUS_MESSAGE)
  }

  const clearLocalRuntimeStatus = () => {
    const current = runtimeStatusLabel()
    if (
      current === RUNTIME_PREPARING_STATUS_MESSAGE
      || current === RUNTIME_RUNNING_STATUS_MESSAGE
      || current === ACTOR_RUNNING_STATUS_MESSAGE
    ) {
      setRuntimeStatusLabel(undefined)
    }
  }

  const actorSurfaceHasActiveTurn = (surface: ActorSurfaceProjectionData | null | undefined) => {
    if (!surface) return false
    return surface.actorLanes.some((lane) =>
      lane.runtimeStatus === "running"
      || lane.runtimeStatus === "waiting_for_human"
      || lane.runtimeStatus === "cancel_requested"
      || Boolean(lane.activeTurnId),
    )
  }

  const updateActorRoundFromSurface = (surface: ActorSurfaceProjectionData | null | undefined) => {
    if (!actorRoundInFlight) return
    if (actorSurfaceHasActiveTurn(surface)) {
      stateGraph.setBusy(true)
      setRuntimeStatusLabel(ACTOR_RUNNING_STATUS_MESSAGE)
      return
    }

    actorRoundInFlight = false
    stateGraph.setBusy(false)
    clearLocalRuntimeStatus()
    finishRoundTimer()
  }
  const selectedActorTargetLabel = createMemo(() => {
    const surface = actorSurface()
    if (!surface) return "目标:Primary"

    const target = surface.selectedTarget
    const lane = target.laneId
      ? surface.conversationLanes.find((item) => item.laneId === target.laneId)
      : undefined
    const actor = target.actorId
      ? surface.actorLanes.find((item) => item.actorId === target.actorId)
      : undefined
    return `目标:${lane?.displayName ?? actor?.displayName ?? surface.selectedLaneId}`
  })
  const composerSelectionLabel = createMemo(() => `${selectionLabel()} · ${selectedActorTargetLabel()}`)
  const selectedActorTarget = () => actorSurface()?.selectedTarget ?? { laneId: "lane:primary" }
  const shouldSendPromptToActorTarget = () => {
    const target = selectedActorTarget()
    if (target.laneId && target.laneId !== "lane:primary") return true
    if (target.actorId) {
      const surface = actorSurface()
      const primaryActorId = surface?.conversationLanes.find((lane) => lane.laneId === "lane:primary")?.actorId
      return target.actorId !== primaryActorId
    }
    return Boolean(target.laneId && target.laneId !== "lane:primary")
  }
  const syncScrollboxStickyState = (value = autoFollowHistory()) => {
    if (scrollbox) scrollbox.stickyScroll = value
  }

  const disableAutoFollowHistory = () => {
    setAutoFollowHistory(false)
    syncScrollboxStickyState(false)
  }

  const focusComposer = () => {
    setFocusRegion("composer")
    scrollbox?.blur()
    textarea?.focus()
  }

  const focusHistory = () => {
    setFocusRegion("history")
    textarea?.blur()
    scrollbox?.focus()
  }

  createEffect(() => {
    busy()
    const region = focusRegion()
    queueMicrotask(() => {
      if (region === "history") {
        textarea?.blur()
        scrollbox?.focus()
        return
      }
      scrollbox?.blur()
      textarea?.focus()
    })
  })

  createEffect(() => {
    const blocked = composerBlocked()
    if (!blocked) return
    queueMicrotask(() => {
      textarea?.blur()
      scrollbox?.blur()
    })
  })

  const syncAutoFollowHistory = () => {
    const nextValue = isNearHistoryBottom(scrollbox)
    setAutoFollowHistory(nextValue)
    syncScrollboxStickyState(nextValue)
  }

  const scheduleAutoFollowSync = () => {
    queueMicrotask(() => {
      syncAutoFollowHistory()
    })
  }

  const maybeScrollToBottom = (force = false) => {
    if (!scrollbox) return
    pendingForcedScrollToBottom = pendingForcedScrollToBottom || force
    if (pendingScrollToBottom) return
    pendingScrollToBottom = true
    queueMicrotask(() => {
      pendingScrollToBottom = false
      const shouldForce = pendingForcedScrollToBottom
      pendingForcedScrollToBottom = false
      if (!scrollbox) return
      if (!shouldForce && (!autoFollowHistory() || hasActiveSelection())) return
      setAutoFollowHistory(true)
      syncScrollboxStickyState(true)
      scrollToBottom(scrollbox)
    })
  }

  const handleManualHistoryWheel = (event: {
    scroll?: { direction?: string }
    preventDefault: () => void
    stopPropagation: () => void
  }) => {
    focusHistory()
    if (hasActiveSelection()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    disableAutoFollowHistory()
    handleHistoryWheelScroll(scrollbox, event)
    scheduleAutoFollowSync()
  }

  const handleHistorySurfaceWheel = (event: {
    scroll?: { direction?: string }
    preventDefault: () => void
    stopPropagation: () => void
  }) => {
    if (hasActiveSelection()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    focusHistory()
    disableAutoFollowHistory()
    event.stopPropagation()
    scheduleAutoFollowSync()
  }

  const handleGlobalWheel = (event: {
    scroll?: { direction?: string }
    preventDefault: () => void
    stopPropagation: () => void
  }) => {
    if (historyFocused() || !composerHasDraft()) {
      handleManualHistoryWheel(event)
    }
  }

  const streamAssistant = (messageID: string, fullText: string) => {
    let index = 0
    const step = 3
    const timer = registerTimer(
      setInterval(() => {
        index = Math.min(fullText.length, index + step)
        const completedAt = index >= fullText.length ? Date.now() : undefined
        stateGraph.patchLocalMessage(messageID, {
          text: fullText.slice(0, index),
          streaming: index < fullText.length,
          completedAt,
        })
        maybeScrollToBottom()

        if (index >= fullText.length) {
          releaseTimer(timer)
          stateGraph.setBusy(false)
          finishRoundTimer(completedAt ?? Date.now())
        }
      }, 18),
    )
  }

  const loadRuntimeSession = async (sessionID: string) => {
    if (!props.runtime || disposed) return
    const loadToken = ++sessionLoadToken
    setSessionLoadLabel("正在加载会话...")
    try {
      const [messagesResult, statusResult, userInputsResult] = await Promise.all([
        props.runtime.client.session.messages({ sessionID }),
        props.runtime.client.session.status(),
        props.runtime.client.session.userInputs({ sessionID }),
      ])
      if (disposed || loadToken !== sessionLoadToken) return

      stateGraph.hydrateRuntimeSession({
        sessionID,
        busy: statusResult.data?.[sessionID]?.type === "busy",
        messages: (messagesResult.data ?? []).map((item) => item.info),
        partsByMessage: Object.fromEntries((messagesResult.data ?? []).map((item) => [item.info.id, item.parts ?? []])),
      })
      const statusMessage = statusResult.data?.[sessionID]?.message
      const normalizedStatusMessage = typeof statusMessage === "string" ? statusMessage.trim() : ""
      setRuntimeStatusLabel(normalizedStatusMessage || undefined)
      stateGraph.setUserInputHistory(sessionID, userInputsResult.data ?? [])
      maybeScrollToBottom(true)
      if (!normalizedStatusMessage) showRuntimePreparingStatus()
      void refreshActorSurface().finally(() => {
        if (!actorRoundInFlight) clearLocalRuntimeStatus()
      })
    } finally {
      if (!disposed && loadToken === sessionLoadToken) {
        setSessionLoadLabel(undefined)
      }
    }
  }

  const refreshActorSurface = async () => {
    if (disposed) return
    if (!props.runtime?.client.actor?.surface) {
      stateGraph.setActorSurface(null)
      updateActorRoundFromSurface(null)
      return
    }
    const state = await props.runtime.client.actor.surface({ sessionID: sessionID() }).catch(() => ({ data: null }))
    if (disposed) return
    const surface = state.data ?? null
    stateGraph.setActorSurface(surface)
    updateActorRoundFromSurface(surface)
  }

  type ActorListTarget = {
    laneID?: string
    actorID?: string
    cancellable?: boolean
    turnID?: string
  }

  const actorHistoryViewKey = (surface: ActorSurfaceProjectionData, target: ActorListTarget): string => {
    const hasExplicitLane = target.laneID !== undefined
    const hasExplicitActor = target.actorID !== undefined
    const actorID = hasExplicitActor ? target.actorID : hasExplicitLane ? undefined : surface.selectedTarget.actorId
    const laneID = hasExplicitLane ? target.laneID : surface.selectedTarget.laneId
    const actorLane = actorID ? surface.actorLanes.find((lane) => lane.actorId === actorID) : undefined
    const conversationLane = laneID ? surface.conversationLanes.find((lane) => lane.laneId === laneID) : undefined
    const laneActor = conversationLane?.actorId
      ? surface.actorLanes.find((lane) => lane.actorId === conversationLane.actorId)
      : undefined
    const transcriptKey = actorLane?.transcriptKey ?? laneActor?.transcriptKey
    if (transcriptKey) {
      return [
        "actor",
        transcriptKey.sessionId ?? sessionID(),
        transcriptKey.actorKey,
        transcriptKey.actorId,
      ].filter(Boolean).join(":")
    }
    if (laneID) return `lane:${laneID}`
    if (actorID) return `actor:${actorID}`
    return `session:${sessionID() ?? "__unsessioned__"}`
  }

  const loadActorHistory = async (
    target: ActorListTarget,
    surface: ActorSurfaceProjectionData | null | undefined = actorSurface(),
  ): Promise<boolean> => {
    const activeSessionID = sessionID()
    if (!activeSessionID || !surface || !props.runtime?.client.actor?.messages) return false
    const result = await props.runtime.client.actor.messages({
      sessionID: activeSessionID,
      laneID: target.laneID,
      actorID: target.actorID,
      limit: 100,
    }).catch((error) => {
      toast.error(error)
      return null
    })
    if (!result) return false
    stateGraph.hydrateActorHistory({
      sessionID: activeSessionID,
      transcriptKey: actorHistoryViewKey(surface, target),
      messages: (result.data ?? []).map((item) => item.info),
      partsByMessage: Object.fromEntries((result.data ?? []).map((item) => [item.info.id, item.parts ?? []])),
    })
    maybeScrollToBottom(true)
    return true
  }

  const bootstrapRuntime = async () => {
    if (!props.runtime) return

    runtimeUnsub?.()
    runtimeUnsub = props.runtime.event.on((event: Event) => {
      if (disposed) return
      switch (event.type) {
        case "session.status": {
          if (event.properties?.sessionID !== sessionID()) return
          const status = event.properties?.status as { type?: string; message?: unknown } | undefined
          const nextBusy = status?.type === "busy"
          const message = typeof status?.message === "string" ? status.message.trim() : ""
          if (message || !nextBusy) {
            setRuntimeStatusLabel(message || undefined)
          } else if (runtimeStatusLabel() === RUNTIME_PREPARING_STATUS_MESSAGE) {
            showRuntimeRunningStatus()
          }
          stateGraph.setBusy(nextBusy)
          if (!nextBusy) finishRoundTimer()
          break
        }
        case "message.updated": {
          const info = event.properties?.info as Message | undefined
          if (!info || info.sessionID !== sessionID()) return
          stateGraph.applyRuntimeMessageUpdated(info)
          maybeScrollToBottom()
          break
        }
        case "message.part.updated": {
          const part = event.properties?.part as Part | undefined
          if (!part || part.sessionID !== sessionID()) return
          stateGraph.applyRuntimePartUpdated(part)
          maybeScrollToBottom()
          break
        }
        case "session.usage": {
          const payload = event.properties as { sessionID?: string; usage?: RuntimeUsage } | undefined
          if (!payload?.sessionID || payload.sessionID !== sessionID() || !payload.usage) return
          stateGraph.applyRuntimeUsageUpdated(payload.sessionID, payload.usage)
          break
        }
        case "session.user_input": {
          const payload = event.properties as {
            sessionID?: string
            text?: string
            createdAt?: number
            history?: UserInputHistoryEntry[]
          } | undefined
          if (!payload?.sessionID || payload.sessionID !== sessionID()) return
          const text = String(payload.text ?? "").trim()
          if (!text && !payload.history) return
          stateGraph.appendUserInputHistory(
            payload.sessionID,
            { text, ...(typeof payload.createdAt === "number" ? { createdAt: payload.createdAt } : {}) },
            payload.history,
          )
          break
        }
        case "message.removed": {
          const payload = event.properties as { sessionID?: string; messageID?: string } | undefined
          if (!payload?.sessionID || !payload.messageID || payload.sessionID !== sessionID()) return
          stateGraph.applyRuntimeMessageRemoved(payload.sessionID, payload.messageID)
          maybeScrollToBottom()
          break
        }
        case "permission.asked": {
          const request = event.properties as PermissionRequest | undefined
          if (!request?.sessionID || !request.id) return
          stateGraph.applyPermissionAsked(request)
          break
        }
        case "permission.replied": {
          const payload = event.properties as { sessionID?: string; requestID?: string } | undefined
          if (!payload?.sessionID || !payload.requestID) return
          stateGraph.applyPermissionReplied(payload.sessionID, payload.requestID)
          break
        }
        case "question.asked": {
          const request = event.properties as QuestionRequest | undefined
          if (!request?.sessionID || !request.id) return
          stateGraph.applyQuestionAsked(request)
          break
        }
        case "question.replied": {
          const payload = event.properties as { sessionID?: string; requestID?: string } | undefined
          if (!payload?.sessionID || !payload.requestID) return
          stateGraph.applyQuestionReplied(payload.sessionID, payload.requestID)
          break
        }
        case "question.rejected": {
          const payload = event.properties as { sessionID?: string; requestID?: string } | undefined
          if (!payload?.sessionID || !payload.requestID) return
          stateGraph.applyQuestionRejected(payload.sessionID, payload.requestID)
          break
        }
      }
      void refreshActorSurface()
    })

    const [agentsResult, configResult] = await Promise.all([
      props.runtime.client.app.agents().catch(() => ({ data: [] })),
      props.runtime.client.config.get().catch(() => ({ data: {} })),
    ])

    const configData = configResult.data ?? {}
    const configuredModel = parseModelRef(
      "model" in configData && typeof configData.model === "string" ? configData.model : undefined,
    )
    const firstAgent = agentsResult.data?.[0]?.name

    stateGraph.mergeSelection({
      agent: !props.selectionOverride?.agent && firstAgent ? firstAgent : undefined,
      providerID: !props.selectionOverride?.model && configuredModel ? configuredModel.providerID : undefined,
      modelID: !props.selectionOverride?.model && configuredModel ? configuredModel.modelID : undefined,
      modelSource: !props.selectionOverride?.model && configuredModel ? "runtime-config" : undefined,
    })

    const resolvedSessionID = await (async () => {
      if (props.sessionID) return props.sessionID
      const currentRoute = route()
      if (currentRoute.type === "session") return currentRoute.sessionID
      if (!props.continueSession) return undefined
      const sessionsResult = await props.runtime!.client.session.list()
      return sessionsResult.data?.at(-1)?.id
    })()

    if (resolvedSessionID) {
      await loadRuntimeSession(resolvedSessionID)
    } else {
      stateGraph.showRuntimePlaceholder(false)
    }

    const composerDraft = composer()
    if (composerDraft?.input.trim() && !initialRuntimePromptSubmitted) {
      initialRuntimePromptSubmitted = true
      void submitPrompt(composerDraft, () => {
        textarea?.setText("")
        textarea?.focus()
      })
    }
  }

  const submitPrompt = async (promptInfo: PromptInfo, clear?: () => void) => {
    const prompt = promptInfo.input.trim()
    if (!prompt || busy() || composerBlocked()) return

    if (props.runtime) {
      if (promptInfo.parts.length <= 1) {
        const builtinCommand = resolveTuiBuiltinSlashCommand(prompt)
        if (builtinCommand) {
          clear?.()
          await props.runtime.client.tui.executeCommand({ command: builtinCommand })
          focusComposer()
          return
        }
      }

      let activeSessionID = sessionID()
      if (!activeSessionID) {
        const created = await props.runtime.client.session.create({})
        activeSessionID = created.data?.id
        if (!activeSessionID) return
        stateGraph.setSessionID(activeSessionID)
      }

      const currentSelection = selection()
      const selectedModel = {
        providerID: currentSelection.providerID,
        modelID: currentSelection.modelID,
      }
      const agent = currentSelection.agent
      const messageID = makeMessageId()
      const roundStartedAt = Date.now()

      clear?.()
      startRoundTimer(roundStartedAt)
      stateGraph.setBusy(true)
      showRuntimePreparingStatus()
      maybeScrollToBottom(true)

      if (prompt.startsWith("/") && promptInfo.parts.length <= 1) {
        const [command, ...args] = prompt.slice(1).split(" ")
        void props.runtime.client.session.command({
          sessionID: activeSessionID,
          command,
          arguments: args.join(" "),
          agent,
          model: selectedModel,
          messageID,
        })
        return
      }

      if (props.runtime.client.actor?.send && shouldSendPromptToActorTarget()) {
        const target = selectedActorTarget()
        const targetLane = target.laneId
        const targetActor = targetLane && targetLane !== "lane:primary" ? undefined : target.actorId
        actorRoundInFlight = true
        void props.runtime.client.actor
          .send({
            sessionID: activeSessionID,
            laneID: targetLane,
            actorID: targetActor,
            text: prompt,
            model: selectedModel,
          })
          .then(async (result) => {
            const selectedSurface = result.data ?? actorSurface()
            stateGraph.setActorSurface(selectedSurface ?? null)
            updateActorRoundFromSurface(selectedSurface)
            const selectedTarget = selectedSurface?.selectedTarget
            const hydrated = await loadActorHistory({
              laneID: selectedTarget?.laneId ?? targetLane,
              actorID: selectedTarget?.actorId ?? targetActor,
            }, selectedSurface)
            if (!hydrated) await loadRuntimeSession(activeSessionID)
          })
          .catch((error) => {
            actorRoundInFlight = false
            toast.error(error)
          })
          .finally(() => {
            if (actorRoundInFlight) return
            stateGraph.setBusy(false)
            clearLocalRuntimeStatus()
            finishRoundTimer()
          })
        return
      }

      void props.runtime.client.session.prompt({
        sessionID: activeSessionID,
        messageID,
        agent,
        model: selectedModel,
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
        parts: buildRuntimePromptParts({
          prompt: promptInfo,
          sessionID: activeSessionID,
          messageID,
        }),
      })
      return
    }

    const roundStartedAt = Date.now()
    const userMessage: TuiA1Message = {
      id: createMessageID("user"),
      kind: "user",
      text: promptInfo.input,
      createdAt: roundStartedAt,
    }
    const toolMessage: TuiA1Message = {
      id: createMessageID("tool"),
      kind: "tool",
      source: "summary",
      tool: "local.echo",
      status: "running",
      summary: "Preparing a simulated assistant reply and validating card + scroll behaviour.",
      input: {
        chars: promptInfo.input.length,
        mode: "tui_a1",
        parts: promptInfo.parts.length,
      },
      createdAt: roundStartedAt,
    }
    const assistantMessage: TuiA1Message = {
      id: createMessageID("assistant"),
      kind: "assistant",
      label: "TuiA1",
      text: "",
      streaming: true,
      selection: selection(),
      createdAt: Date.now(),
    }

    stateGraph.appendLocalMessages([userMessage, toolMessage])
    startRoundTimer(roundStartedAt)
    stateGraph.setBusy(true)
    clear?.()
    maybeScrollToBottom(true)

    const timer = registerTimer(
      setTimeout(() => {
        stateGraph.patchLocalMessage(toolMessage.id, {
          status: "done",
          summary: "Simulated reply prepared. Streaming assistant content into the scroll region.",
        })
        stateGraph.appendLocalMessages([assistantMessage])
        streamAssistant(assistantMessage.id, buildLocalReply(promptInfo.input))

        releaseTimer(timer)
      }, 220),
    )
  }

  const replyPermission = async (request: PermissionRequest, reply: "once" | "always" | "reject") => {
    if (props.runtime) {
      await props.runtime.client.permission.reply({
        requestID: request.id,
        reply,
      })
    }
    stateGraph.recordPermissionHistory(request, reply)
    stateGraph.applyPermissionReplied(request.sessionID, request.id)
  }

  const replyQuestion = async (request: QuestionRequest, answers: QuestionAnswer[]) => {
    if (props.runtime) {
      await props.runtime.client.question.reply({
        requestID: request.id,
        answers,
      })
    }
    stateGraph.recordQuestionHistory(request, answers)
    stateGraph.applyQuestionReplied(request.sessionID, request.id)
  }

  const rejectQuestion = async (request: QuestionRequest) => {
    if (props.runtime) {
      await props.runtime.client.question.reject({
        requestID: request.id,
      })
    }
    stateGraph.recordQuestionHistory(request, [], true)
    stateGraph.applyQuestionRejected(request.sessionID, request.id)
  }

  const openQuestionnaireCenter = () => {
    if (props.onOpenQuestionnaires) {
      props.onOpenQuestionnaires(questionnaireCenter())
      return
    }
    dialog.replace(() => <DialogQuestionnaireCenter entries={questionnaireCenter().entries} />)
  }
  const openSessionList = () => {
    if (props.onOpenSessionList) {
      props.onOpenSessionList()
      return
    }
    dialog.replace(() => <DialogSessionList />)
  }
  const openMessageList = () => {
    if (props.onOpenMessageList) {
      props.onOpenMessageList()
      return
    }
    dialog.replace(() => <DialogMessageList messages={messages()} sessionID={sessionID()} />)
  }
  const openShortcutOverview = () => {
    dialog.replace(() => <DialogShortcuts />)
  }
  const openActorList = async () => {
    if (props.runtime?.client.actor?.surface) {
      await refreshActorSurface()
    }
    const surface = actorSurface()
    if (!surface) {
      toast.show({ message: "当前 runtime 不支持 Actor 列表", variant: "warning" })
      return
    }

    const selectTarget = async (target: ActorListTarget) => {
      if (props.runtime?.client.actor?.select) {
        const selected = await props.runtime.client.actor.select({
          sessionID: sessionID(),
          laneID: target.laneID,
          actorID: target.actorID,
        }).catch(() => null)
        stateGraph.setActorSurface(selected?.data ?? actorSurface())
        await loadActorHistory(target, selected?.data ?? actorSurface())
      }
      dialog.clear()
      focusComposer()
    }
    const cancelTarget = async (target: ActorListTarget) => {
      if (!target.actorID || !props.runtime?.client.actor?.cancel) return
      const selected = await props.runtime.client.actor.cancel({
        sessionID: sessionID(),
        actorID: target.actorID,
        turnID: target.turnID,
      }).catch((error) => {
        toast.error(error)
        return null
      })
      stateGraph.setActorSurface(selected?.data ?? actorSurface())
      await loadActorHistory(target, selected?.data ?? actorSurface())
      toast.show({ message: "已请求取消 Actor", variant: "info" })
    }
    const sendDraftToTarget = async (target: ActorListTarget) => {
      const text = (textarea?.plainText ?? "").trim()
      if (!text || !props.runtime?.client.actor?.send) {
        toast.show({ message: "输入框没有可发送内容", variant: "warning" })
        return
      }
      let activeSessionID = sessionID()
      if (!activeSessionID) {
        const created = await props.runtime.client.session.create({})
        activeSessionID = created.data?.id
        if (!activeSessionID) return
        stateGraph.setSessionID(activeSessionID)
      }
      const selected = await props.runtime.client.actor.send({
        sessionID: activeSessionID,
        laneID: target.laneID,
        actorID: target.actorID,
        text,
      }).catch((error) => {
        toast.error(error)
        return null
      })
      stateGraph.setActorSurface(selected?.data ?? actorSurface())
      textarea?.setText("")
      stateGraph.setComposer({ input: "", parts: [] })
      dialog.clear()
      focusComposer()
      const selectedSurface = selected?.data ?? actorSurface()
      const selectedTarget = selectedSurface?.selectedTarget
      const hydrated = await loadActorHistory({
        laneID: selectedTarget?.laneId ?? target.laneID,
        actorID: selectedTarget?.actorId ?? target.actorID,
      }, selectedSurface)
      if (!hydrated) await loadRuntimeSession(activeSessionID)
    }

    const options: DialogSelectOption<ActorListTarget>[] = [
      ...surface.conversationLanes.map((lane) => ({
        title: lane.displayName,
        value: { laneID: lane.laneId, actorID: lane.actorId },
        description: [actorStatusText(lane.status), summarizeBackendIdentity(lane), summarizeWorkContext(lane.metadata)].filter(Boolean).join(" · "),
        meta: lane.initialized ? "已初始化" : "未初始化",
        detail: [summarizeBackendIdentity(lane), lane.actorId ?? lane.actorKey ?? lane.laneId].filter(Boolean).join(" · "),
        footer: surface.selectedTarget.laneId === lane.laneId ? "当前" : undefined,
        category: "Conversation Lanes",
        onSelect: () => {
          void selectTarget({ laneID: lane.laneId, actorID: lane.actorId })
        },
      })),
      ...surface.actorLanes.map((actorLane) => ({
        title: `${actorLane.displayName} · ${actorLane.actorType}`,
        value: {
          laneID: actorLane.actorType === "primary" ? "lane:primary" : undefined,
          actorID: actorLane.actorId,
          cancellable: actorLane.cancellable,
          turnID: actorLane.activeTurnId,
        },
        description: [actorStatusText(actorLane.runtimeStatus), actorLane.cancellable ? "可取消" : "不可取消", summarizeWorkContext(actorLane.metadata)].filter(Boolean).join(" · "),
        meta: actorLane.actorKey,
        detail: actorLane.transcriptKey.actorKey,
        footer: surface.selectedTarget.actorId === actorLane.actorId ? "当前" : undefined,
        category: "Actor Lanes",
        onSelect: () => {
          void selectTarget({
            laneID: actorLane.actorType === "primary" ? "lane:primary" : undefined,
            actorID: actorLane.actorId,
          })
        },
      })),
    ]

    dialog.replace(() => (
      <DialogSelect
        title="Actor列表"
        skipFilter={false}
        options={options}
        current={surface.selectedTarget.actorId || surface.selectedTarget.laneId
          ? {
              laneID: surface.selectedTarget.laneId,
              actorID: surface.selectedTarget.actorId,
            }
          : undefined}
        keybind={[
          {
            title: "取消",
            keybind: Keybind.parse("c")[0]!,
            onTrigger: (option) => {
              void cancelTarget(option.value)
            },
          },
          {
            title: "发送输入",
            keybind: Keybind.parse("s")[0]!,
            onTrigger: (option) => {
              void sendDraftToTarget(option.value)
            },
          },
        ]}
      />
    ))
  }
  const openUsageGuide = () => {
    if (props.onOpenUsage) {
      props.onOpenUsage()
      return
    }
    dialog.replace(() => (
      <DialogSelect
        title="使用说明"
        skipFilter={true}
        options={[
          {
            title: "Keyboard Shortcuts",
            value: "shortcuts",
            description: "Browse categorized keyboard bindings",
            onSelect: () => openShortcutOverview(),
          },
        ]}
      />
    ))
  }
  const openSlashCommandList = () => {
    dialog.replace(() => (
      <DialogSelect
        title="Slash Commands"
        skipFilter={true}
        options={SLASH_COMMANDS.map((item) => ({
          title: [item.slash, ...(item.aliases ?? [])].join(", "),
          value: item.command,
          description: item.description,
          meta: item.command,
        }))}
      />
    ))
  }
  const openFunctionMenu = () => {
    if (props.onOpenFunctionMenu) {
      props.onOpenFunctionMenu()
      return
    }
    dialog.replace(() => (
      <DialogSelect
        title="功能菜单"
        skipFilter={true}
        options={[
          {
            title: "使用说明",
            value: "usage",
            description: "Open usage guidance and shortcuts",
            onSelect: () => openUsageGuide(),
          },
          {
            title: "Quit",
            value: "quit",
            description: "Exit the current TUI session",
            onSelect: () => {
              dialog.clear()
              void exit()
            },
          },
          {
            title: "Slash Commands",
            value: "slash-commands",
            description: "Browse supported slash commands",
            onSelect: () => openSlashCommandList(),
          },
        ]}
      />
    ))
  }

  createEffect(() => {
    if (bootstrapped) return
    bootstrapped = true
    focusComposer()
    if (props.runtime) {
      void bootstrapRuntime()
      return
    }
    if (props.initialPrompt?.trim()) {
      textarea?.setText(props.initialPrompt)
      void submitPrompt({ input: props.initialPrompt, parts: [] }, () => {
        textarea?.setText("")
        textarea?.focus()
      })
    }
  })

  createEffect(() => {
    const currentRoute = route()
    if (!props.runtime) return
    if (currentRoute.type !== "session") return
    if (currentRoute.sessionID === sessionID()) return
    void loadRuntimeSession(currentRoute.sessionID)
  })

  useKeyboard((event) => {
    if (
      dialog.stack.length === 0
      && !activePermission()
      && !activeQuestion()
      && keybind.match("session_interrupt", event)
    ) {
      event.preventDefault()
      event.stopPropagation()

      const activeSessionID = sessionID()
      if (!props.runtime || !activeSessionID) {
        lastSessionInterruptAt = 0
        return
      }

      const now = Date.now()
      const isDoublePress = now - lastSessionInterruptAt <= SESSION_INTERRUPT_DOUBLE_PRESS_MS
      lastSessionInterruptAt = now
      if (!isDoublePress || sessionInterruptInFlight) return

      sessionInterruptInFlight = true
      void props.runtime.client.session
        .abort({ sessionID: activeSessionID })
        .catch(toast.error)
        .finally(() => {
          sessionInterruptInFlight = false
        })
      return
    }

    if (event.defaultPrevented) return

    const isShiftVerticalArrow = event.shift && (event.name === "up" || event.name === "down")

    if (!isShiftVerticalArrow && shouldRouteHistoryArrowKeys() && event.name === "up") {
      focusHistory()
      disableAutoFollowHistory()
      scrollByLine(scrollbox, "up")
      scheduleAutoFollowSync()
      event.preventDefault()
      return
    }
    if (!isShiftVerticalArrow && shouldRouteHistoryArrowKeys() && event.name === "down") {
      focusHistory()
      disableAutoFollowHistory()
      scrollByLine(scrollbox, "down")
      scheduleAutoFollowSync()
      event.preventDefault()
      return
    }
    if (event.name === "pageup") {
      focusHistory()
      disableAutoFollowHistory()
      scrollByViewport(scrollbox, "up")
      scheduleAutoFollowSync()
      event.preventDefault()
      return
    }
    if (event.name === "pagedown") {
      focusHistory()
      disableAutoFollowHistory()
      scrollByViewport(scrollbox, "down")
      scheduleAutoFollowSync()
      event.preventDefault()
      return
    }
    if (event.name === "home" && (historyFocused() || !composerHasDraft() || event.ctrl)) {
      focusHistory()
      disableAutoFollowHistory()
      scrollToEdge(scrollbox, "top")
      event.preventDefault()
      return
    }
    if (event.name === "end" && (historyFocused() || !composerHasDraft() || event.ctrl)) {
      focusHistory()
      scrollToEdge(scrollbox, "bottom")
      setAutoFollowHistory(true)
      syncScrollboxStickyState(true)
      event.preventDefault()
    }
  })

  onMount(() => {
    const assertTerminalModes = () => {
      // iTerm2 touchpad scroll frequently escapes to shell scrollback instead of
      // arriving as wheel events. In that terminal we prefer alternate scroll
      // mode so gestures are translated into arrow keys that our history handler
      // already consumes. Other terminals keep OpenTUI mouse reporting enabled.
      // @ts-expect-error writeOut exists at runtime on the renderer
      renderer.writeOut(
        scrollMode === "alternate" ? "\x1b[?1007h" : "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h",
      )
    }

    const releaseTerminalModes = () => {
      if (scrollMode !== "alternate") return
      // @ts-expect-error writeOut exists at runtime on the renderer
      renderer.writeOut("\x1b[?1007l")
    }

    assertTerminalModes()
    const guard = setInterval(assertTerminalModes, 1500)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    maybeScrollToBottom(true)
    onCleanup(() => {
      clearInterval(guard)
      clearInterval(clock)
      releaseTerminalModes()
    })
  })

  onCleanup(() => {
    disposed = true
    runtimeUnsub?.()
    for (const timer of timers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    timers.clear()
    fallbackStateGraph?.dispose()
  })

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseScroll={handleGlobalWheel}
      onMouseUp={async () => {
        await copyRendererSelection(renderer as never, {
          onCopied: () => toast.show({ message: "Copied to clipboard", variant: "info" }),
          onError: toast.error,
        })
      }}
    >
      <box
        flexGrow={1}
        minHeight={0}
        flexDirection="column"
        backgroundColor={theme.background}
        onMouseDown={focusHistory}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          focusHistory()
        }}
      >
        <scrollbox
          ref={(value: ScrollBoxRenderable) => {
            scrollbox = value
            syncScrollboxStickyState()
            props.onScrollboxReady?.(value)
          }}
          style={{
            width: "100%",
            height: "100%",
            flexGrow: 1,
            rootOptions: {
              backgroundColor: theme.background,
            },
            wrapperOptions: {
              backgroundColor: theme.background,
            },
            viewportOptions: {
              backgroundColor: theme.background,
            },
            contentOptions: {
              width: "100%",
              gap: 0,
              backgroundColor: theme.background,
            },
            verticalScrollbarOptions: {
              visible: true,
              trackOptions: {
                foregroundColor: theme.secondary,
                backgroundColor: theme.backgroundElement,
              },
            },
            horizontalScrollbarOptions: {
              visible: false,
            },
          }}
          focused={historyFocused()}
          scrollX={false}
          scrollY={true}
          stickyScroll={autoFollowHistory()}
          stickyStart="bottom"
          paddingTop={0}
          paddingBottom={0}
          onMouseUp={() => {
            if (renderer.getSelection()?.getSelectedText()) return
            focusHistory()
          }}
          onMouseScroll={handleHistorySurfaceWheel}
        >
          <box
            width="100%"
            onMouseUp={() => {
              if (renderer.getSelection()?.getSelectedText()) return
              focusHistory()
            }}
          >
            <sessionContext.Provider
              value={{
                width: 120,
                sessionID: sessionID() ?? "tui_a1",
                directory: props.directory,
                activePermissionCallID: activePermissionCallID(),
                conceal: () => false,
                showThinking: () => true,
                showTimestamps: () => true,
                showDetails: () => true,
                diffWrapMode: () => "word",
                keybindLabel: () => "",
                navigateToSession: () => {},
                agentColor: createTuiA1AgentColor,
              }}
            >
              <MessageCards messages={messages()} />
            </sessionContext.Provider>
          </box>
        </scrollbox>
        <box width="100%">
          <text fg={historyIndicatorColor()} wrapMode="char" onMouseScroll={handleManualHistoryWheel}>
            {historyIndicatorText()}
          </text>
        </box>
      </box>

      <Show when={activePermission() || activeQuestion()}>
        <ApprovalPane
          permission={activePermission()}
          question={activeQuestion()}
          onPermissionReply={(request, reply) => {
            void replyPermission(request, reply)
          }}
          onQuestionReply={(request, answers) => {
            void replyQuestion(request, answers)
          }}
          onQuestionReject={(request) => {
            void rejectQuestion(request)
          }}
        />
      </Show>

      <Composer
        busy={busy()}
        blocked={composerBlocked()}
        blockLabel={composerBlockLabel()}
        directory={props.directory}
        focused={composerFocused()}
        statusLabel={sessionLoadLabel() ?? runtimeStatusLabel()}
        selectionLabel={composerSelectionLabel()}
        userInputHistory={currentUserInputHistory().map((entry) => ({ input: entry.text, parts: [] }))}
        onHistoryScrollRequest={handleManualHistoryWheel}
        onFocusRequest={focusComposer}
        onReady={(value) => {
          textarea = value
        }}
        onSubmit={(prompt, clear) => {
          void submitPrompt(prompt, clear)
        }}
      />

      <BottomBar
        busy={busy()}
        metricsLabel={bottomBarMetricsLabel()}
        questionnaireLabel={questionnaireFooterLabel()}
        questionnaireHighlighted={questionnaireCenter().pendingCount > 0}
        onOpenQuestionnaires={openQuestionnaireCenter}
        onOpenMessageList={openMessageList}
        onOpenSessionList={openSessionList}
        onOpenActorList={openActorList}
        onOpenFunctionMenu={openFunctionMenu}
      />
    </box>
  )
}
