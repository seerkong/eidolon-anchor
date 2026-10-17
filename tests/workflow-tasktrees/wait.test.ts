import {expect,test} from 'bun:test';
import {mkdir,realpath,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {globalFixture,globalRequest as request} from '../global-taskspaces/fixture';
import {WorkflowFactStore} from '../../cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowFactStore';
import {createWorkflowTaskTreeNodePort} from '../../cell/packages/ai-runtime-host-capsule/src/workflowTaskTreeNode';
import type {WorkflowTaskTreeOwnerCall} from '@cell/ai-runtime-host-contract';

async function caseFixture(kind:true|'permission'){
 let owner!:WorkflowTaskTreeOwnerCall;const f=await globalFixture(undefined,kind,{onTaskTreeOwner:call=>{owner=call}});
 const project=join(f.options.globalRoot!,'..','project');await mkdir(project);const cwd=await realpath(project);if(kind==='permission')await writeFile(join(cwd,'secret.txt'),'owned fixture material');
 const created=await f.host.commandGlobalTaskSpace!(request,{kind:'create',commandId:'space',expectedServerInstanceId:f.host.capabilities(request).serverInstanceId,name:'TaskTree wait'});
 const identity={workflowRef:'resource://flow',instanceId:'instance',runId:'run',nodeId:'node',invocationKey:'node#0',generation:0};
 let interrupted=false,plans=0;
 const port=createWorkflowTaskTreeNodePort({authority:{daemonId:'controlled-fixture',workspaceKey:'project'},facts:new WorkflowFactStore(join(project,'facts')),request:()=>request,interrupted:()=>interrupted,pollMs:10,effects:{call(request,intent){return owner(request,{origin:intent.origin,executionWorkspace:{workspaceKey:'project',workspaceId:cwd,workDir:cwd}},intent)}}});
 const pending=port.run(identity,{schemaVersion:'eidolon.workflow-tasktree/v1',taskSpaceId:created.taskSpaceId,name:'Explicit wait',mode:'all',limits:{maxTasks:4,maxDepth:2,maxPlannerCalls:1},aggregation:'last',resultSchema:{type:'string'}},async(contacts:unknown)=>{plans++;return {schemaVersion:'eidolon.workflow-tasktree-proposal/v1',nodes:[{kind:'task',id:'leaf',parentId:null,name:'Original wait',recipientKey:(contacts as {recipientKey:string}[])[0]!.recipientKey,text:'Wait in original actor'}]}});
 void pending.catch(()=>{});
 return {f,pending,created,get plans(){return plans},async close(){interrupted=true;await pending.catch(()=>{});await f.cleanup()}};
}
test('original task domain questionnaire blocks the outer result until an exact owner answer settles the root',async()=>{
 const c=await caseFixture(true);let completed=false;void c.pending.then(()=>{completed=true},()=>{});
 try{
  const view=await c.f.until(c.created.taskSpaceId,v=>v.nodes.some(n=>n.waits?.some(w=>w.kind==='domain_question'))),leaf=view.nodes.find(n=>n.waits?.length)!,root=view.nodes.find(n=>n.parentTaskId===null)!,wait=leaf.waits![0]!;
  expect(wait).toMatchObject({kind:'domain_question',canAnswer:true});expect(completed).toBe(false);expect(c.plans).toBe(1);expect(c.f.calls).toBe(1);
  await c.f.host.commandGlobalTaskSpace!(request,{kind:'answer',commandId:'answer',expectedServerInstanceId:c.f.host.capabilities(request).serverInstanceId,taskSpaceId:c.created.taskSpaceId,rootId:root.taskId,taskId:leaf.taskId,waitRef:wait.sourceRef,responseText:'Q1: accepted original domain response',expectedRevision:view.revision,expectedControlRevision:root.controlRevision!});
  await c.f.until(c.created.taskSpaceId,v=>v.nodes.find(node=>node.taskId===root.taskId)?.status==='Succeeded');
  expect(await c.pending).toBe(JSON.stringify({value:'canonical-result-2'}));expect(c.f.calls).toBe(2);expect(c.plans).toBe(1);
 }finally{await c.close()}
},30000);
test('original backend approval stays unavailable to domain answers and does not admit an outer result',async()=>{
 const c=await caseFixture('permission');let completed=false;void c.pending.then(()=>{completed=true},()=>{});
 try{
  const view=await c.f.until(c.created.taskSpaceId,v=>v.nodes.some(n=>n.waits?.some(w=>w.kind==='backend_approval'))),leaf=view.nodes.find(n=>n.waits?.length)!,root=view.nodes.find(n=>n.parentTaskId===null)!,wait=leaf.waits![0]!;
  expect(wait).toMatchObject({kind:'backend_approval',canAnswer:false});expect(completed).toBe(false);
  await expect(c.f.host.commandGlobalTaskSpace!(request,{kind:'answer',commandId:'fake-approve',expectedServerInstanceId:c.f.host.capabilities(request).serverInstanceId,taskSpaceId:c.created.taskSpaceId,rootId:root.taskId,taskId:leaf.taskId,waitRef:wait.sourceRef,responseText:'approve',expectedRevision:view.revision,expectedControlRevision:root.controlRevision!})).rejects.toMatchObject({status:409,error:{code:'global_question_not_pending'}});
  expect(c.f.calls).toBe(1);expect(c.plans).toBe(1);expect(completed).toBe(false);
 }finally{await c.close()}
},30000);
