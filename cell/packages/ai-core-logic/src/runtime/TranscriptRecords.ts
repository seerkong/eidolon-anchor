/**
 * In-memory codec between stream-level TranscriptRecords (the
 * MessageHistoryGraph record vocabulary) and committed ChatMessages.
 * This is pure in-memory reduction — no file persistence is involved
 * (the legacy on-disk actor transcript format has been removed).
 */
import type { ChatMessage, ToolCall } from "@shared/composer"
import type { TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript"

function parseJsonSafe(value: string): any | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function normalizeToolCalls(message: any): ToolCall[] {
  if (Array.isArray(message?.toolCalls)) return message.toolCalls as ToolCall[]
  if (Array.isArray(message?.rawToolCalls)) return message.rawToolCalls as ToolCall[]
  if (typeof message?.rawToolCallsStr === "string") {
    const parsed = parseJsonSafe(message.rawToolCallsStr)
    if (Array.isArray(parsed)) return parsed as ToolCall[]
  }
  return []
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw !== "string") {
    return {}
  }
  const parsed = parseJsonSafe(raw)
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return raw.trim() ? { raw } : {}
}

function toToolCall(record: any): ToolCall | null {
  const toolCallId = String(record?.toolCallId ?? record?.id ?? "").trim()
  const toolName = String(record?.toolName ?? record?.name ?? record?.functionName ?? "").trim()
  if (!toolCallId && !toolName) return null
  return {
    id: toolCallId || toolName,
    name: toolName || toolCallId,
    input: parseToolArguments(record?.arguments ?? record?.functionArguments ?? record?.input ?? {}),
  }
}

function isPlaceholderToolCall(toolCall: ToolCall): boolean {
  return toolCall.name === toolCall.id && Object.keys(toolCall.input ?? {}).length === 0
}

function addOrReplaceToolCall(toolCalls: ToolCall[], toolCall: ToolCall): void {
  const index = toolCalls.findIndex((entry) => entry.id === toolCall.id)
  if (index < 0) {
    toolCalls.push(toolCall)
    return
  }
  const current = toolCalls[index]
  if (isPlaceholderToolCall(current) && !isPlaceholderToolCall(toolCall)) {
    toolCalls[index] = toolCall
    return
  }
  if (!isPlaceholderToolCall(toolCall) && JSON.stringify(toolCall.input ?? {}) !== JSON.stringify(current.input ?? {})) {
    toolCalls[index] = toolCall
  }
}

