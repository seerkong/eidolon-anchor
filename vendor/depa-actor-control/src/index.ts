export const MAILBOX_WORK_CLASSES = [
  "recoverable_input",
  "mandatory_completion",
  "interrupt",
  "control_marker",
  "low_priority_continuation",
  "timer_wake",
] as const

export type MailboxWorkClass = (typeof MAILBOX_WORK_CLASSES)[number] | (string & {})

export type ActorControlTarget = {
  actorKey?: string
  actorId?: string
  fiberId?: string
}

export type ActorControlCausality = {
  causedBy?: string
  parentOperationId?: string
  correlationId?: string
}

export type ExpectedControlBarrier = {
  barrierId: string
  purpose: string
}

export type ActorControlOperation<TPayload = unknown> = {
  operationId: string
  kind: string
  target: ActorControlTarget
  causality?: ActorControlCausality
  idempotencyKey?: string
  expectedBarrier?: ExpectedControlBarrier
  payload?: TPayload
}

export function createActorControlOperation<TPayload>(input: ActorControlOperation<TPayload>): ActorControlOperation<TPayload> {
  return {
    operationId: input.operationId,
    kind: input.kind,
    target: { ...input.target },
    causality: input.causality ? { ...input.causality } : undefined,
    idempotencyKey: input.idempotencyKey,
    expectedBarrier: input.expectedBarrier ? { ...input.expectedBarrier } : undefined,
    payload: input.payload,
  }
}

export type ControlSignalStatus = "pending" | "consumed" | "tombstone"

export type ControlSignalRecord<TPayload = unknown> = {
  signalId: string
  operationId?: string
  status: ControlSignalStatus
  sequence?: number
  idempotencyKey?: string
  deliveredAt?: number
  consumedAt?: number
  payload?: TPayload
}

export type ControlSignalLedger<TPayload = unknown> = {
  pending: ControlSignalRecord<TPayload>[]
  consumed: ControlSignalRecord<TPayload>[]
  tombstones: ControlSignalRecord<TPayload>[]
}

export type ControlBarrierBlocker = {
  participantId: string
  workClass?: MailboxWorkClass
  phase?: string
  reason: string
}

export type ControlBarrierResult =
  | {
      safe: true
      barrierId: string
      purpose: string
      blockers: []
    }
  | {
      safe: false
      barrierId: string
      purpose: string
      blockers: ControlBarrierBlocker[]
    }

export function createSafeControlBarrier(input: {
  barrierId: string
  purpose: string
}): ControlBarrierResult {
  return {
    safe: true,
    barrierId: input.barrierId,
    purpose: input.purpose,
    blockers: [],
  }
}

export function createBlockedControlBarrier(input: {
  barrierId: string
  purpose: string
  blockers: ControlBarrierBlocker[]
}): ControlBarrierResult {
  return {
    safe: false,
    barrierId: input.barrierId,
    purpose: input.purpose,
    blockers: input.blockers.map((blocker) => ({
      participantId: blocker.participantId,
      workClass: blocker.workClass,
      phase: blocker.phase,
      reason: blocker.reason,
    })),
  }
}

export function isControlBarrierSafe(result: ControlBarrierResult): boolean {
  return result.safe
}

export type DurableHead = {
  headId: string
  kind: string
}

export type DurableHeadCohort = {
  cohortId: string
  barrierId: string
  heads: DurableHead[]
  canAdvance: (barrier: ControlBarrierResult) => boolean
}

export function createDurableHeadCohort(input: {
  cohortId: string
  barrierId: string
  heads: DurableHead[]
}): DurableHeadCohort {
  return {
    cohortId: input.cohortId,
    barrierId: input.barrierId,
    heads: input.heads.map((head) => ({ ...head })),
    canAdvance: (barrier) => barrier.barrierId === input.barrierId && barrier.safe,
  }
}
