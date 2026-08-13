/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, Show } from "solid-js"
import { OpenHorizontalBorder } from "../../../../../ui/primitives/border"
import { BoxRenderable, RGBA, TextAttributes } from "@opentui/core"
import type { ToolPart as ToolPartType } from "@terminal/core/AIAgent"
import { useRenderer, type JSX } from "@opentui/solid"
import { useSessionContext } from "./session-context"
import { filetype, normalizePath } from "./path-utils"
import { tuiA1Theme as theme } from "../../../theme"

const BLOCK_TOOL_TITLE_WIDTH_RATIO = 0.8

function displayWidth(value: string): number {
  let width = 0
  for (const char of value) {
    width += char.codePointAt(0)! > 0xff ? 2 : 1
  }
  return width
}

function takeLeadingDisplayWidth(value: string, maxWidth: number): string {
  let result = ""
  let width = 0
  for (const char of value) {
    const charWidth = displayWidth(char)
    if (width + charWidth > maxWidth) break
    result += char
    width += charWidth
  }
  return result
}

function takeTrailingDisplayWidth(value: string, maxWidth: number): string {
  const characters = Array.from(value)
  let result = ""
  let width = 0
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const char = characters[index]!
    const charWidth = displayWidth(char)
    if (width + charWidth > maxWidth) break
    result = char + result
    width += charWidth
  }
  return result
}

function fitBlockToolTitle(value: string, maxWidth: number): string {
  const safeWidth = Math.max(1, Math.floor(maxWidth))
  if (displayWidth(value) <= safeWidth) return value

  const ellipsis = "…"
  const ellipsisWidth = displayWidth(ellipsis)
  if (safeWidth <= ellipsisWidth) return ".".repeat(safeWidth)

  const remainingWidth = safeWidth - ellipsisWidth
  const leadingWidth = Math.ceil(remainingWidth * 0.55)
  const trailingWidth = remainingWidth - leadingWidth
  return `${takeLeadingDisplayWidth(value, leadingWidth)}${ellipsis}${takeTrailingDisplayWidth(value, trailingWidth)}`
}

export type ToolCardProps<T = unknown> = {
  input: Record<string, any>
  metadata: Record<string, any>
  permission?: Record<string, any>
  tool: string
  output?: string
  part: ToolPartType
}

export function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  children: JSX.Element
  part: ToolPartType
}) {
  const [margin, setMargin] = createSignal(0)
  const ctx = useSessionContext()

  const permission = createMemo(() => ctx.activePermissionCallID === props.part.callID)
  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (props.complete) return theme.textMuted
    return theme.text
  })
  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))
  const denied = createMemo(
    () =>
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  return (
    <box
      marginTop={margin()}
      paddingLeft={3}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) return
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
        }
      }}
    >
      <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
        <Show fallback={<>~ {props.pending}</>} when={props.complete}>
          <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
        </Show>
      </text>
      <Show when={error() && !denied()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

export function BlockTool(props: {
  title: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPartType
  borderColor?: RGBA
}) {
  const renderer = useRenderer()
  const ctx = useSessionContext()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  const title = createMemo(() =>
    fitBlockToolTitle(props.title, Math.floor(ctx.width * BLOCK_TOOL_TITLE_WIDTH_RATIO)),
  )
  return (
    <box
      border={OpenHorizontalBorder.border}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={OpenHorizontalBorder.customBorderChars}
      borderColor={props.borderColor ?? theme.toolBorder}
      title={` ${title()} `}
      titleAlignment="left"
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

export function formatInput(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

export { filetype, normalizePath }