export function reduceTranscriptToMessages(records: TranscriptRecord[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  let pendingAssistant: {
    content: string[]
    reasoning: string[]
    toolCalls: ToolCall[]
    startAt?: number
    endAt?: number
  } | null = null

  const applyRecordTiming = (target: { startAt?: number; endAt?: number }, record?: TranscriptRecord) => {
    if (typeof record?.startAt === "number") {
      target.startAt = typeof target.startAt === "number" ? Math.min(target.startAt, record.startAt) : record.startAt
    }
    if (typeof record?.endAt === "number") {
      target.endAt = typeof target.endAt === "number" ? Math.max(target.endAt, record.endAt) : record.endAt
    }
  }

  const ensureAssistant = (record?: TranscriptRecord) => {
    if (!pendingAssistant) {
      pendingAssistant = { content: [], reasoning: [], toolCalls: [] }
    }
    applyRecordTiming(pendingAssistant, record)
    return pendingAssistant
  }

  const flushAssistant = () => {
    if (!pendingAssistant) return
    const content = pendingAssistant.content.join("\n")
    const reasoning = pendingAssistant.reasoning.join("\n")
    const hasToolCalls = pendingAssistant.toolCalls.length > 0
    if (content || reasoning || hasToolCalls) {
      const next: ChatMessage = {
        role: "assistant",
        content,
      }
      if (typeof pendingAssistant.startAt === "number") next.startAt = pendingAssistant.startAt
      if (typeof pendingAssistant.endAt === "number") next.endAt = pendingAssistant.endAt
      if (reasoning) next.reasoning_content = reasoning
      if (hasToolCalls) {
        next.toolCalls = pendingAssistant.toolCalls.map((entry) => ({ ...entry, input: { ...entry.input } }))
        next.rawToolCalls = pendingAssistant.toolCalls.map((entry) => ({ ...entry, input: { ...entry.input } }))
        next.rawToolCallsStr = JSON.stringify(next.rawToolCalls)
      }
      messages.push(next)
    }
    pendingAssistant = null
  }

  for (const record of records) {
    switch (record.stream) {
      case "user_input":
        flushAssistant()
        messages.push({
          role: "user",
          content: record.payload,
          ...(typeof record.startAt === "number" ? { startAt: record.startAt } : {}),
          ...(typeof record.endAt === "number" ? { endAt: record.endAt } : {}),
        })
        break
      case "think":
        ensureAssistant(record).reasoning.push(record.payload)
        break
      case "content":
        ensureAssistant(record).content.push(record.payload)
        break
      case "tool_call_start": {
        const parsed = parseJsonSafe(record.payload)
        const toolCall = toToolCall(parsed ?? {})
        if (toolCall) addOrReplaceToolCall(ensureAssistant(record).toolCalls, toolCall)
        break
      }
      case "tool_call": {
        const parsed = parseJsonSafe(record.payload)
        const toolCall = toToolCall(parsed?.tool_call ?? parsed ?? {})
        if (toolCall) addOrReplaceToolCall(ensureAssistant(record).toolCalls, toolCall)
        break
      }
      case "tool_call_result": {
        flushAssistant()
        const parsed = parseJsonSafe(record.payload)
        const content = typeof parsed?.result === "string" ? parsed.result : record.payload
        const toolCallId = String(parsed?.toolCallId ?? parsed?.id ?? "")
        messages.push({
          role: "tool",
          content,
          tool_call_id: toolCallId,
          ...(typeof record.startAt === "number" ? { startAt: record.startAt } : {}),
          ...(typeof record.endAt === "number" ? { endAt: record.endAt } : {}),
        } as any)
        break
      }
      case "questionnaire_result": {
        flushAssistant()
        const parsed = parseJsonSafe(record.payload)
        const content = typeof parsed?.rawText === "string" ? parsed.rawText : record.payload
        const toolCallId = String(parsed?.toolCallId ?? "")
        if (toolCallId || content) {
          messages.push({
            role: "tool",
            content,
            tool_call_id: toolCallId,
            ...(typeof record.startAt === "number" ? { startAt: record.startAt } : {}),
            ...(typeof record.endAt === "number" ? { endAt: record.endAt } : {}),
          } as any)
        }
        break
      }
      case "questionnaire_request":
      case "quote":
      case "tool_call_error":
      default:
        break
    }
  }

  flushAssistant()
  return messages
}

export function messagesToTranscriptRecords(messages: ChatMessage[]): TranscriptRecord[] {
  const records: TranscriptRecord[] = []
  for (const message of messages as any[]) {
    if (!message || message.role === "system") continue
    if (message.role === "user") {
      records.push({
        stream: "user_input",
        payload: String(message.content ?? ""),
        ...(typeof message.startAt === "number" ? { startAt: message.startAt } : {}),
        ...(typeof message.endAt === "number" ? { endAt: message.endAt } : {}),
      })
      continue
    }
    if (message.role === "assistant") {
      if (typeof message.reasoning_content === "string" && message.reasoning_content) {
        records.push({
          stream: "think",
          payload: message.reasoning_content,
          ...(typeof message.startAt === "number" ? { startAt: message.startAt } : {}),
          ...(typeof message.endAt === "number" ? { endAt: message.endAt } : {}),
        })
      }
      if (typeof message.content === "string" && message.content) {
        records.push({
          stream: "content",
          payload: message.content,
          ...(typeof message.startAt === "number" ? { startAt: message.startAt } : {}),
          ...(typeof message.endAt === "number" ? { endAt: message.endAt } : {}),
        })
      }
      for (const toolCall of normalizeToolCalls(message)) {
        records.push({
          stream: "tool_call_start",
          payload: JSON.stringify({
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            arguments: JSON.stringify(toolCall.input ?? {}),
          }),
          ...(typeof message.startAt === "number" ? { startAt: message.startAt } : {}),
          ...(typeof message.endAt === "number" ? { endAt: message.endAt } : {}),
        })
      }
      continue
    }
    if (message.role === "tool") {
      records.push({
        stream: "tool_call_result",
        payload: JSON.stringify({
          toolCallId: String(message.toolCallId ?? message.tool_call_id ?? ""),
          result: String(message.content ?? ""),
          isError: String(message.content ?? "").startsWith("Error:"),
        }),
        ...(typeof message.startAt === "number" ? { startAt: message.startAt } : {}),
        ...(typeof message.endAt === "number" ? { endAt: message.endAt } : {}),
      })
      continue
    }
    records.push({
      stream: "content",
      payload: String(message.content ?? ""),
      ...(typeof message.startAt === "number" ? { startAt: message.startAt } : {}),
      ...(typeof message.endAt === "number" ? { endAt: message.endAt } : {}),
    })
  }
  return records
}
