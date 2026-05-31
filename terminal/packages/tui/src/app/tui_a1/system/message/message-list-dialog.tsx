/** @jsxImportSource @opentui/solid */
// Message List is a dense operational surface for the active in-memory timeline.
// Keep row height stable and actions explicit so users can quickly fork or revert
// from a specific message without scanning the full transcript.
import { RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js"
import { useRuntimeClient } from "../../../../providers/runtime-client"
import { useTheme } from "../../../../providers/theme"
import { Locale } from "../../../../support/util/locale"
import type { TuiA1Message } from "../../data"
import { useRoute } from "../../route/route-context"
import { useDialog } from "../../../../ui/dialog/context"
import "opentui-spinner/solid"

const MESSAGE_INSET = 1
const MESSAGE_TIME_WIDTH = 18
const MESSAGE_ACTION_WIDTH = 24

type MessageListOption = {
  id: string
  targetMessageID: string
  role: string
  title: string
  preview: string
  created: string
  createdAt: number
}

function normalizePreview(value: string | undefined, fallback: string) {
  return (value ?? "").replace(/\s+/g, " ").trim() || fallback
}

function messageTitle(message: TuiA1Message) {
  if (message.kind === "tool") {
    return `TOOL ${message.tool}`
  }
  if (message.kind === "assistant") {
    return message.mode === "think" ? "THINKING" : "ASSISTANT"
  }
  return "USER"
}

function messagePreview(message: TuiA1Message) {
  if (message.kind === "tool") {
    if ("summary" in message) return message.summary
    return message.output ?? message.tool
  }
  return message.text
}

function targetMessageID(message: TuiA1Message) {
  if (message.kind === "assistant" && message.parentID) return message.parentID
  if (message.kind === "tool" && "part" in message) return message.part.messageID
  const textSegment = message.id.match(/^(.*):text:\d+$/)
  return textSegment?.[1] ?? message.id
}

function moveIndex(current: number, direction: number, total: number) {
  if (total <= 0) return 0
  let next = current + direction
  if (next < 0) next = total - 1
  if (next >= total) next = 0
  return next
}

export function DialogMessageList(props: {
  messages: TuiA1Message[]
  sessionID?: string
}) {
  const dialog = useDialog()
  const route = useRoute()
  const sdk = useRuntimeClient()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [selected, setSelected] = createSignal(0)

  let scroll: ScrollBoxRenderable | undefined

  const dialogTextWidth = createMemo(() => Math.max(20, Math.floor(dimensions().width * 0.9) - MESSAGE_INSET * 2))
  const titleLimit = createMemo(() => Math.max(8, dialogTextWidth() - MESSAGE_ACTION_WIDTH - 3))
  const previewLimit = createMemo(() => Math.max(16, dialogTextWidth() - MESSAGE_TIME_WIDTH - 1))
  const options = createMemo<MessageListOption[]>(() =>
    [...props.messages]
      .filter((message) => message.id !== "runtime-ready" && message.id !== "runtime-connecting")
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((message) => ({
        id: message.id,
        targetMessageID: targetMessageID(message),
        role: messageTitle(message),
        title: Locale.truncate(`${message.id} ${messageTitle(message)}`, titleLimit()),
        preview: Locale.truncate(normalizePreview(messagePreview(message), "(No message text)"), previewLimit()),
        created: Locale.todayTimeOrDateTime(message.createdAt),
        createdAt: message.createdAt,
      })),
  )
  const active = createMemo(() => options()[selected()])
  const currentSessionID = createMemo(() => props.sessionID ?? (route.data.type === "session" ? route.data.sessionID : undefined))

  function scrollToSelected() {
    const option = active()
    if (!option) return
    scroll?.scrollChildIntoView(option.id)
  }

  function move(direction: number) {
    setSelected((current) => moveIndex(current, direction, options().length))
    queueMicrotask(scrollToSelected)
  }

  async function forkFromMessage(option = active()) {
    const sessionID = currentSessionID()
    if (!option || !sessionID) return
    const result = await sdk.client.session.fork({
      sessionID,
      messageID: option.targetMessageID,
    })
    if (!result.data) return
    route.navigate({
      type: "session",
      sessionID: result.data.id,
    })
    dialog.clear()
  }

  async function revertToMessage(option = active()) {
    const sessionID = currentSessionID()
    if (!option || !sessionID) return
    const result = await sdk.client.session.revert({
      sessionID,
      messageID: option.targetMessageID,
    })
    if (!result.data) return
    route.navigate({
      type: "session",
      sessionID,
    })
    dialog.clear()
  }

  createEffect(
    on(options, (list) => {
      if (selected() >= list.length) setSelected(Math.max(0, list.length - 1))
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
    if (event.ctrl && event.name === "f") {
      event.preventDefault()
      void forkFromMessage()
      return
    }
    if (event.ctrl && event.name === "r") {
      event.preventDefault()
      void revertToMessage()
    }
  })

  onMount(() => {
    dialog.setSize("large")
    dialog.setPaddingTop(0)
  })

  const rowBackground = (isActive: boolean) => (isActive ? theme.backgroundElement : RGBA.fromInts(0, 0, 0, 0))
  const rowPrimary = (isActive: boolean) => (isActive ? theme.text : theme.textMuted)
  const rowSecondary = (isActive: boolean) => (isActive ? theme.secondary : theme.textMuted)
  const actionText = (isActive: boolean) => (isActive ? theme.text : theme.secondary)

  return (
    <box flexDirection="column" height="100%" paddingTop={0} paddingBottom={0}>
      <box paddingLeft={MESSAGE_INSET} paddingRight={MESSAGE_INSET} height={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          消息列表
        </text>
      </box>
      <box height={1} />
      <box flexGrow={1} minHeight={0}>
        <Show
          when={options().length > 0}
          fallback={
            <box height="100%" paddingLeft={MESSAGE_INSET} paddingRight={MESSAGE_INSET}>
              <text fg={theme.textMuted}>当前会话没有可操作消息</text>
            </box>
          }
        >
          <scrollbox
            ref={(value: ScrollBoxRenderable) => {
              scroll = value
            }}
            height="100%"
            paddingLeft={MESSAGE_INSET}
            paddingRight={MESSAGE_INSET}
            scrollbarOptions={{ visible: false }}
          >
            <For each={options()}>
              {(option, index) => {
                const isActive = createMemo(() => index() === selected())
                return (
                  <box
                    id={option.id}
                    flexDirection="column"
                    height={2}
                    backgroundColor={rowBackground(isActive())}
                    onMouseOver={() => {
                      setSelected(index())
                    }}
                  >
                    <box flexDirection="row" height={1}>
                      <text flexGrow={1} fg={rowPrimary(isActive())} attributes={isActive() ? TextAttributes.BOLD : undefined} overflow="hidden">
                        {option.title}
                      </text>
                      <box flexShrink={0} width={MESSAGE_ACTION_WIDTH} flexDirection="row" justifyContent="flex-end" gap={1}>
                        <text
                          fg={actionText(isActive())}
                          attributes={TextAttributes.BOLD}
                          onMouseUp={(evt) => {
                            evt.stopPropagation()
                            void forkFromMessage(option)
                          }}
                        >
                          [分叉会话]
                        </text>
                        <text
                          fg={actionText(isActive())}
                          attributes={TextAttributes.BOLD}
                          onMouseUp={(evt) => {
                            evt.stopPropagation()
                            void revertToMessage(option)
                          }}
                        >
                          [回退至此]
                        </text>
                      </box>
                    </box>
                    <box flexDirection="row" height={1}>
                      <text flexGrow={1} fg={rowSecondary(isActive())} overflow="hidden">
                        {option.preview}
                      </text>
                      <box flexShrink={0} width={MESSAGE_TIME_WIDTH} flexDirection="row" justifyContent="flex-end">
                        <text fg={rowSecondary(isActive())} overflow="hidden">{option.created}</text>
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
      <box flexShrink={0} flexDirection="row" justifyContent="flex-end" paddingLeft={MESSAGE_INSET} paddingRight={MESSAGE_INSET}>
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
