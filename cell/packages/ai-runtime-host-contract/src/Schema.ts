import type { ActorSummary, CommandAdmission, CommandEnvelope, CommandStatus, CreateSessionCommand } from "./Command"
import type { HistoryPage, MessageContentChunk } from "./ContentRead"
import type { HostCapabilities, SessionSummary } from "./HostPort"
import type { ObservationFrame } from "./Observation"

type Schema =
  | { type: "string"; max: number; min: number }
  | { type: "number"; min: number; max: number }
  | { type: "boolean" }
  | { type: "enum"; values: readonly (string | number | boolean)[] }
  | { type: "array"; item: Schema; max: number }
  | { type: "object"; fields: Readonly<Record<string, Schema>>; optional: readonly string[]; maxBytes?: number }
  | { type: "union"; key: string; variants: Readonly<Record<string, Schema>> }

const str = (max: number, min = 0): Schema => ({ type: "string", max, min })
const num = (max = Number.MAX_SAFE_INTEGER): Schema => ({ type: "number", min: 0, max })
const flag: Schema = { type: "boolean" }
const one = (...values: readonly (string | number | boolean)[]): Schema => ({ type: "enum", values })
const arr = (item: Schema, max: number): Schema => ({ type: "array", item, max })
const obj = (fields: Readonly<Record<string, Schema>>, optional: readonly string[] = [], maxBytes?: number): Schema => ({ type: "object", fields, optional, maxBytes })
const union = (key: string, variants: Readonly<Record<string, Schema>>): Schema => ({ type: "union", key, variants })
const id = str(256, 1)
const epoch = id
const cursor = str(4096, 1)
const action = one("observe", "read_history", "send_text", "cancel_turn", "answer_question")
const error = obj({ code: id, requestId: id, retryable: flag, message: str(1024), currentEpoch: epoch, state: one("unknown") }, ["message", "currentEpoch", "state"])
const turn = obj({ actorId: id, turnId: id, state: one("queued", "running", "waiting_input", "succeeded", "failed", "cancelled", "interrupted"), canCancel: flag, pendingQuestionIds: arr(id, 64) })
const actor = obj({
  actorId: id, displayName: str(512, 1), executionKind: one("primary", "interactive", "delegate", "detached"),
  runtimeState: one("idle", "running", "waiting_input", "stopped", "failed"),
  allowedActions: arr(action, 5), capabilities: obj({ textInput: flag, cancelTurn: flag, questionnaireAnswer: flag }),
  disabledReasons: obj({ observe: str(1024), read_history: str(1024), send_text: str(1024), cancel_turn: str(1024), answer_question: str(1024) }, ["observe", "read_history", "send_text", "cancel_turn", "answer_question"]),
}, ["disabledReasons"])
const status = obj({ commandId: id, epoch, turnId: id, state: one("accepted", "applied", "rejected", "unknown"), associatedTurn: turn, result: obj({ actorId: id }, ["actorId"]), error }, ["turnId", "associatedTurn", "result", "error"])
const admission = union("status", {
  accepted: obj({ status: one("accepted"), commandId: id, epoch, turnId: id, acceptedAt: str(64, 1) }, ["turnId"]),
  existing_control: obj({ status: one("existing_control"), epoch, requestedCommandId: id, existingControlId: id, actorId: id, turnId: id, questionnaireId: id }, ["questionnaireId"]),
  already_terminal: obj({ status: one("already_terminal"), epoch, requestedCommandId: id, associatedTurn: turn }),
})
const commandPayloads = {
  send_text: obj({ actorId: id, text: str(64 * 1024, 1) }),
  cancel_turn: obj({ actorId: id, turnId: id }),
  answer_question: obj({ actorId: id, turnId: id, questionnaireId: id, responseText: str(64 * 1024, 1) }),
  create_actor: obj({ profileId: id, displayName: str(512, 1), modelRef: id }, ["displayName", "modelRef"]),
}
const command = union("kind", Object.fromEntries(Object.entries(commandPayloads).map(([kind, payload]) => [kind,
  obj({ commandId: id, surfaceId: id, expectedEpoch: epoch, kind: one(kind), payload }),
])))
const part = union("kind", {
  text: obj({ kind: one("text"), text: str(256 * 1024) }),
  reasoning: obj({ kind: one("reasoning"), text: str(256 * 1024) }),
  tool_call: obj({ kind: one("tool_call"), toolCallId: id, name: id, input: str(256 * 1024) }),
  tool_result: obj({ kind: one("tool_result"), toolCallId: id, output: str(256 * 1024), isError: flag }),
})
const preview = obj({ parts: arr(part, 2048), startOffset: num(), totalBytes: num(), truncated: flag }, [], 256 * 1024)
const message = obj({ messageId: id, role: one("system", "user", "assistant", "tool"), preview, contentRef: obj({ messageId: id, historyRevision: id }) }, ["contentRef"])
const stream = obj({ actorId: id, turnId: id, attemptId: id, messageId: id, revision: num(), preview })
const question = obj({
  actorId: id, turnId: id, questionnaireId: id, state: one("pending", "answered", "cancelled"), canAnswer: flag,
  schema: obj({ title: str(4096), questions: arr(obj({
    id, prompt: str(64 * 1024), multiple: flag,
    options: arr(obj({ id, label: str(4096), description: str(16 * 1024) }, ["description"]), 1024),
  }, ["multiple", "options"]), 256) }, [], 64 * 1024),
}, ["schema"])
const checkpoint = obj({ state: one("pending", "saved", "failed"), revision: id, error }, ["revision", "error"])
const snapshot = obj({
  sessionId: id, epoch, seq: num(), cursor,
  actors: arr(actor, 64),
  histories: arr(obj({ actorId: id, historyRevision: id, messages: arr(message, 200), pageCursor: cursor, historyWindowTruncated: flag }, ["pageCursor"]), 64),
  pendingStreams: arr(stream, 4096), commands: arr(status, 10000), turns: arr(turn, 10000), questions: arr(question, 64),
  callerControls: obj({ commandIds: arr(id, 10000), turnIds: arr(id, 10000), questionnaireIds: arr(id, 64) }),
  checkpoint,
})
const eventPayloads = {
  "actor.created": actor,
  "actor.updated": actor,
  "command.updated": status,
  "turn.updated": turn,
  "stream.updated": stream,
  "stream.closed": obj({ actorId: id, turnId: id, attemptId: id, messageId: id, committed: flag }),
  "history.committed": obj({ actorId: id, historyRevision: id, message, turnId: id, attemptId: id }, ["turnId", "attemptId"]),
  "question.updated": question,
  "checkpoint.updated": checkpoint,
  "session.closing": obj({ reason: one("shutdown", "maintenance", "failure") }),
}
const frame = union("kind", {
  ...Object.fromEntries(Object.entries(eventPayloads).map(([kind, payload]) => [kind,
    obj({ epoch, seq: num(), cursor, kind: one(kind), actorId: id, commandId: id, turnId: id, payload }, ["actorId", "commandId", "turnId"]),
  ])),
  snapshot: obj({ kind: one("snapshot"), requestId: id, payload: snapshot }),
  reset_required: obj({ kind: one("reset_required"), requestId: id, code: id }),
  "protocol.error": obj({ kind: one("protocol.error"), requestId: id, code: id, retryable: one(false) }),
})
const historyPage = obj({ actorId: id, epoch, historyRevision: id, messages: arr(message, 200), nextCursor: cursor }, ["nextCursor"], 1024 * 1024)
const contentChunk = obj({ codec: one("public-message-json-v1"), encoding: one("base64"), messageId: id, historyRevision: id, offsetBytes: num(), totalBytes: num(), data: str(256 * 1024), nextCursor: cursor }, ["nextCursor"], 256 * 1024)
const capabilities = obj({
  protocolVersion: one("1"), serverInstanceId: id,
  features: obj({ actorCreate: flag, concurrentActors: flag, cancelTurn: flag, questionnaireAnswer: flag, historyPagination: flag, resumeStream: flag }),
  inputKinds: arr(one("text"), 1),
  limits: obj({ httpBodyBytes: num(), textBytes: num(), actorsPerSession: num(), queuedPerActor: num(), queuedPerSession: num(), subscriptionsPerPrincipal: num(), liveFrameBytes: num(), snapshotBytes: num(), parserBytes: num(), historyPageBytes: num(), contentChunkBytes: num() }),
  allowedProfiles: arr(id, 256), authMode: one("bearer"),
})
const sessionSummary = obj({ sessionId: id, epoch, displayName: str(512, 1), readOnly: flag })
const createSession = obj({ commandId: id, profileId: id, expectedServerInstanceId: id })

