import type { HistoryPage, HostAuthorizationEffects, HostIdentityEffects, HostRequest, MessageContentChunk, MessagePreview } from "@cell/ai-runtime-host-contract"
import { HostProtocolFailure } from "./commands"

export type PublicHistoryMessage = { messageId: string; totalBytes(): number; preview(maxBytes: number, totalBytes: number): MessagePreview; bytes(offset: number, length: number): Uint8Array }
export type PublicHistoryView = {
  revision: number; count: number; metadataBytes: number
  valid(): boolean
  message(index: number): PublicHistoryMessage | undefined
  release(): void
}
type View = { token: string; actorId: string; historyRevision: string; source: PublicHistoryView; expiresAt: number; touched: number }
export type HistoryReadState = { views: Map<string, View>; closed: boolean }
export type HistoryReadRuntime = {
  sessionId: string; epoch: string; state: HistoryReadState; authorization: HostAuthorizationEffects; identity: HostIdentityEffects
  effects: { capture(actorId: string): PublicHistoryView | undefined; seal(value: unknown): string; open(cursor: string): unknown; base64(bytes: Uint8Array): string }
  limits?: { views?: number; viewBytes?: number; ttlMs?: number; pageBytes?: number }
}
type Cursor = { kind: "page" | "content"; sessionId: string; epoch: string; actorId: string; principalId: string; grantsVersion: string; revision: string; token: string; expiresAt: number; offset: number; messageId?: string; codec?: "public-message-json-v1" }
const size = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
export const publicHistoryRevision = (epoch: string, revision: number): string => `${encodeURIComponent(epoch)}:history:${revision}`
export const createHistoryReadState = (): HistoryReadState => ({ views: new Map(), closed: false })
function fail(request: HostRequest | undefined, code: string, status = 410): never { throw new HostProtocolFailure(status, { code, requestId: request?.requestId ?? "history", retryable: false }) }
const key = (actorId: string, revision: string) => JSON.stringify([actorId, revision])
function expire(runtime: HistoryReadRuntime): void {
  for (const [id, view] of runtime.state.views) if (runtime.identity.now() >= view.expiresAt || !view.source.valid()) { view.source.release(); runtime.state.views.delete(id) }
}
function authorize(runtime: HistoryReadRuntime, request: HostRequest, actorId: string): void {
  if (runtime.state.closed) fail(request, "session_closing", 409)
  if (runtime.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion
    || !runtime.authorization.permits(request.principal, { kind: "session", sessionId: runtime.sessionId, action: "open" })
    || !runtime.authorization.permits(request.principal, { kind: "actor", sessionId: runtime.sessionId, actorId, action: "read_history" })) fail(request, "forbidden", 403)
}
/** Registers only a bounded revision handle. It never retains a copied message list or encoded content. */
export function capturePublicHistory(runtime: HistoryReadRuntime, actorId: string): { historyRevision: string; count: number } {
  if (runtime.state.closed) fail(undefined, "session_closing", 409)
  expire(runtime)
  const source = runtime.effects.capture(actorId); if (!source) fail(undefined, "actor_not_found", 404)
  const revision = publicHistoryRevision(runtime.epoch, source.revision); const id = key(actorId, revision)
  const existing = runtime.state.views.get(id)
  if (existing) { source.release(); existing.touched = runtime.identity.now(); return { historyRevision: revision, count: existing.source.count } }
  const budget = runtime.limits?.viewBytes ?? 32 * 1024 * 1024
  if (source.metadataBytes > budget || !Number.isSafeInteger(source.count) || source.count < 0) { source.release(); fail(undefined, "history_capacity", 413) }
  while (runtime.state.views.size >= (runtime.limits?.views ?? 32) || [...runtime.state.views.values()].reduce((n, view) => n + view.source.metadataBytes, 0) + source.metadataBytes > budget) {
    const oldest = [...runtime.state.views].sort((a, b) => a[1].touched - b[1].touched)[0]
    if (!oldest) { source.release(); fail(undefined, "history_capacity", 413) }
    oldest[1].source.release(); runtime.state.views.delete(oldest[0])
  }
  const now = runtime.identity.now()
  runtime.state.views.set(id, { token: runtime.identity.newId(), actorId, historyRevision: revision, source, expiresAt: now + Math.min(runtime.limits?.ttlMs ?? 120000, 120000), touched: now })
  return { historyRevision: revision, count: source.count }
}
function binding(runtime: HistoryReadRuntime, request: HostRequest, view: View, kind: Cursor["kind"], offset: number, messageId?: string): Cursor {
  return { kind, sessionId: runtime.sessionId, epoch: runtime.epoch, actorId: view.actorId, principalId: request.principal.principalId, grantsVersion: request.principal.grantsVersion, revision: view.historyRevision, token: view.token, expiresAt: view.expiresAt, offset, ...(messageId ? { messageId, codec: "public-message-json-v1" as const } : {}) }
}
function readCursor(runtime: HistoryReadRuntime, request: HostRequest, actorId: string, cursor: string, kind: Cursor["kind"]): { cursor: Cursor; view: View } {
  expire(runtime)
  const value = runtime.effects.open(cursor) as Cursor | undefined
  const code = kind === "content" ? "content_cursor_expired" : "history_cursor_expired"
  if (!value || value.kind !== kind || value.sessionId !== runtime.sessionId || value.epoch !== runtime.epoch || value.actorId !== actorId
    || value.principalId !== request.principal.principalId || value.grantsVersion !== request.principal.grantsVersion
    || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.expiresAt <= runtime.identity.now()) fail(request, code)
  const view = runtime.state.views.get(key(actorId, value.revision))
  if (!view || view.token !== value.token || view.expiresAt !== value.expiresAt) fail(request, code)
  view.touched = runtime.identity.now(); return { cursor: value, view }
}
export function readPublicHistory(runtime: HistoryReadRuntime, request: HostRequest, actorId: string, input: { before?: string; limit?: number } = {}): HistoryPage {
  authorize(runtime, request, actorId)
  const limit = input.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail(request, "invalid_limit", 400)
  let view: View; let before: number
  if (input.before) { const decoded = readCursor(runtime, request, actorId, input.before, "page"); view = decoded.view; before = decoded.cursor.offset }
  else { const capture = capturePublicHistory(runtime, actorId); view = runtime.state.views.get(key(actorId, capture.historyRevision))!; before = view.source.count }
  if (before > view.source.count) fail(request, "history_cursor_expired")
  const messages: MessagePreview[] = []; let index = before
  const page: HistoryPage = { actorId, epoch: runtime.epoch, historyRevision: view.historyRevision, messages }
  const budget = runtime.limits?.pageBytes ?? 1024 * 1024
  while (index > 0 && messages.length < limit) {
    const message = view.source.message(index - 1); if (!message) fail(request, "history_cursor_expired")
    let preview = { ...message.preview(256 * 1024, message.totalBytes()), contentRef: { messageId: message.messageId, historyRevision: view.historyRevision } }
    const cursor = index - 1 > 0 ? runtime.effects.seal(binding(runtime, request, view, "page", index - 1)) : undefined
    if (size({ ...page, messages: [preview, ...messages], nextCursor: cursor, requestId: request.requestId }) > budget) {
      if (messages.length) break
      preview = { ...preview, preview: { ...preview.preview, parts: [], truncated: true } }
      if (size({ ...page, messages: [preview], nextCursor: cursor, requestId: request.requestId }) > budget) fail(request, "response_too_large", 413)
    }
    messages.unshift(preview); index--
  }
  return { ...page, ...(index > 0 ? { nextCursor: runtime.effects.seal(binding(runtime, request, view, "page", index)) } : {}) }
}
export function readPublicContent(runtime: HistoryReadRuntime, request: HostRequest, actorId: string, input: { messageId: string; historyRevision: string; cursor?: string; maxBytes?: number }): MessageContentChunk {
  authorize(runtime, request, actorId); expire(runtime)
  const maxBytes = input.maxBytes ?? 65536
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024) fail(request, "invalid_max_bytes", 400)
  let view: View; let offset = 0
  if (input.cursor) {
    const decoded = readCursor(runtime, request, actorId, input.cursor, "content"); view = decoded.view; offset = decoded.cursor.offset
    if (decoded.cursor.messageId !== input.messageId || decoded.cursor.revision !== input.historyRevision || decoded.cursor.codec !== "public-message-json-v1") fail(request, "content_cursor_expired")
  } else {
    let found = runtime.state.views.get(key(actorId, input.historyRevision))
    if (!found) { capturePublicHistory(runtime, actorId); found = runtime.state.views.get(key(actorId, input.historyRevision)) }
    if (!found) fail(request, "content_cursor_expired")
    view = found
  }
  view.touched = runtime.identity.now()
  let message: PublicHistoryMessage | undefined
  for (let index = 0; index < view.source.count; index++) { const item = view.source.message(index); if (item?.messageId === input.messageId) { message = item; break } }
  if (!message) fail(request, "message_not_found", 404)
  const total = message.totalBytes(); if (offset >= total) fail(request, "content_cursor_expired")
  const base = { codec: "public-message-json-v1" as const, encoding: "base64" as const, messageId: input.messageId, historyRevision: input.historyRevision, offsetBytes: offset, totalBytes: total }
  // Reserve the final cursor length and base64 expansion, then binary-search the encoded response budget.
  const raw = message.bytes(offset, Math.min(total - offset, Math.floor(maxBytes * 3 / 4)))
  let low = 1; let high = raw.length; let result: MessageContentChunk | undefined
  while (low <= high) {
    const length = Math.floor((low + high) / 2); const next = offset + length
    const candidate: MessageContentChunk = { ...base, data: runtime.effects.base64(raw.subarray(0, length)), ...(next < total ? { nextCursor: runtime.effects.seal(binding(runtime, request, view, "content", next, input.messageId)) } : {}) }
    if (size({ ...candidate, requestId: request.requestId }) <= maxBytes) { result = candidate; low = length + 1 } else high = length - 1
  }
  if (!result) fail(request, "response_too_large", 413)
  return result
}
export function closeHistoryReads(runtime: HistoryReadRuntime): void { runtime.state.closed = true; for (const view of runtime.state.views.values()) view.source.release(); runtime.state.views.clear() }
