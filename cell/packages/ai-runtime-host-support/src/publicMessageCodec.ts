import type { MessagePreview, PublicMessage, PublicMessagePart } from "@cell/ai-runtime-host-contract"

/** Structural owner read input: only these allowlisted fields are ever visited by the public encoder. */
export type PublicMessageSource = {
  recordId: string
  message: { messageId?: string; role: string; content: unknown; reasoningContent?: string; toolCallId?: string; tool_call_id?: string;
    resultMetadata?: { isError?: unknown }; toolCalls?: readonly { id: string; name: string; input: Record<string, unknown> }[] }
}
export type PublicMessageRead = {
  messageId: string; role: PublicMessage["role"]
  encode: () => Iterable<Uint8Array>
  preview: (maxBytes: number, totalBytes: number) => MessagePreview
}
const encoder = new TextEncoder()
function* quoted(value: string): Generator<string> {
  yield '"'
  for (let at = 0; at < value.length;) {
    let end = Math.min(value.length, at + 1024)
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--
    yield JSON.stringify(value.slice(at, end)).slice(1, -1); at = end
  }
  yield '"'
}
function* json(value: unknown, parents = new Set<object>(), depth = 0): Generator<string> {
  if (depth > 64) throw new Error("public_content_depth")
  if (typeof value === "string") { yield* quoted(value); return }
  if (value === null || typeof value === "number" || typeof value === "boolean") { yield JSON.stringify(value); return }
  if (typeof value !== "object") { yield "null"; return }
  if (parents.has(value)) throw new Error("public_content_cycle")
  parents.add(value)
  try {
    if (Array.isArray(value)) {
      yield "["; for (let i = 0; i < value.length; i++) { if (i) yield ","; yield* json(value[i], parents, depth + 1) }; yield "]"
    } else {
      yield "{"; let first = true
      for (const key of Object.keys(value)) {
        const item = (value as Record<string, unknown>)[key]; if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") continue
        if (!first) yield ","; first = false; yield* quoted(key); yield ":"; yield* json(item, parents, depth + 1)
      }
      yield "}"
    }
  } finally { parents.delete(value) }
}
function* textContent(content: unknown): Generator<string> {
  if (typeof content === "string") yield content
  else if (Array.isArray(content)) for (const part of content) if (part && part.type === "text" && typeof part.text === "string") yield part.text
}
type Part = { kind: "text" | "reasoning"; values: Iterable<string>; filename?: string; sourceDigest?: string }
  | { kind: "image"; value: Extract<PublicMessagePart, { kind: "image" }> }
  | { kind: "tool_call"; id: string; name: string; input: unknown } | { kind: "tool_result"; id: string; values: Iterable<string>; isError: boolean }
