import {
  parseCommandEnvelope, parseCreateSessionCommand, parseCommandAdmission, parseCommandStatus,
  parseHostCapabilities, parseSessionList, parseSessionSummary, parseActorDirectory,
  parseHistoryPage, parseMessageContentChunk, WireSchemaError,
  parseAttachmentOperation, parseAttachmentSummary,
  parseSessionStatistics,
  parseConversationOperation, parseConversationOperationList,
  parseSessionManagementCommand, parseSessionManagementResult, parseSessionMetadata,
  parseActorManagementCommand,parseActorManagementResult,
  parsePersistedSessionPage,parsePersistedSessionPreflight,parseImportPersistedSessionCommand,parseImportedSessionResult,
  type RuntimeHostPort, type HostRequest,
  parseHostParticipantDirectory, parseHostParticipantBootstrapCommand, parseHostParticipantBindingReceipt,
  parseHostParticipantSendCommand, parseHostParticipantDelivery, parseHostExecutionOutputPage,
  parseHostParticipantWorkPage, parseHostParticipantArtifactRead, parseHostParticipantArtifactChunk,parseHostParticipantControlCommand,parseHostParticipantAttachmentCommand,
  parseGlobalTaskSpaceCommand,parseGlobalTaskSpacePage,parseGlobalTaskSpaceView,parseGlobalTaskSpaceResult,
  parseGlobalTaskRootPlanView,parseGlobalTaskDetail,parseGlobalTaskArtifactChunk,
} from "@cell/ai-runtime-host-contract"
import { createHttpHost, type HttpListenOptions } from "./httpHost"
import { acceptsRequestOrigin, validateRuntimeSecurity, type RuntimeSecurity } from "./runtimeAuth"
import { observationResponse } from "./runtimeSse"
import {parseWorkflowCommand,parseWorkflowDirectory,parseWorkflowRunPage,parseWorkflowRunView,parseWorkflowEventPage,parseWorkflowCommandResult,parseWorkflowMaterialChunk} from '@cell/ai-runtime-host-contract'

export class RequestFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

