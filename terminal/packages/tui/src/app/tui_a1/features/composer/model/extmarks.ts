import type { TextareaRenderable } from "@opentui/core"
import type { SetStoreFunction } from "solid-js/store"
import { produce } from "solid-js/store"
import type { PromptInfo } from "./prompt-info"

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
