import {expect,test} from 'bun:test';
import {mkdir,realpath,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {globalFixture,globalRequest as request} from '../global-taskspaces/fixture';
import {seedTaskTreeFlowResources} from './fixtures/resources';
import {createHost} from '../../cell/packages/ai-runtime-host-capsule/src/host';
import {createWorkflowTaskTreeRelay} from '@cell/ai-runtime-host-logic';
import type {WorkflowTaskTreeOwnerCall} from '@cell/ai-runtime-host-contract';

test('both original wait protocols retain a paused root across Host restart and explicitly continue only unstarted work',async()=>{
 let owner!:WorkflowTaskTreeOwnerCall;const releases=new Map<number,()=>void>(),gates=new Map<number,Promise<void>>();
 for(const call of [1,3])gates.set(call,new Promise(resolve=>releases.set(call,resolve)));
 const f=await globalFixture(call=>gates.get(call)??Promise.resolve(),false,{onTaskTreeOwner:call=>{owner=call}});
 let projectHost:Awaited<ReturnType<typeof createHost>>|undefined;
 try{
  const project=join(f.options.globalRoot!,'..','recover-project');await mkdir(project);const cwd=await realpath(project);await seedTaskTreeFlowResources(cwd,{tasks:2});
  const source={workspaceKey:'project',workspaceId:cwd,workDir:cwd,revision:1,placement:'workspace' as const};
  const relay=createWorkflowTaskTreeRelay({daemonId:'controlled-fixture',principalId:'owner',grantsVersion:'1',globalWorkspaceKey:'global',sourceWorkspace:source,currentWorkspace:()=>source,isSourceReady:()=>Boolean(projectHost),canonicalDirectory:realpath,authorization:f.options.authorization!,
   async verifyWorkflowOrigin(request,origin){const view=await projectHost!.workflowRun!(request,{runId:origin.runId});return view.run.instanceId===origin.instanceId&&view.run.workflowRef===origin.workflowRef&&Boolean(view.taskTrees?.some(link=>link.nodeId===origin.nodeId&&link.invocationKey===origin.invocationKey&&link.generation===origin.generation))},forward:(...args)=>owner(...args)});
  const options={workDir:cwd,globalRoot:f.options.globalRoot,authorization:f.options.authorization!,runtimeConfig:f.options.runtimeConfig,taskTreeAuthority:{daemonId:'controlled-fixture',workspaceKey:'project'},taskTreeEffects:{call:relay}};
  projectHost=await createHost(options);
  const created=await f.host.commandGlobalTaskSpace!(request,{kind:'create',commandId:'space',expectedServerInstanceId:f.host.capabilities(request).serverInstanceId,name:'Multi-root recovery'});
  for(const [index,fqn] of ['eidolon.fixture.TaskTreeCtrl','eidolon.fixture.TaskTreeData'].entries()){
   // Refresh the original authored fixture before freezing this run; later mutation must not change its admitted source.
   if(index){await projectHost.close();projectHost=undefined;await seedTaskTreeFlowResources(cwd,{tasks:2});projectHost=await createHost(options)}
   const definition=(await projectHost.workflowDefinitions!(request)).definitions.find(d=>d.fqn===fqn)!;
   const input=definition.form==='AIDataWorkflow'?{value:{taskSpaceId:created.taskSpaceId}}:{taskSpaceId:created.taskSpaceId};
   const receipt=await projectHost.commandWorkflow!(request,{kind:'start',commandId:fqn,expectedServerInstanceId:projectHost.capabilities(request).serverInstanceId,workflowRef:definition.workflowRef,definitionRevision:definition.revision,input,source:{kind:'independent',channelId:'workflow-center',label:'Workflow center'},confirmed:true});
   let native;try{native=await f.until(created.taskSpaceId,v=>v.nodes.some(n=>n.kind==='task'&&n.status==='Running')&&v.nodes.some(n=>n.workflow?.runId===receipt.runId))}catch(error){throw new Error(JSON.stringify({error:String(error),view:await projectHost.workflowRun!(request,{runId:receipt.runId!}),events:await projectHost.workflowEvents!(request,{runId:receipt.runId!})}))}
   const root=native.nodes.find(n=>n.parentTaskId===null&&n.workflow?.runId===receipt.runId)!;
   await f.host.commandGlobalTaskSpace!(request,{kind:'pause',commandId:`pause-${index}`,expectedServerInstanceId:f.host.capabilities(request).serverInstanceId,taskSpaceId:created.taskSpaceId,rootId:root.taskId,expectedRevision:native.revision,expectedControlRevision:root.controlRevision!});
   releases.get(index*2+1)!();
   const paused=await f.until(created.taskSpaceId,v=>v.nodes.some(n=>n.parentTaskId===root.taskId&&n.status==='Succeeded')&&!v.nodes.some(n=>n.parentTaskId===root.taskId&&n.status==='Running'));
   expect(paused.nodes.filter(n=>n.parentTaskId===root.taskId&&n.status==='Ready')).toHaveLength(1);
   const wait=await projectHost.workflowRun!(request,{runId:receipt.runId!});expect(wait.run.status).toBe('Waiting');expect(wait.run.terminal).toBe(false);expect(f.calls).toBe(index*2+1);
   if(index===0){const handle=wait.waits[0]!;await expect(projectHost.commandWorkflow!(request,{kind:'resume_ctrl',commandId:'fake-payload',expectedServerInstanceId:projectHost.capabilities(request).serverInstanceId,expectedGeneration:wait.run.generation,runId:receipt.runId!,signalKind:handle.signalKind,signalKey:handle.signalKey,resumeToken:handle.resumeToken,outcome:'Success',payload:'fake result',confirmed:true})).rejects.toMatchObject({error:{code:'workflow_tasktree_result_required'}})}
   else expect(wait.dataResumes.find(row=>row.nodeId==='tree')).toMatchObject({canResume:false,unavailableReason:'workflow_tasktree_result_required'});
   for(const kind of ['Workflows','Data'])await writeFile(join(cwd,'.eidolon','resources',kind,'flow-code','tree.ts'),'export function tree(){throw new Error("live source must not replace frozen code")}; export const dataTree=tree;');
   await projectHost.close();projectHost=undefined;await f.restart();projectHost=await createHost(options);
   const restored=await projectHost.workflowRun!(request,{runId:receipt.runId!});expect(restored.run.status).toBe('Waiting');expect(restored.taskTrees![0]!.rootId).toBe(root.taskId);expect(f.calls).toBe(index*2+1);
   const link=restored.taskTrees![0]!,command={kind:'resume_tasktree' as const,commandId:`continue-${index}`,expectedServerInstanceId:projectHost.capabilities(request).serverInstanceId,expectedGeneration:restored.run.generation,runId:receipt.runId!,nodeId:link.nodeId,invocationKey:link.invocationKey,confirmed:true as const};
   const accepted=await projectHost.commandWorkflow!(request,command);expect(accepted.state).toBe('completed');
   const deadline=Date.now()+15000;let after=await projectHost.workflowRun!(request,{runId:receipt.runId!});
   while(!after.run.terminal){if(Date.now()>deadline)throw new Error(JSON.stringify({after,events:await projectHost.workflowEvents!(request,{runId:receipt.runId!})}));await Bun.sleep(20);after=await projectHost.workflowRun!(request,{runId:receipt.runId!})}
   expect(after.run.status).toBe(index?'Succeeded':'Completed');expect(f.calls).toBe(index*2+2);
   expect(await projectHost.commandWorkflow!(request,command)).toEqual({...accepted,replayed:true});expect(f.calls).toBe(index*2+2);
  }
 }finally{for(const release of releases.values())release();await projectHost?.close();await f.cleanup()}
},90000);
