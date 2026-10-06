import { parseObservationFrame } from "@cell/ai-runtime-host-contract"
import type {
  ActorSummary, AssociatedTurn, CheckpointStatus, CommandEnvelope, CommandStatus, HistoryWindow, HostAuthorizationEffects,
  HostIdentityEffects, HostRequest, ObservationCursorBinding, ObservationCursorEffects, ObservationEvent,
  ObservationFrame, ObservationPayloads, ObservationQueue, ObservationQueueEffects, PendingStream,
  Preview, Principal, QuestionRecord, SessionSnapshot, Subscription,
} from "@cell/ai-runtime-host-contract"
import { HostProtocolFailure } from "./commands"

export type ObservationPublication = {
  [K in keyof ObservationPayloads]: { kind: K; payload: ObservationPayloads[K] } &
    (K extends "command.updated" ? { principalId: string } : { principalId?: string })
}[keyof ObservationPayloads]
type OwnedCommand = { principalId: string; value: CommandStatus }
type Projection = {
  actors: Map<string, ActorSummary>; histories: Map<string, HistoryWindow>; streams: Map<string, PendingStream>
  commands: Map<string, OwnedCommand>; turns: Map<string, AssociatedTurn>; questions: Map<string, QuestionRecord>
  turnOwners: Map<string, Set<string>>; checkpoint: CheckpointStatus
}
type Retained = { publication: ObservationPublication; seq: number; time: number; bytes: number; callers: readonly string[] }
type Observer = { request: HostRequest; actors: readonly string[]; binding: ObservationCursorBinding; queue: ObservationQueue; terminal?: ObservationFrame }
export type ObservationLimits = {
  ringCount: number; ringBytes: number; ringTtlMs: number; metadataBytes: number; schemaBytes: number
  historyBytes: number; pendingBytes: number; snapshotBytes: number; frameBytes: number; subscriptionsPerPrincipal: number
}
export const defaultObservationLimits: ObservationLimits = {
  ringCount: 10000, ringBytes: 16 * 1024 * 1024, ringTtlMs: 600000, metadataBytes: 1024 * 1024,
  schemaBytes: 4 * 1024 * 1024, historyBytes: 1024 * 1024, pendingBytes: 1024 * 1024,
  snapshotBytes: 8 * 1024 * 1024, frameBytes: 1024 * 1024, subscriptionsPerPrincipal: 32,
}
export type ObservationState = {
  controlReservations: Map<string, ObservationControlReservation>
  projection: Projection; seq: number; ring: Retained[]; ringBytes: number; observers: Set<Observer>
  processing: boolean; pending: ObservationPublication[]; closed: boolean
}
export type ObservationControlReservation = { kind: "cancel" | "answer"; turnId: string; questionnaireId?: string }
export type ObservationReservationLease = { commit: () => void; release: () => void }
// One public command record is limited to 2048 UTF-8 bytes. Its separate
// callerControls.commandIds entry is at most 256 UTF-8 bytes (schema enforced),
// or 1538 JSON bytes when every byte needs a six-character escape.
// 4096 covers both plus JSON framing; schema is accounted independently.
export const observationControlReservationBytes = 4096
const reservationKey = (value: ObservationControlReservation): string => JSON.stringify([value.kind, value.turnId, value.questionnaireId ?? null])
const reservedBytes = (reservations: Map<string, ObservationControlReservation>): number => reservations.size * observationControlReservationBytes
function releasedBy(reservations: Map<string, ObservationControlReservation>, publication: ObservationPublication) {
  const turn = publication.kind === "turn.updated" ? publication.payload : publication.kind === "command.updated" ? publication.payload.associatedTurn : undefined
  for (const [key, value] of reservations) {
    if (turn && terminalTurn(turn) && value.turnId === turn.turnId
      || publication.kind === "question.updated" && publication.payload.state !== "pending" && value.kind === "answer" && value.questionnaireId === publication.payload.questionnaireId) reservations.delete(key)
  }
}
export type ObservationRuntime = {
  sessionId: string; epoch: string; state: ObservationState; authorization: HostAuthorizationEffects
  identity: HostIdentityEffects; cursors: ObservationCursorEffects; queues: ObservationQueueEffects
  limits?: Partial<ObservationLimits>
}
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
const terminalTurn = (turn: AssociatedTurn): boolean => ["succeeded", "failed", "cancelled", "interrupted"].includes(turn.state)
const streamKey = (s: { actorId: string; turnId: string; attemptId: string; messageId: string }): string => JSON.stringify([s.actorId, s.turnId, s.attemptId, s.messageId])
const commandKey = (principal: string, id: string): string => JSON.stringify([principal, id])
const limitsFor = (runtime: ObservationRuntime) => ({ ...defaultObservationLimits, ...runtime.limits })
function failure(code: string, status = 413, requestId = "observation"): never {
  throw new HostProtocolFailure(status, { code, requestId, retryable: false })
}
export function createObservationState(): ObservationState {
  return { controlReservations: new Map(), projection: { actors: new Map(), histories: new Map(), streams: new Map(), commands: new Map(), turns: new Map(), questions: new Map(), turnOwners: new Map(), checkpoint: { state: "saved" } }, seq: 0, ring: [], ringBytes: 0, observers: new Set(), processing: false, pending: [], closed: false }
}
function permitted(runtime: ObservationRuntime, principal: Principal, actorId: string, action: ActorSummary["allowedActions"][number]): boolean {
  return !!runtime.state.projection.actors.get(actorId)?.allowedActions.includes(action)
    && runtime.authorization.permits(principal, { kind: "actor", sessionId: runtime.sessionId, actorId, action })
}
function validObserver(runtime: ObservationRuntime, observer: Pick<Observer, "request" | "actors">): boolean {
  return runtime.authorization.currentGrantsVersion(observer.request.principal.principalId) === observer.request.principal.grantsVersion
    && runtime.authorization.permits(observer.request.principal, { kind: "session", sessionId: runtime.sessionId, action: "open" })
    && observer.actors.every(id => permitted(runtime, observer.request.principal, id, "observe"))
}
function pruneRing(runtime: ObservationRuntime): void {
  const s = runtime.state; const limits = limitsFor(runtime); const now = runtime.identity.now()
  while (s.ring.length && (s.ring.length > limits.ringCount || s.ringBytes > limits.ringBytes || now - s.ring[0].time >= limits.ringTtlMs)) s.ringBytes -= s.ring.shift()!.bytes
}
/** Keeps only a bounded suffix of public parts; the canonical history owner is never changed. */
function clipPreview(preview: Preview, budget: number): Preview {
  if (bytes(preview) <= budget) return preview
  const parts = [...preview.parts]; const original = bytes(parts)
  while (parts.length > 1 && bytes({ ...preview, parts, truncated: true }) > budget) parts.shift()
  if (parts.length && bytes({ ...preview, parts, truncated: true }) > budget) {
    const last = parts[0]
    const field = last.kind === "text" || last.kind === "reasoning" ? "text" : last.kind === "tool_call" ? "input" : "output"
    const text = (last as unknown as Record<string, string>)[field]
    let low = 0; let high = text.length; let suffix = ""
    while (low <= high) {
      const count = Math.floor((low + high) / 2)
      let candidate = text.slice(text.length - count)
      if (candidate.length && candidate.charCodeAt(0) >= 0xdc00 && candidate.charCodeAt(0) <= 0xdfff) candidate = candidate.slice(1)
      if (bytes({ ...preview, parts: [{ ...last, [field]: candidate }], truncated: true }) <= budget) { suffix = candidate; low = count + 1 } else high = count - 1
    }
    parts[0] = { ...last, [field]: suffix }
    if (bytes({ ...preview, parts, truncated: true }) > budget) parts.length = 0
  }
  return { ...preview, parts, truncated: true, startOffset: Math.min(preview.totalBytes, preview.startOffset + original - bytes(parts)) }
}
function cloneProjection(p: Projection): Projection {
  return { actors: new Map(p.actors), histories: new Map(p.histories), streams: new Map(p.streams), commands: new Map(p.commands), turns: new Map(p.turns), questions: new Map(p.questions), turnOwners: new Map([...p.turnOwners].map(([id, owners]) => [id, new Set(owners)])), checkpoint: p.checkpoint }
}
function activeCommand(p: Projection, status: CommandStatus): boolean {
  if (status.state === "rejected") return false
  const turn = status.turnId ? p.turns.get(status.turnId) ?? status.associatedTurn : status.associatedTurn
  if (turn && terminalTurn(turn)) return false
  return status.state === "accepted" || status.state === "unknown" || !!turn && !terminalTurn(turn)
}
function retireControls(p: Projection): void {
  for (const [id, record] of p.questions) if (record.state !== "pending" || (p.turns.get(record.turnId) && terminalTurn(p.turns.get(record.turnId)!))) p.questions.delete(id)
  for (const [id, record] of p.commands) if (!activeCommand(p, record.value)) p.commands.delete(id)
  for (const [id, turn] of p.turns) if (terminalTurn(turn)) {
    p.turns.delete(id); p.turnOwners.delete(id)
    for (const [key, stream] of p.streams) if (stream.turnId === id) p.streams.delete(key)
  }
  for (const id of p.turnOwners.keys()) if (!p.turns.has(id) && ![...p.commands.values()].some(c => c.value.turnId === id) && ![...p.questions.values()].some(q => q.turnId === id)) p.turnOwners.delete(id)
}
function metadata(p: Projection): unknown {
  return { actors: [...p.actors.values()], histories: [...p.histories.values()].map(h => ({ ...h, messages: h.messages.map(m => ({ ...m, preview: { ...m.preview, parts: [] } })) })), streams: [...p.streams.values()].map(s => ({ ...s, preview: { ...s.preview, parts: [] } })), commands: [...p.commands.values()].map(c => c.value), turns: [...p.turns.values()], questions: [...p.questions.values()].map(({ schema: _, ...q }) => q), checkpoint: p.checkpoint,
    callerControls: { commandIds: [...p.commands.values()].map(c => c.value.commandId), turnIds: [...p.turns.keys()], questionnaireIds: [...p.questions.keys()] } }
}
function checkProjection(p: Projection, limits: ObservationLimits): void {
  if (p.actors.size > 64 || bytes(metadata(p)) > limits.metadataBytes) failure("snapshot_capacity")
  for (const record of [...p.actors.values(), ...[...p.commands.values()].map(c => c.value), ...p.turns.values(), ...[...p.questions.values()].map(({ schema: _, ...q }) => q)]) if (bytes(record) > 2048) failure("snapshot_capacity")
  if (p.questions.size > 64 || [...p.questions.values()].reduce((n, q) => n + (q.schema ? bytes(q.schema) : 0), 0) > limits.schemaBytes) failure("question_capacity", 429)
  for (const q of p.questions.values()) if (q.schema && bytes(q.schema) > 65536) failure("question_capacity", 429)
}
function updateProjection(p: Projection, publication: ObservationPublication): readonly string[] {
  const payload = publication.payload
  let callers: readonly string[] = []
  switch (publication.kind) {
    case "actor.created": case "actor.updated": p.actors.set(publication.payload.actorId, publication.payload); break
    case "command.updated": {
      const value = publication.payload; callers = [publication.principalId]
      p.commands.set(commandKey(publication.principalId, value.commandId), { principalId: publication.principalId, value })
      if (value.turnId) { const owners = p.turnOwners.get(value.turnId) ?? new Set(); owners.add(publication.principalId); p.turnOwners.set(value.turnId, owners) }
      if (value.associatedTurn) p.turns.set(value.associatedTurn.turnId, value.associatedTurn)
      break
    }
    case "turn.updated": p.turns.set(publication.payload.turnId, publication.payload); break
    case "question.updated": p.questions.set(publication.payload.questionnaireId, publication.payload); break
    case "stream.updated": {
      const stream = publication.payload; const old = p.streams.get(streamKey(stream))
      if (!old || stream.revision > old.revision) p.streams.set(streamKey(stream), stream)
      break
    }
    case "stream.closed": p.streams.delete(streamKey(publication.payload)); break
    case "history.committed": {
      const value = publication.payload; const old = p.histories.get(value.actorId)
      const messages = [...(old?.messages ?? []).filter(m => m.messageId !== value.message.messageId), value.message].slice(-200)
      p.histories.set(value.actorId, { actorId: value.actorId, historyRevision: value.historyRevision, messages, historyWindowTruncated: !!old?.historyWindowTruncated || (old?.messages.length ?? 0) >= 200 })
      if (value.turnId && value.attemptId) p.streams.delete(streamKey({ ...value, turnId: value.turnId, attemptId: value.attemptId, messageId: value.message.messageId }))
      break
    }
    case "checkpoint.updated": p.checkpoint = publication.payload; break
  }
  if ("turnId" in payload && payload.turnId) {
    if (publication.principalId) { const owners = p.turnOwners.get(payload.turnId) ?? new Set(); owners.add(publication.principalId); p.turnOwners.set(payload.turnId, owners) }
    callers = [...(p.turnOwners.get(payload.turnId) ?? [])]
  }
  return callers
}
function boundedProjection(p: Projection, limits: ObservationLimits = defaultObservationLimits): void {
  for (const [actorId, history] of p.histories) {
    let available = 1024 * 1024; const messages = []
    for (const message of [...history.messages].reverse()) {
      const size = bytes(message); if (size > available) break
      available -= size; messages.unshift(message)
    }
    p.histories.set(actorId, { ...history, messages, historyWindowTruncated: history.historyWindowTruncated || messages.length < history.messages.length })
  }
  const remaining = new Map<string, number>()
  for (const [key, stream] of [...p.streams].reverse()) {
    const available = remaining.get(stream.actorId) ?? 1024 * 1024
    const preview = clipPreview(stream.preview, Math.max(128, available))
    remaining.set(stream.actorId, Math.max(0, available - bytes(preview)))
    p.streams.set(key, { ...stream, preview })
  }
  // History is a display window, never a reason to reject an otherwise valid owner commit.
  // Reserve metadata for actors and active controls by evicting old display identities first.
  let excess = bytes(metadata(p)) - limits.metadataBytes
  while (excess > 0) {
    const history = [...p.histories.values()].filter(h => h.messages.length).sort((a, b) => b.messages.length - a.messages.length)[0]
    if (!history) break
    let remove = 0; let freed = 0
    while (remove < history.messages.length && freed < excess) {
      const message = history.messages[remove++]; freed += bytes({ ...message, preview: { ...message.preview, parts: [] } }) + 1
    }
    p.histories.set(history.actorId, { ...history, messages: history.messages.slice(remove), historyWindowTruncated: true })
    excess = bytes(metadata(p)) - limits.metadataBytes
  }
}
function redactTurn(runtime: ObservationRuntime, principal: Principal, turn: AssociatedTurn): AssociatedTurn {
  return { ...turn, canCancel: turn.canCancel && permitted(runtime, principal, turn.actorId, "cancel_turn") }
}
function redactQuestion(runtime: ObservationRuntime, principal: Principal, question: QuestionRecord): QuestionRecord {
  const canAnswer = question.canAnswer && permitted(runtime, principal, question.actorId, "answer_question")
  const { schema, ...rest } = question
  return { ...rest, canAnswer, ...(canAnswer && schema ? { schema } : {}) }
}
function eventFor(runtime: ObservationRuntime, observer: Observer, retained: Retained): ObservationEvent | undefined {
  const { publication, seq, callers } = retained; const principal = observer.request.principal
  const payload = publication.payload
  const actorId = "actorId" in payload ? payload.actorId : undefined
  const own = callers.includes(principal.principalId)
  const display = actorId !== undefined && observer.actors.includes(actorId)
  if (publication.kind === "command.updated" ? !own : !["checkpoint.updated", "session.closing"].includes(publication.kind) && !display && !(own && ["turn.updated", "question.updated"].includes(publication.kind))) return undefined
  let value: unknown = payload
  if (publication.kind === "actor.created" || publication.kind === "actor.updated") value = { ...publication.payload, allowedActions: publication.payload.allowedActions.filter(action => permitted(runtime, principal, publication.payload.actorId, action)) }
  if (publication.kind === "turn.updated") value = redactTurn(runtime, principal, publication.payload)
  if (publication.kind === "question.updated") value = redactQuestion(runtime, principal, publication.payload)
  if (publication.kind === "command.updated" && publication.payload.associatedTurn) value = { ...publication.payload, associatedTurn: redactTurn(runtime, principal, publication.payload.associatedTurn) }
  return { epoch: runtime.epoch, seq, cursor: runtime.cursors.issue(observer.binding, seq), kind: publication.kind, ...(actorId ? { actorId } : {}), payload: value } as ObservationEvent
}
function terminate(observer: Observer, code: string): void {
  observer.terminal = { kind: "protocol.error", code, requestId: observer.request.requestId, retryable: false }; observer.queue.close()
}
/** Synchronous admission preflight; caller must publish in the same turn, before yielding. */
export function preflightObservation(runtime: ObservationRuntime, input: ObservationPublication | readonly ObservationPublication[]): void {
  prepareObservationReservation(runtime, {}, input)
}
/** Prepare only; commit and publication must remain in the same synchronous owner transaction. */
export function prepareObservationReservation(runtime: ObservationRuntime, change: {
  reserve?: readonly ObservationControlReservation[]; consume?: readonly ObservationControlReservation[]
}, input: ObservationPublication | readonly ObservationPublication[] = []): ObservationReservationLease {
  if (runtime.state.closed) failure("session_closing", 409)
  const previous = runtime.state.controlReservations
  const reservations = new Map(previous)
  for (const value of change.reserve ?? []) reservations.set(reservationKey(value), value)
  for (const value of change.consume ?? []) reservations.delete(reservationKey(value))
  const projection = cloneProjection(runtime.state.projection)
  for (const publication of Array.isArray(input) ? input : [input as ObservationPublication]) {
    parseObservationFrame({ epoch: runtime.epoch, seq: runtime.state.seq + 1, cursor: "validation", kind: publication.kind, payload: publication.payload })
    updateProjection(projection, publication)
    releasedBy(reservations, publication)
  }
  const limits = { ...limitsFor(runtime), metadataBytes: limitsFor(runtime).metadataBytes - reservedBytes(reservations) }
  for (const value of change.reserve ?? []) {
    const turn = projection.turns.get(value.turnId)
    if (!turn || bytes({ commandId: "\u0000".repeat(256), epoch: runtime.epoch, state: "accepted", turnId: value.turnId, associatedTurn: turn }) > 2048) failure("control_capacity", 429)
  }
  retireControls(projection); boundedProjection(projection, limits)
  checkProjection(projection, limits)
  let committed = false; let released = false
  return {
    commit() {
      if (committed || released) return
      if (runtime.state.controlReservations !== previous) throw new Error("observation_reservation_stale")
      runtime.state.controlReservations = reservations; committed = true
    },
    release() {
      if (released) return
      released = true
      if (!committed) return
      const current = new Map(runtime.state.controlReservations)
      for (const value of change.reserve ?? []) current.delete(reservationKey(value))
      for (const value of change.consume ?? []) {
        const before = previous.get(reservationKey(value))
        const turn = runtime.state.projection.turns.get(value.turnId)
        if (before && turn && !terminalTurn(turn) && (value.kind === "cancel" || runtime.state.projection.questions.has(value.questionnaireId!))) current.set(reservationKey(value), before)
      }
      runtime.state.controlReservations = current
    },
  }
}
export function prepareObservationCommand(runtime: ObservationRuntime, command: CommandEnvelope, principalId: string, status: CommandStatus): ObservationReservationLease {
  const reservation: ObservationControlReservation | undefined = status.turnId
    ? command.kind === "answer_question" ? { kind: "answer", turnId: status.turnId, questionnaireId: command.payload.questionnaireId }
      : { kind: "cancel", turnId: status.turnId } : undefined
  return prepareObservationReservation(runtime, {
    ...(command.kind === "send_text" && reservation ? { reserve: [reservation] } : {}),
    ...((command.kind === "cancel_turn" || command.kind === "answer_question") && reservation ? { consume: [reservation] } : {}),
  }, { kind: "command.updated", principalId, payload: status })
}
/** Publication is synchronous; injected effects may reenter, so subsequent publications are drained after fan-out. */
export function publishObservation(runtime: ObservationRuntime, input: ObservationPublication): void {
  const state = runtime.state; if (state.closed) return
  const publication = structuredClone(input)
  if (state.processing) {
    if (state.pending.length >= 1000 || bytes(publication) + state.pending.reduce((n, item) => n + bytes(item), 0) > 2 * 1024 * 1024) failure("publication_capacity", 429)
    state.pending.push(publication); return
  }
  state.processing = true
  try {
    let next: ObservationPublication | undefined = publication
    while (next) {
      const limits = limitsFor(runtime)
      if (next.kind === "history.committed") next = { ...next, payload: { ...next.payload, message: { ...next.payload.message, preview: clipPreview(next.payload.message.preview, 256 * 1024 - 1024) } } }
      if (next.kind === "stream.updated") next = { ...next, payload: { ...next.payload, preview: clipPreview(next.payload.preview, 256 * 1024 - 1024) } }
      // Validate public shape before mutating projection or allocating a sequence.
      parseObservationFrame({ epoch: runtime.epoch, seq: state.seq + 1, cursor: "validation", kind: next.kind, payload: next.payload })
      if ("actorId" in next.payload && next.kind !== "actor.created" && next.kind !== "actor.updated" && !state.projection.actors.has(next.payload.actorId)) failure("actor_not_found", 404)
      const projected = cloneProjection(state.projection); const callers = updateProjection(projected, next)
      const reservations = new Map(state.controlReservations); releasedBy(reservations, next)
      const capacityLimits = { ...limits, metadataBytes: limits.metadataBytes - reservedBytes(reservations) }
      retireControls(projected); boundedProjection(projected, capacityLimits); checkProjection(projected, capacityLimits)
      state.controlReservations = reservations
      state.projection = projected
      const retained: Retained = { publication: next, callers, seq: ++state.seq, time: runtime.identity.now(), bytes: bytes(next) }
      state.ring.push(retained); state.ringBytes += retained.bytes; pruneRing(runtime)
      for (const observer of [...state.observers]) {
        if (!validObserver(runtime, observer)) { observer.queue.close(); continue }
        const event = eventFor(runtime, observer, retained)
        if (!event) continue
        if (runtime.queues.frameBytes(event) > limits.frameBytes) terminate(observer, "frame_too_large")
        else observer.queue.push(event, "live")
      }
      next = state.pending.shift()
    }
  } finally { state.processing = false; state.pending.length = 0 }
}
/** Only seed derived owner history before observation starts. Subsequent commits use publication. */
export function seedObservationHistory(runtime: ObservationRuntime, history: HistoryWindow): void {
  if (runtime.state.processing || runtime.state.observers.size) throw new Error("history_seed_after_observation")
  const projection = cloneProjection(runtime.state.projection)
  projection.histories.set(history.actorId, { ...history, messages: history.messages.slice(-200).map(message => structuredClone({ ...message, preview: clipPreview(message.preview, 256 * 1024 - 1024) })), historyWindowTruncated: history.historyWindowTruncated || history.messages.length > 200 })
  const limits = { ...limitsFor(runtime), metadataBytes: limitsFor(runtime).metadataBytes - reservedBytes(runtime.state.controlReservations) }
  boundedProjection(projection, limits); checkProjection(projection, limits); runtime.state.projection = projection
}
/** Owner rewind/compaction invalidates display history; next reconnect receives reset + a fresh snapshot. */
export function resetObservationHistory(runtime: ObservationRuntime, history: HistoryWindow): void {
  if (runtime.state.processing) throw new Error("history_reset_reentrant")
  const projection = cloneProjection(runtime.state.projection)
  projection.histories.set(history.actorId, structuredClone(history))
  const limits = { ...limitsFor(runtime), metadataBytes: limitsFor(runtime).metadataBytes - reservedBytes(runtime.state.controlReservations) }
  boundedProjection(projection, limits); checkProjection(projection, limits)
  runtime.state.projection = projection; runtime.state.seq++
  runtime.state.ring.length = 0; runtime.state.ringBytes = 0
  for (const observer of [...runtime.state.observers]) observer.queue.close()
}
/** Remove departed owner identities only after all their caller controls finish.
 * There is no actor.deleted wire event: invalidating the ring closes readers so
 * the next capture derives its directory from the new authoritative projection.
 */
