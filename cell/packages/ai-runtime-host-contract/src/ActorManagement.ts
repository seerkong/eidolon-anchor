/** Original Actor lifecycle, distinct from closing a browser pane or deleting files. */
export type ActorLifecycle = Readonly<{
  state: 'active' | 'archived' | 'tombstoned';
  revision: number;
  changedAt?: number;
}>;
export type ActorManagementCommand = Readonly<{
  commandId: string;
  kind: 'archive_actor' | 'delete_actor';
  expectedServerInstanceId: string;
  expectedEpoch: string;
  expectedLifecycleRevision: number;
}>;
/** Principal-scoped durable proof; a historical receipt does not overwrite the current lifecycle. */
export type ActorManagementResult = Readonly<{
  sessionId: string;
  actorId: string;
  commandId: string;
  kind: ActorManagementCommand['kind'];
  submittedEpoch: string;
  lifecycle: Readonly<{state: 'archived' | 'tombstoned'; revision: number; changedAt: number}>;
}>;
