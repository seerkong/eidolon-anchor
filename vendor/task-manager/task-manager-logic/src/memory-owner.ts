import type {
  TaskArtifactBody,
  TaskArtifactDigest,
  TaskCommandId,
  TaskCommandReceipt,
  TaskHistoryEvent,
  TaskSpaceCommit,
  TaskSpaceCommitResult,
  TaskSpaceId,
  TaskSpaceOwnerPort,
  TaskSpaceSnapshot,
} from 'task-manager-contract';
import { TaskManagerError } from './errors.js';
import {
  validateTaskSpaceCommitAdmission,
  validateTaskSpaceCommitCommand,
} from './owner-admission.js';
import { deepImmutableClone } from './validation.js';

interface MemoryTaskSpaceState {
  readonly snapshot: TaskSpaceSnapshot;
  readonly history: readonly TaskHistoryEvent[];
  readonly receiptsByCommand: ReadonlyMap<TaskCommandId, TaskCommandReceipt>;
  readonly artifacts: ReadonlyMap<TaskArtifactDigest, TaskArtifactBody>;
}

/** Deterministic effect adapter for tests and embedded single-process use. */
export class InMemoryTaskSpaceOwner implements TaskSpaceOwnerPort {
  readonly #spaces = new Map<TaskSpaceId, MemoryTaskSpaceState>();

  async readSnapshot(taskSpaceId: TaskSpaceId): Promise<TaskSpaceSnapshot | undefined> {
    const snapshot = this.#spaces.get(taskSpaceId)?.snapshot;
    return snapshot === undefined ? undefined : deepImmutableClone(snapshot);
  }

  async readReceiptByCommand(
    taskSpaceId: TaskSpaceId,
    commandId: TaskCommandId,
  ): Promise<TaskCommandReceipt | undefined> {
    const receipt = this.#spaces.get(taskSpaceId)?.receiptsByCommand.get(commandId);
    return receipt === undefined ? undefined : deepImmutableClone(receipt);
  }

  async readHistory(taskSpaceId: TaskSpaceId): Promise<readonly TaskHistoryEvent[]> {
    return deepImmutableClone(this.#spaces.get(taskSpaceId)?.history ?? []);
  }

  async readArtifact(
    taskSpaceId: TaskSpaceId,
    digest: TaskArtifactDigest,
  ): Promise<TaskArtifactBody | undefined> {
    const artifact = this.#spaces.get(taskSpaceId)?.artifacts.get(digest);
    return artifact === undefined ? undefined : deepImmutableClone(artifact);
  }

  async compareAndSwap(commit: TaskSpaceCommit): Promise<TaskSpaceCommitResult> {
    commit = deepImmutableClone(commit);
    const submittedCommandDigest = validateTaskSpaceCommitCommand(commit);
    const current = this.#spaces.get(commit.taskSpaceId);
    const replay = current?.receiptsByCommand.get(commit.commandId);
    if (current && replay) {
      if (replay.commandDigest !== submittedCommandDigest) {
        throw new TaskManagerError('command-receipt-mismatch', `command ${commit.commandId} digest does not match prior admission`);
      }
      return deepImmutableClone({
        kind: 'command-replayed',
        taskSpaceId: commit.taskSpaceId,
        revision: current.snapshot.revision,
        snapshot: current.snapshot,
        receipt: replay,
      });
    }

    const actualRevision = current?.snapshot.revision ?? null;
    if (actualRevision !== commit.expectedRevision) {
      return deepImmutableClone({
        kind: 'revision-conflict',
        taskSpaceId: commit.taskSpaceId,
        expectedRevision: commit.expectedRevision,
        actualRevision,
      });
    }

    const receipt = validateTaskSpaceCommitAdmission(commit, {
      ...(current === undefined ? {} : { currentSnapshot: current.snapshot }),
      existingArtifacts: current?.artifacts ?? new Map(),
    });
    const receiptsByCommand = new Map(current?.receiptsByCommand ?? []);
    for (const candidate of commit.receipts) receiptsByCommand.set(candidate.commandId, deepImmutableClone(candidate));
    const artifacts = new Map(current?.artifacts ?? []);
    for (const artifact of commit.artifacts) {
      const prior = artifacts.get(artifact.digest);
      if (prior && !sameArtifact(prior, artifact)) {
        throw new TaskManagerError('artifact-conflict', `digest ${artifact.digest} has conflicting content`);
      }
      artifacts.set(artifact.digest, deepImmutableClone(artifact));
    }
    const next: MemoryTaskSpaceState = {
      snapshot: deepImmutableClone(commit.snapshot),
      history: deepImmutableClone([...(current?.history ?? []), ...commit.events]),
      receiptsByCommand,
      artifacts,
    };
    this.#spaces.set(commit.taskSpaceId, next);
    return deepImmutableClone({
      kind: 'commit-accepted',
      taskSpaceId: commit.taskSpaceId,
      revision: next.snapshot.revision,
      snapshot: next.snapshot,
      receipt,
    });
  }
}

function sameArtifact(left: TaskArtifactBody, right: TaskArtifactBody): boolean {
  return left.digest === right.digest
    && left.mediaType === right.mediaType
    && left.sizeBytes === right.sizeBytes
    && left.encoding === right.encoding
    && left.data === right.data;
}
