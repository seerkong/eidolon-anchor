import {expect,test} from 'bun:test';
import {mkdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {globalFixture,globalRequest as request} from '../global-taskspaces/fixture';
import {seedTaskTreeFlowResources} from './fixtures/resources';
import {createHost} from '../../cell/packages/ai-runtime-host-capsule/src/host';
import type {WorkflowTaskTreeOwnerCall} from '@cell/ai-runtime-host-contract';

test('bad root schema preserves original successful tasks but never admits either original flow successor or synthetic manual output',async()=>{
 let owner!:WorkflowTaskTreeOwnerCall;const f=await globalFixture(undefined,false,{onTaskTreeOwner:call=>{owner=call}});let host:Awaited<ReturnType<typeof createHost>>|undefined;
 try{
  const project=join(f.options.globalRoot!,'..','schema-project');await mkdir(project);const cwd=await realpath(project);await seedTaskTreeFlowResources(cwd,{resultType:'integer'});
  host=await createHost({workDir:cwd,globalRoot:f.options.globalRoot,runtimeConfig:f.options.runtimeConfig,authorization:f.options.authorization!,taskTreeAuthority:{daemonId:'controlled-fixture',workspaceKey:'project'},taskTreeEffects:{call:(request,intent)=>owner(request,{origin:intent.origin,executionWorkspace:{workspaceKey:'project',workspaceId:cwd,workDir:cwd}},intent)}});
  const created=await f.host.commandGlobalTaskSpace!(request,{kind:'create',commandId:'space',expectedServerInstanceId:f.host.capabilities(request).serverInstanceId,name:'Schema proof'});
  for(const [index,fqn] of ['eidolon.fixture.TaskTreeCtrl','eidolon.fixture.TaskTreeData'].entries()){
   const definition=(await host.workflowDefinitions!(request)).definitions.find(d=>d.fqn===fqn)!,input=index?{value:{taskSpaceId:created.taskSpaceId}}:{taskSpaceId:created.taskSpaceId};
   const receipt=await host.commandWorkflow!(request,{kind:'start',commandId:fqn,expectedServerInstanceId:host.capabilities(request).serverInstanceId,workflowRef:definition.workflowRef,definitionRevision:definition.revision,input,source:{kind:'independent',channelId:'workflow-center',label:'Workflow center'},confirmed:true});
   await f.until(created.taskSpaceId,v=>v.rootCount===index+1&&v.nodes.filter(n=>n.parentTaskId===null).every(n=>n.status==='Succeeded'));
   const deadline=Date.now()+5000;while(!(await host.workflowEvents!(request,{runId:receipt.runId!})).entries.some(event=>event.kind==='workflow.tasktree.wait-paused')){if(Date.now()>deadline)throw new Error('schema rejection observation missing');await Bun.sleep(10)}
   const view=await host.workflowRun!(request,{runId:receipt.runId!});expect(view.run).toMatchObject({terminal:false,status:'Waiting'});expect(view.nodes.some(n=>(n.nodeId==='done'||n.nodeId==='return')&&['Succeeded','Success'].includes(n.status))).toBe(false);
   const link=view.taskTrees![0]!;expect(link.admitted).toBe(true);
   const resume={kind:'resume_tasktree' as const,commandId:`bad-resume-${index}`,expectedServerInstanceId:host.capabilities(request).serverInstanceId,runId:receipt.runId!,expectedGeneration:view.run.generation,nodeId:link.nodeId,invocationKey:link.invocationKey,confirmed:true as const};
   expect((await host.commandWorkflow!(request,resume)).state).toBe('unknown');expect((await host.workflowRun!(request,{runId:receipt.runId!})).run.terminal).toBe(false);expect(f.calls).toBe(index+1);
  }
 }finally{await host?.close();await f.cleanup()}
},45000);
