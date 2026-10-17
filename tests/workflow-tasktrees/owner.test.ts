import {expect,test} from 'bun:test';
import {InMemoryTaskSpaceOwner} from 'task-manager-logic';
import {commandGlobalTaskSpace,type GlobalTaskSpaceRuntime} from '@cell/ai-runtime-host-logic';
import {admitWorkflowTaskTree} from '../../cell/packages/ai-runtime-host-logic/src/workflowTaskTreeAdmission';
import {parseWorkflowTaskTreeSpec,parseWorkflowTaskTreeProposal,workflowTaskTreeRecipientKey} from '../../cell/packages/ai-runtime-host-logic/src/workflowTaskTrees';

async function fixture(){
 const owner=Object.assign(new InMemoryTaskSpaceOwner(),{listTaskSpaceIds:async()=>[] as string[]});
 const runtime:GlobalTaskSpaceRuntime={owner,daemonScope:'isolated',serverInstanceId:'server',now:()=>Date.now(),newId:()=>crypto.randomUUID(),cursors:new Map(),check(){}};
 const request={requestId:'tree-admission',principal:{principalId:'owner',grantsVersion:'1'}};
 const recipient={kind:'holon' as const,ref:'resource://team',ownerScopeRef:'global',bindingRef:'binding://team',bindingDigest:'sha256:team',admissionRef:'admission-team'};
 const directory={ownerScopeRef:'global',registryRevision:'original',contacts:[{recipient,name:'Team',parentRefs:[],available:true}]};
 const created=await commandGlobalTaskSpace(runtime,request,{kind:'create',commandId:'space',expectedServerInstanceId:'server',name:'Original space'});
 const spec=parseWorkflowTaskTreeSpec({schemaVersion:'eidolon.workflow-tasktree/v1',taskSpaceId:created.taskSpaceId,name:'Explicit tree',mode:'all',limits:{maxTasks:4,maxDepth:3,maxPlannerCalls:1},aggregation:'last',resultSchema:{type:'object'}});
 const proposal=parseWorkflowTaskTreeProposal({schemaVersion:'eidolon.workflow-tasktree-proposal/v1',nodes:[{kind:'task',id:'leaf',parentId:null,name:'Work',recipientKey:workflowTaskTreeRecipientKey(recipient),text:'Original intent'}]},spec);
 const origin={daemonId:'daemon',workspaceKey:'workspace',workflowRef:'resource://flow',instanceId:'instance',runId:'run',nodeId:'node',invocationKey:'node#0',generation:0};
 return {runtime,request,created,recipient,input:{spec,proposal,origin,directory,expectedRevision:0}};
}
test('original owner CAS freezes one root and immutable admission receipt while retaining other roots',async()=>{
 const f=await fixture(),id=f.created.taskSpaceId;
 await commandGlobalTaskSpace(f.runtime,f.request,{kind:'add_root',commandId:'other',expectedServerInstanceId:'server',taskSpaceId:id,expectedRevision:0,root:{rootId:'other-root',name:'Other root',mode:'all',nodes:[{kind:'task',taskId:'other-leaf',parentTaskId:'other-root',name:'Other leaf',recipient:f.recipient,text:'Untouched'}]}});
 const before=await f.runtime.owner.readSnapshot(id),input={...f.input,expectedRevision:1};
 const admitted=await admitWorkflowTaskTree(f.runtime,f.request,input);
 expect(admitted.replayed).toBe(false);expect(admitted.revision).toBe(2);
 const after=(await f.runtime.owner.readSnapshot(id))!;
 // The original replan stamps all records; compare every ownership/business fact.
 const facts=(task:typeof after.tasks[number])=>{const {updatedAt,...facts}=task;return facts};
 expect(after.tasks.filter(t=>t.taskId.startsWith('other-')).map(facts)).toEqual(before!.tasks.map(facts));
 const root=after.tasks.find(t=>t.taskId===admitted.rootId)!;
 expect(root.definition.profile.facts.workflowTaskTree).toMatchObject({principalId:'owner',origin:f.input.origin,spec:f.input.spec});
 expect(after.tasks.find(t=>t.taskId!==admitted.rootId&&!t.taskId.startsWith('other-'))!.status).toBe('Ready');
 const replay=await admitWorkflowTaskTree({...f.runtime,serverInstanceId:'restarted'},f.request,input);
 expect(replay).toEqual({...admitted,replayed:true});expect((await f.runtime.owner.readSnapshot(id))!.revision).toBe(2);
 await expect(admitWorkflowTaskTree(f.runtime,f.request,{...input,spec:{...input.spec,name:'Changed'}})).rejects.toMatchObject({error:{code:'workflow_tasktree_identity_conflict'}});
 await expect(commandGlobalTaskSpace(f.runtime,f.request,{kind:'edit_root',commandId:'rewrite',expectedServerInstanceId:'server',taskSpaceId:id,expectedRevision:2,root:{rootId:admitted.rootId,name:'Rewrite',mode:'all',nodes:[]}})).rejects.toMatchObject({error:{code:'global_workflow_root_plan_frozen'}});
 await expect(commandGlobalTaskSpace(f.runtime,f.request,{kind:'execute',commandId:'double-execute',expectedServerInstanceId:'server',taskSpaceId:id,rootId:admitted.rootId,expectedRevision:2,expectedControlRevision:0})).rejects.toMatchObject({error:{code:'global_workflow_root_owned'}});
 const second=await admitWorkflowTaskTree(f.runtime,f.request,{...input,origin:{...input.origin,generation:1},expectedRevision:2});
 expect(second.rootId).not.toBe(admitted.rootId);expect((await f.runtime.owner.readSnapshot(id))!.tasks).toHaveLength(6);
});
test('foreign principal, stale CAS and conflicting concurrent proposals never admit a second copy',async()=>{
 const f=await fixture();
 await expect(admitWorkflowTaskTree(f.runtime,{...f.request,principal:{...f.request.principal,principalId:'foreign'}},f.input)).rejects.toMatchObject({status:404});
 await expect(admitWorkflowTaskTree(f.runtime,f.request,{...f.input,expectedRevision:99})).rejects.toMatchObject({error:{code:'workflow_tasktree_revision_conflict'}});
 expect((await f.runtime.owner.readSnapshot(f.created.taskSpaceId))!.tasks).toHaveLength(0);
 const results=await Promise.allSettled([admitWorkflowTaskTree(f.runtime,f.request,f.input),admitWorkflowTaskTree(f.runtime,f.request,f.input)]);
 expect(results.filter(result=>result.status==='fulfilled').length).toBeGreaterThanOrEqual(1);
 expect((await f.runtime.owner.readSnapshot(f.created.taskSpaceId))!.tasks).toHaveLength(2);
});
