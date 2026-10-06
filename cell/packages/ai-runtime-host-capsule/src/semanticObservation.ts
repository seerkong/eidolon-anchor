import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import type { ObservationPayloads, PendingStream, Preview, PublicMessagePart } from "@cell/ai-runtime-host-contract"

type StreamPublication = { kind: "stream.updated"; payload: PendingStream }
  | { kind: "stream.closed"; payload: ObservationPayloads["stream.closed"] }
type RetainedStream = { value: PendingStream; parts: PublicMessagePart[]; totalBytes: number }

// Count without copying a potentially large incoming token/tool fragment.
function utf8Bytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}

function suffix(text: string, budget: number): string {
  let start = text.length, bytes = 0
  while (start > 0) {
    const code = text.charCodeAt(start - 1)
    const pair = code >= 0xdc00 && code <= 0xdfff && start > 1 && text.charCodeAt(start - 2) >= 0xd800 && text.charCodeAt(start - 2) <= 0xdbff
    const width = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3
    if (bytes + width > budget) break
    bytes += width; start -= pair ? 2 : 1
  }
  return text.slice(start)
}

function textOf(part: PublicMessagePart): string {
  return part.kind === "tool_call" ? part.input : part.kind === "tool_result" ? part.output : part.text
}
function withText(part: PublicMessagePart, text: string): PublicMessagePart {
  return part.kind === "tool_call" ? { ...part, input: text } : part.kind === "tool_result" ? { ...part, output: text } : { ...part, text }
}

export type SemanticObservationOptions = {
  publish(event: StreamPublication): void
  maxPreviewBytes?: number
  maxStreams?: number
}

