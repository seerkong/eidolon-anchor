export type ActorAction = "observe" | "read_history" | "send_text" | "cancel_turn" | "answer_question"
export type ActorExecutionKind = "primary" | "interactive" | "delegate" | "detached"
export type TurnState = "queued" | "running" | "waiting_input" | "succeeded" | "failed" | "cancelled" | "interrupted"

export type ProtocolError = Readonly<{
  code: string
  requestId: string
  retryable: boolean
  message?: string
  currentEpoch?: string
  state?: "unknown"
}>

export type CommandPayloads = {
  send_text: { actorId: string; text: string }
  cancel_turn: { actorId: string; turnId: string }
  answer_question: { actorId: string; turnId: string; questionnaireId: string; responseText: string }
  create_actor: { profileId: string; displayName?: string; modelRef?: string }
}

export type CommandEnvelope = {
  [K in keyof CommandPayloads]: Readonly<{
    commandId: string
    surfaceId: string
    expectedEpoch: string
    kind: K
    payload: Readonly<CommandPayloads[K]>
  }>
}[keyof CommandPayloads]

export type AssociatedTurn = Readonly<{
  actorId: string
  turnId: string
  state: TurnState
  canCancel: boolean
  pendingQuestionIds: readonly string[]
}>

export type CommandReceipt = Readonly<{
  commandId: string
  epoch: string
  status: "accepted"
  turnId?: string
  acceptedAt: string
}>

export type CommandStatus = Readonly<{
  commandId: string
  epoch: string
  turnId?: string
  state: "accepted" | "applied" | "rejected" | "unknown"
  associatedTurn?: AssociatedTurn
  result?: { actorId?: string }
  error?: ProtocolError
}>

export type ExistingControl = Readonly<{
  status: "existing_control"
  epoch: string
  requestedCommandId: string
  existingControlId: string
  actorId: string
  turnId: string
  questionnaireId?: string
}>

export type AlreadyTerminal = Readonly<{
  status: "already_terminal"
  epoch: string
  requestedCommandId: string
  associatedTurn: AssociatedTurn
}>

export type CommandAdmission = CommandReceipt | ExistingControl | AlreadyTerminal

export type ActorSummary = Readonly<{
  actorId: string
  displayName: string
  executionKind: ActorExecutionKind
  runtimeState: "idle" | "running" | "waiting_input" | "stopped" | "failed"
  allowedActions: readonly ActorAction[]
  capabilities: Readonly<{ textInput: boolean; cancelTurn: boolean; questionnaireAnswer: boolean }>
  disabledReasons?: Readonly<Record<string, string>>
}>

export type CreateSessionCommand = Readonly<{
  commandId: string
  profileId: string
  expectedServerInstanceId: string
}>
