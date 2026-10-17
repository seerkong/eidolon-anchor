import {expect,test} from 'bun:test';
import {createActor,createVM,serializeActor,hydrateActor} from '../../../../cell/packages/ai-core-logic/src';
import {dispatchActorRuntimeFacetEvent} from '../../../../cell/packages/ai-core-logic/src/runtime/ActorRuntimeFacet';
import {createWorkflowLifecycleFacetRegistry} from '../../../../cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowLifecycleFacet';
import {ACTOR_RETIREMENT_FACET_ID,ACTOR_RETIREMENT_CODEC,prepareActorRetirement,normalizeActorRetirementValue,extendActorRetirementFacetRegistry} from '../../../../cell/packages/ai-organ-logic/src/runtime/ActorRetirementFacet';
const invocation={commandId:'archive',principalId:'owner',digest:'sha256:'+'a'.repeat(64),submittedEpoch:'original',expectedRevision:0,phase:'archived' as const,occurredAt:10};
test('bounded pure retirement retains exact identity, phases, version and original principal command proof',()=>{
  const first=prepareActorRetirement({actorId:'actor',primary:false,invocation});
  expect(first.envelope.revision).toBe(1);expect(first.replayed).toBe(false);
  const again=prepareActorRetirement({actorId:'actor',primary:false,current:first.envelope,invocation});
  expect(again).toMatchObject({commit:first.commit,replayed:true});
  expect(()=>prepareActorRetirement({actorId:'actor',primary:false,current:first.envelope,invocation:{...invocation,digest:'sha256:'+'b'.repeat(64)}})).toThrow('idempotency_conflict');
  expect(()=>prepareActorRetirement({actorId:'another',primary:false,current:first.envelope,invocation})).toThrow('invalid');
  expect(()=>prepareActorRetirement({actorId:'actor',primary:true,invocation})).toThrow('primary_protected');
  expect(()=>prepareActorRetirement({actorId:'actor',primary:false,current:first.envelope,invocation:{...invocation,commandId:'stale',phase:'tombstoned'}})).toThrow('revision_changed');
  const second=prepareActorRetirement({actorId:'actor',primary:false,current:first.envelope,invocation:{...invocation,commandId:'delete',digest:'sha256:'+'b'.repeat(64),expectedRevision:1,phase:'tombstoned',occurredAt:20}});
  expect(second.envelope.revision).toBe(2);expect(normalizeActorRetirementValue(second.envelope.value).commits).toHaveLength(2);
  expect(()=>prepareActorRetirement({actorId:'actor',primary:false,current:second.envelope,invocation:{...invocation,commandId:'revive',expectedRevision:2}})).toThrow('already_retired');
  expect(()=>normalizeActorRetirementValue({...normalizeActorRetirementValue(second.envelope.value),phase:'active'})).toThrow('invalid');
  expect(()=>normalizeActorRetirementValue({...normalizeActorRetirementValue(second.envelope.value),path:'/tmp'})).toThrow('invalid');
});
test('original Actor serialization/hydration retains retirement and existing registry codecs, and rejects work before a provider effect',async()=>{
  const registry=extendActorRetirementFacetRegistry(createWorkflowLifecycleFacetRegistry());
  expect(extendActorRetirementFacetRegistry(registry)).toBe(registry);
  const actor=createActor({key:'fixed',type:'interactive',systemPrompts:['original']}),prepared=prepareActorRetirement({actorId:actor.id,primary:false,invocation});
  actor.runtimeFacets={[ACTOR_RETIREMENT_FACET_ID]:prepared.envelope};
  const snapshot=serializeActor(actor),restored=hydrateActor(snapshot,{actorFacetRuntime:registry});
  expect(restored.id).toBe(actor.id);expect(restored.type).toBe('interactive');expect(restored.runtimeFacets).toEqual(actor.runtimeFacets);
  const vm=createVM({controlActorKey:'fixed',actors:{fixed:restored},runtimeContext:{actorFacetRuntime:registry}});
  expect(()=>dispatchActorRuntimeFacetEvent(vm,{actorKey:restored.key,facetId:ACTOR_RETIREMENT_FACET_ID},{kind:'beforeTurn',operationId:'stale-work',occurredAt:100})).toThrow('actor_archived');
  let ran=0,aborted=0;
  await expect(ACTOR_RETIREMENT_CODEC.aroundProvider!({selector:{actorKey:'fixed',facetId:ACTOR_RETIREMENT_FACET_ID},envelope:prepared.envelope,event:{kind:'aroundProvider',operationId:'old',occurredAt:100,providerAttempt:0}},
    {...vm,providerBoundary:{run:async()=>{ran++;return 'not allowed'},abort:()=>{aborted++}}} as any)).rejects.toThrow('actor_archived');
  expect(ran).toBe(0);expect(aborted).toBe(0);
  expect(()=>normalizeActorRetirementValue({actorId:actor.id,phase:'archived',changedAt:10,commits:[]})).toThrow();
});