/** Read-only projection of the existing semantic and committed-history owners. */
export function createSemanticObservation(options: SemanticObservationOptions) {
  const streams = new Map<string, RetainedStream>()
  const attempts = new Map<string, { attemptId: string; turnId?: string; state: "active" | "succeeded" | "aborted" }>()
  const previewBudget = Math.max(256, Math.min(64 * 1024, options.maxPreviewBytes ?? 32 * 1024))
  const maxStreams = Math.max(1, Math.min(128, options.maxStreams ?? 128))
  let disposed = false
  const close = (key: string, committed: boolean) => {
    const stream = streams.get(key)
    if (!stream) return
    const { actorId, turnId, attemptId, messageId } = stream.value
    options.publish({ kind: "stream.closed", payload: { actorId, turnId, attemptId, messageId, committed } })
    streams.delete(key)
  }
  const publish = (stream: RetainedStream) => {
    // Keep a tail of the preview, never a second full transcript or tool result.
    while (stream.parts.length > 64) stream.parts.shift()
    const size = () => utf8Bytes(JSON.stringify(stream.parts))
    while (stream.parts.length > 1 && size() > previewBudget) stream.parts.shift()
    if (stream.parts.length && size() > previewBudget) {
      const part = stream.parts[0]!
      let low = 0, high = previewBudget, best = ""
      while (low <= high) {
        const count = Math.floor((low + high) / 2)
        const text = suffix(textOf(part), count)
        if (utf8Bytes(JSON.stringify([withText(part, text)])) <= previewBudget) { best = text; low = count + 1 }
        else high = count - 1
      }
      stream.parts = [withText(part, best)]
      if (size() > previewBudget) stream.parts = []
    }
    const retainedBytes = stream.parts.reduce((sum, part) => sum + utf8Bytes(textOf(part)), 0)
    const preview: Preview = { parts: stream.parts.map(part => ({ ...part })), totalBytes: stream.totalBytes,
      startOffset: Math.max(0, stream.totalBytes - retainedBytes), truncated: retainedBytes < stream.totalBytes }
    stream.value = { ...stream.value, revision: stream.value.revision + 1, preview }
    options.publish({ kind: "stream.updated", payload: stream.value })
  }
  return {
    onSemantic(event: SemanticEvent): void {
      if (disposed) return
      const actorId = event.actor.actor_id
      if (event.event_type === "semantic_provider_attempt_started") {
        if ([actorId, event.attempt_id, event.executionOrigin?.turnId ?? ""].some(id => id.length > 1024)) return
        for (const [key, stream] of streams) if (stream.value.actorId === actorId && stream.value.attemptId !== event.attempt_id) close(key, false)
        attempts.delete(actorId)
        while (attempts.size >= maxStreams) attempts.delete(attempts.keys().next().value!)
        attempts.set(actorId, { attemptId: event.attempt_id, turnId: event.executionOrigin?.turnId, state: "active" })
        return
      }
      if (event.event_type === "semantic_provider_attempt_aborted") {
        for (const [key, stream] of streams) if (stream.value.actorId === actorId && stream.value.attemptId === event.attempt_id) close(key, false)
        const attempt = attempts.get(actorId)
        if (attempt?.attemptId === event.attempt_id) attempt.state = "aborted"
        return
      }
      if (event.event_type === "semantic_provider_attempt_succeeded") {
        const attempt = attempts.get(actorId)
        if (attempt?.attemptId === event.attempt_id) attempt.state = "succeeded"
        return
      }
      // Results are committed synchronously by the history owner. Projecting
      // them again here could resurrect a stream after its committed callback.
      if (!["semantic_content_delta", "semantic_think_delta", "semantic_tool_call_planned", "semantic_tool_call_start"].includes(event.event_type)) return
      const turnId = event.executionOrigin?.turnId
      const attemptId = event.providerAttemptId
      const messageId = event.messageId
      if (!turnId || !attemptId || !messageId || [actorId, turnId, attemptId, messageId].some(id => id.length > 1024)) return
      const attempt = attempts.get(actorId)
      if (!attempt || attempt.attemptId !== attemptId || attempt.state !== "active") return
      const key = JSON.stringify([actorId, messageId])
      let stream = streams.get(key)
      if (!stream) {
        // An actor can retain a completed-but-not-yet-committed attempt briefly;
        // the map remains bounded even when an upstream terminal is missing.
        while (streams.size >= maxStreams) close(streams.keys().next().value!, false)
        stream = { value: { actorId, turnId, attemptId, messageId, revision: 0,
          preview: { parts: [], startOffset: 0, totalBytes: 0, truncated: false } }, parts: [], totalBytes: 0 }
        streams.set(key, stream)
      }
      if (event.event_type === "semantic_content_delta" || event.event_type === "semantic_think_delta") {
        const kind = event.event_type === "semantic_content_delta" ? "text" : "reasoning"
        stream.totalBytes += utf8Bytes(event.text)
        const tail = suffix(event.text, previewBudget)
        const last = stream.parts.at(-1)
        if (last?.kind === kind) stream.parts[stream.parts.length - 1] = { kind, text: suffix(last.text + tail, previewBudget) }
        else stream.parts.push({ kind, text: tail })
      } else if (event.event_type === "semantic_tool_call_planned" || event.event_type === "semantic_tool_call_start") {
        const tool = event.tool_call
        if (tool.tool_call_id.length > 1024 || tool.tool_name.length > 1024) return
        const index = stream.parts.findIndex(part => part.kind === "tool_call" && part.toolCallId === tool.tool_call_id)
        const old = index < 0 ? undefined : stream.parts[index]
        const part: PublicMessagePart = { kind: "tool_call", toolCallId: tool.tool_call_id, name: tool.tool_name,
          input: suffix(tool.arguments_text, previewBudget) }
        stream.totalBytes += Math.max(0, utf8Bytes(tool.arguments_text) - (old ? utf8Bytes(textOf(old)) : 0))
        if (index < 0) stream.parts.push(part)
        else stream.parts[index] = part
      }
      publish(stream)
    },
    /** Enrich only; do not remove pending until the caller published history. */
    onCommitted(payload: ObservationPayloads["history.committed"]): ObservationPayloads["history.committed"] {
      const stream = streams.get(JSON.stringify([payload.actorId, payload.message.messageId]))
      return stream ? { ...payload, turnId: stream.value.turnId, attemptId: stream.value.attemptId } : payload
    },
    closeCommitted(payload: ObservationPayloads["history.committed"]): void {
      if (!disposed) close(JSON.stringify([payload.actorId, payload.message.messageId]), true)
    },
    closeTurn(actorId: string, turnId: string): void {
      for (const [key, stream] of streams) if (stream.value.actorId === actorId && stream.value.turnId === turnId) close(key, false)
      if (attempts.get(actorId)?.turnId === turnId) attempts.delete(actorId)
    },
    readPending(): readonly PendingStream[] { return [...streams.values()].map(stream => structuredClone(stream.value)) },
    dispose(): void { disposed = true; streams.clear(); attempts.clear() },
  }
}