export function retireObservationActors(runtime: ObservationRuntime, liveActorIds: ReadonlySet<string>): string[] {
  if (runtime.state.processing) throw new Error("actor_retirement_reentrant")
  const projection = cloneProjection(runtime.state.projection)
  retireControls(projection)
  // An admitted command may not have a turn binding yet. Its target is private
  // to the command index, so conservatively retain identities until it settles.
  if ([...projection.commands.values()].some(command => !command.value.associatedTurn && activeCommand(projection, command.value))) return []
  const protectedActors = new Set([
    ...[...projection.turns.values()].map(turn => turn.actorId),
    ...[...projection.questions.values()].map(question => question.actorId),
    ...[...projection.commands.values()].flatMap(command => command.value.associatedTurn ? [command.value.associatedTurn.actorId] : []),
  ])
  const retired: string[] = []
  for (const actorId of projection.actors.keys()) {
    if (liveActorIds.has(actorId) || protectedActors.has(actorId)) continue
    projection.actors.delete(actorId); projection.histories.delete(actorId)
    for (const [id, stream] of projection.streams) if (stream.actorId === actorId) projection.streams.delete(id)
    retired.push(actorId)
  }
  if (!retired.length) return retired
  runtime.state.projection = projection; runtime.state.seq++
  runtime.state.ring.length = 0; runtime.state.ringBytes = 0
  for (const observer of [...runtime.state.observers]) observer.queue.close()
  return retired
}
function buildSnapshot(runtime: ObservationRuntime, observer: Observer): ObservationFrame {
  const p = runtime.state.projection; const principal = observer.request.principal; const limits = limitsFor(runtime)
  const own = [...p.commands.values()].filter(c => c.principalId === principal.principalId)
  const ownTurns = new Set([...p.turnOwners].filter(([, owners]) => owners.has(principal.principalId)).map(([id]) => id))
  const display = new Set(observer.actors)
  const turns = [...p.turns.values()].filter(t => display.has(t.actorId) || ownTurns.has(t.turnId)).map(t => redactTurn(runtime, principal, t))
  const questions = [...p.questions.values()].filter(q => display.has(q.actorId) || ownTurns.has(q.turnId)).map(q => redactQuestion(runtime, principal, q))
  let historyBytes = limits.historyBytes; const histories: HistoryWindow[] = []
  for (const actorId of display) {
    const history = p.histories.get(actorId); if (!history || !permitted(runtime, principal, actorId, "read_history")) continue
    const messages = []
    for (const message of [...history.messages].reverse()) { const size = bytes(message); if (size > historyBytes) break; historyBytes -= size; messages.unshift(message) }
    histories.push({ ...history, messages, historyWindowTruncated: history.historyWindowTruncated || messages.length < history.messages.length })
  }
  let pendingBytes = limits.pendingBytes; const pendingStreams: PendingStream[] = []
  for (const stream of p.streams.values()) if (display.has(stream.actorId)) {
    const preview = clipPreview(stream.preview, Math.max(128, pendingBytes)); pendingBytes = Math.max(0, pendingBytes - bytes(preview)); pendingStreams.push({ ...stream, preview })
  }
  const payload: SessionSnapshot = {
    sessionId: runtime.sessionId, epoch: runtime.epoch, seq: runtime.state.seq, cursor: runtime.cursors.issue(observer.binding, runtime.state.seq),
    actors: [...display].map(id => p.actors.get(id)!).map(actor => ({ ...actor, allowedActions: actor.allowedActions.filter(action => permitted(runtime, principal, actor.actorId, action)) })),
    histories, pendingStreams, commands: own.map(c => ({ ...c.value, ...(c.value.associatedTurn ? { associatedTurn: redactTurn(runtime, principal, c.value.associatedTurn) } : {}) })), turns, questions,
    callerControls: { commandIds: own.map(c => c.value.commandId), turnIds: turns.filter(t => ownTurns.has(t.turnId)).map(t => t.turnId), questionnaireIds: questions.filter(q => ownTurns.has(q.turnId)).map(q => q.questionnaireId) }, checkpoint: p.checkpoint,
  }
  const frame: ObservationFrame = { kind: "snapshot", requestId: observer.request.requestId, payload }
  parseObservationFrame(frame)
  if (runtime.queues.frameBytes(frame) > limits.snapshotBytes) failure("snapshot_capacity", 413, observer.request.requestId)
  return frame
}
export function captureObservation(runtime: ObservationRuntime, request: HostRequest, input: { actors: readonly string[]; after?: string }): Subscription {
  const state = runtime.state; const limits = limitsFor(runtime)
  if (state.closed) failure("session_closing", 409, request.requestId)
  if (state.processing) throw new Error("observation_capture_reentrant")
  const actors = [...new Set(input.actors)].sort()
  if (actors.length > 64) failure("scope_capacity", 400, request.requestId)
  for (const id of actors) if (!state.projection.actors.has(id)) failure("actor_not_found", 404, request.requestId)
  if ([...state.observers].filter(o => o.request.principal.principalId === request.principal.principalId).length >= limits.subscriptionsPerPrincipal) failure("subscription_capacity", 429, request.requestId)
  const scope = { request, actors, binding: { epoch: runtime.epoch, principalId: request.principal.principalId, grantsVersion: request.principal.grantsVersion, actors } }
  if (!validObserver(runtime, scope)) failure("forbidden", 403, request.requestId)
  const observer: Observer = { ...scope, queue: runtime.queues.create(() => state.observers.delete(observer)) }
  state.processing = true
  try {
    pruneRing(runtime)
    const after = input.after ? runtime.cursors.read(observer.binding, input.after) : undefined
    let replay = after !== undefined && after <= state.seq && after >= (state.ring[0]?.seq ?? state.seq + 1) - 1
    // A valid retained cursor may still require more bootstrap backlog than one lease can hold.
    // Reset to the exact current snapshot rather than closing immediately and replaying forever.
    if (replay) {
      let count = 0; let replayBytes = 0
      for (const entry of state.ring) if (entry.seq > after!) {
        const frame = eventFor(runtime, observer, entry)
        if (frame) { count++; replayBytes += runtime.queues.frameBytes(frame) }
        if (count > 1000 || replayBytes > 2 * 1024 * 1024) { replay = false; break }
      }
    }
    // Register before any cursor/queue effect can synchronously publish; publications wait behind this gate.
    state.observers.add(observer)
    if (input.after && !replay) observer.queue.push({ kind: "reset_required", requestId: request.requestId, code: "cursor_expired" }, "bootstrap")
    if (!replay) observer.queue.push(buildSnapshot(runtime, observer), "bootstrap")
    else for (const entry of state.ring) if (entry.seq > after!) {
      const frame = eventFor(runtime, observer, entry)
      if (frame && runtime.queues.frameBytes(frame) > limits.frameBytes) { terminate(observer, "frame_too_large"); break }
      if (frame && !observer.queue.push(frame, "live")) break
    }
  } catch (error) { observer.queue.close(); throw error }
  finally {
    state.processing = false
    const pending = state.pending.shift()
    if (pending) publishObservation(runtime, pending)
  }
  const source = observer.queue.frames[Symbol.asyncIterator]()
  return { close: () => { observer.terminal = undefined; observer.queue.close() }, frames: { [Symbol.asyncIterator]() { return {
    async next(): Promise<IteratorResult<ObservationFrame>> {
      if (!validObserver(runtime, observer)) { observer.terminal = undefined; observer.queue.close() }
      const item = await source.next()
      if (!validObserver(runtime, observer)) { observer.terminal = undefined; observer.queue.close(); return { done: true, value: undefined } }
      if (item.done && observer.terminal) { const frame = observer.terminal; observer.terminal = undefined; return { done: false, value: frame } }
      return item
    },
    async return() { observer.terminal = undefined; observer.queue.close(); return { done: true as const, value: undefined } },
  } } } }
}
export function revalidateObservations(runtime: ObservationRuntime): void {
  for (const observer of [...runtime.state.observers]) if (!validObserver(runtime, observer)) observer.queue.close()
}
export function closeObservations(runtime: ObservationRuntime): void {
  runtime.state.controlReservations.clear()
  runtime.state.closed = true; runtime.state.pending.length = 0
  for (const observer of [...runtime.state.observers]) observer.queue.close()
  runtime.state.ring.length = 0; runtime.state.ringBytes = 0
  runtime.state.projection = createObservationState().projection
}
