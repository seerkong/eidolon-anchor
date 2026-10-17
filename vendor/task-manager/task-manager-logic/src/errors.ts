export type TaskManagerErrorCode =
  | 'artifact-conflict'
  | 'artifact-not-found'
  | 'canonical-data-invalid'
  | 'claim-expired'
  | 'claim-not-expired'
  | 'claim-token-mismatch'
  | 'command-receipt-mismatch'
  | 'cross-space-identity'
  | 'cyclic-task-forest'
  | 'duplicate-task-identity'
  | 'invalid-commit'
  | 'invalid-task-definition'
  | 'invalid-task-transition'
  | 'lease-out-of-range'
  | 'revision-conflict'
  | 'root-binding-conflict'
  | 'root-control-revision-conflict'
  | 'root-busy'
  | 'root-paused'
  | 'root-execution-unknown'
  | 'task-not-root'
  | 'task-not-found'
  | 'task-not-ready'
  | 'task-space-already-exists'
  | 'task-space-not-found'
  | 'terminal-task-immutable';

export class TaskManagerError extends Error {
  readonly name = 'TaskManagerError';

  constructor(
    readonly code: TaskManagerErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}
