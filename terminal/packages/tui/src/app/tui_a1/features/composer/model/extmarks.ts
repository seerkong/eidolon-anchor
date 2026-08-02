import type { TextareaRenderable } from "@opentui/core"
import type { SetStoreFunction } from "solid-js/store"
import { produce } from "solid-js/store"
import type { PromptInfo } from "./prompt-info"
import { clonePromptInfo, sortPromptParts } from "./prompt-parts"

export type ExtmarkStore = {
  prompt: PromptInfo
  extmarkToPartIndex: Map<number, number>
}

type PromptPart = PromptInfo["parts"][number]

type VirtualTextSource = {
  start: number
  end: number
  value: string
}

function readTextSource(part: PromptPart): VirtualTextSource | undefined {
  return (part as { source?: { text?: VirtualTextSource } }).source?.text
}

function readAgentSource(part: PromptPart): VirtualTextSource | undefined {
  return (part as { source?: VirtualTextSource }).source
}

function shiftPartAfterDeletion(part: PromptPart, start: number, length: number) {
  const source = part.type === "agent" ? readAgentSource(part) : readTextSource(part)
  if (!source || source.start < start) return
  source.start -= length
  source.end -= length
}

export function deleteAttachmentBlocksFromPrompt(
  prompt: PromptInfo,
  edit: {
    key: "backspace" | "delete"
    cursorOffset: number
    selection?: { start: number; end: number }
  },
): { prompt: PromptInfo; deletedPartIndexes: number[] } {
  const selection = edit.selection
    ? {
        start: Math.min(edit.selection.start, edit.selection.end),
        end: Math.max(edit.selection.start, edit.selection.end),
      }
    : undefined
  const fileRanges = prompt.parts.flatMap((part, index) => {
    if (part.type !== "file") return []
    const source = readTextSource(part)
    return source ? [{ ...source, index }] : []
  })
  const hit = fileRanges.filter((range) => {
    if (selection && selection.start !== selection.end) {
      return selection.start < range.end && range.start < selection.end
    }
    if (edit.key === "backspace") {
      return (
        edit.cursorOffset === range.end ||
        (edit.cursorOffset === range.end + 1 && /^\s$/.test(prompt.input.slice(range.end, edit.cursorOffset)))
      )
    }
    return edit.cursorOffset === range.start
  })

  if (!hit.length) return { prompt: clonePromptInfo(prompt), deletedPartIndexes: [] }

  const deleteStart = selection
    ? Math.min(selection.start, ...hit.map((range) => range.start))
    : Math.min(...hit.map((range) => range.start))
  let deleteEnd = selection
    ? Math.max(selection.end, ...hit.map((range) => range.end))
    : Math.max(...hit.map((range) => range.end))
  if (!selection && edit.key === "backspace" && edit.cursorOffset === deleteEnd + 1) deleteEnd = edit.cursorOffset
  const nextPrompt = clonePromptInfo(prompt)
  nextPrompt.input = nextPrompt.input.slice(0, deleteStart) + nextPrompt.input.slice(deleteEnd)
  nextPrompt.parts = sortPromptParts(
    nextPrompt.parts.filter((part) => {
      const source = part.type === "agent" ? readAgentSource(part) : readTextSource(part)
      return !source || source.end <= deleteStart || source.start >= deleteEnd
    }),
  )
  for (const part of nextPrompt.parts) shiftPartAfterDeletion(part, deleteEnd, deleteEnd - deleteStart)

  return {
    prompt: nextPrompt,
    deletedPartIndexes: hit.map((range) => range.index).sort((left, right) => left - right),
  }
}

export function restoreExtmarksFromParts(
  input: TextareaRenderable,
  parts: PromptInfo["parts"],
  fileStyleId: number,
  agentStyleId: number,
  pasteStyleId: number,
  promptPartTypeId: number,
  setStore: SetStoreFunction<ExtmarkStore>,
) {
  input.extmarks.clear()
  setStore("extmarkToPartIndex", new Map())

  parts.forEach((part, partIndex) => {
    let start = 0
    let end = 0
    let virtualText = ""
    let styleId: number | undefined

    const textSource = readTextSource(part)
    const agentSource = readAgentSource(part)

    if (part.type === "file" && textSource) {
      start = textSource.start
      end = textSource.end
      virtualText = textSource.value
      styleId = fileStyleId
    } else if (part.type === "agent" && agentSource) {
      start = agentSource.start
      end = agentSource.end
      virtualText = agentSource.value
      styleId = agentStyleId
    } else if (part.type === "text" && textSource) {
      start = textSource.start
      end = textSource.end
      virtualText = textSource.value
      styleId = pasteStyleId
    }

    if (virtualText) {
      const extmarkId = input.extmarks.create({
        start,
        end,
        virtual: true,
        styleId,
        typeId: promptPartTypeId,
      })
      setStore("extmarkToPartIndex", (map: Map<number, number>) => {
        const newMap = new Map(map)
        newMap.set(extmarkId, partIndex)
        return newMap
      })
    }
  })
}

export function syncExtmarksWithPromptParts(
  input: TextareaRenderable,
  promptPartTypeId: number,
  setStore: SetStoreFunction<ExtmarkStore>,
) {
  const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
  setStore(
    produce((draft) => {
      const newMap = new Map<number, number>()
      const newParts: typeof draft.prompt.parts = []

      for (const extmark of allExtmarks) {
        const partIndex = draft.extmarkToPartIndex.get(extmark.id)
        if (partIndex !== undefined) {
          const part = draft.prompt.parts[partIndex]
          if (part) {
            const textSource = readTextSource(part)
            const agentSource = readAgentSource(part)

            if (part.type === "agent" && agentSource) {
              agentSource.start = extmark.start
              agentSource.end = extmark.end
            } else if (part.type === "file" && textSource) {
              textSource.start = extmark.start
              textSource.end = extmark.end
            } else if (part.type === "text" && textSource) {
              textSource.start = extmark.start
              textSource.end = extmark.end
            }
            newMap.set(extmark.id, newParts.length)
            newParts.push(part)
          }
        }
      }

      draft.extmarkToPartIndex = newMap
      draft.prompt.parts = newParts
    }),
  )
}
