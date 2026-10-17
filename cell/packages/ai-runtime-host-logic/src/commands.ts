import { parseCommandEnvelope } from "@cell/ai-runtime-host-contract"
import type {
  ActorSummary, AssociatedTurn, CommandAdmission, CommandEnvelope, CommandReceipt, CommandStatus,
  HostAuthorizationEffects, HostIdentityEffects, HostRequest, ProtocolError, QuestionRecord,
} from "@cell/ai-runtime-host-contract"

export class HostProtocolFailure extends Error {
  constructor(readonly status: number, readonly error: ProtocolError) { super(error.code) }
}

/** An owner may already have committed. Never report rejection or retry it. */
export class HostCommandOutcomeUnknown extends Error {
  constructor(readonly code: string, readonly result?: CommandStatus["result"]) { super(code) }
}

type CommandEntry = {
  hash: string
  principalId: string
  requestId: string
  receipt?: CommandReceipt
  status?: CommandStatus
  terminalAt?: number
}
type TurnControl = { principalId: string; commandKey: string; turn: AssociatedTurn; cancelKey?: string; cancelReserved: boolean; terminalAt?: number }
type QuestionControl = { record: QuestionRecord; answerKey?: string; responseHash?: string; answerReserved: boolean; terminalAt?: number }
export type CommandAdmissionLease = { commit: () => void; release: () => void }

export type CommandIndex = {
  entries: Map<string, CommandEntry>
  turns: Map<string, TurnControl>
  questions: Map<string, QuestionControl>
  reserved: number
  accepting: boolean
}

export type CommandRuntime = {
  sessionId: string
  epoch: string
  index: CommandIndex
  authorization: HostAuthorizationEffects
  identity: HostIdentityEffects
  effects: {
    digest: (text: string) => string
    actor: (actorId: string) => ActorSummary | undefined
    preflight: (command: CommandEnvelope, admission: { request: HostRequest; status: CommandStatus }) => void | CommandAdmissionLease
    execute: (command: CommandEnvelope, turnId: string | undefined, request: HostRequest) => Promise<CommandStatus["result"] | void>
    defer: (run: () => Promise<void>) => void
    publishCommand: (principalId: string, status: CommandStatus) => void
  }
}

export type CommandLimits = { receipts: number; identities: number; terminalTtlMs: number; controls?: number; controlBytes?: number }
export const defaultCommandLimits: CommandLimits = { receipts: 10000, identities: 100000, terminalTtlMs: 24 * 60 * 60 * 1000 }

export function createCommandIndex(): CommandIndex {
  return { entries: new Map(), turns: new Map(), questions: new Map(), reserved: 0, accepting: true }
}

const terminal = (turn: AssociatedTurn): boolean => ["succeeded", "failed", "cancelled", "interrupted"].includes(turn.state)
const keyFor = (principalId: string, commandId: string): string => JSON.stringify([principalId, commandId])

function fail(request: HostRequest, status: number, code: string, currentEpoch?: string): never {
  throw new HostProtocolFailure(status, { code, requestId: request.requestId, retryable: false, ...(currentEpoch ? { currentEpoch } : {}) })
}

function checkAuthorization(runtime: CommandRuntime, request: HostRequest, command: CommandEnvelope): void {
  if (runtime.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion) fail(request, 403, "forbidden")
  const target = command.kind === "create_actor"
    ? { kind: "session" as const, sessionId: runtime.sessionId, action: "create_actor" as const }
    : { kind: "actor" as const, sessionId: runtime.sessionId, actorId: command.payload.actorId, action: command.kind }
  if (!runtime.authorization.permits(request.principal, target)) fail(request, 403, "forbidden")
  if (command.kind !== "create_actor") {
    const actor = runtime.effects.actor(command.payload.actorId)
    if (!actor) fail(request, 404, "actor_not_found")
    if (!actor.allowedActions.includes(command.kind)) fail(request, 403, "forbidden")
    if (actor.executionKind !== "primary" && actor.executionKind !== "interactive") fail(request, 403, "actor_read_only")
  }
}

function updateCommand(runtime: CommandRuntime, key: string, state: CommandStatus["state"], result?: CommandStatus["result"], error?: ProtocolError): void {
  const entry = runtime.index.entries.get(key)
  if (!entry?.status) return
  const { result: _previousResult, error: _previousError, ...identity } = entry.status
  entry.status = { ...identity, state, ...(result ? { result } : {}), ...(error ? { error } : {}) }
  const turn = entry.status.turnId ? runtime.index.turns.get(entry.status.turnId)?.turn : undefined
  if (turn) entry.status = { ...entry.status, associatedTurn: turn }
  if (state !== "accepted" && (!turn || terminal(turn))) entry.terminalAt = runtime.identity.now()
  runtime.effects.publishCommand(entry.principalId, entry.status)
}

