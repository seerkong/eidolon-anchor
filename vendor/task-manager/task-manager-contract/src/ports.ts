import type { TaskHistoryEvent } from './events.js';
import type {
  TaskArtifactBody,
  TaskArtifactDigest,
  TaskCommandDigest,
  TaskCommandId,
  TaskRevision,
  TaskSpaceId,
  TaskSpaceSnapshot,
} from './kernel.js';
import type { TaskCommand } from './commands.js';
import type { TaskCommandReceipt } from './receipts.js';

/**
 * One owner admission. Implementations must make the snapshot, events,
 * receipts and newly supplied artifacts visible together or not at all.
 */
export interface TaskSpaceCommit {
  readonly kind: 'task-space-commit';
  readonly taskSpaceId: TaskSpaceId;
  /** `null` creates a previously absent TaskSpace. */
  readonly expectedRevision: TaskRevision | null;
  readonly commandId: TaskCommandId;
  readonly commandDigest: TaskCommandDigest;
  readonly command: TaskCommand;
  readonly snapshot: TaskSpaceSnapshot;
  readonly events: readonly TaskHistoryEvent[];
  readonly receipts: readonly TaskCommandReceipt[];
  readonly artifacts: readonly TaskArtifactBody[];
}

export const TASK_SPACE_COMMIT_RESULT_KINDS = Object.freeze([
  'commit-accepted',
  'command-replayed',
  'revision-conflict',
] as const);

export interface TaskSpaceCommitAccepted {
  readonly kind: 'commit-accepted';
  readonly taskSpaceId: TaskSpaceId;
  readonly revision: TaskRevision;
  readonly snapshot: TaskSpaceSnapshot;
  readonly receipt: TaskCommandReceipt;
}

export interface TaskSpaceCommandReplayed {
  readonly kind: 'command-replayed';
  readonly taskSpaceId: TaskSpaceId;
  readonly revision: TaskRevision;
  readonly snapshot: TaskSpaceSnapshot;
  readonly receipt: TaskCommandReceipt;
}

export interface TaskSpaceRevisionConflict {
  readonly kind: 'revision-conflict';
  readonly taskSpaceId: TaskSpaceId;
  readonly expectedRevision: TaskRevision | null;
  readonly actualRevision: TaskRevision | null;
}

export type TaskSpaceCommitResult =
  | TaskSpaceCommitAccepted
  | TaskSpaceCommandReplayed
  | TaskSpaceRevisionConflict;

/** Backend-neutral durable authority consumed by runtime-first Processors. */
export interface TaskSpaceOwnerPort {
  readSnapshot(taskSpaceId: TaskSpaceId): Promise<TaskSpaceSnapshot | undefined>;
  readReceiptByCommand(
    taskSpaceId: TaskSpaceId,
    commandId: TaskCommandId,
  ): Promise<TaskCommandReceipt | undefined>;
  readHistory(taskSpaceId: TaskSpaceId): Promise<readonly TaskHistoryEvent[]>;
  readArtifact(taskSpaceId: TaskSpaceId, digest: TaskArtifactDigest): Promise<TaskArtifactBody | undefined>;
  compareAndSwap(commit: TaskSpaceCommit): Promise<TaskSpaceCommitResult>;
}

/** Optional bounded discovery; authority and authorization stay with the host. */
export interface TaskSpaceDirectoryPort {
  listTaskSpaceIds(input?:Readonly<{maxEntries?:number}>):Promise<readonly TaskSpaceId[]>;
}