function attachmentMetadata(part: { filename?: unknown; sourceDigest?: unknown }) {
  return {
    ...(typeof part.filename === "string" && part.filename && encoder.encode(part.filename).byteLength <= 256 && !/[/\\\0\r\n]/.test(part.filename) ? { filename: part.filename } : {}),
    ...(typeof part.sourceDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(part.sourceDigest) ? { sourceDigest: part.sourceDigest } : {}),
  }
}
function toolResultIsError(message: PublicMessageSource["message"]): boolean {
  if (typeof message.resultMetadata?.isError === "boolean") return message.resultMetadata.isError
  // Pre-outcome conversation records used the same Error: convention as the
  // runtime's legacy tool adapter. New records always carry the typed outcome.
  return typeof message.content === "string" && message.content.startsWith("Error:")
}
function* publicParts(source: PublicMessageSource): Generator<Part> {
  const m = source.message
  if (m.role === "tool") yield { kind: "tool_result", id: m.toolCallId ?? m.tool_call_id ?? source.recordId, values: textContent(m.content), isError: toolResultIsError(m) }
  else if (typeof m.content === "string") yield { kind: "text", values: [m.content] }
  else if (Array.isArray(m.content)) for (const part of m.content) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text" && typeof part.text === "string") yield { kind: "text", values: [part.text], ...attachmentMetadata(part) }
    else if (part.type === "image" && typeof part.mime === "string" && encoder.encode(part.mime).byteLength <= 128) {
      const dataUrl = typeof part.dataUrl === "string" && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(part.dataUrl) ? part.dataUrl : undefined
      yield { kind: "image", value: { kind: "image", mime: part.mime, ...attachmentMetadata(part),
        ...(Number.isSafeInteger(part.size) && part.size >= 0 ? { size: part.size } : {}), ...(dataUrl ? { dataUrl } : {}) } }
    }
  }
  if (m.reasoningContent) yield { kind: "reasoning", values: [m.reasoningContent] }
  for (const tool of m.toolCalls ?? []) yield { kind: "tool_call", id: tool.id, name: tool.name, input: tool.input }
}
function* quotedFragments(fragments: Iterable<string>): Generator<string> {
  yield '"'; for (const text of fragments) { const q = quoted(text); q.next(); let previous = q.next(); for (let next = q.next(); !next.done; next = q.next()) { yield previous.value!; previous = next } }; yield '"'
}
function* encodePart(part: Part): Generator<string> {
  if (part.kind === "image") { yield* json(part.value) }
  else if (part.kind === "tool_call") {
    yield '{"kind":"tool_call","toolCallId":'; yield* quoted(part.id); yield ',"name":'; yield* quoted(part.name); yield ',"input":'; yield* quotedFragments(json(part.input)); yield "}"
  } else if (part.kind === "tool_result") {
    yield '{"kind":"tool_result","toolCallId":'; yield* quoted(part.id); yield ',"output":'; yield* quotedFragments(part.values); yield `,"isError":${part.isError}}`
  } else {
    yield `{"kind":"${part.kind}","text":`; yield* quotedFragments(part.values)
    if (part.filename) { yield ',"filename":'; yield* quoted(part.filename) }
    if (part.sourceDigest) { yield ',"sourceDigest":'; yield* quoted(part.sourceDigest) }
    yield "}"
  }
}
function truncatedPart(part: Part, budget: number): PublicMessagePart | undefined {
  if (part.kind === "image") {
    const { dataUrl: _dataUrl, ...metadata } = part.value
    return encoder.encode(JSON.stringify(metadata)).byteLength <= budget ? metadata : undefined
  }
  const values = part.kind === "tool_call" ? json(part.input) : part.values
  let text = ""; let remaining = Math.max(0, Math.floor((budget - 2048) / 6))
  for (const value of values) {
    const piece = value.slice(0, remaining)
    text += piece; remaining -= piece.length
    if (!remaining) break
  }
  if (text.length && text.charCodeAt(text.length - 1) >= 0xd800 && text.charCodeAt(text.length - 1) <= 0xdbff) text = text.slice(0, -1)
  const result: PublicMessagePart = part.kind === "tool_call" ? { kind: "tool_call", toolCallId: part.id, name: part.name, input: text }
    : part.kind === "tool_result" ? { kind: "tool_result", toolCallId: part.id, output: text, isError: part.isError }
    : { kind: part.kind, text, ...(part.filename ? { filename: part.filename } : {}), ...(part.sourceDigest ? { sourceDigest: part.sourceDigest } : {}) }
  return encoder.encode(JSON.stringify(result)).byteLength <= budget ? result : undefined
}
export function createPublicMessageRead(source: PublicMessageSource): PublicMessageRead {
  if (!["system", "user", "assistant", "tool"].includes(source.message.role)) throw new Error("public_content_role")
  const messageId = source.message.messageId ?? source.recordId
  const role = source.message.role as PublicMessage["role"]
  return {
    messageId, role,
    *encode() {
      yield encoder.encode('{"messageId":'); for (const fragment of quoted(messageId)) yield encoder.encode(fragment)
      yield encoder.encode(`,"role":"${role}","parts":[`)
      let first = true
      for (const part of publicParts(source)) { if (!first) yield encoder.encode(","); first = false; for (const fragment of encodePart(part)) yield encoder.encode(fragment) }
      yield encoder.encode("]}")
    },
    preview(maxBytes, totalBytes) {
      const parts: PublicMessagePart[] = []; let used = 128; let truncated = false
      for (const part of publicParts(source)) {
        if (parts.length >= 2048) { truncated = true; break }
        const chunks: string[] = []; let size = 0; let oversized = false
        for (const piece of encodePart(part)) {
          size += encoder.encode(piece).byteLength
          if (size + used + 1 > maxBytes - 1024) { oversized = true; break }
          chunks.push(piece)
        }
        if (oversized) {
          // Restart the part iterator: encodePart may already have consumed a generator-backed text field.
          let fresh: Part | undefined; let index = 0
          for (const candidate of publicParts(source)) { if (index++ === parts.length) { fresh = candidate; break } }
          const suffix = fresh ? truncatedPart(fresh, maxBytes - used - 1024) : undefined
          if (suffix) parts.push(suffix)
          truncated = true; break
        }
        used += size + 1; parts.push(JSON.parse(chunks.join("")))
      }
      return { messageId, role, preview: { parts, totalBytes, startOffset: 0, truncated } }
    },
  }
}

/** Walks source incrementally; never creates the full public JSON or retains the source in a cache. */
export function measurePublicMessage(read: PublicMessageRead): number { let size = 0; for (const chunk of read.encode()) size += chunk.byteLength; return size }
export function readPublicMessageBytes(read: PublicMessageRead, offset: number, length: number): Uint8Array {
  const result = new Uint8Array(length); let position = 0; let written = 0
  for (const chunk of read.encode()) {
    if (position + chunk.length > offset && written < length) {
      const start = Math.max(0, offset - position); const count = Math.min(chunk.length - start, length - written)
      result.set(chunk.subarray(start, start + count), written); written += count
    }
    position += chunk.length; if (written === length) break
  }
  return result.subarray(0, written)
}
