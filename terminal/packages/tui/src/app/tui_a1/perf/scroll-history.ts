import type { ScrollBoxRenderable } from "@opentui/core"

export type TuiA1ScrollDirection = "up" | "down"
export type TuiA1ScrollEdge = "top" | "bottom"

type TuiA1ScrollWheelEvent = {
  scroll?: { direction?: string }
  preventDefault: () => void
  stopPropagation: () => void
}

export function scrollByViewport(
  scrollbox: ScrollBoxRenderable | undefined,
  direction: TuiA1ScrollDirection,
  fraction = 0.75,
) {
  if (!scrollbox) return
  const amount = Math.max(3, Math.floor(scrollbox.height * fraction))
  scrollbox.scrollBy(direction === "up" ? -amount : amount)
}

export function scrollByLine(
  scrollbox: ScrollBoxRenderable | undefined,
  direction: TuiA1ScrollDirection,
  lines = 3,
) {
  if (!scrollbox) return
  scrollbox.scrollBy(direction === "up" ? -lines : lines)
}

export function scrollToEdge(scrollbox: ScrollBoxRenderable | undefined, edge: TuiA1ScrollEdge) {
  if (!scrollbox) return
  scrollbox.scrollTo(edge === "top" ? 0 : scrollbox.scrollHeight)
}

export function handleHistoryWheelScroll(
  scrollbox: ScrollBoxRenderable | undefined,
  event: TuiA1ScrollWheelEvent,
) {
  if (!scrollbox || !event.scroll?.direction) return
  const amount = Math.max(3, Math.floor(scrollbox.height / 5))
  if (event.scroll.direction === "up") scrollbox.scrollBy(-amount)
  if (event.scroll.direction === "down") scrollbox.scrollBy(amount)
  event.preventDefault()
  event.stopPropagation()
}
