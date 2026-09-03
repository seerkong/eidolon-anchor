import type { TuiA1Message } from "../data"

export type VirtualHistoryWindow = {
  startIndex: number
  endIndex: number
  messages: TuiA1Message[]
  topSpacer: number
  bottomSpacer: number
  totalHeight: number
}

const TOOL_TEXT_PREVIEW_CHARS = 4000
const TOOL_TEXT_PREVIEW_LINES = 24

function lineDisplayWidth(text: string): number {
  let width = 0
  for (const char of text) width += char.codePointAt(0)! > 0xff ? 2 : 1
  return width
}

function wrappedLines(text: string, width: number): number {
  return String(text ?? "").split(/\r?\n/).reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(lineDisplayWidth(line) / Math.max(1, width))),
    0,
  )
}

function previewText(text: string, maxLines: number, maxChars = TOOL_TEXT_PREVIEW_CHARS): string {
  const lines = String(text ?? "").split(/\r?\n/).slice(0, maxLines)
  return lines.join("\n").slice(0, maxChars)
}

function runtimeToolPreview(message: Extract<TuiA1Message, { kind: "tool"; source: "runtime-part" }>): {
  text: string
  chrome: number
} | null {
  if (message.tool === "bash") {
    return { text: previewText(String(message.metadata.output ?? ""), 10), chrome: 6 }
  }
  if (message.tool === "edit" || message.tool === "multiedit") {
    return { text: previewText(String(message.metadata.diff ?? ""), TOOL_TEXT_PREVIEW_LINES), chrome: 6 }
  }
  if (message.tool === "write") {
    return { text: previewText(String(message.input.content ?? ""), TOOL_TEXT_PREVIEW_LINES), chrome: 6 }
  }
  if (message.tool === "read" && message.metadata.contextResource) {
    return {
      text: previewText(String(message.metadata.contextResource.contentText ?? ""), TOOL_TEXT_PREVIEW_LINES),
      chrome: 7,
    }
  }
  return null
}

export function estimateHistoryMessageHeight(message: TuiA1Message, width: number): number {
  const contentWidth = Math.max(12, width - 6)
  if (message.kind === "user" || message.kind === "assistant") {
    // Include the inter-card margin in the virtual geometry. A conservative
    // first-frame estimate prevents tail-follow from stopping above the newest
    // card before render measurements arrive.
    return Math.max(5, wrappedLines(message.text, contentWidth) + 4)
  }
  if (message.source === "summary") {
    return Math.max(5, wrappedLines(message.summary, contentWidth) + 4)
  }
  const preview = runtimeToolPreview(message)
  if (!preview) return 4
  return Math.max(6, wrappedLines(preview.text, contentWidth) + preview.chrome)
}

/** Pure viewport projection used by the renderer and deterministic tests. */
export function computeVirtualHistoryWindow(input: {
  messages: TuiA1Message[]
  scrollTop: number
  viewportHeight: number
  width: number
  overscanViewports?: number
  measuredHeights?: ReadonlyMap<string, number>
}): VirtualHistoryWindow {
  const heights = input.messages.map((message) => (
    input.measuredHeights?.get(message.id) ?? estimateHistoryMessageHeight(message, input.width)
  ))
  const offsets: number[] = [0]
  for (const height of heights) offsets.push(offsets[offsets.length - 1] + height)
  const totalHeight = offsets[offsets.length - 1] ?? 0
  if (input.messages.length === 0) {
    return { startIndex: 0, endIndex: 0, messages: [], topSpacer: 0, bottomSpacer: 0, totalHeight: 0 }
  }

  const viewportHeight = Math.max(1, input.viewportHeight)
  const scrollTop = Math.min(Math.max(0, input.scrollTop), Math.max(0, totalHeight - viewportHeight))
  const overscan = viewportHeight * Math.max(0, input.overscanViewports ?? 1)
  const startY = Math.max(0, scrollTop - overscan)
  const endY = Math.min(totalHeight, scrollTop + viewportHeight + overscan)
  let startIndex = 0
  while (startIndex < heights.length && offsets[startIndex + 1] <= startY) startIndex += 1
  let endIndex = startIndex
  while (endIndex < heights.length && offsets[endIndex] < endY) endIndex += 1
  if (endIndex === startIndex) endIndex = Math.min(input.messages.length, startIndex + 1)

  return {
    startIndex,
    endIndex,
    messages: input.messages.slice(startIndex, endIndex),
    topSpacer: offsets[startIndex] ?? 0,
    bottomSpacer: Math.max(0, totalHeight - (offsets[endIndex] ?? totalHeight)),
    totalHeight,
  }
}

export function prependScrollAnchor(input: { insertedHeight: number; scrollTop: number }): number {
  return Math.max(0, input.scrollTop + Math.max(0, input.insertedHeight))
}
