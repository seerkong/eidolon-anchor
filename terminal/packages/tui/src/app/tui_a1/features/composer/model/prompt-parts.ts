import { makePartId, type AgentPart, type FilePart, type Part, type TextPart } from "@terminal/core/AIAgent"
import type { PromptInfo } from "./prompt-info"

type PromptPart = PromptInfo["parts"][number]

type PromptPartRange = {
  start: number
  end: number
}

function readPromptPartRange(part: PromptPart): PromptPartRange | undefined {
  if (part.type === "agent") {
    const source = (part as AgentPart & { source?: { start: number; end: number } }).source
    if (!source) return undefined
    return {
      start: source.start,
      end: source.end,
    }
  }

  const source = (part as FilePart | TextPart).source?.text
  if (!source) return undefined
  return {
    start: source.start,
    end: source.end,
  }
}

function readPromptPartValue(part: PromptPart): string {
  if (part.type === "agent") {
    return `@${part.name}`
  }
  if (part.type === "file") {
    return part.source?.text?.value ?? part.filename ?? part.source?.path ?? "file"
  }
  return part.source?.text?.value ?? part.text
}

export function clonePromptInfo(prompt: PromptInfo): PromptInfo {
  return {
    input: prompt.input,
    mode: prompt.mode,
    parts: prompt.parts.map((part): PromptPart => {
      if (part.type === "agent") {
        return {
          ...part,
          source: part.source ? { ...part.source } : undefined,
        }
      }
      if (part.type === "text") {
        return {
          ...part,
          source: part.source
            ? {
                text: { ...part.source.text },
              }
            : undefined,
        }
      }
      return {
        ...part,
        source: part.source
          ? {
              ...part.source,
              ...(part.source.text ? { text: { ...part.source.text } } : {}),
            }
          : undefined,
      }
    }),
  }
}

function rangesOverlap(left: PromptPartRange, right: PromptPartRange): boolean {
  return left.start < right.end && right.start < left.end
}

function isRangeClaimed(parts: PromptInfo["parts"], candidate: PromptPartRange): boolean {
  return parts.some((part) => {
    const range = readPromptPartRange(part)
    return range ? rangesOverlap(range, candidate) : false
  })
}

function isMentionBoundary(char: string | undefined): boolean {
  return !char || /[\s.,!?;:()[\]{}"'`]/.test(char)
}

export function sortPromptParts(parts: PromptInfo["parts"]): PromptInfo["parts"] {
  return [...parts].sort((left, right) => {
    const leftRange = readPromptPartRange(left)
    const rightRange = readPromptPartRange(right)
    if (!leftRange && !rightRange) return 0
    if (!leftRange) return 1
    if (!rightRange) return -1
    if (leftRange.start !== rightRange.start) return leftRange.start - rightRange.start
    return leftRange.end - rightRange.end
  })
}

export function normalizePromptInfoForSubmit(prompt: PromptInfo, agentNames: string[] = []): PromptInfo {
  const nextPrompt = clonePromptInfo(prompt)
  const trimmedInput = nextPrompt.input.trim()
  if (!trimmedInput) return nextPrompt

  if (nextPrompt.parts.length === 0 && trimmedInput.startsWith("/")) {
    const start = nextPrompt.input.indexOf(trimmedInput)
    nextPrompt.parts = [
      {
        type: "text",
        text: trimmedInput,
        source: {
          text: {
            start,
            end: start + trimmedInput.length,
            value: trimmedInput,
          },
        },
      },
    ]
    return nextPrompt
  }

  if (!agentNames.length) return nextPrompt

  const knownAgentNames = new Set(agentNames.filter(Boolean))
  if (!knownAgentNames.size) return nextPrompt

  const mentionPattern = /@([A-Za-z0-9._-]+)/g
  const mentionParts: PromptInfo["parts"] = []
  for (const match of nextPrompt.input.matchAll(mentionPattern)) {
    const start = match.index
    if (start === undefined) continue
    const value = match[0]
    const name = match[1]
    const end = start + value.length
    if (!knownAgentNames.has(name)) continue
    if (!isMentionBoundary(nextPrompt.input[start - 1])) continue
    if (!isMentionBoundary(nextPrompt.input[end])) continue
    if (isRangeClaimed(nextPrompt.parts, { start, end })) continue
    if (isRangeClaimed(mentionParts, { start, end })) continue
    mentionParts.push({
      type: "agent",
      name,
      source: {
        start,
        end,
        value,
      },
    })
  }

  if (mentionParts.length === 0) return nextPrompt
  nextPrompt.parts = sortPromptParts([...nextPrompt.parts, ...mentionParts])
  return nextPrompt
}

function createTextRuntimePart(input: {
  sessionID: string
  messageID: string
  text: string
  source?: TextPart["source"]
}): TextPart | null {
  if (!input.text) return null
  return {
    id: makePartId(),
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "text",
    text: input.text,
    synthetic: false,
    ignored: false,
    source: input.source,
  }
}

export function buildRuntimePromptParts(input: {
  prompt: PromptInfo
  sessionID: string
  messageID: string
}): Part[] {
  const sortedParts = sortPromptParts(input.prompt.parts)
  const runtimeParts: Part[] = []
  let offset = 0

  for (const part of sortedParts) {
    const range = readPromptPartRange(part)
    if (!range) continue
    const start = Math.max(offset, Math.min(input.prompt.input.length, range.start))
    const end = Math.max(start, Math.min(input.prompt.input.length, range.end))
    const plainText = input.prompt.input.slice(offset, start)
    const textPart = createTextRuntimePart({
      sessionID: input.sessionID,
      messageID: input.messageID,
      text: plainText,
    })
    if (textPart) runtimeParts.push(textPart)

    if (part.type === "agent") {
      runtimeParts.push({
        id: makePartId(),
        sessionID: input.sessionID,
        messageID: input.messageID,
        type: "agent",
        name: part.name,
        source: part.source ? { ...part.source } : undefined,
      } as AgentPart)
    } else if (part.type === "file") {
      runtimeParts.push({
        ...part,
        id: makePartId(),
        sessionID: input.sessionID,
        messageID: input.messageID,
        source: part.source
          ? {
              ...part.source,
              text: part.source.text ? { ...part.source.text } : undefined,
            }
          : undefined,
      } as FilePart)
    } else if (part.type === "text") {
      const structuredTextPart = createTextRuntimePart({
        sessionID: input.sessionID,
        messageID: input.messageID,
        text: part.text,
        source: part.source
          ? {
              ...part.source,
              text: part.source.text ? { ...part.source.text } : undefined,
            }
          : undefined,
      })
      if (structuredTextPart) runtimeParts.push(structuredTextPart)
    }

    offset = end
  }

  const tail = createTextRuntimePart({
    sessionID: input.sessionID,
    messageID: input.messageID,
    text: input.prompt.input.slice(offset),
  })
  if (tail) runtimeParts.push(tail)

  return runtimeParts
}

export function buildPromptInputFromParts(parts: PromptInfo["parts"]): string {
  return sortPromptParts(parts).reduce((text, part) => text + readPromptPartValue(part) + " ", "").trimEnd()
}
