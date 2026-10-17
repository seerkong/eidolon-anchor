import type {ActorRetirementValue,ActorRetirementPhase,ActorRetirementInvocation,ActorRetirementCommit} from '@cell/ai-organ-contract/runtime/ActorRetirement';
import type {ActorRuntimeFacetCodecEntry,ActorRuntimeFacetEnvelope,ActorRuntimeFacetRegistry} from '@cell/ai-core-contract/runtime/ActorRuntimeFacet';
import {createActorRuntimeFacetRegistry,ActorRuntimeFacetProviderBoundaryError} from '@cell/ai-core-logic/runtime/ActorRuntimeFacet';

export const ACTOR_RETIREMENT_FACET_ID='eidolon.actor-retirement';
export const ACTOR_RETIREMENT_SCHEMA='1';
function fail(code:string):never{throw new Error(code)}
function closed(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail('actor_retirement_invalid');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Object.keys(descriptors).length!==keys.length||keys.some(key=>!Object.prototype.hasOwnProperty.call(descriptors,key)||!('value' in descriptors[key]!)))return fail('actor_retirement_invalid');
  return Object.fromEntries(keys.map(key=>[key,descriptors[key]!.value]));
}
function identifier(value:unknown):string{
  if(typeof value!=='string'||!value||value.length>256||/[\x00-\x1f\x7f]/.test(value))return fail('actor_retirement_invalid');
  return value;
}
function integer(value:unknown):number{
  if(!Number.isSafeInteger(value)||(value as number)<0)return fail('actor_retirement_invalid');return value as number;
}
function phase(value:unknown):ActorRetirementPhase{
  if(value!=='archived'&&value!=='tombstoned')return fail('actor_retirement_invalid');return value;
}
function digest(value:unknown):string{
  if(typeof value!=='string'||!/^sha256:[a-f0-9]{64}$/.test(value))return fail('actor_retirement_invalid');return value;
}
function commit(value:unknown):ActorRetirementCommit{
  const data=closed(value,['commandId','principalId','digest','submittedEpoch','phase','revision','changedAt']);
  return Object.freeze({commandId:identifier(data.commandId),principalId:identifier(data.principalId),digest:digest(data.digest),submittedEpoch:identifier(data.submittedEpoch),phase:phase(data.phase),revision:integer(data.revision),changedAt:integer(data.changedAt)});
}
export function normalizeActorRetirementValue(value:unknown):ActorRetirementValue{
  const data=closed(value,['actorId','phase','changedAt','commits']);
  if(!Array.isArray(data.commits)||data.commits.length<1||data.commits.length>2)return fail('actor_retirement_invalid');
  const commits=data.commits.map(commit);
  for(let i=0;i<commits.length;i++){
    if(commits[i]!.revision!==i+1||i===1&&(commits[0]!.phase!=='archived'||commits[1]!.phase!=='tombstoned'
      ||commits[1]!.changedAt<commits[0]!.changedAt||commits[1]!.commandId===commits[0]!.commandId&&commits[1]!.principalId===commits[0]!.principalId))return fail('actor_retirement_invalid');
  }
  const result={actorId:identifier(data.actorId),phase:phase(data.phase),changedAt:integer(data.changedAt),commits:Object.freeze(commits)};
  if(result.phase!==commits.at(-1)!.phase||result.changedAt!==commits.at(-1)!.changedAt)return fail('actor_retirement_invalid');
  return Object.freeze(result);
}

/** Pure preparation: checkpoint and publication effects belong to the caller.
 * At most active -> archived -> tombstoned; no identity reuse or restoration. */
