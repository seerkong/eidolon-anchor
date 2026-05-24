import { Clipboard } from "../../support/util/clipboard"

type RendererSelection = {
  getSelectedText(): string
}

type SelectionRenderer = {
  getSelection(): RendererSelection | undefined
  clearSelection(): void
  writeOut?(value: string): void
}

export async function copyRendererSelection(
  renderer: SelectionRenderer,
  options?: {
    onCopied?: () => void
    onError?: (error: unknown) => void
  },
) {
  const text = renderer.getSelection()?.getSelectedText()
  if (!text || text.length === 0) return false

  const base64 = Buffer.from(text).toString("base64")
  const osc52 = `\x1b]52;c;${base64}\x07`
  const finalOsc52 = process.env["TMUX"] ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52

  try {
    renderer.writeOut?.(finalOsc52)
    await Clipboard.copy(text)
    options?.onCopied?.()
  } catch (error) {
    options?.onError?.(error)
  } finally {
    renderer.clearSelection()
  }

  return true
}