/** Publish an explicitly verified owner outcome for a still-retained unknown command. */
export function recordHostCommandOutcome(runtime: CommandRuntime, principalId: string, input: { commandId: string; epoch: string; state: "applied" | "rejected"; result?: CommandStatus["result"]; error?: ProtocolError }): void {
  if (input.epoch !== runtime.epoch) return
  const key = keyFor(principalId, input.commandId)
  if (runtime.index.entries.get(key)?.status?.state !== "unknown") return
  updateCommand(runtime, key, input.state, input.result, input.error)
}

export function recordHostTurn(runtime: CommandRuntime, turn: AssociatedTurn): void {
  const control = runtime.index.turns.get(turn.turnId)
  if (!control || control.turn.actorId !== turn.actorId) return
  control.turn = turn
  if (terminal(turn)) {
    control.terminalAt ??= runtime.identity.now()
    if (control.cancelReserved) { control.cancelReserved = false; runtime.index.reserved-- }
    for (const question of runtime.index.questions.values()) {
      if (question.record.turnId !== turn.turnId) continue
      if (question.answerReserved) { question.answerReserved = false; runtime.index.reserved-- }
      const { schema: _schema, ...controlRecord } = question.record
      question.record = { ...controlRecord, canAnswer: false, state: question.record.state === "pending" ? "cancelled" : question.record.state }
      question.terminalAt ??= runtime.identity.now()
    }
  }
  for (const [key, entry] of runtime.index.entries) {
    if (entry.status?.turnId !== turn.turnId) continue
    entry.status = { ...entry.status, associatedTurn: turn }
    if (turn.state === "cancelled" && entry.status.state === "accepted" && key === control.commandKey) {
      updateCommand(runtime, key, "rejected", undefined, { code: "cancelled_before_delivery", requestId: entry.requestId, retryable: false })
    } else {
      if (terminal(turn) && entry.status.state !== "accepted") entry.terminalAt = runtime.identity.now()
      runtime.effects.publishCommand(entry.principalId, entry.status)
    }
  }
}

function prune(runtime: CommandRuntime, limits: CommandLimits, need: number): void {
  let count = [...runtime.index.entries.values()].filter((entry) => entry.receipt).length
  const now = runtime.identity.now()
  for (const [id, question] of runtime.index.questions) if (question.terminalAt !== undefined && now - question.terminalAt >= limits.terminalTtlMs) runtime.index.questions.delete(id)
  for (const [id, turn] of runtime.index.turns) if (turn.terminalAt !== undefined && now - turn.terminalAt >= limits.terminalTtlMs) runtime.index.turns.delete(id)
  for (const entry of runtime.index.entries.values()) {
    if (!entry.receipt || entry.terminalAt === undefined) continue
    if (count + runtime.index.reserved + need <= limits.receipts && now - entry.terminalAt < limits.terminalTtlMs) continue
    entry.receipt = undefined
    entry.status = undefined
    count--
  }
}
function controlAvailable(runtime: CommandRuntime, limits: CommandLimits, record: unknown): boolean {
  const records = [...runtime.index.turns.values(), ...runtime.index.questions.values()]
  return records.length + 1 <= (limits.controls ?? limits.identities)
    // Reserve room for subsequent bounded turn/control metadata growth as well
    // as today's schema. Terminal question schemas are removed immediately.
    && [...records, record].reduce<number>((total, item) => total + Math.max(4096, new TextEncoder().encode(JSON.stringify(item)).byteLength), 2) <= (limits.controlBytes ?? 64 * 1024 * 1024)
}

function available(runtime: CommandRuntime, limits: CommandLimits, need: number): boolean {
  prune(runtime, limits, need)
  const receipts = [...runtime.index.entries.values()].filter((entry) => entry.receipt).length
  return receipts + runtime.index.reserved + need <= limits.receipts && runtime.index.entries.size + runtime.index.reserved + need <= limits.identities
}

export function reserveHostQuestion(runtime: CommandRuntime, request: HostRequest, question: QuestionRecord, limits: CommandLimits = defaultCommandLimits): void {
  const turn = runtime.index.turns.get(question.turnId)
  if (!turn || turn.turn.actorId !== question.actorId || terminal(turn.turn)) fail(request, 409, "question_not_pending")
  if (runtime.index.questions.has(question.questionnaireId)) fail(request, 409, "question_identity_conflict")
  if (!available(runtime, limits, 1)) fail(request, 429, "control_capacity")
  if (!controlAvailable(runtime, limits, { record: question, answerReserved: true })) fail(request, 429, "control_capacity")
  if ([...runtime.index.questions.values()].filter((item) => item.record.state === "pending").length >= 64) fail(request, 429, "question_capacity")
  runtime.index.reserved++
  runtime.index.questions.set(question.questionnaireId, { record: question, answerReserved: true })
}

