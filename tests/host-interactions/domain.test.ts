import {expect,test} from 'bun:test';
import {emptyHostInteractions,recordHostInvocation,transitionHostInvocation,recoverHostInteractions,registerHost,publishHostContext} from '../../cell/packages/ai-core-logic/src/runtime/HostInteractions';
import {createVM} from '@cell/ai-core-logic/runtime/runtime';
import {serializeVM,hydrateVM} from '@cell/ai-core-logic/runtime/snapshot/vmSnapshot';
import {parseHostInteractionOperation,parseCommandEnvelope} from '../../cell/packages/ai-runtime-host-contract/src';
const call=(id='i')=>({invocationId:id,hostId:'h',actorId:'a',principalId:'p',turnId:'original',attemptId:'attempt',toolCallId:'tool',registrationRevision:1,toolName:'write',inputJson:'{}',access:'write' as const,revision:1,state:'awaiting_confirmation' as const});
test('original revision, confirmation and immutable result owner exclude double execution and stale action',()=>{
 const state=emptyHostInteractions();recordHostInvocation(state,call());
 expect(()=>transitionHostInvocation(state,'i',1,'start')).toThrow('not_ready');transitionHostInvocation(state,'i',1,'confirm');
 expect(()=>transitionHostInvocation(state,'i',1,'start')).toThrow('revision_conflict');transitionHostInvocation(state,'i',2,'start');expect(()=>transitionHostInvocation(state,'i',3,'start')).toThrow('not_ready');
 const receipt={receiptId:'r',status:'succeeded' as const,resultJson:'{"effect":1}'};transitionHostInvocation(state,'i',3,'receipt',receipt);expect(transitionHostInvocation(state,'i',3,'receipt',receipt).revision).toBe(4);
 expect(()=>transitionHostInvocation(state,'i',4,'receipt',{...receipt,resultJson:'{"effect":2}'})).toThrow('receipt_conflict');expect(()=>transitionHostInvocation(state,'i',4,'confirm')).toThrow('terminal');
 expect(()=>recordHostInvocation(state,{...call(),actorId:'foreign'})).toThrow('invocation_conflict');
});
test('existing VM snapshot preserves host domain; recovery marks unsettled effects unknown without replay',()=>{
 const state=emptyHostInteractions();recordHostInvocation(state,call());const vm=createVM({controlActorKey:'Primary',actors:{},sessionState:{hostInteractions:state}});
 const snapshot=serializeVM(vm);expect(snapshot.sessionState?.hostInteractions?.invocations.i.state).toBe('awaiting_confirmation');
 const restored=hydrateVM(snapshot,{}).sessionState.hostInteractions!;recoverHostInteractions(restored);expect(restored.invocations.i.state).toBe('unknown');expect(snapshot.sessionState?.hostInteractions?.invocations.i.state).toBe('awaiting_confirmation');
 expect(()=>transitionHostInvocation(restored,'i',2,'start')).toThrow('not_ready');
});
test('context and registration have one scoped version owner; strict protocol rejects capabilities outside declaration',()=>{
 const state=emptyHostInteractions(),host={hostId:'h',actorId:'a',principalId:'p',origin:'http://localhost',revision:1,tools:[]};registerHost(state,host,0);
 expect(()=>registerHost(state,{...host,actorId:'other'},1)).toThrow('scope_mismatch');expect(()=>registerHost(state,host,0)).toThrow('revision_conflict');
 publishHostContext(state,'h',{version:1,observedAt:0,digestJson:'{"business":1}'});expect(()=>publishHostContext(state,'h',{version:1,observedAt:0,digestJson:'{"business":2}'})).toThrow('version_conflict');
 expect(()=>parseHostInteractionOperation({operation:'register',hostId:'h',origin:'http://localhost/path',expectedRevision:0,tools:[]})).toThrow('origin');
 expect(()=>parseCommandEnvelope({kind:'host_interaction',commandId:'c',surfaceId:'s',expectedEpoch:'e',payload:{actorId:'a',operationJson:'{"operation":"arbitrary_exec","hostId":"h"}'}})).toThrow('operationJson');
});
