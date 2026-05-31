/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For } from "solid-js"
import { useTheme } from "../../providers/theme"

type TipPart = { text: string; highlight: boolean }

function parse(tip: string): TipPart[] {
  const parts: TipPart[] = []
  const regex = /\{highlight\}(.*?)\{\/highlight\}/g
  const found = Array.from(tip.matchAll(regex))
  const state = found.reduce(
    (acc, match) => {
      const start = match.index ?? 0
      if (start > acc.index) {
        acc.parts.push({ text: tip.slice(acc.index, start), highlight: false })
      }
      acc.parts.push({ text: match[1], highlight: true })
      acc.index = start + match[0].length
      return acc
    },
    { parts, index: 0 },
  )

  if (state.index < tip.length) {
    parts.push({ text: tip.slice(state.index), highlight: false })
  }

  return parts
}

export function Tips() {
  const theme = useTheme().theme
  const parts = parse(TIPS[Math.floor(Math.random() * TIPS.length)])

  return (
    <box flexDirection="row" maxWidth="100%">
      <text flexShrink={0} style={{ fg: theme.warning }}>
        ● Tip{" "}
      </text>
      <text flexShrink={1}>
        <For each={parts}>
          {(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}
        </For>
      </text>
    </box>
  )
}

const TIPS = [
  "Press {highlight}Ctrl+P{/highlight} to open the command palette for sessions, models, providers and system surfaces",
  "Use {highlight}/status{/highlight} or {highlight}Ctrl+X S{/highlight} to inspect the current system facts surface",
  "Use {highlight}/session{/highlight} or {highlight}Ctrl+X L{/highlight} to resume an existing conversation",
  "Use {highlight}/models{/highlight} or {highlight}Ctrl+X M{/highlight} to switch the current model",
  "Use {highlight}/agents{/highlight} or {highlight}Ctrl+X A{/highlight} to inspect available agents",
  "Use {highlight}/theme{/highlight} or {highlight}Ctrl+X T{/highlight} to adjust the official shell appearance",
  "Use {highlight}/connect{/highlight} to attach an additional provider when the starter model is not enough",
  "Use {highlight}/actor{/highlight}, {highlight}/member{/highlight}, and {highlight}/holon{/highlight} for fast actor workflow shortcuts",
  "Run {highlight}/actor assign alice -- review the API layer{/highlight} to send a final-reply task to an actor",
  "Run {highlight}/member create alice @code{/highlight} to create a member quickly",
  "Run {highlight}/holon create autonomous research{/highlight} to create an autonomous holon",
  "Run {highlight}/holon assign:s research -- implement the migration and report progress{/highlight} to stream work from a holon",
  "Run {highlight}/holon appoint alpha alice{/highlight} to appoint the leader of a leader-led holon",
  "The leader key is {highlight}Ctrl+X{/highlight}; combine it with the shortcuts shown in status and help surfaces",
  "Use {highlight}PageUp{/highlight}/{highlight}PageDown{/highlight} to navigate through conversation history",
  "Press {highlight}Home{/highlight} or {highlight}End{/highlight} to jump to the start or end of the visible conversation",
  "Press {highlight}shift+enter{/highlight} to add a newline in the composer without submitting",
  "Click {highlight}会话{/highlight} in the bottom bar to resume an existing conversation",
  "Open {highlight}菜单{/highlight} then {highlight}使用说明{/highlight} to browse keyboard shortcuts",
  "Run {highlight}/help{/highlight} from the prompt or pick Help in the command palette to reopen the guide",
]
