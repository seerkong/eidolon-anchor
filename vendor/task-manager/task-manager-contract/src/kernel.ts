export type TaskSpaceId = string;
export type TaskId = string;
export type TaskRelationId = string;
export type TaskCommandId = string;
export type TaskCommandDigest = `sha256:${string}`;
export type TaskEventId = string;
export type TaskReceiptId = string;
export type TaskClaimId = string;
export type TaskPlanId = string;
export type TaskArtifactDigest = `sha256:${string}`;
export type TaskRevision = number;
export type TaskSequence = number;
export type TaskTimestamp = string;

export type ImmutableJsonPrimitive = string | number | boolean | null;
export type ImmutableJsonValue =
  | ImmutableJsonPrimitive
  | readonly ImmutableJsonValue[]
  | { readonly [key: string]: ImmutableJsonValue };

export const TASK_STATUSES = Object.freeze([
  'Pending',
  'Ready',
  'Claimed',
  'Running',
  'Waiting',
  'Succeeded',
  'Failed',
  'Cancelled',
] as const);

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskTerminalStatus = Extract<TaskStatus, 'Succeeded' | 'Failed' | 'Cancelled'>;
export type TaskWorkStatus = Extract<TaskStatus, 'Claimed' | 'Running' | 'Waiting'>;

/** Closed profile boundary. The kernel never interprets `facts`. */
export interface TaskProfileEnvelope<
  ProfileKind extends string = string,
  Facts extends Readonly<Record<string, ImmutableJsonValue>> = Readonly<Record<string, ImmutableJsonValue>>,
> {
  readonly kind: 'task-profile';
  readonly profileKind: ProfileKind;
  readonly schemaVersion: number;
  readonly facts: Facts;
}

export interface TaskArtifactRef {
  readonly kind: 'task-artifact-ref';
  readonly digest: TaskArtifactDigest;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly name?: string;
}

/** Immutable transport form for a content-addressed artifact body. */
export interface TaskArtifactBody {
  readonly kind: 'task-artifact-body';
  readonly digest: TaskArtifactDigest;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly encoding: 'base64';
  readonly data: string;
}

interface TaskNodeDefinitionBase<Profile extends TaskProfileEnvelope> {
  readonly taskId: TaskId;
  readonly name: string;
  readonly order: number;
  readonly description?: string;
  readonly profile: Profile;
  readonly inputArtifacts: readonly TaskArtifactRef[];
}

export interface TaskDefinition<Profile extends TaskProfileEnvelope = TaskProfileEnvelope>
  extends TaskNodeDefinitionBase<Profile> {
  readonly kind: 'task';
}

export const TASK_GROUP_MODES = Object.freeze(['sequential', 'all', 'any'] as const);
export type TaskGroupMode = (typeof TASK_GROUP_MODES)[number];

export interface TaskGroupDefinition<Profile extends TaskProfileEnvelope = TaskProfileEnvelope>
  extends TaskNodeDefinitionBase<Profile> {
  readonly kind: 'task-group';
  readonly mode: TaskGroupMode;
}

export type TaskNodeDefinition<Profile extends TaskProfileEnvelope = TaskProfileEnvelope> =
  | TaskDefinition<Profile>
  | TaskGroupDefinition<Profile>;

export interface ParentChildTaskRelation {
  readonly kind: 'parent-child';
  readonly relationId: TaskRelationId;
  readonly parentTaskId: TaskId | null;
  readonly childTaskId: TaskId;
  readonly order: number;
}

export interface TaskDependencyRelation {
  readonly kind: 'dependency';
  readonly relationId: TaskRelationId;
  readonly predecessorTaskId: TaskId;
  readonly successorTaskId: TaskId;
}

export type TaskRelation = ParentChildTaskRelation | TaskDependencyRelation;

export interface TaskSpaceDefinition<Profile extends TaskProfileEnvelope = TaskProfileEnvelope> {
  readonly kind: 'task-space-definition';
  readonly taskSpaceId: TaskSpaceId;
  readonly name: string;
  readonly schemaVersion: number;
  /** Explicit container capability; existing definitions remain non-empty. */
  readonly allowEmpty?: true;
  readonly tasks: readonly TaskNodeDefinition<Profile>[];
  readonly relations: readonly TaskRelation[];
}

/** Owner-issued lease capability; callers must present the exact live value. */
export interface TaskClaimToken {
  readonly kind: 'task-claim-token';
  readonly claimId: TaskClaimId;
  readonly taskSpaceId: TaskSpaceId;
  readonly taskId: TaskId;
  readonly assigneeRef: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly claimedAt: TaskTimestamp;
  readonly heartbeatAt: TaskTimestamp;
  readonly expiresAt: TaskTimestamp;
}

export interface TaskFailure {
  readonly kind: 'task-failure';
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: ImmutableJsonValue;
}

export interface TaskPlan {
  readonly kind: 'task-plan';
  readonly planId: TaskPlanId;
  readonly tasks: readonly TaskNodeDefinition[];
  readonly relations: readonly TaskRelation[];
  readonly reason: string;
}

export interface TaskRecord<Profile extends TaskProfileEnvelope = TaskProfileEnvelope> {
  readonly kind: 'task-record';
  readonly taskSpaceId: TaskSpaceId;
  readonly taskId: TaskId;
  readonly definition: TaskNodeDefinition<Profile>;
  /** Domain-owned current facts, initialized from `definition.profile`. */
  readonly profile: Profile;
  /** Exact canonical preparation receipt, once a managed leaf has been admitted. */
  readonly preparationReceiptId?: TaskReceiptId;
  readonly status: TaskStatus;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly activeClaim: TaskClaimToken | null;
  readonly outputArtifacts: readonly TaskArtifactRef[];
  readonly createdAt: TaskTimestamp;
  readonly updatedAt: TaskTimestamp;
  /** Root dispatch authority; task execution status remains owned separately. */
  readonly rootControl?: TaskRootControl;
}

export interface TaskRootBinding {
  readonly bindingId: string;
  readonly authorityRef: string;
  readonly executionRef: string;
  readonly digest: `sha256:${string}`;
}

export interface TaskRootControl {
  readonly revision: number;
  readonly paused: boolean;
  readonly binding: TaskRootBinding | null;
}

export interface TaskSpaceSnapshot<Profile extends TaskProfileEnvelope = TaskProfileEnvelope> {
  readonly kind: 'task-space-snapshot';
  readonly taskSpaceId: TaskSpaceId;
  readonly revision: TaskRevision;
  readonly definition: TaskSpaceDefinition<Profile>;
  readonly tasks: readonly TaskRecord<Profile>[];
  readonly historyEventIds: readonly TaskEventId[];
  readonly issuedReceiptIds: readonly TaskReceiptId[];
  readonly createdAt: TaskTimestamp;
  readonly updatedAt: TaskTimestamp;
}
