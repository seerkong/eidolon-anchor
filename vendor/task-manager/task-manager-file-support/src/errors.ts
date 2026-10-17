export type FileTaskSpaceErrorCode =
  | 'artifact-conflict'
  | 'artifact-digest-mismatch'
  | 'artifact-not-found'
  | 'command-receipt-mismatch'
  | 'corrupt-head'
  | 'digest-mismatch'
  | 'immutable-conflict'
  | 'invalid-commit'
  | 'journal-corrupt'
  | 'lock-corrupt'
  | 'lock-timeout'
  | 'path-boundary'
  | 'directory-capacity';

export class FileTaskSpaceError extends Error {
  readonly name = 'FileTaskSpaceError';

  constructor(
    readonly code: FileTaskSpaceErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}