export class WireSchemaError extends Error {
  readonly code = "invalid_schema"
  constructor(readonly field: string) {
    super(`Invalid runtime protocol field: ${field}`)
    this.name = "WireSchemaError"
  }
}

function check(schema: Schema, value: unknown, field: string, budget: { nodes: number }): void {
  if (--budget.nodes < 0) throw new WireSchemaError(field)
  const invalid = (): never => { throw new WireSchemaError(field) }
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string" || value.length > schema.max) invalid()
      const length = new TextEncoder().encode(value as string).byteLength
      if (length < schema.min || length > schema.max) invalid()
      return
    }
    case "number":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < schema.min || value > schema.max) invalid()
      return
    case "boolean":
      if (typeof value !== "boolean") invalid()
      return
    case "enum":
      if (!schema.values.some((candidate) => candidate === value)) invalid()
      return
    case "array":
      if (!Array.isArray(value) || value.length > schema.max) invalid()
      for (let index = 0; index < (value as unknown[]).length; index++) check(schema.item, (value as unknown[])[index], `${field}[${index}]`, budget)
      return
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
      const record = value as Record<string, unknown>
      if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) invalid()
      for (const key of Object.keys(record)) if (!Object.prototype.hasOwnProperty.call(schema.fields, key)) throw new WireSchemaError(`${field}.${key}`)
      for (const [key, child] of Object.entries(schema.fields)) {
        if (!Object.prototype.hasOwnProperty.call(record, key) && schema.optional.includes(key)) continue
        check(child, record[key], `${field}.${key}`, budget)
      }
      if (schema.maxBytes !== undefined) measureJsonBytes(value, schema.maxBytes, field)
      return
    }
    case "union": {
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
      const discriminant = (value as Record<string, unknown>)[schema.key]
      if (typeof discriminant !== "string" || !Object.prototype.hasOwnProperty.call(schema.variants, discriminant)) invalid()
      check(schema.variants[discriminant as string], value, field, budget)
    }
  }
}

