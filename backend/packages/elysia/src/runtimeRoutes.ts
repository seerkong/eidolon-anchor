import {
  parseCommandEnvelope, parseCreateSessionCommand, parseCommandAdmission, parseCommandStatus,
  parseHostCapabilities, parseSessionList, parseSessionSummary, parseActorDirectory,
  parseHistoryPage, parseMessageContentChunk, WireSchemaError,
  type RuntimeHostPort, type HostRequest,
} from "@cell/ai-runtime-host-contract"
import { createHttpHost, type HttpListenOptions } from "./httpHost"
import { acceptsRequestOrigin, validateRuntimeSecurity, type RuntimeSecurity } from "./runtimeAuth"
import { observationResponse } from "./runtimeSse"

class RequestFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

function text(value: string | null | undefined, required = true, maxBytes = 256): string | undefined {
  if (value == null && !required) return undefined
  if (!value || new TextEncoder().encode(value).byteLength > maxBytes || /[\r\n\0]/.test(value)) throw new RequestFailure(400, "invalid_schema")
  return value
}
function number(value: string | null, min: number, max: number): number | undefined {
  if (value == null) return undefined
  if (!/^[0-9]+$/.test(value)) throw new RequestFailure(400, "invalid_schema")
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new RequestFailure(400, "invalid_schema")
  return result
}
function query(request: Request, allowed: readonly string[]): URLSearchParams {
  const result = new URL(request.url).searchParams
  for (const key of result.keys()) if (!allowed.includes(key) || result.getAll(key).length !== 1) throw new RequestFailure(400, "invalid_schema")
  return result
}
async function parseBody<T>(request: Request, parse: (value: unknown) => T): Promise<T> {
  const value = await body(request)
  try { return parse(value) }
  catch (error) { if (error instanceof WireSchemaError) throw new RequestFailure(400, "invalid_schema"); throw error }
}
async function body(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new RequestFailure(415, "unsupported_content_type")
  const reader = request.body?.getReader()
  if (!reader) throw new RequestFailure(400, "invalid_schema")
  const chunks: Uint8Array[] = []
  let size = 0
  let timedOut = false
  const deadline = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}) }, 30_000)
  try {
    while (true) {
      const chunk = await reader.read()
      if (timedOut) throw new RequestFailure(408, "body_timeout")
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 256 * 1024) { await reader.cancel(); throw new RequestFailure(413, "body_too_large") }
      chunks.push(chunk.value)
    }
  } finally { clearTimeout(deadline); reader.releaseLock() }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new RequestFailure(400, "invalid_schema") }
}
function json(payload: unknown, requestId: string, status = 200, maxBytes = 1024 * 1024, extra?: Record<string, string>): Response {
  const value = JSON.stringify({ ...(payload as object), requestId })
  if (Buffer.byteLength(value) > maxBytes) throw new RequestFailure(413, "response_too_large")
  return new Response(value, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-Id": requestId, ...extra } })
}
function failure(error: unknown, requestId: string): Response {
  if (error instanceof RequestFailure) return json({ code: error.code, retryable: false }, requestId, error.status)
  if (error instanceof URIError) return json({ code: "invalid_schema", retryable: false }, requestId, 400)
  if (error instanceof WireSchemaError) return json({ code: "invalid_host_response", retryable: false }, requestId, 500)
  const candidate = error as { status?: number; error?: { code?: string; currentEpoch?: string; state?: string }; retryAfter?: number }
  const status = candidate?.status
  if (status && [400, 401, 403, 404, 409, 410, 413, 422, 429, 503].includes(status) && /^[a-z][a-z0-9_]{0,100}$/.test(candidate.error?.code ?? "")) {
    return json({ code: candidate.error!.code, retryable: false,
      ...(typeof candidate.error!.currentEpoch === "string" && candidate.error!.currentEpoch.length <= 256 ? { currentEpoch: candidate.error!.currentEpoch } : {}),
      ...(candidate.error!.state === "unknown" ? { state: "unknown" } : {}),
    }, requestId, status, 1024 * 1024, status === 429 ? { "Retry-After": String(Number.isSafeInteger(candidate.retryAfter) && candidate.retryAfter! > 0 ? candidate.retryAfter : 1) } : undefined)
  }
  return json({ code: "internal_error", retryable: false }, requestId, 500)
}

export type AnchorHttpHostOptions = Readonly<{
  runtime: RuntimeHostPort
  listen?: HttpListenOptions
  security: RuntimeSecurity
  log?: (metadata: { method: string; route: string; requestId: string; status: number }) => void
}>

export function createAnchorHttpHost(options: AnchorHttpHostOptions) {
  const listen = options.listen ?? {}
  validateRuntimeSecurity(listen, options.security)
  const active = new Set<() => Promise<void>>()
  const runtime = options.runtime
  let closing = false
  const host = createHttpHost(listen, app => {
    // A single raw request boundary keeps Elysia's automatic JSON parser and legacy CORS out of this protocol.
    app.all("/*", async ({ request }) => {
      const requestId = crypto.randomUUID()
      let route = "<unmatched>"
      let response: Response
      try {
        if (closing) throw new RequestFailure(503, "host_closing")
        const origin = host.address!
        if (!acceptsRequestOrigin(request, origin, options.security, app.server?.requestIP(request)?.address ?? null)) throw new RequestFailure(403, "origin_rejected")
        const auth = request.headers.get("authorization")
        if (!auth?.startsWith("Bearer ") || auth.length > 4096) throw new RequestFailure(401, "unauthenticated")
        const principal = await options.security.authenticate(auth.slice(7))
        if (!principal || options.security.authorization.currentGrantsVersion(principal.principalId) !== principal.grantsVersion) throw new RequestFailure(401, "unauthenticated")
        const context: HostRequest = { requestId, principal }
        const parts = new URL(request.url).pathname.replace(/\/$/, "").split("/").slice(1).map(part => decodeURIComponent(part))
        const [version, resource, sessionId, subresource, actorId, leaf, messageId, content] = parts
        if (version !== "v1") throw new RequestFailure(404, "route_not_found")
        const method = request.method
        const only = (allowed: string) => { if (method !== allowed) throw new RequestFailure(405, "method_not_allowed") }
        if (resource === "capabilities" && parts.length === 2) {
          route = "/v1/capabilities"; only("GET"); query(request, [])
          response = json(parseHostCapabilities(runtime.capabilities(context)), requestId)
        } else if (resource === "sessions" && parts.length === 2) {
          route = "/v1/sessions"
          if (method === "POST") { query(request, []); response = json(parseSessionSummary(await runtime.createSession(context, await parseBody(request, parseCreateSessionCommand))), requestId, 201) }
          else { only("GET"); const q = query(request, ["after", "limit"]); response = json(parseSessionList(await runtime.sessions(context, { after: text(q.get("after"), false, 4096), limit: number(q.get("limit"), 1, 200) })), requestId) }
        } else if (resource === "sessions" && sessionId) {
          text(sessionId)
          const selector = { sessionId }
          if (subresource === "actors" && parts.length === 4) {
            route = "/v1/sessions/:sessionId/actors"; only("GET"); query(request, [])
            response = json(parseActorDirectory(await runtime.actors(context, selector)), requestId)
          } else if (subresource === "commands" && parts.length === 4) {
            route = "/v1/sessions/:sessionId/commands"; only("POST"); query(request, [])
            const result = parseCommandAdmission(await runtime.command(context, selector, await parseBody(request, parseCommandEnvelope)))
            response = json(result, requestId, result.status === "accepted" ? 202 : 200)
          } else if (subresource === "commands" && parts.length === 5) {
            route = "/v1/sessions/:sessionId/commands/:commandId"; only("GET"); const q = query(request, ["expectedEpoch"])
            response = json(parseCommandStatus(await runtime.commandStatus(context, selector, { commandId: text(actorId)!, expectedEpoch: text(q.get("expectedEpoch"))! })), requestId)
          } else if (subresource === "actors" && actorId && leaf === "history" && parts.length === 6) {
            route = "/v1/sessions/:sessionId/actors/:actorId/history"; only("GET"); const q = query(request, ["before", "limit"])
            response = json(parseHistoryPage(await runtime.history(context, { sessionId, actorId: text(actorId)! }, { before: text(q.get("before"), false, 4096), limit: number(q.get("limit"), 1, 200) })), requestId)
          } else if (subresource === "actors" && actorId && leaf === "messages" && messageId && content === "content" && parts.length === 8) {
            route = "/v1/sessions/:sessionId/actors/:actorId/messages/:messageId/content"; only("GET"); const q = query(request, ["historyRevision", "cursor", "maxBytes"])
            const maxBytes = number(q.get("maxBytes"), 4096, 256 * 1024) ?? 64 * 1024
            response = json(parseMessageContentChunk(await runtime.content(context, { sessionId, actorId: text(actorId)! }, { messageId: text(messageId)!, historyRevision: text(q.get("historyRevision"))!, cursor: text(q.get("cursor"), false, 4096), maxBytes })), requestId, 200, maxBytes)
          } else if (subresource === "events" && parts.length === 4) {
            route = "/v1/sessions/:sessionId/events"; only("GET"); const q = query(request, ["actors", "after"])
            const actors = q.get("actors") === "" ? [] : text(q.get("actors"), true, 64 * 257)!.split(",")
            if (actors.length > 64 || new Set(actors).size !== actors.length) throw new RequestFailure(400, "invalid_schema")
            actors.forEach(actor => text(actor))
            const after = text(q.get("after"), false, 4096), last = text(request.headers.get("last-event-id"), false, 4096)
            if (after && last && after !== last) throw new RequestFailure(400, "cursor_conflict")
            const subscription = await runtime.subscribe(context, selector, { actors, after: after ?? last })
            if (closing || request.signal.aborted) { subscription.close(); throw new RequestFailure(503, "host_closing") }
            response = observationResponse(subscription, request.signal, requestId, active)
          } else throw new RequestFailure(404, "route_not_found")
        } else throw new RequestFailure(404, "route_not_found")
      } catch (error) { response = failure(error, requestId) }
      options.log?.({ method: request.method, route, requestId, status: response.status })
      return response
    }, { type: "none" })
  }, async () => {
    closing = true
    await Promise.allSettled([...active].map(close => close()))
    await runtime.close()
  })
  return host
}
