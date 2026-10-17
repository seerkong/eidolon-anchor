import type {
  TaskClaimId,
  TaskClaimToken,
  TaskCommandId,
  TaskCommandDigest,
  TaskEventId,
  TaskId,
  TaskPlanId,
  TaskReceiptId,
  TaskRevision,
  TaskSpaceId,
  TaskTerminalStatus,
  TaskTimestamp,
  TaskRootControl,
} from './kernel.js';

interface TaskReceiptBase<Kind extends string> {
  readonly kind: Kind;
  readonly receiptId: TaskReceiptId;
  readonly commandId: TaskCommandId;
  readonly commandDigest: TaskCommandDigest;
  readonly intentDigest?: TaskCommandDigest;
  readonly taskSpaceId: TaskSpaceId;
  readonly fromRevision: TaskRevision;
  readonly toRevision: TaskRevision;
  readonly eventIds: readonly TaskEventId[];
  readonly committedAt: TaskTimestamp;
}

export interface TaskTransitionReceipt extends TaskReceiptBase<'task-transition-receipt'> {
  readonly taskId?: TaskId;
}

export interface TaskClaimReceipt extends TaskReceiptBase<'task-claim-receipt'> {
  readonly taskId: TaskId;
  readonly claim: TaskClaimToken;
}

export interface TaskSettlementReceipt extends TaskReceiptBase<'task-settlement-receipt'> {
  readonly taskId: TaskId;
  readonly claimId?: TaskClaimId;
  readonly status: TaskTerminalStatus;
}

export interface TaskReplanReceipt extends TaskReceiptBase<'task-replan-receipt'> {
  readonly planId: TaskPlanId;
  readonly affectedTaskIds: readonly TaskId[];
}

export interface TaskRootControlReceipt extends TaskReceiptBase<'task-root-control-receipt'> {
  readonly taskId: TaskId;
  readonly control: TaskRootControl;
}

export type TaskCommandReceipt =
  | TaskTransitionReceipt
  | TaskClaimReceipt
  | TaskSettlementReceipt
  | TaskReplanReceipt
  | TaskRootControlReceipt;
