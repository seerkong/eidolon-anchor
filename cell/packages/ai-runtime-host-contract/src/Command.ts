import type { HostInputPart } from "./Attachment"
import type { ConversationOperation } from "./Conversation"
import type { GoalControl, GoalControlReceipt, SessionGoalView } from "./Goal"
export type ActorAction = "host_interaction" | "observe" | "read_history" | "send_text" | "cancel_turn" | "answer_question" | "set_model" | "compact" | "send_input" | "upload_attachment" | "set_work_mode" | "fork_conversation" | "rewind_conversation" | "set_goal" | "continue_goal" | "archive_actor" | "delete_actor"
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
  host_interaction: { actorId: string; operationJson: string }
  send_text: { actorId: string; text: string }
  send_input: { actorId: string; parts: readonly HostInputPart[] }
  cancel_turn: { actorId: string; turnId: string }
  answer_question: { actorId: string; turnId: string; questionnaireId: string; responseText: string }
  create_actor: { profileId: string; displayName?: string; modelRef?: string }
  set_model: { actorId: string; modelRef: string }
  compact: { actorId: string; expectedHistoryRevision: string }
  set_work_mode: { actorId: string; workMode: "build" | "plan" }
  set_goal: GoalControl
  continue_goal: { actorId: string; goalId: string }
  fork_conversation: { actorId: string; expectedHistoryRevision: string; selector: { kind: "current_head" } | { kind: "through_committed_message"; messageId: string } }
  rewind_conversation: { actorId: string; expectedHistoryRevision: string; selector: { kind: "through_committed_message"; messageId: string } }
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
  source?: "goal"
  goalId?: string
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
  result?: { actorId?: string; compact?: Readonly<{ compacted: boolean; tokensBefore: number; messagesAfter: number; historyRevision: string }>; workMode?: "build" | "plan"; conversation?: ConversationOperation; goal?: GoalControlReceipt }
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
  lifecycle?: import('./ActorManagement').ActorLifecycle
  /** Stable identity within this session, only for fixed foreground actors. */
  memberId?: string
  displayName: string
  executionKind: ActorExecutionKind
  runtimeState: "idle" | "running" | "waiting_input" | "stopped" | "failed"
  allowedActions: readonly ActorAction[]
  capabilities: Readonly<{ textInput: boolean; cancelTurn: boolean; questionnaireAnswer: boolean }>
  disabledReasons?: Readonly<Record<string, string>>
  modelRef?: string
  workContext?: Readonly<{ workMode: "build" | "plan"; taskPhase: "normal" | "answer"; workModeUpdatedAt: string; taskPhaseUpdatedAt: string }>
  threadGoal?: SessionGoalView
}>

export type CreateSessionCommand = Readonly<{
  commandId: string
  profileId: string
  expectedServerInstanceId: string
}>
