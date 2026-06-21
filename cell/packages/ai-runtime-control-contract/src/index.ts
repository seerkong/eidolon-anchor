import type {
  ActorControlOperation,
  ControlBarrierBlocker,
  ControlBarrierResult,
  DurableHead,
  MailboxWorkClass,
} from "depa-actor-control"

export const AI_TURN_BARRIER_CONSUMERS = [
  "snapshot_save",
  "idle_preemption",
  "heartbeat_eligibility",
  "recovery_scheduling",
  "tui_settled",
] as const

export type AiTurnBarrierConsumer = (typeof AI_TURN_BARRIER_CONSUMERS)[number]

export const AI_TURN_BARRIER_REASONS = [
  "mandatory_continuation",
  "pending_mailbox_work",
] as const

export type AiTurnBarrierReason = (typeof AI_TURN_BARRIER_REASONS)[number] | (string & {})

export const AI_CONTROL_OPERATION_KINDS = [
  "human_input",
  "questionnaire_answer",
  "cancel_turn",
  "heartbeat_fire",
  "actor_surface_select",
] as const

export type AiControlOperationKind = (typeof AI_CONTROL_OPERATION_KINDS)[number] | (string & {})

export type AiMailboxKind =
  | "control"
  | "toolResult"
  | "asyncCompletion"
  | "childDone"
  | "memberCoordination"
  | "humanInput"
  | "memberChatInbox"
  | "heartbeat"
  | (string & {})

export type AiMailboxWorkClassification = {
  mailboxKind: AiMailboxKind
  workClass: MailboxWorkClass
  reason: AiTurnBarrierReason
}

export type AiTurnBarrierBlocker = ControlBarrierBlocker & {
  fiberId?: string
  actorKey?: string
  actorId?: string
  status?: string
  mailboxKinds?: AiMailboxKind[]
  reason: AiTurnBarrierReason
}

export type AiTurnBarrierResult =
  | (Omit<ControlBarrierResult & { safe: true }, "purpose" | "blockers"> & {
      purpose: AiTurnBarrierConsumer
      blockers: []
    })
  | (Omit<ControlBarrierResult & { safe: false }, "purpose" | "blockers"> & {
      purpose: AiTurnBarrierConsumer
      blockers: AiTurnBarrierBlocker[]
    })

export type AiControlOperation<TPayload = unknown> = Omit<ActorControlOperation<TPayload>, "kind"> & {
  kind: AiControlOperationKind
}

export type AiDurableHead = DurableHead & {
  kind:
    | "runtime_snapshot"
    | "conversation_head"
    | "questionnaire_table"
    | "scheduler_state"
    | "actor_surface_projection"
    | (string & {})
}

export type AiDurableHeadCohort = {
  cohortId: string
  barrierId: string
  heads: AiDurableHead[]
}

export const AI_RUNTIME_CONTROL_COMMAND_KINDS = [
  "effect_request",
  "effect_result",
  "durable_head_buffer",
  "safepoint_evaluate",
  "cohort_commit",
] as const

export type AiRuntimeControlCommandKind = (typeof AI_RUNTIME_CONTROL_COMMAND_KINDS)[number]

export type AiRuntimeControlCommand =
  | {
      kind: "effect_request"
      commandId: string
      effectId: string
      handlerKey: string
      idempotencyKey?: string
      payload?: unknown
    }
  | {
      kind: "effect_result"
      commandId: string
      effectId: string
      resultId: string
      payload?: unknown
    }
  | {
      kind: "durable_head_buffer"
      commandId: string
      headId: string
      sequence: number
      value?: unknown
    }
  | {
      kind: "safepoint_evaluate"
      commandId: string
      cohortId: string
      reason?: "durable_head_buffered" | "manual" | (string & {})
    }
  | {
      kind: "cohort_commit"
      commandId: string
      cohortId: string
    }

export const AI_RUNTIME_CONTROL_COMMAND_QUEUES = [
  "effectResult",
  "safepoint",
  "commit",
  "normal",
] as const

export type AiRuntimeControlCommandQueue = (typeof AI_RUNTIME_CONTROL_COMMAND_QUEUES)[number]

export const AI_RUNTIME_EFFECT_STATUSES = [
  "requested",
  "dispatching",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "orphaned",
  "dirty",
] as const

export type AiRuntimeEffectStatus = (typeof AI_RUNTIME_EFFECT_STATUSES)[number]

export const AI_RUNTIME_EFFECT_KINDS = [
  "tool_call",
  "mcp_tool",
  "bash",
  "permission",
  "questionnaire",
  "provider_completion",
  "runtime_checkpoint",
] as const

export type AiRuntimeEffectKind = (typeof AI_RUNTIME_EFFECT_KINDS)[number]

export type AiRuntimeEffectLifecycleEvent =
  | {
      kind: "request"
      effectKind: AiRuntimeEffectKind
      effectId: string
      handlerKey: string
      idempotencyKey: string
      sourceCommandId?: string
      payload?: unknown
    }
  | {
      kind: "waiting"
      effectKind: AiRuntimeEffectKind
      effectId: string
      handlerKey: string
      idempotencyKey: string
      waitReason: string
      payload?: unknown
    }
  | {
      kind: "result"
      effectKind: AiRuntimeEffectKind
      effectId: string
      handlerKey: string
      resultId: string
      payload?: unknown
    }
  | {
      kind: "failed"
      effectKind: AiRuntimeEffectKind
      effectId: string
      handlerKey: string
      error: string
      retryable: boolean
    }

