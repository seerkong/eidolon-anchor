import type {
  ImmutableJsonValue,
  TaskArtifactRef,
  TaskClaimToken,
  TaskCommandId,
  TaskEventId,
  TaskFailure,
  TaskId,
  TaskPlanId,
  TaskRevision,
  TaskSequence,
  TaskSpaceId,
  TaskStatus,
  TaskTimestamp,
  TaskRootControl,
} from './kernel.js';

export const TASK_EVENT_KINDS = Object.freeze([
  'task-space.created',
  'task-space.patched',
  'task.readied',
  'task.claimed',
  'task.claim-heartbeat-recorded',
  'task.claim-expired',
  'task.started',
  'task.waiting',
  'task.settled',
  'task.failed',
  'task.cancelled',
  'task.replanned',
  'task.group-status-projected',
  'task.root-controlled',
  'task.prepared',
] as const);

export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

interface TaskEventBase<Kind extends TaskEventKind> {
  readonly kind: Kind;
  readonly eventId: TaskEventId;
  readonly commandId: TaskCommandId;
  readonly taskSpaceId: TaskSpaceId;
  readonly sequence: TaskSequence;
  readonly fromRevision: TaskRevision;
  readonly toRevision: TaskRevision;
  readonly occurredAt: TaskTimestamp;
}

export interface TaskSpaceCreatedEvent extends TaskEventBase<'task-space.created'> {}

export interface TaskSpacePatchedEvent extends TaskEventBase<'task-space.patched'> {
  readonly taskId: TaskId;
}

interface TaskStateEventBase<Kind extends TaskEventKind> extends TaskEventBase<Kind> {
  readonly taskId: TaskId;
  readonly fromStatus: TaskStatus;
  readonly toStatus: TaskStatus;
}

export interface TaskReadiedEvent extends TaskStateEventBase<'task.readied'> {}

export interface TaskClaimedEvent extends TaskStateEventBase<'task.claimed'> {
  readonly claim: TaskClaimToken;
}

export interface TaskClaimHeartbeatRecordedEvent extends TaskEventBase<'task.claim-heartbeat-recorded'> {
  readonly taskId: TaskId;
  readonly previousClaim: TaskClaimToken;
  readonly claim: TaskClaimToken;
}

export interface TaskClaimExpiredEvent extends TaskStateEventBase<'task.claim-expired'> {
  readonly expiredClaim: TaskClaimToken;
  readonly nextAttempt: number;
  readonly nextLeaseEpoch: number;
}

export interface TaskStartedEvent extends TaskStateEventBase<'task.started'> {
  readonly claimId: string;
}

export interface TaskWaitingEvent extends TaskStateEventBase<'task.waiting'> {
  readonly claimId: string;
  readonly reason: string;
  readonly details?: ImmutableJsonValue;
}

export interface TaskSettledEvent extends TaskStateEventBase<'task.settled'> {
  readonly claimId: string;
  readonly outputArtifacts: readonly TaskArtifactRef[];
  readonly result?: ImmutableJsonValue;
}

export interface TaskFailedEvent extends TaskStateEventBase<'task.failed'> {
  readonly claimId: string;
  readonly failure: TaskFailure;
}

export interface TaskCancelledEvent extends TaskStateEventBase<'task.cancelled'> {
  readonly claimId?: string;
  readonly reason: string;
}

export interface TaskReplannedEvent extends TaskEventBase<'task.replanned'> {
  readonly planId: TaskPlanId;
  readonly affectedTaskIds: readonly TaskId[];
}

export interface TaskGroupStatusProjectedEvent extends TaskStateEventBase<'task.group-status-projected'> {}

export interface TaskRootControlledEvent extends TaskEventBase<'task.root-controlled'> {
  readonly taskId: TaskId;
  readonly control: TaskRootControl;
}

export interface TaskPreparedEvent extends TaskEventBase<'task.prepared'> {
  readonly taskId: TaskId;
  readonly preparationReceiptId: string;
}

export type TaskHistoryEvent =
  | TaskSpaceCreatedEvent
  | TaskSpacePatchedEvent
  | TaskReadiedEvent
  | TaskClaimedEvent
  | TaskClaimHeartbeatRecordedEvent
  | TaskClaimExpiredEvent
  | TaskStartedEvent
  | TaskWaitingEvent
  | TaskSettledEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskReplannedEvent
  | TaskGroupStatusProjectedEvent
  | TaskRootControlledEvent
  | TaskPreparedEvent;
