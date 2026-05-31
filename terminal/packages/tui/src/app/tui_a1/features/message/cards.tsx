/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useTerminalDimensions } from "@opentui/solid"
import type { BoxRenderable } from "@opentui/core"
import { tuiA1Theme as theme } from "../../theme"
import { formatTuiA1Selection, type TuiA1Message } from "../../data"
import { resolveTuiA1ToolCard } from "./model/tool-registry"

type ToolMessage = Extract<TuiA1Message, { kind: "tool" }>
type SummaryToolMessage = Extract<ToolMessage, { source: "summary" }>
type RuntimeToolMessage = Extract<ToolMessage, { source: "runtime-part" }>
type UserOrAssistantMessage = Exclude<TuiA1Message, ToolMessage>
type UserMessage = UserOrAssistantMessage & { kind: "user" }
type AssistantMessage = UserOrAssistantMessage & { kind: "assistant" }

const FRAME_SCROLLBAR_GUTTER_WIDTH = 1
const MESSAGE_TEXT_CHUNK_CHARS = 2400
const STREAMING_TEXT_TAIL_CHARS = 3200

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0)!
    width += codePoint > 0xff && !/^[─╭╮╰╯]$/.test(char) ? 2 : 1
  }
  return width
}

function fitLine(left: string, right: string, width: number, fill = " "): string {
  const safeWidth = Math.max(1, width)
  const rightWidth = displayWidth(right)
  const leftBudget = Math.max(0, safeWidth - rightWidth)
  let fittedLeft = ""
  let fittedWidth = 0
  for (const char of left) {
    const charWidth = displayWidth(char)
    if (fittedWidth + charWidth > leftBudget) break
    fittedLeft += char
    fittedWidth += charWidth
  }
  const gapWidth = Math.max(0, safeWidth - fittedWidth - rightWidth)
  return `${fittedLeft}${fill.repeat(gapWidth)}${right}`
}

export function frameLine(params: {
  leftCorner: string
  rightCorner: string
  leftLabel?: string
  rightLabel?: string
  width: number
}): string {
  const width = Math.max(2, params.width)
  const left = params.leftLabel ? `${params.leftCorner}─ ${params.leftLabel} ` : params.leftCorner
  const right = params.rightLabel ? `─ ${params.rightLabel} ─${params.rightCorner}` : params.rightCorner
  return fitLine(left, right, width, "─")
}

function createFrameWidth() {
  const dimensions = useTerminalDimensions()
  const [measuredWidth, setMeasuredWidth] = createSignal(0)
  const width = createMemo(() => {
    const containerWidth = measuredWidth() > 0 ? measuredWidth() : dimensions().width
    return Math.max(2, containerWidth - FRAME_SCROLLBAR_GUTTER_WIDTH)
  })

  return { width, setMeasuredWidth }
}

function formatToolInput(input?: Record<string, string | number | boolean>): string {
  if (!input) return ""
  const pairs = Object.entries(input).map(([key, value]) => `${key}=${value}`)
  return pairs.length ? `[${pairs.join(", ")}]` : ""
}

export function streamingTextWindow(text: string): string {
  if (text.length <= STREAMING_TEXT_TAIL_CHARS) return text
  return text.slice(-STREAMING_TEXT_TAIL_CHARS)
}

export function splitMessageTextForRender(text: string): string[] {
  if (!text) return [""]
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += MESSAGE_TEXT_CHUNK_CHARS) {
    chunks.push(text.slice(index, index + MESSAGE_TEXT_CHUNK_CHARS))
  }
  return chunks
}

function CardFrame(props: {
  borderColor: any
  eyebrow: string
  title: string
  titleColor: any
  startedAt: number
  completedAt?: number
  children: any
}) {
  const frame = createFrameWidth()
  const headerLabel = createMemo(() => [props.eyebrow, props.title].filter(Boolean).join(" "))
  const topLine = createMemo(() =>
    frameLine({
      leftCorner: "╭",
      rightCorner: "╮",
      leftLabel: headerLabel(),
      rightLabel: formatTimestamp(props.startedAt),
      width: frame.width(),
    }),
  )
  const bottomLine = createMemo(() =>
    frameLine({
      leftCorner: "╰",
      rightCorner: "╯",
      rightLabel: props.completedAt ? formatTimestamp(props.completedAt) : undefined,
      width: frame.width(),
    }),
  )

  return (
    <box
      width="100%"
      renderBefore={function () {
        const el = this as BoxRenderable
        frame.setMeasuredWidth(el.width)
      }}
    >
      <text fg={props.borderColor}>{topLine()}</text>
      <box width="100%" paddingLeft={1} backgroundColor={theme.backgroundPanel}>
        {props.children}
      </box>
      <text fg={props.borderColor}>{bottomLine()}</text>
    </box>
  )
}

