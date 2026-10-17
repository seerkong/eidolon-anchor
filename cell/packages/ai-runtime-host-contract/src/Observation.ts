import type { ActorSummary, AssociatedTurn, CommandStatus, ProtocolError } from "./Command"

export type PublicMessagePart = Readonly<
  | { kind: "text"; text: string; filename?: string; sourceDigest?: string }
  | { kind: "image"; mime: string; filename?: string; sourceDigest?: string; size?: number; dataUrl?: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; toolCallId: string; name: string; input: string }
  | { kind: "tool_result"; toolCallId: string; output: string; isError: boolean }
>

export type Preview = Readonly<{
  parts: readonly PublicMessagePart[]
  startOffset: number
  totalBytes: number
  truncated: boolean
}>

export type PublicMessage = Readonly<{
  messageId: string
  role: "system" | "user" | "assistant" | "tool"
  parts: readonly PublicMessagePart[]
}>

export type MessagePreview = Readonly<{
  messageId: string
  role: PublicMessage["role"]
  preview: Preview
  contentRef?: { messageId: string; historyRevision: string }
}>

export type PendingStream = Readonly<{
  actorId: string
  turnId: string
  attemptId: string
  messageId: string
  revision: number
  preview: Preview
}>

export type QuestionSchema = Readonly<{
  version?: 2
  title: string
  kind?: "clarification" | "approval" | "freeform" | "form"
  intro?: string
  suspendPolicy?: "pause_all" | "continue_others"
  questions: readonly Readonly<{
    id: string
    prompt: string
    type?: "text" | "yes_no" | "single_select" | "multi_select" | "number" | "json"
    required?: boolean
    /** Bounded JSON text preserves false, zero, null, arrays and object defaults. */
    defaultJson?: string
    helpText?: string
    options?: readonly Readonly<{ id: string; label: string; description?: string }>[]
    multiple?: boolean
  }>[]
}>

export type QuestionRecord = Readonly<{
  actorId: string
  turnId: string
  questionnaireId: string
  state: "pending" | "answered" | "cancelled"
  canAnswer: boolean
  schema?: QuestionSchema
}>

export type CheckpointStatus = Readonly<{
  state: "pending" | "saved" | "failed"
  revision?: string
  error?: ProtocolError
}>

export type HistoryWindow = Readonly<{
  actorId: string
  historyRevision: string
  messages: readonly MessagePreview[]
  pageCursor?: string
  historyWindowTruncated: boolean
}>

export type SessionSnapshot = Readonly<{
  sessionId: string
  epoch: string
  seq: number
  cursor: string
  actors: readonly ActorSummary[]
  histories: readonly HistoryWindow[]
  pendingStreams: readonly PendingStream[]
  commands: readonly CommandStatus[]
  turns: readonly AssociatedTurn[]
  questions: readonly QuestionRecord[]
  callerControls: Readonly<{ commandIds: readonly string[]; turnIds: readonly string[]; questionnaireIds: readonly string[] }>
  checkpoint: CheckpointStatus
}>

export type ObservationPayloads = {
  "actor.created": ActorSummary
  "actor.updated": ActorSummary
  "command.updated": CommandStatus
  "turn.updated": AssociatedTurn
  "stream.updated": PendingStream
  "stream.closed": Readonly<{ actorId: string; turnId: string; attemptId: string; messageId: string; committed: boolean }>
  "history.committed": Readonly<{ actorId: string; historyRevision: string; message: MessagePreview; turnId?: string; attemptId?: string }>
  "question.updated": QuestionRecord
  "checkpoint.updated": CheckpointStatus
  "session.closing": Readonly<{ reason: "shutdown" | "maintenance" | "failure" }>
}

export type ObservationEvent = {
  [K in keyof ObservationPayloads]: Readonly<{
    epoch: string
    seq: number
    cursor: string
    kind: K
    actorId?: string
    commandId?: string
    turnId?: string
    payload: ObservationPayloads[K]
  }>
}[keyof ObservationPayloads]

export type ProtocolFrame =
  | Readonly<{ kind: "snapshot"; requestId: string; payload: SessionSnapshot }>
  | Readonly<{ kind: "reset_required"; requestId: string; code: string }>
  | Readonly<{ kind: "protocol.error"; code: string; requestId: string; retryable: false }>

export type ObservationFrame = ObservationEvent | ProtocolFrame
