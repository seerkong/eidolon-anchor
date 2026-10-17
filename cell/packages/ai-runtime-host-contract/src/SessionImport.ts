import type {SessionSummary} from './HostPort';

/** Original workspace persistence inventory. No arbitrary filesystem path or
 * snapshot/provider payload is exposed by this contract. */
export type PersistedSessionCandidate=Readonly<{
  sessionId:string;
  displayName:string;
  format:'v4'|'legacy-v3'|'unsupported'|'corrupt'|'history-only';
  registered:boolean;
  tuiHidden:boolean;
}>;
export type PersistedSessionPage=Readonly<{candidates:readonly PersistedSessionCandidate[];nextCursor?:string}>;
export type PersistedSessionPreflight=Readonly<{
  sessionId:string;
  displayName:string;
  snapshotVersion:3|4;
  sourceDigest:string;
  controlActorKey:string;
  actorCount:number;
  readOnly:boolean;
  migrationRequired:boolean;
  registered:boolean;
  tuiHidden:boolean;
}>;
export type ImportPersistedSessionCommand=Readonly<{
  commandId:string;
  expectedServerInstanceId:string;
  expectedSourceDigest:string;
  upgrade:boolean;
}>;
export type ImportedSessionResult=Readonly<{
  commandId:string;
  session:SessionSummary;
  sourceDigest:string;
  snapshotVersion:3|4;
  migrated:boolean;
  backupFile?:string;
}>;