function measureJsonBytes(value: unknown, limit: number, field: string): number {
  let bytes = 0
  const add = (count: number): void => {
    bytes += count
    if (bytes > limit) throw new WireSchemaError(field)
  }
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      add(2 + Math.max(0, item.length - 1))
      for (const child of item) visit(child)
    } else if (item && typeof item === "object") {
      const entries = Object.entries(item)
      add(2 + Math.max(0, entries.length - 1))
      for (const [key, child] of entries) { visit(key); add(1); visit(child) }
    } else {
      const encoded = JSON.stringify(item)
      if (encoded === undefined) throw new WireSchemaError(field)
      add(new TextEncoder().encode(encoded).byteLength)
    }
  }
  visit(value)
  return bytes
}

function parse<T>(schema: Schema, value: unknown): T {
  check(schema, value, "$", { nodes: 200000 })
  return value as T
}

export const parseCommandEnvelope = (value: unknown): CommandEnvelope => parse(command, value)
export const parseCommandAdmission = (value: unknown): CommandAdmission => parse(admission, value)
export const parseCommandStatus = (value: unknown): CommandStatus => parse(status, value)
export const parseActorSummary = (value: unknown): ActorSummary => parse(actor, value)
export const parseObservationFrame = (value: unknown): ObservationFrame => parse(frame, value)
export const parseHistoryPage = (value: unknown): HistoryPage => parse(historyPage, value)
export function parseMessageContentChunk(value: unknown): MessageContentChunk {
  const chunk = parse<MessageContentChunk>(contentChunk, value)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) throw new WireSchemaError("$.data")
  const size = chunk.data.length / 4 * 3 - (chunk.data.endsWith("==") ? 2 : chunk.data.endsWith("=") ? 1 : 0)
  if (chunk.offsetBytes > chunk.totalBytes || size > chunk.totalBytes - chunk.offsetBytes) throw new WireSchemaError("$.offsetBytes")
  if (chunk.nextCursor ? size === 0 || chunk.offsetBytes + size >= chunk.totalBytes : chunk.offsetBytes + size !== chunk.totalBytes) throw new WireSchemaError("$.nextCursor")
  return chunk
}
export function parseHostCapabilities(value: unknown): HostCapabilities {
  const result = parse<HostCapabilities>(capabilities, value)
  if (result.inputKinds.length !== 1) throw new WireSchemaError("$.inputKinds")
  return result
}
export const parseSessionSummary = (value: unknown): SessionSummary => parse(sessionSummary, value)
export const parseCreateSessionCommand = (value: unknown): CreateSessionCommand => parse(createSession, value)

export function parseWireResponse<T extends object>(value: unknown, decode: (body: unknown) => T): T & { requestId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WireSchemaError("$")
  const { requestId, ...body } = value as Record<string, unknown>
  check(id, requestId, "$.requestId", { nodes: 1 })
  return { ...decode(body), requestId: requestId as string }
}

export const parseSessionList = (value: unknown): { sessions: readonly SessionSummary[]; nextCursor?: string } =>
  parse(obj({ sessions: arr(sessionSummary, 200), nextCursor: cursor }, ["nextCursor"]), value)
export const parseActorDirectory = (value: unknown): { epoch: string; actors: readonly ActorSummary[] } =>
  parse(obj({ epoch, actors: arr(actor, 64) }), value)