export function prepareActorRetirement(input:Readonly<{
  actorId:string;primary:boolean;current?:ActorRuntimeFacetEnvelope;invocation:ActorRetirementInvocation;
}>):Readonly<{envelope:ActorRuntimeFacetEnvelope;commit:ActorRetirementCommit;replayed:boolean}>{
  const actorId=identifier(input.actorId),i=closed(input.invocation,['commandId','principalId','digest','submittedEpoch','expectedRevision','phase','occurredAt']);
  const invocation={commandId:identifier(i.commandId),principalId:identifier(i.principalId),digest:digest(i.digest),submittedEpoch:identifier(i.submittedEpoch),expectedRevision:integer(i.expectedRevision),phase:phase(i.phase),occurredAt:integer(i.occurredAt)};
  const current=input.current;
  if(current&&(current.facetId!==ACTOR_RETIREMENT_FACET_ID||current.schemaVersion!==ACTOR_RETIREMENT_SCHEMA))return fail('actor_retirement_invalid');
  const value=current?normalizeActorRetirementValue(current.value):undefined;
  if(value&&(value.actorId!==actorId||current!.revision!==value.commits.at(-1)!.revision))return fail('actor_retirement_invalid');
  if(input.primary)return fail('actor_primary_protected');
  const previous=value?.commits.find(c=>c.commandId===invocation.commandId&&c.principalId===invocation.principalId);
  if(previous){
    if(previous.digest!==invocation.digest||previous.phase!==invocation.phase)return fail('idempotency_conflict');
    return {envelope:current!,commit:previous,replayed:true};
  }
  if(invocation.expectedRevision!==(current?.revision??0))return fail('actor_lifecycle_revision_changed');
  if(value&&(value.phase==='tombstoned'||invocation.phase==='archived'))return fail('actor_already_retired');
  const next=Object.freeze({...invocation,revision:(current?.revision??0)+1,changedAt:Math.max(invocation.occurredAt,value?.changedAt??0)});
  const committed=commit({commandId:next.commandId,principalId:next.principalId,digest:next.digest,submittedEpoch:next.submittedEpoch,phase:next.phase,revision:next.revision,changedAt:next.changedAt});
  const nextValue=normalizeActorRetirementValue({actorId,phase:committed.phase,changedAt:committed.changedAt,commits:[...(value?.commits??[]),committed]});
  return {envelope:Object.freeze({facetId:ACTOR_RETIREMENT_FACET_ID,schemaVersion:ACTOR_RETIREMENT_SCHEMA,revision:committed.revision,value:nextValue}),commit:committed,replayed:false};
}

export const ACTOR_RETIREMENT_CODEC:ActorRuntimeFacetCodecEntry=Object.freeze({
  facetId:ACTOR_RETIREMENT_FACET_ID,schemaVersion:ACTOR_RETIREMENT_SCHEMA,normalize:normalizeActorRetirementValue,
  onEvent(context){
    if(context.event.kind==='beforeTurn')throw new Error(`actor_${normalizeActorRetirementValue(context.envelope.value).phase}`);
    return null;
  },
  async aroundProvider(context,_runtime){
    const value=normalizeActorRetirementValue(context.envelope.value);
    throw new ActorRuntimeFacetProviderBoundaryError(ACTOR_RETIREMENT_FACET_ID,`actor_${value.phase}`);
  },
});
export function extendActorRetirementFacetRegistry(registry:ActorRuntimeFacetRegistry):ActorRuntimeFacetRegistry{
  const entries=registry.entries.filter(entry=>entry.facetId===ACTOR_RETIREMENT_FACET_ID);
  if(entries.some(entry=>entry.schemaVersion!==ACTOR_RETIREMENT_SCHEMA))return fail('actor_retirement_unknown_schema');
  return entries.length?registry:createActorRuntimeFacetRegistry([...registry.entries,ACTOR_RETIREMENT_CODEC]);
}

/** Read the original Actor fact, never infer retirement from a surface view. */
export function readActorRetirement(actor: Readonly<{id:string;runtimeFacets:Readonly<Record<string,ActorRuntimeFacetEnvelope>>}>):ActorRetirementValue|undefined{
  const envelope=actor.runtimeFacets[ACTOR_RETIREMENT_FACET_ID];
  if(!envelope)return undefined;
  if(envelope.facetId!==ACTOR_RETIREMENT_FACET_ID||envelope.schemaVersion!==ACTOR_RETIREMENT_SCHEMA)return fail('actor_retirement_invalid');
  const value=normalizeActorRetirementValue(envelope.value);
  if(value.actorId!==actor.id||value.commits.at(-1)!.revision!==envelope.revision)return fail('actor_retirement_invalid');
  return value;
}
export function requireActiveActor(actor:Parameters<typeof readActorRetirement>[0]):void{
  const value=readActorRetirement(actor);
  if(value)fail(`actor_${value.phase}`);
}