/** Undo an unpublished reservation only; accepted answers keep their identity/tombstone. */
export function releaseHostQuestion(runtime: CommandRuntime, identity: Pick<QuestionRecord, "questionnaireId" | "actorId" | "turnId">): void {
  const item = runtime.index.questions.get(identity.questionnaireId)
  if (!item || item.record.actorId !== identity.actorId || item.record.turnId !== identity.turnId || item.answerKey) return
  if (item.answerReserved) { item.answerReserved = false; runtime.index.reserved-- }
  runtime.index.questions.delete(identity.questionnaireId)
}

/** Reflect a terminal owner row without retaining its potentially large answer schema. */
export function recordHostQuestion(runtime: CommandRuntime, question: QuestionRecord): void {
  const item = runtime.index.questions.get(question.questionnaireId)
  if (!item || item.record.actorId !== question.actorId || item.record.turnId !== question.turnId) return
  if (item.record.state !== "pending") return
  if (question.state === "pending") { item.record = question; return }
  if (item.answerReserved) { item.answerReserved = false; runtime.index.reserved-- }
  const { schema: _schema, ...record } = question
  item.record = { ...record, canAnswer: false }
  item.terminalAt = runtime.identity.now()
  const turn = runtime.index.turns.get(question.turnId)?.turn
  if (turn) recordHostTurn(runtime, { ...turn, pendingQuestionIds: turn.pendingQuestionIds.filter(id => id !== question.questionnaireId) })
}

