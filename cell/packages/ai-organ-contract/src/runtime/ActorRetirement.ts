/** Retiring an Actor never changes its execution kind, identity or history. */
export type ActorRetirementPhase='archived'|'tombstoned';
export type ActorRetirementCommit=Readonly<{
  commandId:string;
  principalId:string;
  digest:string;
  submittedEpoch:string;
  phase:ActorRetirementPhase;
  revision:number;
  changedAt:number;
}>;
export type ActorRetirementValue=Readonly<{
  actorId:string;
  phase:ActorRetirementPhase;
  changedAt:number;
  commits:readonly ActorRetirementCommit[];
}>;
export type ActorRetirementInvocation=Readonly<{
  commandId:string;
  principalId:string;
  digest:string;
  submittedEpoch:string;
  expectedRevision:number;
  phase:ActorRetirementPhase;
  occurredAt:number;
}>;
