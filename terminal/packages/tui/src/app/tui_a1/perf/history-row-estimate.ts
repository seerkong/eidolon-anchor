import type { TuiA1Message } from "../data"

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
    // Initial hint only; the shared runtime replaces it with measured outer
    // geometry. This module does not choose a window or a scroll position.
    return Math.max(5, wrappedLines(message.text, contentWidth) + 4)
  }
  if (message.source === "summary") {
    return Math.max(5, wrappedLines(message.summary, contentWidth) + 4)
  }
  const preview = runtimeToolPreview(message)
  if (!preview) return 4
  return Math.max(6, wrappedLines(preview.text, contentWidth) + preview.chrome)
}