export function admitHostCommand(runtime: CommandRuntime, request: HostRequest, input: unknown, limits: CommandLimits = defaultCommandLimits): CommandAdmission {
  const command = parseCommandEnvelope(input)
  checkAuthorization(runtime, request, command)
  if (command.expectedEpoch !== runtime.epoch) fail(request, 409, "epoch_mismatch", runtime.epoch)
  prune(runtime, limits, 0)
  const key = keyFor(request.principal.principalId, command.commandId)
  const hash = runtime.effects.digest(JSON.stringify([command.kind, Object.entries(command.payload).sort(([a], [b]) => a.localeCompare(b))]))
  const previous = runtime.index.entries.get(key)
  if (previous) {
    if (previous.hash !== hash) fail(request, 409, "idempotency_conflict")
    prune(runtime, limits, 0)
    if (!previous.receipt) fail(request, 410, "command_expired")
    return previous.receipt
  }

  let existingKey: string | undefined
  let turnControl: TurnControl | undefined
  let questionControl: QuestionControl | undefined
  let responseHash: string | undefined
  if (command.kind === "cancel_turn" || command.kind === "answer_question") {
    turnControl = runtime.index.turns.get(command.payload.turnId)
    if (!turnControl || turnControl.turn.actorId !== command.payload.actorId) fail(request, 404, "turn_not_found")
    if (command.kind === "cancel_turn") existingKey = turnControl.cancelKey
    else {
      questionControl = runtime.index.questions.get(command.payload.questionnaireId)
      if (!questionControl || questionControl.record.turnId !== command.payload.turnId || questionControl.record.actorId !== command.payload.actorId) fail(request, 409, "question_not_pending")
      responseHash = runtime.effects.digest(command.payload.responseText)
      if (questionControl.responseHash && questionControl.responseHash !== responseHash) fail(request, 409, "question_not_pending")
      existingKey = questionControl.answerKey
    }
    if (existingKey) {
      const existingControlId = JSON.parse(existingKey)[1] as string
      return { status: "existing_control", epoch: runtime.epoch, requestedCommandId: command.commandId, existingControlId, actorId: command.payload.actorId, turnId: command.payload.turnId, ...(command.kind === "answer_question" ? { questionnaireId: command.payload.questionnaireId } : {}) }
    }
    if (terminal(turnControl.turn)) return { status: "already_terminal", epoch: runtime.epoch, requestedCommandId: command.commandId, associatedTurn: turnControl.turn }
    if (questionControl && questionControl.record.state !== "pending") fail(request, 409, "question_not_pending")
  }
  if (!runtime.index.accepting && !turnControl) fail(request, 409, "session_closing")
  const sendsInput = command.kind === "send_text" || command.kind === "send_input" || command.kind === "continue_goal"
  if (sendsInput) {
    const queued = [...runtime.index.turns.values()].filter((item) => item.turn.state === "queued")
    if (queued.length >= 128 || queued.filter((item) => item.turn.actorId === command.payload.actorId).length >= 32) fail(request, 429, "turn_capacity")
  }
  const reserved = command.kind === "cancel_turn" ? turnControl?.cancelReserved : command.kind === "answer_question" ? questionControl?.answerReserved : false
  const needed = sendsInput ? 2 : reserved ? 0 : 1
  if (!available(runtime, limits, needed)) fail(request, 429, "command_capacity")
  const turnId = sendsInput ? runtime.identity.newId() : command.kind === "cancel_turn" || command.kind === "answer_question" ? command.payload.turnId : undefined
  const receipt: CommandReceipt = { commandId: command.commandId, epoch: runtime.epoch, status: "accepted", acceptedAt: new Date(runtime.identity.now()).toISOString(), ...(turnId ? { turnId } : {}) }
  const associatedTurn: AssociatedTurn | undefined = sendsInput
    ? { actorId: command.payload.actorId, turnId: turnId!, state: "queued", canCancel: true, pendingQuestionIds: [], ...(command.kind === "continue_goal" ? { source: "goal" as const, goalId: command.payload.goalId } : {}) }
    : turnControl?.turn
  const initialStatus: CommandStatus = { commandId: command.commandId, epoch: runtime.epoch, state: "accepted", ...(turnId ? { turnId } : {}), ...(associatedTurn ? { associatedTurn } : {}) }
  if (sendsInput && !controlAvailable(runtime, limits, { principalId: request.principal.principalId, commandKey: key, turn: associatedTurn, cancelReserved: true })) fail(request, 429, "control_capacity")
  const lease = runtime.effects.preflight(command, { request, status: initialStatus })
  try { lease?.commit() } catch (error) { lease?.release(); throw error }
  runtime.index.entries.set(key, { hash, principalId: request.principal.principalId, requestId: request.requestId, receipt, status: initialStatus })
  if (sendsInput) {
    runtime.index.reserved++
    runtime.index.turns.set(turnId!, { principalId: request.principal.principalId, commandKey: key, turn: associatedTurn!, cancelReserved: true })
  } else if (command.kind === "cancel_turn" && turnControl) {
    if (turnControl.cancelReserved) runtime.index.reserved--
    turnControl.cancelReserved = false
    turnControl.cancelKey = key
  } else if (command.kind === "answer_question" && questionControl) {
    if (questionControl.answerReserved) runtime.index.reserved--
    questionControl.answerReserved = false
    questionControl.answerKey = key
    questionControl.responseHash = responseHash
  }
  runtime.effects.publishCommand(request.principal.principalId, initialStatus)
  const immutableCommand = structuredClone(command)
  runtime.effects.defer(async () => {
    const entry = runtime.index.entries.get(key)
    if (entry?.status?.state !== "accepted") { lease?.release(); return }
    try {
      const result = await runtime.effects.execute(immutableCommand, turnId, request)
      if (entry.status?.state === "accepted") updateCommand(runtime, key, "applied", result || undefined)
    } catch (error) {
      lease?.release()
      if (error instanceof HostCommandOutcomeUnknown) {
        updateCommand(runtime, key, "unknown", error.result, { code: error.code, requestId: request.requestId, retryable: false, state: "unknown" })
        return
      }
      if (sendsInput && turnId) {
        const turn = runtime.index.turns.get(turnId)?.turn
        if (turn && !terminal(turn)) recordHostTurn(runtime, { ...turn, state: "failed", canCancel: false, pendingQuestionIds: [] })
      } else if (command.kind === "cancel_turn" && turnControl && !terminal(turnControl.turn)) {
        turnControl.cancelKey = undefined; turnControl.cancelReserved = true; runtime.index.reserved++
      } else if (command.kind === "answer_question" && questionControl && questionControl.record.state === "pending") {
        questionControl.answerKey = undefined; questionControl.responseHash = undefined; questionControl.answerReserved = true; runtime.index.reserved++
      }
      updateCommand(runtime, key, "rejected", undefined, { code: error instanceof HostProtocolFailure ? error.error.code : "command_failed", requestId: request.requestId, retryable: false })
      const failed = runtime.index.entries.get(key)
      if (failed) failed.terminalAt = runtime.identity.now()
    }
  })
  return receipt
}

export function readHostCommand(runtime: CommandRuntime, request: HostRequest, input: { commandId: string; expectedEpoch: string }, limits: CommandLimits = defaultCommandLimits): CommandStatus {
  if (runtime.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion || !runtime.authorization.permits(request.principal, { kind: "session", sessionId: runtime.sessionId, action: "open" })) fail(request, 403, "forbidden")
  if (input.expectedEpoch !== runtime.epoch) throw new HostProtocolFailure(410, { code: "command_epoch_expired", currentEpoch: runtime.epoch, state: "unknown", requestId: request.requestId, retryable: false })
  prune(runtime, limits, 0)
  const entry = runtime.index.entries.get(keyFor(request.principal.principalId, input.commandId))
  if (!entry) fail(request, 404, "command_not_found")
  if (!entry.status) fail(request, 410, "command_expired")
  const turn = entry.status.turnId ? runtime.index.turns.get(entry.status.turnId)?.turn : undefined
  return { ...entry.status, ...(turn ? { associatedTurn: turn } : {}) }
}