export type AiRuntimeEffectRecord = {
  effectId: string
  handlerKey?: string
  idempotencyKey?: string
  status: AiRuntimeEffectStatus
  requestCommandId?: string
  resultId?: string
  requestSeen: boolean
  resultSeen: boolean
  payload?: unknown
  resultPayload?: unknown
}

export type AiRuntimeDurableHeadState = {
  headId: string
  kind: AiDurableHead["kind"]
  committedSequence: number
  bufferedSequence?: number
  value?: unknown
}

export const AI_RUNTIME_SESSION_HEAD_SOURCES = [
  "snapshot",
  "conversation",
  "mailbox",
  "control_signals",
  "ingress_log",
  "diagnostics_log",
] as const

export type AiRuntimeSessionHeadSource = (typeof AI_RUNTIME_SESSION_HEAD_SOURCES)[number]

export const AI_RUNTIME_SESSION_HEAD_SEQUENCE_STRATEGIES = [
  "manifest_version",
  "index_updated_at",
  "content_hash",
  "event_count",
  "mailbox_length",
  "control_signal_sequence",
] as const

export type AiRuntimeSessionHeadSequenceStrategy = (typeof AI_RUNTIME_SESSION_HEAD_SEQUENCE_STRATEGIES)[number]

export type AiRuntimeSessionHeadDescriptor = {
  headId: string
  kind: AiDurableHead["kind"]
  source: AiRuntimeSessionHeadSource
  sequenceStrategy: AiRuntimeSessionHeadSequenceStrategy
  requiredForCheckpoint: boolean
}

export const AI_RUNTIME_REAL_SESSION_HEADS: AiRuntimeSessionHeadDescriptor[] = [
  {
    headId: "runtime_snapshot",
    kind: "runtime_snapshot",
    source: "snapshot",
    sequenceStrategy: "manifest_version",
    requiredForCheckpoint: true,
  },
  {
    headId: "conversation",
    kind: "conversation_head",
    source: "conversation",
    sequenceStrategy: "index_updated_at",
    requiredForCheckpoint: true,
  },
  {
    headId: "mailbox",
    kind: "mailbox_head",
    source: "mailbox",
    sequenceStrategy: "mailbox_length",
    requiredForCheckpoint: true,
  },
  {
    headId: "control_signals",
    kind: "control_signal_head",
    source: "control_signals",
    sequenceStrategy: "control_signal_sequence",
    requiredForCheckpoint: true,
  },
  {
    headId: "ingress_log",
    kind: "ingress_log",
    source: "ingress_log",
    sequenceStrategy: "event_count",
    requiredForCheckpoint: false,
  },
  {
    headId: "diagnostics_log",
    kind: "diagnostics_log",
    source: "diagnostics_log",
    sequenceStrategy: "event_count",
    requiredForCheckpoint: false,
  },
]

export const AI_RUNTIME_DURABLE_COHORT_STATUSES = [
  "open",
  "ready",
  "committing",
  "committed",
  "dirty",
] as const

export type AiRuntimeDurableCohortStatus = (typeof AI_RUNTIME_DURABLE_COHORT_STATUSES)[number]

export type AiRuntimeDurableCohortState = {
  cohortId: string
  headIds: string[]
  status: AiRuntimeDurableCohortStatus
  commitMarker?: string
}

export const AI_RUNTIME_RECOVERY_CLASSES = [
  "clean",
  "pending",
  "retryable",
  "orphaned",
  "dirty",
] as const

export type AiRuntimeRecoveryClass = (typeof AI_RUNTIME_RECOVERY_CLASSES)[number]

export type AiRuntimeControlPersistenceState = {
  effects: Record<string, AiRuntimeEffectRecord>
  heads: Record<string, AiRuntimeDurableHeadState>
  cohorts: Record<string, AiRuntimeDurableCohortState>
}

export type AiRuntimeControlRecoveryState = {
  classification: AiRuntimeRecoveryClass
}

export type AiRuntimeControlRuntimeState = {
  persistence: AiRuntimeControlPersistenceState
  recovery: AiRuntimeControlRecoveryState
}

export type AiRuntimeControlState<TCommandGroupState = unknown> = {
  commands: TCommandGroupState
  runtime: AiRuntimeControlRuntimeState
}

export type AiRuntimeEffectDispatchRequest = {
  effectId: string
  handlerKey: string
  idempotencyKey?: string
  payload?: unknown
}

export type AiRuntimeEffectDispatchResult = {
  effectId: string
  resultId: string
  payload?: unknown
}

export type AiRuntimeEffectDispatchPort = {
  dispatchEffect: (request: AiRuntimeEffectDispatchRequest) => Promise<AiRuntimeEffectDispatchResult>
  hasHandler: (handlerKey: string) => boolean
}

export type AiRuntimeDurableHeadPort = {
  bufferHead: (headId: string, sequence: number, value: unknown) => Promise<void>
  commitCohort: (cohort: AiRuntimeDurableCohortState, heads: Record<string, AiRuntimeDurableHeadState>) => Promise<string>
}

export type AiRuntimeControlPorts = {
  effects: AiRuntimeEffectDispatchPort
  durableHeads: AiRuntimeDurableHeadPort
}

export * from "./derivation"

export * from "./capsule"
