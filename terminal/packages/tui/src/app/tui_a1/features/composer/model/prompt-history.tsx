/** @jsxImportSource @opentui/solid */
import path from "path"
import { Global } from "../../../../../support/global"
import { onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { clone } from "remeda"
import { createSimpleContext } from "../../../../../providers/helper"
import { appendFile, writeFile } from "fs/promises"
import type { PromptInfo } from "./prompt-info"

export type { PromptInfo } from "./prompt-info"

const MAX_HISTORY_ENTRIES = 50

export type PromptHistoryState = {
  index: number
  history: PromptInfo[]
  draft?: PromptInfo
}

function clonePrompt(prompt: PromptInfo): PromptInfo {
  return clone(prompt)
}

function isSamePrompt(left: PromptInfo | undefined, right: PromptInfo): boolean {
  if (!left) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

function readPromptAtIndex(state: PromptHistoryState, index: number): PromptInfo | undefined {
  if (index === 0) return state.draft
  const entry = state.history.at(index)
  return entry ? clonePrompt(entry) : undefined
}

export function appendPromptHistoryEntry(
  state: PromptHistoryState,
  item: PromptInfo,
): {
  nextState: PromptHistoryState
  trimmed: boolean
  entry: PromptInfo
} {
  const entry = clonePrompt(item)
  const history = [...state.history, entry]
  const trimmed = history.length > MAX_HISTORY_ENTRIES

  return {
    nextState: {
      history: trimmed ? history.slice(-MAX_HISTORY_ENTRIES) : history,
      index: 0,
      draft: undefined,
    },
    trimmed,
    entry,
  }
}

export function movePromptHistoryCursor(
  state: PromptHistoryState,
  direction: 1 | -1,
  current: PromptInfo,
): {
  nextState: PromptHistoryState
  prompt?: PromptInfo
} {
  if (!state.history.length) return { nextState: state }

  const activePrompt = readPromptAtIndex(state, state.index)
  if (activePrompt && !isSamePrompt(activePrompt, current)) {
    return { nextState: state }
  }

  let nextIndex = state.index
  let nextDraft = state.draft

  if (direction === -1) {
    if (state.index === 0) {
      nextDraft = clonePrompt(current)
      nextIndex = -1
    } else if (Math.abs(state.index) < state.history.length) {
      nextIndex -= 1
    } else {
      return { nextState: state }
    }
  } else {
    if (state.index === 0) return { nextState: state }
    nextIndex += 1
  }

  const nextState: PromptHistoryState = {
    ...state,
    draft: nextDraft,
    index: nextIndex,
  }

  return {
    nextState,
    prompt: readPromptAtIndex(nextState, nextIndex) ?? {
      input: "",
      parts: [],
    },
  }
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const historyFile = Bun.file(path.join(Global.Path.state, "prompt-history.jsonl"))
    onMount(async () => {
      const text = await historyFile.text().catch(() => "")
      const lines = text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((line): line is PromptInfo => line !== null)
        .slice(-MAX_HISTORY_ENTRIES)

      setStore("history", lines)

      // Rewrite file with only valid entries to self-heal corruption
      if (lines.length > 0) {
        const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n"
        writeFile(historyFile.name!, content).catch(() => {})
      }
    })

    const [store, setStore] = createStore({
      index: 0,
      draft: undefined as PromptInfo | undefined,
      history: [] as PromptInfo[],
    })

    return {
      move(direction: 1 | -1, current: PromptInfo) {
        const { nextState, prompt } = movePromptHistoryCursor(store, direction, current)
        setStore(
          produce((draft) => {
            draft.index = nextState.index
            draft.draft = nextState.draft
          }),
        )
        return prompt
      },
      append(item: PromptInfo) {
        const { nextState, trimmed, entry } = appendPromptHistoryEntry(store, item)
        setStore(
          produce((draft) => {
            draft.history = nextState.history
            draft.index = nextState.index
            draft.draft = nextState.draft
          }),
        )

        if (trimmed) {
          const content = store.history.map((line) => JSON.stringify(line)).join("\n") + "\n"
          writeFile(historyFile.name!, content).catch(() => {})
          return
        }

        appendFile(historyFile.name!, JSON.stringify(entry) + "\n").catch(() => {})
      },
    }
  },
})