function text(value: string | null | undefined, required = true, maxBytes = 256): string | undefined {
  if (value == null && !required) return undefined
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > maxBytes || /[\r\n\0]/.test(value)) throw new RequestFailure(400, "invalid_schema")
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
export async function parseBody<T>(request: Request, parse: (value: unknown) => T): Promise<T> {
  const value = await body(request)
  try { return parse(value) }
  catch (error) { if (error instanceof WireSchemaError) throw new RequestFailure(400, "invalid_schema"); throw error }
}
export async function body(request: Request): Promise<unknown> {
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
export function json(payload: unknown, requestId: string, status = 200, maxBytes = 1024 * 1024, extra?: Record<string, string>): Response {
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
  runtime?: RuntimeHostPort
  workspace?: Readonly<{ workspaceId: string; workDir: string }>
  resolveScope?: (request: Request, context: HostRequest, parts: string[]) => Promise<Response | { runtime: RuntimeHostPort; workspace: { workspaceId: string; workDir: string }; parts: string[] }>
  close?: () => Promise<void>
  listen?: HttpListenOptions
  security: RuntimeSecurity
  log?: (metadata: { method: string; route: string; requestId: string; status: number }) => void
}>

export function createAnchorHttpHost(options: AnchorHttpHostOptions) {
  const listen = options.listen ?? {}
  validateRuntimeSecurity(listen, options.security)
  const active = new Set<() => Promise<void>>()
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
        let parts = new URL(request.url).pathname.replace(/\/$/, "").split("/").slice(1).map(part => decodeURIComponent(part))
        let runtime = options.runtime, workspace = options.workspace
        if (options.resolveScope) {
          const scope = await options.resolveScope(request, context, parts)
          if (scope instanceof Response) return scope
          runtime = scope.runtime; workspace = scope.workspace; parts = scope.parts
        }
        if (!runtime) throw new RequestFailure(503, 'workspace_unavailable')
        const [version, resource, sessionId, subresource, actorId, leaf, messageId, content] = parts
        if (version !== "v1") throw new RequestFailure(404, "route_not_found")
        const method = request.method
        const only = (allowed: string) => { if (method !== allowed) throw new RequestFailure(405, "method_not_allowed") }
        if (resource === "workspace" && parts.length === 2) {
          route = "/v1/workspace"; only("GET"); query(request, [])
          const capabilities = runtime.capabilities(context)
          if (!options.security.authorization.permits(principal, { kind: 'server', action: 'list_sessions' })) throw new RequestFailure(403, 'forbidden')
          if (!workspace) throw new RequestFailure(503, 'workspace_metadata_unavailable')
          response = json({ ...workspace, serverInstanceId: capabilities.serverInstanceId }, requestId)
        } else if (resource === "capabilities" && parts.length === 2) {
          route = "/v1/capabilities"; only("GET"); query(request, [])
          response = json(parseHostCapabilities(runtime.capabilities(context)), requestId)
        } else if(resource==='persisted-sessions'&&parts.length===2){
          route='/v1/persisted-sessions';only('GET');const q=query(request,['after','limit']);
          if(!runtime.persistedSessions)throw new RequestFailure(503,'session_import_unavailable');
          response=json(parsePersistedSessionPage(await runtime.persistedSessions(context,{after:text(q.get('after'),false,4096),limit:number(q.get('limit'),1,40)})),requestId,200,65536);
        } else if(resource==='persisted-sessions'&&sessionId){
          const selector={sessionId:text(sessionId)!};query(request,[]);
          if(subresource==='preflight'&&parts.length===4){
            route='/v1/persisted-sessions/:sessionId/preflight';only('GET');
            if(!runtime.preflightPersistedSession)throw new RequestFailure(503,'session_import_unavailable');
            response=json(parsePersistedSessionPreflight(await runtime.preflightPersistedSession(context,selector)),requestId,200,8192);
          }else if(subresource==='imports'&&parts.length===4){
            route='/v1/persisted-sessions/:sessionId/imports';only('POST');
            if(!runtime.importPersistedSession)throw new RequestFailure(503,'session_import_unavailable');
            response=json(parseImportedSessionResult(await runtime.importPersistedSession(context,selector,await parseBody(request,parseImportPersistedSessionCommand))),requestId,200,16384);
          }else if(subresource==='imports'&&parts.length===5){
            route='/v1/persisted-sessions/:sessionId/imports/:commandId';only('GET');
            if(!runtime.importedSessionResult)throw new RequestFailure(503,'session_import_unavailable');
            response=json(parseImportedSessionResult(await runtime.importedSessionResult(context,selector,{commandId:text(actorId)!})),requestId,200,16384);
          }else throw new RequestFailure(404,'not_found');
        } else if(resource==='workflows'){
          route='/v1/workflows'
          const requirePort=(value:unknown)=>{if(typeof value!=='function')throw new RequestFailure(503,'workflow_workbench_unavailable')}
          if(parts.length===3&&sessionId==='definitions'){
            only('GET');query(request,[]);requirePort(runtime.workflowDefinitions)
            response=json(parseWorkflowDirectory(await runtime.workflowDefinitions!(context)),requestId,200,1048576)
          }else if(parts.length===3&&sessionId==='runs'){
            only('GET');const q=query(request,['after','limit']);requirePort(runtime.workflowRuns)
            response=json(parseWorkflowRunPage(await runtime.workflowRuns!(context,{...(q.has('after')?{after:text(q.get('after'),true,4096)}:{}),...(q.has('limit')?{limit:number(q.get('limit'),1,100)}:{})})),requestId,200,262144)
          }else if(parts.length===3&&sessionId==='commands'){
            only('POST');query(request,[]);requirePort(runtime.commandWorkflow)
            response=json(parseWorkflowCommandResult(await runtime.commandWorkflow!(context,await parseBody(request,parseWorkflowCommand))),requestId,200,8192)
          }else if(parts.length===4&&sessionId==='commands'){
            only('GET');query(request,[]);requirePort(runtime.workflowCommandResult)
            response=json(parseWorkflowCommandResult(await runtime.workflowCommandResult!(context,{commandId:text(subresource)!})),requestId,200,8192)
          }else if(parts.length===4&&sessionId==='runs'){
            only('GET');query(request,[]);requirePort(runtime.workflowRun)
            response=json(parseWorkflowRunView(await runtime.workflowRun!(context,{runId:text(subresource)!})),requestId,200,1048576)
          }else if(parts.length===5&&sessionId==='runs'&&actorId==='events'){
            only('GET');const q=query(request,['after','limit']);requirePort(runtime.workflowEvents)
            response=json(parseWorkflowEventPage(await runtime.workflowEvents!(context,{runId:text(subresource)!,...(q.has('after')?{after:text(q.get('after'),true,4096)}:{}),...(q.has('limit')?{limit:number(q.get('limit'),1,100)}:{})})),requestId,200,1048576)
          }else if(parts.length===5&&sessionId==='runs'&&actorId==='material'){
            only('GET');const q=query(request,['materialRef','revision','path','offsetBytes','limitBytes']);requirePort(runtime.workflowMaterial)
            response=json(parseWorkflowMaterialChunk(await runtime.workflowMaterial!(context,{runId:text(subresource)!,materialRef:text(q.get('materialRef'),true,1024)!,revision:text(q.get('revision'))!,path:text(q.get('path'),true,1024)!,...(q.has('offsetBytes')?{offsetBytes:number(q.get('offsetBytes'),0,Number.MAX_SAFE_INTEGER)}:{}),...(q.has('limitBytes')?{limitBytes:number(q.get('limitBytes'),1,32768)}:{})})),requestId,200,65536)
          }else throw new RequestFailure(404,'not_found')
        } else if(resource==='task-spaces'){
          route='/v1/task-spaces'
          if(parts.length===2){
            only('GET');const q=query(request,['after','limit'])
            if(!runtime.globalTaskSpaces)throw new RequestFailure(503,'global_taskspaces_unavailable')
            response=json(parseGlobalTaskSpacePage(await runtime.globalTaskSpaces(context,{...(q.has('after')?{after:text(q.get('after'))}:{}),...(q.has('limit')?{limit:number(q.get('limit'),1,100)}:{})})),requestId,200,131072)
          }else if(parts.length===3&&sessionId==='commands'){
            only('POST');query(request,[])
            if(!runtime.commandGlobalTaskSpace)throw new RequestFailure(503,'global_taskspaces_unavailable')
            response=json(parseGlobalTaskSpaceResult(await runtime.commandGlobalTaskSpace(context,await parseBody(request,parseGlobalTaskSpaceCommand))),requestId,200,8192)
          }else if(parts.length===4&&sessionId==='commands'){
            route='/v1/task-spaces/commands/:commandId';only('GET');query(request,[]);const commandId=text(subresource)!
            if(!runtime.globalTaskCreateResult)throw new RequestFailure(503,'global_taskspaces_unavailable')
            response=json(parseGlobalTaskSpaceResult(await runtime.globalTaskCreateResult(context,{commandId})),requestId,200,8192)
          }else if(parts.length===3){
            only('GET');const q=query(request,['after','limit']);text(sessionId)
            if(!runtime.globalTaskSpace)throw new RequestFailure(503,'global_taskspaces_unavailable')
            response=json(parseGlobalTaskSpaceView(await runtime.globalTaskSpace(context,{taskSpaceId:sessionId,...(q.has('after')?{after:text(q.get('after'))}:{}),...(q.has('limit')?{limit:number(q.get('limit'),1,100)}:{})})),requestId,200,131072)
          }else if(parts.length===5&&subresource==='commands'){
            only('GET');query(request,[]);text(sessionId);text(actorId)
            if(!runtime.globalTaskSpaceResult)throw new RequestFailure(503,'global_taskspaces_unavailable')
            response=json(parseGlobalTaskSpaceResult(await runtime.globalTaskSpaceResult(context,{taskSpaceId:sessionId,commandId:actorId})),requestId,200,8192)
          }else if(parts.length===6&&subresource==='roots'&&parts[5]==='plan'){
            route='/v1/task-spaces/:taskSpaceId/roots/:rootId/plan';only('GET');query(request,[]);text(sessionId);text(actorId)
            if(!runtime.globalTaskRootPlan)throw new RequestFailure(503,'global_taskspaces_unavailable')
            response=json(parseGlobalTaskRootPlanView(await runtime.globalTaskRootPlan(context,{taskSpaceId:sessionId,rootId:actorId})),requestId,200,131072)
          }else if(parts.length===5&&subresource==='tasks'){
            route='/v1/task-spaces/:taskSpaceId/tasks/:taskId';only('GET');const q=query(request,['after','limit']);text(sessionId);text(actorId)
            if(!runtime.globalTaskDetail)throw new RequestFailure(503,'global_taskspaces_unavailable')
            response=json(parseGlobalTaskDetail(await runtime.globalTaskDetail(context,{taskSpaceId:sessionId,taskId:actorId,...(q.has('after')?{after:text(q.get('after'))}:{}),...(q.has('limit')?{limit:number(q.get('limit'),1,100)}:{})})),requestId,200,131072)
          }else if(parts.length===7&&subresource==='tasks'&&parts[5]==='artifacts'){
            route='/v1/task-spaces/:taskSpaceId/tasks/:taskId/artifacts/:digest';only('GET');const q=query(request,['offsetBytes','limitBytes']);text(sessionId);text(actorId);const digest=text(parts[6])!
            if(!runtime.globalTaskArtifact)throw new RequestFailure(503,'global_taskspaces_unavailable')
            response=json(parseGlobalTaskArtifactChunk(await runtime.globalTaskArtifact(context,{taskSpaceId:sessionId,taskId:actorId,digest,...(q.has('offsetBytes')?{offsetBytes:number(q.get('offsetBytes'),0,Number.MAX_SAFE_INTEGER)}:{}),...(q.has('limitBytes')?{limitBytes:number(q.get('limitBytes'),1,32768)}:{})})),requestId,200,65536)
          }else throw new RequestFailure(404,'route_not_found')
        } else if (resource === "sessions" && parts.length === 2) {
          route = "/v1/sessions"
          if (method === "POST") { query(request, []); response = json(parseSessionSummary(await runtime.createSession(context, await parseBody(request, parseCreateSessionCommand))), requestId, 201) }
          else { only("GET"); const q = query(request, ["after", "limit"]); response = json(parseSessionList(await runtime.sessions(context, { after: text(q.get("after"), false, 4096), limit: number(q.get("limit"), 1, 200) })), requestId) }
        } else if (resource === "sessions" && sessionId) {
          text(sessionId)
          const selector = { sessionId }
          if (subresource === "management" && parts.length === 4) {
            route = "/v1/sessions/:sessionId/management"; query(request, [])
            if (method === "POST") {
              if (!runtime.manageSession) throw new RequestFailure(503, "session_management_unavailable")
              response = json(parseSessionManagementResult(await runtime.manageSession(context, selector, await parseBody(request, parseSessionManagementCommand))), requestId, 200, 8192)
            } else {
              only("GET")
              if (!runtime.sessionMetadata) throw new RequestFailure(503, "session_management_unavailable")
              response = json(parseSessionMetadata(await runtime.sessionMetadata(context, selector)), requestId, 200, 8192)
            }
          } else if (subresource === "management" && parts.length === 5) {
            route = "/v1/sessions/:sessionId/management/:commandId"; only("GET"); query(request, [])
            if (!runtime.sessionManagementResult) throw new RequestFailure(503, "session_management_unavailable")
            response = json(parseSessionManagementResult(await runtime.sessionManagementResult(context, selector, { commandId: text(actorId)! })), requestId, 200, 8192)
          } else if (subresource === "actors" && parts.length === 4) {
            route = "/v1/sessions/:sessionId/actors"; only("GET"); const q = query(request, ["view"])
            if (q.has("view") && q.get("view") !== "directory") throw new RequestFailure(400, "invalid_schema")
            response = json(parseActorDirectory(await runtime.actors(context, selector, { directoryOnly: q.get("view") === "directory" })), requestId)
          } else if (subresource === "statistics" && parts.length === 4) {
            route = "/v1/sessions/:sessionId/statistics"; only("GET"); const q = query(request, ["expectedEpoch"])
            if (!runtime.statistics) throw new RequestFailure(503, "statistics_unavailable")
            response = json(parseSessionStatistics(await runtime.statistics(context, selector, { expectedEpoch: text(q.get("expectedEpoch"))! })), requestId, 200, 16 * 1024)
          } else if (subresource === "operations" && parts.length === 4) {
            route = "/v1/sessions/:sessionId/operations"; only("GET"); const q = query(request, ["expectedEpoch", "limit"])
            if (!runtime.conversationOperations) throw new RequestFailure(503, "conversation_operations_unavailable")
            response = json(parseConversationOperationList(await runtime.conversationOperations(context, selector, { expectedEpoch: text(q.get("expectedEpoch"))!, limit: number(q.get("limit"), 1, 200) })), requestId)
          } else if (subresource === "operations" && parts.length === 5) {
            route = "/v1/sessions/:sessionId/operations/:operationId"; only("GET"); const q = query(request, ["expectedEpoch"])
            if (!runtime.conversationOperation) throw new RequestFailure(503, "conversation_operations_unavailable")
            response = json(parseConversationOperation(await runtime.conversationOperation(context, selector, { expectedEpoch: text(q.get("expectedEpoch"))!, operationId: text(actorId)! })), requestId)
          } else if (subresource === "operations" && leaf === "reconcile" && parts.length === 6) {
            route = "/v1/sessions/:sessionId/operations/:operationId/reconcile"; only("POST"); query(request, [])
            if (!runtime.conversationOperation) throw new RequestFailure(503, "conversation_operations_unavailable")
            const value = await body(request)
            if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "expectedEpoch")) throw new RequestFailure(400, "invalid_schema")
            const expectedEpoch = text((value as { expectedEpoch?: string }).expectedEpoch)!
            response = json(parseConversationOperation(await runtime.conversationOperation(context, selector, { expectedEpoch, operationId: text(actorId)!, reconcile: true })), requestId)
          } else if(subresource==='host-interactions'&&parts.length===4){
            route='/v1/sessions/:sessionId/host-interactions';only('GET');const q=query(request,['expectedEpoch']);
            if(!runtime.hostInteractions)throw new RequestFailure(503,'host_interactions_unavailable');
            response=json(await runtime.hostInteractions(context,selector,{expectedEpoch:text(q.get('expectedEpoch'))!}),requestId);
          } else if (subresource === "commands" && parts.length === 4) {
            route = "/v1/sessions/:sessionId/commands"; only("POST"); query(request, [])
            const result = parseCommandAdmission(await runtime.command(context, selector, await parseBody(request, parseCommandEnvelope)))
            response = json(result, requestId, result.status === "accepted" ? 202 : 200)
          } else if (subresource === "commands" && parts.length === 5) {
            route = "/v1/sessions/:sessionId/commands/:commandId"; only("GET"); const q = query(request, ["expectedEpoch"])
            response = json(parseCommandStatus(await runtime.commandStatus(context, selector, { commandId: text(actorId)!, expectedEpoch: text(q.get("expectedEpoch"))! })), requestId)
          } else if(subresource==='actors'&&actorId&&leaf==='management'&&parts.length===6){
            route='/v1/sessions/:sessionId/actors/:actorId/management';only('POST');query(request,[])
            if(!runtime.manageActor)throw new RequestFailure(503,'actor_management_unavailable')
            response=json(parseActorManagementResult(await runtime.manageActor(context,{sessionId,actorId:text(actorId)!},await parseBody(request,parseActorManagementCommand))),requestId)
          } else if(subresource==='actors'&&actorId&&leaf==='management'&&messageId&&parts.length===7){
            route='/v1/sessions/:sessionId/actors/:actorId/management/:commandId';only('GET');query(request,[])
            if(!runtime.actorManagementResult)throw new RequestFailure(503,'actor_management_unavailable')
            response=json(parseActorManagementResult(await runtime.actorManagementResult(context,{sessionId,actorId:text(actorId)!},{commandId:text(messageId)!})),requestId)
          } else if (subresource === "actors" && actorId && leaf === "attachments" && parts.length === 6) {
            route = "/v1/sessions/:sessionId/actors/:actorId/attachments"; only("POST"); query(request, [])
            if (!runtime.attachment) throw new RequestFailure(503, "attachment_upload_unavailable")
            response = json(parseAttachmentSummary(await runtime.attachment(context, { sessionId, actorId: text(actorId)! }, await parseBody(request, parseAttachmentOperation))), requestId)
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
    if (options.close) await options.close()
    else await options.runtime?.close()
  })
  return host
}
