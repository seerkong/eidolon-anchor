import type { TextareaRenderable } from "@opentui/core"
import path from "path"
import type { SetStoreFunction } from "solid-js/store"
import { produce } from "solid-js/store"
import type { ExtmarkStore } from "./extmarks"
import type { PromptInfo } from "./prompt-info"
import { clonePromptInfo, sortPromptParts } from "./prompt-parts"

export function pasteText(
  input: TextareaRenderable,
  text: string,
  virtualText: string,
  pasteStyleId: number | undefined,
  promptPartTypeId: number,
  setStore: SetStoreFunction<ExtmarkStore>,
) {
  const currentOffset = input.visualCursor.offset
  const extmarkStart = currentOffset
  const extmarkEnd = extmarkStart + virtualText.length

  input.insertText(virtualText + " ")

  const extmarkId = input.extmarks.create({
    start: extmarkStart,
    end: extmarkEnd,
    virtual: true,
    styleId: pasteStyleId,
    typeId: promptPartTypeId,
  })

  setStore(
    produce((draft) => {
      const partIndex = draft.prompt.parts.length
      draft.prompt.parts.push({
        type: "text" as const,
        text,
        source: {
          text: {
            start: extmarkStart,
            end: extmarkEnd,
            value: virtualText,
          },
        },
      })
      draft.extmarkToPartIndex.set(extmarkId, partIndex)
    }),
  )
}

export async function pasteImage(
  input: TextareaRenderable,
  file: { filename?: string; content: string; mime: string },
  pasteStyleId: number | undefined,
  promptPartTypeId: number,
  setStore: SetStoreFunction<ExtmarkStore>,
) {
  const currentOffset = input.visualCursor.offset
  const extmarkStart = currentOffset
  const rawFilename = file.filename?.trim()
  const virtualText = rawFilename
    ? rawFilename.includes("/") || rawFilename.includes("\\")
      ? `@fs:${rawFilename}`
      : rawFilename
    : "image"
  const extmarkEnd = extmarkStart + virtualText.length
  const textToInsert = virtualText + " "

  input.insertText(textToInsert)

  const extmarkId = input.extmarks.create({
    start: extmarkStart,
    end: extmarkEnd,
    virtual: true,
    styleId: pasteStyleId,
    typeId: promptPartTypeId,
  })

  const part: PromptInfo["parts"][number] = {
    type: "file" as const,
    mime: file.mime,
    filename: file.filename,
    url: `data:${file.mime};base64,${file.content}`,
    source: {
      type: "file",
      path: file.filename ?? "",
      text: {
        start: extmarkStart,
        end: extmarkEnd,
        value: virtualText,
      },
    },
  }
  setStore(
    produce((draft) => {
      const partIndex = draft.prompt.parts.length
      draft.prompt.parts.push(part)
      draft.extmarkToPartIndex.set(extmarkId, partIndex)
    }),
  )
}

export function insertAgentPart(
  input: TextareaRenderable,
  agentName: string,
  promptPartTypeId: number,
  setStore: SetStoreFunction<ExtmarkStore>,
) {
  const currentOffset = input.visualCursor.offset
  const virtualText = `@${agentName}`
  const extmarkStart = currentOffset
  const extmarkEnd = extmarkStart + virtualText.length

  input.insertText(virtualText + " ")

  const extmarkId = input.extmarks.create({
    start: extmarkStart,
    end: extmarkEnd,
    virtual: true,
    typeId: promptPartTypeId,
  })

  setStore(
    produce((draft) => {
      const partIndex = draft.prompt.parts.length
      draft.prompt.parts.push({
        type: "agent",
        name: agentName,
        source: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      })
      draft.extmarkToPartIndex.set(extmarkId, partIndex)
    }),
  )
}

export function insertFilePart(
  input: TextareaRenderable,
  file: {
    path: string
    filename?: string
    mime?: string
  },
  promptPartTypeId: number,
  setStore: SetStoreFunction<ExtmarkStore>,
) {
  const currentOffset = input.visualCursor.offset
  const virtualText = formatFilePartVirtualText(file)
  const extmarkStart = currentOffset
  const extmarkEnd = extmarkStart + virtualText.length

  input.insertText(virtualText + " ")

  const extmarkId = input.extmarks.create({
    start: extmarkStart,
    end: extmarkEnd,
    virtual: true,
    typeId: promptPartTypeId,
  })

  setStore(
    produce((draft) => {
      const partIndex = draft.prompt.parts.length
      draft.prompt.parts.push({
        type: "file",
        mime: file.mime ?? "text/plain",
        filename: file.filename ?? virtualText,
        source: {
          type: "file",
          path: file.path,
          text: {
            start: extmarkStart,
            end: extmarkEnd,
            value: virtualText,
          },
        },
      })
      draft.extmarkToPartIndex.set(extmarkId, partIndex)
    }),
  )
}

export function formatFilePartVirtualText(file: {
  path: string
  filename?: string
}) {
  const fileLabel = file.filename?.trim() || path.basename(file.path) || file.path
  return `@fs:${fileLabel}`
}

function shiftPromptPartRanges(part: PromptInfo["parts"][number], delta: number, offset: number) {
  if (part.type === "agent") {
    if (!part.source || part.source.start < offset) return
    part.source.start += delta
    part.source.end += delta
    return
  }

  const textSource = part.source?.text
  if (!textSource || textSource.start < offset) return
  textSource.start += delta
  textSource.end += delta
}

export function buildPromptWithInsertedFilePart(
  prompt: PromptInfo,
  file: {
    path: string
    filename?: string
    mime?: string
  },
  offset = prompt.input.length,
): PromptInfo {
  const nextPrompt = clonePromptInfo(prompt)
  const virtualText = formatFilePartVirtualText(file)
  const insertion = `${virtualText} `
  const clampedOffset = Math.max(0, Math.min(offset, nextPrompt.input.length))
  nextPrompt.input = nextPrompt.input.slice(0, clampedOffset) + insertion + nextPrompt.input.slice(clampedOffset)

  for (const part of nextPrompt.parts) {
    shiftPromptPartRanges(part, insertion.length, clampedOffset)
  }

  nextPrompt.parts = sortPromptParts([
    ...nextPrompt.parts,
    {
      type: "file",
      mime: file.mime ?? "text/plain",
      filename: file.filename ?? path.basename(file.path) ?? file.path,
      source: {
        type: "file",
        path: file.path,
        text: {
          start: clampedOffset,
          end: clampedOffset + virtualText.length,
          value: virtualText,
        },
      },
    },
  ])

  return nextPrompt
}

export function buildPromptWithInsertedAgentPart(
  prompt: PromptInfo,
  agentName: string,
  offset = prompt.input.length,
): PromptInfo {
  const nextPrompt = clonePromptInfo(prompt)
  const virtualText = `@${agentName}`
  const insertion = `${virtualText} `
  const clampedOffset = Math.max(0, Math.min(offset, nextPrompt.input.length))
  nextPrompt.input = nextPrompt.input.slice(0, clampedOffset) + insertion + nextPrompt.input.slice(clampedOffset)

  for (const part of nextPrompt.parts) {
    shiftPromptPartRanges(part, insertion.length, clampedOffset)
  }

  nextPrompt.parts = sortPromptParts([
    ...nextPrompt.parts,
    {
      type: "agent",
      name: agentName,
      source: {
        start: clampedOffset,
        end: clampedOffset + virtualText.length,
        value: virtualText,
      },
    },
  ])

  return nextPrompt
}
