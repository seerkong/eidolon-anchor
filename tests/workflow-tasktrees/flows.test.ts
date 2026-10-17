import {expect,test} from 'bun:test';
import {mkdir,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {globalFixture,globalRequest as request} from '../global-taskspaces/fixture';
import {seedWorkflowResources} from '../workflow-workbench/fixtures/runtime';
import {createHost} from '../../cell/packages/ai-runtime-host-capsule/src/host';
import {createWorkflowTaskTreeRelay} from '@cell/ai-runtime-host-logic';
import type {WorkflowTaskTreeOwnerCall} from '@cell/ai-runtime-host-contract';

test('original ctrl and data code nodes share the optional component and trusted parent while simple nodes create no roots',async()=>{
 let owner!:WorkflowTaskTreeOwnerCall;const f=await globalFixture(undefined,false,{onTaskTreeOwner:call=>{owner=call}});
 let projectHost:Awaited<ReturnType<typeof createHost>>|undefined;
 try{
  const project=join(f.options.globalRoot!,'..','workflow-project');await mkdir(project);const cwd=await realpath(project);await seedWorkflowResources(cwd);
  const resources=join(cwd,'.eidolon','resources');
  const code=`export async function tree(runtime:any,input:any){
 const taskSpaceId=input.taskSpaceId;
 return runtime.taskTrees.run({schemaVersion:'eidolon.workflow-tasktree/v1',taskSpaceId,name:'Explicit complex node',mode:'all',limits:{maxTasks:4,maxDepth:3,maxPlannerCalls:1},aggregation:'last',resultSchema:{type:'string'}},async(contacts:any)=>({schemaVersion:'eidolon.workflow-tasktree-proposal/v1',nodes:[{kind:'task',id:'leaf',parentId:null,name:'Original Holon work',recipientKey:contacts[0].recipientKey,text:'Small original task'}]}));
}
export async function dataTree(runtime:any,inputs:any){return {value:await tree(runtime,inputs.value)}}`;
  await writeFile(join(resources,'Workflows','flow-code','tree.ts'),code);await writeFile(join(resources,'Data','flow-code','tree.ts'),code);
  await writeFile(join(resources,'Workflows','TaskTree.xnl'),`<AICtrlWorkflow #eidolon.fixture.TaskTreeCtrl envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.fixture.TaskTreeCtrl>) [
 <ExternalJob #tree {src="vfs://./flow-code/tree.ts#tree" config={taskTree=true}}>
 <Return #done {src="vfs://./flow-code/index.ts#identity"}>
]>`);
  await writeFile(join(resources,'Data','TaskTree.xnl'),`<AIDataWorkflow #eidolon.fixture.TaskTreeData envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.fixture.TaskTreeData {inputPorts=["value"] outputPorts=["value"]}>) [
 <EntryNode #entry>
 <TransformNode #tree {inputs={value="flow-port://#entry/value"} outputs=["value"] src="vfs://./flow-code/tree.ts#dataTree" config={node_type="manual" taskTree=true}}>
 <ReturnNode #return {inputs={value="flow-port://#tree/value"}}>
]>`);
  const source={workspaceKey:'project',workspaceId:cwd,workDir:cwd,revision:1,placement:'workspace' as const};
  const relay=createWorkflowTaskTreeRelay({daemonId:'controlled-fixture',principalId:'owner',grantsVersion:'1',globalWorkspaceKey:'global',sourceWorkspace:source,currentWorkspace:()=>source,isSourceReady:()=>Boolean(projectHost),canonicalDirectory:realpath,authorization:f.options.authorization!,
   async verifyWorkflowOrigin(request,origin){const view=await projectHost!.workflowRun!(request,{runId:origin.runId});return view.workspaceId===cwd&&view.run.workflowRef===origin.workflowRef&&view.run.instanceId===origin.instanceId&&Boolean(view.taskTrees?.some(node=>node.nodeId===origin.nodeId&&node.generation===origin.generation&&node.invocationKey===origin.invocationKey))&&((view.nodes.find(node=>node.nodeId===origin.nodeId)?.generation??view.run.generation)===origin.generation)},forward:owner});
  projectHost=await createHost({workDir:cwd,globalRoot:f.options.globalRoot,authorization:f.options.authorization!,runtimeConfig:f.options.runtimeConfig,taskTreeAuthority:{daemonId:'controlled-fixture',workspaceKey:'project'},taskTreeEffects:{call:relay}});
  const created=await f.host.commandGlobalTaskSpace!(request,{kind:'create',commandId:'space',expectedServerInstanceId:f.host.capabilities(request).serverInstanceId,name:'Shared original global space'});
  const definitions=(await projectHost.workflowDefinitions!(request)).definitions;
  for(const [index,fqn] of ['eidolon.fixture.SummaryWorkflow','eidolon.fixture.TaskTreeCtrl','eidolon.fixture.TaskTreeData'].entries()){
   const definition=definitions.find(d=>d.fqn===fqn)!,input=definition.form==='AIDataWorkflow'?{value:{taskSpaceId:created.taskSpaceId}}:{taskSpaceId:created.taskSpaceId};
   const result=await projectHost.commandWorkflow!(request,{kind:'start',commandId:fqn,expectedServerInstanceId:projectHost.capabilities(request).serverInstanceId,workflowRef:definition.workflowRef,definitionRevision:definition.revision,input,source:{kind:'independent',channelId:'workflow-center',label:'Workflow center'},confirmed:true});
   const deadline=Date.now()+15000;let view=await projectHost.workflowRun!(request,{runId:result.runId!});
   while(!view.run.terminal){if(Date.now()>deadline)throw new Error(JSON.stringify(view));await Bun.sleep(20);view=await projectHost.workflowRun!(request,{runId:result.runId!})}
   if(view.run.status!=='Completed'&&view.run.status!=='Succeeded')throw new Error(JSON.stringify({view,events:await projectHost.workflowEvents!(request,{runId:result.runId!,limit:100})}));
   expect(view.run.terminal).toBe(true);expect((await f.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).rootCount).toBe(index);
  }
  expect(f.calls).toBe(2);expect((await projectHost.sessions(request,{})).sessions).toEqual([]);expect((await f.host.sessions(request,{})).sessions).toEqual([]);
 }finally{await projectHost?.close();await f.cleanup()}
},45000);
