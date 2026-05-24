import type { AssistantMessage, Message, Part, Session } from "@terminal/core/AIAgent"
import type { PromptInfo } from "../../composer/model/prompt-info"
import { buildPromptInputFromParts } from "../../composer/model/prompt-parts"
import { summarizeDiffText } from "./session-diff-summary"

export type SessionRevertSummary = {
  messageID: string
  reverted: Message[]
  diff?: string
  diffFiles: {
    filename: string
    additions: number
    deletions: number
  }[]
}

export function buildPromptInfoFromParts(parts: Part[] = []): PromptInfo {
  const promptParts = parts.reduce((agg, part) => {
    if (part.type === "file" || part.type === "agent") {
      agg.push(part)
      return agg
    }
    if (part.type === "text" && part.source?.text) {
      agg.push({
        type: "text",
        text: part.text,
        source: {
          text: { ...part.source.text },
        },
      })
    }
    return agg
  }, [] as PromptInfo["parts"])

  const textInput = parts.reduce((agg, part) => {
    if (part.type === "text" && !part.synthetic) {
      agg += part.text
    }
    return agg
  }, "")

  return {
    input: textInput || buildPromptInputFromParts(promptParts),
    parts: promptParts,
  }
}

export function extractMessageText(parts: Part[] = []): string {
  return parts.reduce((agg, part) => {
    if (part.type === "text" && !part.synthetic) {
      agg += part.text
    }
    return agg
  }, "")
}

export function hasDisplayableTextPart(parts: Part[] = []): boolean {
  return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
}

export function findPendingAssistantMessageId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg?.role === "assistant" && !msg.time.completed) return msg.id
  }
  return undefined
}

export function findLastAssistantMessage(messages: Message[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg?.role === "assistant") return msg as AssistantMessage
  }
  return undefined
}

export function summarizeSessionRevert(
  revertInfo: Session["revert"] | undefined,
  messages: Message[],
): SessionRevertSummary | undefined {
  if (!revertInfo?.messageID) return

  const diffText = typeof revertInfo.diff === "string" ? revertInfo.diff : ""
  const diffFiles = diffText ? summarizeDiffText(diffText) : []

  return {
    messageID: String(revertInfo.messageID),
    reverted: messages.filter((message) => message.id >= revertInfo.messageID! && message.role === "user"),
    diff: typeof revertInfo.diff === "string" ? revertInfo.diff : undefined,
    diffFiles,
  }
}