function UserCard(props: { message: UserMessage }) {
  return (
    <CardFrame
      borderColor={theme.userBorder}
      eyebrow="USER"
      title=""
      titleColor={theme.text}
      startedAt={props.message.createdAt}
      completedAt={props.message.completedAt}
    >
      <text fg={theme.text} content={props.message.text} />
    </CardFrame>
  )
}

function AssistantCard(props: { message: AssistantMessage }) {
  const thinking = createMemo(() => props.message.mode === "think")
  const streaming = createMemo(() => Boolean(props.message.streaming))
  const displayText = createMemo(() => (streaming() ? streamingTextWindow(props.message.text) : props.message.text))
  const displayChunks = createMemo(() => splitMessageTextForRender(displayText()))
  const metadata = createMemo(() =>
    props.message.selection ? `(${formatTuiA1Selection(props.message.selection)})` : props.message.label ?? "Local Agent",
  )

  return (
    <CardFrame
      borderColor={thinking() ? theme.textMuted : theme.assistantBorder}
      eyebrow={thinking() ? "THINKING" : "ASSISTANT"}
      title={metadata()}
      titleColor={thinking() ? theme.textMuted : theme.secondary}
      startedAt={props.message.createdAt}
      completedAt={props.message.completedAt}
    >
      <For each={displayChunks()}>
        {(chunk) => <text fg={thinking() ? theme.textMuted : theme.text} content={chunk} />}
      </For>
    </CardFrame>
  )
}

function SummaryToolCard(props: { message: SummaryToolMessage }) {
  const badge = createMemo(() => (props.message.status === "running" ? " RUNNING " : " DONE "))
  const badgeFg = createMemo(() => (props.message.status === "running" ? theme.background : theme.backgroundPanel))
  const badgeBg = createMemo(() => (props.message.status === "running" ? theme.warning : theme.success))
  const inputLine = createMemo(() => formatToolInput(props.message.input))
  const frame = createFrameWidth()
  const topLine = createMemo(() =>
    frameLine({
      leftCorner: "╭",
      rightCorner: "╮",
      leftLabel: `TOOL ${props.message.tool}`,
      rightLabel: formatTimestamp(props.message.createdAt),
      width: frame.width(),
    }),
  )
  const bottomLine = createMemo(() =>
    frameLine({
      leftCorner: "╰",
      rightCorner: "╯",
      rightLabel: props.message.completedAt ? formatTimestamp(props.message.completedAt) : undefined,
      width: frame.width(),
    }),
  )

  return (
    <box
      width="100%"
      renderBefore={function () {
        const el = this as BoxRenderable
        frame.setMeasuredWidth(el.width)
      }}
    >
      <text fg={theme.toolBorder}>{topLine()}</text>
      <box width="100%" paddingLeft={1} backgroundColor={theme.backgroundElement}>
        <text fg={theme.text}>
          <span style={{ bg: badgeBg(), fg: badgeFg(), bold: true }}>{badge()}</span>
          <Show when={inputLine()}>
            <span style={{ fg: theme.textMuted }}> {inputLine()}</span>
          </Show>
        </text>
        <text fg={theme.textMuted} content={props.message.summary} />
      </box>
      <text fg={theme.toolBorder}>{bottomLine()}</text>
    </box>
  )
}

function RuntimeToolCard(props: { message: RuntimeToolMessage }) {
  const card = createMemo(() => resolveTuiA1ToolCard(props.message.tool))
  return (
    <Dynamic
      component={card()}
      tool={props.message.tool}
      input={props.message.input}
      metadata={props.message.metadata}
      output={props.message.output}
      part={props.message.part}
    />
  )
}

function MessageCard(props: { message: () => TuiA1Message; index: () => number }) {
  return (
    <box width="100%" marginTop={props.index() === 0 ? 0 : 1}>
      <Switch>
        <Match when={props.message().kind === "user"}>
          <UserCard message={props.message() as UserMessage} />
        </Match>
        <Match when={props.message().kind === "assistant"}>
          <AssistantCard message={props.message() as AssistantMessage} />
        </Match>
        <Match when={props.message().kind === "tool" && (props.message() as ToolMessage).source === "runtime-part"}>
          <RuntimeToolCard message={props.message() as RuntimeToolMessage} />
        </Match>
        <Match when={props.message().kind === "tool" && (props.message() as ToolMessage).source === "summary"}>
          <SummaryToolCard message={props.message() as SummaryToolMessage} />
        </Match>
      </Switch>
    </box>
  )
}

export function MessageCards(props: { messages: TuiA1Message[] }) {
  const messagesById = createMemo(() => new Map(props.messages.map((message) => [message.id, message] as const)))
  const messageIds = createMemo(() => props.messages.map((message) => message.id))

  return (
    <For each={messageIds()}>
      {(messageID, index) => {
        const message = createMemo(() => messagesById().get(messageID))
        return (
          <Show when={message()}>
            <MessageCard message={() => message()!} index={index} />
          </Show>
        )
      }}
    </For>
  )
}
