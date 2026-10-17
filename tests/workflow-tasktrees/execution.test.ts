import {expect,test} from 'bun:test';
import {mkdir,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {globalFixture,globalRequest as request} from '../global-taskspaces/fixture';
import {workflowTaskTreeRecipientKey} from '@cell/ai-runtime-host-logic';
import {openGlobalTaskSpaceOwner} from '@cell/ai-runtime-host-support';
import type {WorkflowTaskTreeOwnerCall} from '@cell/ai-runtime-host-contract';

test('explicit ALL tree executes original global Holon claims serially in a trusted project cwd without a public Session',async()=>{
 let ownerCall!:WorkflowTaskTreeOwnerCall,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve});
 const f=await globalFixture(call=>call===1?gate:Promise.resolve(),false,{onTaskTreeOwner:call=>{ownerCall=call}});
 try{
  const project=join(f.options.globalRoot!,'..','execution-project');await mkdir(project);const cwd=await realpath(project);
  const origin={daemonId:'controlled-fixture',workspaceKey:'project',workflowRef:'resource://flow',instanceId:'instance',runId:'run',nodeId:'node',invocationKey:'node#0',generation:0};
  const context={origin,executionWorkspace:{workspaceKey:'project',workspaceId:cwd,workDir:cwd}};
  const created=await f.host.commandGlobalTaskSpace!(request,{kind:'create',commandId:'space',expectedServerInstanceId:f.host.capabilities(request).serverInstanceId,name:'Original space'});
  const admitted=await ownerCall(request,context,{kind:'admit',origin,expectedRevision:0,spec:{schemaVersion:'eidolon.workflow-tasktree/v1',taskSpaceId:created.taskSpaceId,name:'Explicit ALL tree',mode:'all',limits:{maxTasks:4,maxDepth:2,maxPlannerCalls:1},aggregation:'last',resultSchema:{type:'string'}},proposal:{schemaVersion:'eidolon.workflow-tasktree-proposal/v1',nodes:['a','b'].map(id=>({kind:'task' as const,id,parentId:null,name:id,recipientKey:workflowTaskTreeRecipientKey(f.recipient),text:id}))}}) as {rootId:string};
  const execute={kind:'execute' as const,origin,taskSpaceId:created.taskSpaceId,expectedRevision:1,expectedControlRevision:0};
  await ownerCall(request,context,execute);
  const running=await f.until(created.taskSpaceId,v=>f.calls===1&&v.nodes.some(n=>n.kind==='task'&&n.status==='Running'));
  expect(running.nodes.filter(node=>node.kind==='task'&&node.status==='Running')).toHaveLength(1);expect(f.calls).toBe(1);
  await Bun.sleep(100);expect(f.calls).toBe(1);release();
  await f.until(created.taskSpaceId,v=>v.nodes.find(n=>n.taskId===admitted.rootId)?.status==='Succeeded');expect(f.calls).toBe(2);
  const snapshot=(await openGlobalTaskSpaceOwner(f.workDir).readSnapshot(created.taskSpaceId))!,root=snapshot.tasks.find(t=>t.taskId===admitted.rootId)!;
  const artifact=(await openGlobalTaskSpaceOwner(f.workDir).readArtifact(created.taskSpaceId,root.rootControl!.binding!.digest))!;
  expect(JSON.parse(Buffer.from(artifact.data,'base64').toString('utf8')).workflowTaskTree).toEqual(context);
  expect(snapshot.tasks.filter(t=>t.definition.kind==='task').every(t=>t.preparationReceiptId&&t.outputArtifacts.length)).toBe(true);
  expect(existsSync(join(cwd,'.eidolon','sessions'))).toBe(false);expect(existsSync(join(f.workDir,'.eidolon','sessions'))).toBe(false);
  const observed=await ownerCall(request,context,{kind:'observe',origin,taskSpaceId:created.taskSpaceId}) as any;
  expect(observed).toMatchObject({state:'succeeded',output:JSON.stringify({value:'canonical-result-2'})});expect(observed.settlements).toHaveLength(2);
  expect(await ownerCall(request,context,execute)).toMatchObject({replayed:true});expect(f.calls).toBe(2);
  const nextOrigin={...origin,generation:1},nextContext={...context,origin:nextOrigin},current=await f.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId});
  const bad=await ownerCall(request,nextContext,{kind:'admit',origin:nextOrigin,expectedRevision:current.revision,spec:{...observed.spec,resultSchema:{type:'integer'}},proposal:{schemaVersion:'eidolon.workflow-tasktree-proposal/v1',nodes:[{kind:'task',id:'bad-schema',parentId:null,name:'Bad schema',recipientKey:workflowTaskTreeRecipientKey(f.recipient),text:'Preserve original result'}]}}) as {rootId:string;revision:number};
  await ownerCall(request,nextContext,{kind:'execute',origin:nextOrigin,taskSpaceId:created.taskSpaceId,expectedRevision:bad.revision,expectedControlRevision:0});
  await f.until(created.taskSpaceId,v=>v.nodes.find(n=>n.taskId===bad.rootId)?.status==='Succeeded');
  await expect(ownerCall(request,nextContext,{kind:'observe',origin:nextOrigin,taskSpaceId:created.taskSpaceId})).rejects.toMatchObject({status:409,error:{code:'workflow_tasktree_result_schema_mismatch'}});
  expect((await f.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).nodes.find(n=>n.taskId===bad.rootId)?.status).toBe('Succeeded');expect(f.calls).toBe(3);
 }finally{release();await f.cleanup()}
},30000);
