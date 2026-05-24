import { createEffect, createMemo, createSignal, For, onCleanup } from "solid-js"
import type { ColorInput } from "@opentui/core"
import { useTheme } from "../../../providers/theme"
import { createColors, createFrames } from "../../spinner"

export type BusyBeaconState = "busy" | "retry" | "idle" | "error" | "aborted"

export function BusyBeacon(props: {
  state: BusyBeaconState
  side: "left" | "right"
  color: ColorInput
  enabled: boolean
  width?: number
}) {
  const theme = (() => {
    try {
      return useTheme().theme
    } catch {
      return {
        warning: "#f5c56b",
        error: "#ff7a7a",
        textMuted: "#76808c",
      }
    }
  })()

  const palette = createMemo(() => {
    switch (props.state) {
      case "retry":
      case "error":
        return {
          color: props.state === "retry" ? theme.warning : theme.error,
          fallback: "■⬝⬝⬝⬝⬝⬝■",
          fg: props.state === "retry" ? theme.warning : theme.error,
        }
      case "aborted":
        return {
          color: theme.warning,
          fallback: "⬝■⬝⬝⬝⬝■⬝",
          fg: theme.warning,
        }
      case "idle":
        return {
          color: props.color,
          fallback: "⬝⬝⬝⬝⬝⬝⬝⬝",
          fg: theme.textMuted,
        }
      default:
        return {
          color: props.color,
          fallback: "■⬝⬝⬝⬝⬝⬝■",
          fg: props.color,
        }
    }
  })

  const animated = createMemo(() => props.enabled && (props.state === "busy" || props.state === "retry"))
  const width = () => props.width ?? 8
  const frames = createMemo(() =>
    createFrames({
      color: palette().color,
      style: "blocks",
      inactiveFactor: 0.6,
      minAlpha: 0.3,
      width: width(),
      mirror: props.side === "right",
    }),
  )
  const colorGen = createMemo(() =>
    createColors({
      color: palette().color,
      style: "blocks",
      inactiveFactor: 0.6,
      minAlpha: 0.3,
      width: width(),
      mirror: props.side === "right",
    }),
  )
  const [frameIndex, setFrameIndex] = createSignal(0)

  createEffect(() => {
    if (!animated()) {
      setFrameIndex(0)
      return
    }
    const total = frames().length
    const timer = setInterval(() => {
      setFrameIndex((current) => (current + 1) % total)
    }, 40)
    onCleanup(() => clearInterval(timer))
  })

  const currentFrame = createMemo(() => frames()[frameIndex()] ?? palette().fallback)
  const cells = createMemo(() =>
    currentFrame()
      .split("")
      .map((char, index) => ({
        char,
        color: colorGen()(frameIndex(), index, 0, width()),
      })),
  )

  return (
    <box flexShrink={0}>
      {animated() ? (
        <text>
          <For each={cells()}>
            {(cell) => <span style={{ fg: cell.color }}>{cell.char}</span>}
          </For>
        </text>
      ) : (
        <text fg={palette().fg}>{palette().fallback}</text>
      )}
    </box>
  )
}
