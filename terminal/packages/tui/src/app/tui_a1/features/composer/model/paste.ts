import type { TextareaRenderable } from "@opentui/core"
import path from "path"
import type { SetStoreFunction } from "solid-js/store"
import { produce } from "solid-js/store"
import type { ExtmarkStore } from "./extmarks"
import type { PromptInfo } from "./prompt-info"
import { clonePromptInfo, sortPromptParts } from "./prompt-parts"
import type { InputImageContentPart, InputTextContentPart } from "@shared/composer"

export type AttachmentPathPlatform = "win32" | "posix"

export type AttachmentPartInput = {
  path: string
  filename?: string
  mime?: string
  url?: string
  attachment?: InputTextContentPart | InputImageContentPart
}

function decodeFileUri(candidate: string, platform: AttachmentPathPlatform): string | null {
  try {
    const url = new URL(candidate)
    if (url.protocol !== "file:") return null
    if (platform === "win32") {
      const pathname = decodeURIComponent(url.pathname)
      if (url.hostname) return `\\\\${url.hostname}${pathname.replaceAll("/", "\\")}`
      return pathname.replace(/^\/(?:([A-Za-z]:))/, "$1").replaceAll("/", "\\")
    }
    if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${decodeURIComponent(url.pathname)}`
    return decodeURIComponent(url.pathname)
  } catch {
    return null
  }
}

function tokenizePathPaste(payload: string, platform: AttachmentPathPlatform): string[] | null {
  const tokens: string[] = []
  let token = ""
  let quote: "'" | '"' | null = null

  const pushToken = () => {
    if (!token) return
    tokens.push(token)
    token = ""
  }

  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index]
    if (quote) {
      if (char === quote) {
        if (quote === "'" && payload[index + 1] === "'") {
          token += "'"
          index += 1
        } else {
          quote = null
        }
      } else if (char === "\\" && quote === '"' && platform === "posix" && payload[index + 1]) {
        token += payload[index + 1]
        index += 1
      } else {
        token += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      pushToken()
      continue
    }
    if (platform === "posix" && char === "\\" && payload[index + 1]) {
      token += payload[index + 1]
      index += 1
      continue
    }
    if (platform === "win32" && char === "`" && payload[index + 1]) {
      token += payload[index + 1]
      index += 1
      continue
    }
    token += char
  }

  if (quote) return null
  pushToken()
  return tokens.length ? tokens : null
}

function normalizePathCandidate(candidate: string, platform: AttachmentPathPlatform): string | null {
  if (/^file:/i.test(candidate)) return decodeFileUri(candidate, platform)
  if (platform === "win32") {
    return /^(?:[A-Za-z]:\\|\\\\)/.test(candidate) ? candidate : null
  }
  return candidate.startsWith("/") ? candidate : null
}

export function parseAttachmentPathPaste(
  payload: string,
  options: {
    platform: AttachmentPathPlatform
    isFile: (candidate: string) => boolean
  },
): string[] | null {
  const trimmed = payload.trim()
  if (!trimmed) return null

  const wholeCandidate = normalizePathCandidate(
    trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && (trimmed[0] === '"' || trimmed[0] === "'")
      ? trimmed.slice(1, -1)
      : trimmed,
    options.platform,
  )
  if (wholeCandidate && options.isFile(wholeCandidate)) return [wholeCandidate]

  const tokens = tokenizePathPaste(trimmed, options.platform)
  if (!tokens) return null
  const candidates: string[] = []
  for (const token of tokens) {
    const candidate = normalizePathCandidate(token, options.platform)
    if (!candidate || !options.isFile(candidate)) return null
    candidates.push(candidate)
  }
  return candidates.length ? candidates : null
}

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
  return insertAttachmentParts(prompt, [file], offset)
}

export function insertAttachmentParts(
  prompt: PromptInfo,
  files: AttachmentPartInput[],
  offset = prompt.input.length,
): PromptInfo {
  const nextPrompt = clonePromptInfo(prompt)
  const clampedOffset = Math.max(0, Math.min(offset, nextPrompt.input.length))
  const additions: PromptInfo["parts"] = []
  let insertion = ""

  for (const file of files) {
    const virtualText = formatFilePartVirtualText(file)
    const start = clampedOffset + insertion.length
    insertion += `${virtualText} `
    additions.push({
      type: "file",
      mime: file.mime ?? "text/plain",
      filename: file.filename ?? path.basename(file.path) ?? file.path,
      ...(file.url ? { url: file.url } : {}),
      ...(file.attachment ? { attachment: { ...file.attachment } } : {}),
      source: {
        type: "file",
        path: file.attachment ? file.filename ?? path.basename(file.path) : file.path,
        text: {
          start,
          end: start + virtualText.length,
          value: virtualText,
        },
      },
    })
  }

  if (!insertion) return nextPrompt
  nextPrompt.input = nextPrompt.input.slice(0, clampedOffset) + insertion + nextPrompt.input.slice(clampedOffset)

  for (const part of nextPrompt.parts) {
    shiftPromptPartRanges(part, insertion.length, clampedOffset)
  }

  nextPrompt.parts = sortPromptParts([...nextPrompt.parts, ...additions])

  return nextPrompt
}

export function insertPlainPromptText(
  prompt: PromptInfo,
  text: string,
  offset = prompt.input.length,
): PromptInfo {
  const nextPrompt = clonePromptInfo(prompt)
  const clampedOffset = Math.max(0, Math.min(offset, nextPrompt.input.length))
  nextPrompt.input = nextPrompt.input.slice(0, clampedOffset) + text + nextPrompt.input.slice(clampedOffset)
  for (const part of nextPrompt.parts) {
    shiftPromptPartRanges(part, text.length, clampedOffset)
  }
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
