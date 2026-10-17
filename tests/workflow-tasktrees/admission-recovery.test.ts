import {expect,test} from 'bun:test';
import {mkdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {globalFixture,globalRequest as request} from '../global-taskspaces/fixture';
import {createWorkflowTaskTreeNodePort} from '../../cell/packages/ai-runtime-host-capsule/src/workflowTaskTreeNode';
import {WorkflowFactStore} from '../../cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowFactStore';
import type {WorkflowTaskTreeOwnerCall} from '@cell/ai-runtime-host-contract';

test('lost admission response recovers the canonical ready root once; uncertain execution never resends',async()=>{
 let owner!:WorkflowTaskTreeOwnerCall;
 const f=await globalFixture(undefined,false,{onTaskTreeOwner:call=>{owner=call}});
 try{
  const project=join(f.options.globalRoot!,'..','project');await mkdir(project);const cwd=await realpath(project);
  const space=await f.host.commandGlobalTaskSpace!(request,{kind:'create',commandId:'space',expectedServerInstanceId:f.host.capabilities(request).serverInstanceId,name:'Lost admission'});
  const factsRoot=join(f.options.globalRoot!,'..','workflow-facts'),facts=new WorkflowFactStore(factsRoot);
  const identity={workflowRef:'resource://flow',instanceId:'instance',runId:'run',nodeId:'node',invocationKey:'node#0',generation:0},authority={daemonId:'controlled-fixture',workspaceKey:'project'};
  let dropAdmission=true,plans=0,executes=0;
  const compose=()=>createWorkflowTaskTreeNodePort({authority,facts:new WorkflowFactStore(factsRoot),request:()=>request,interrupted:()=>false,pollMs:20,effects:{async call(request,intent){
   if(intent.kind==='execute')executes++;
   const result=await owner(request,{origin:intent.origin,executionWorkspace:{workspaceKey:'project',workspaceId:cwd,workDir:cwd}},intent);
   if(intent.kind==='admit'&&dropAdmission){dropAdmission=false;throw Error('lost admission response')}
   return result;
  }}});
  const spec={schemaVersion:'eidolon.workflow-tasktree/v1',taskSpaceId:space.taskSpaceId,name:'Complex node',mode:'sequential',limits:{maxTasks:4,maxDepth:3,maxPlannerCalls:1},aggregation:'last',resultSchema:{type:'string'}};
  const plan=async(choices:unknown)=>{plans++;return {schemaVersion:'eidolon.workflow-tasktree-proposal/v1',nodes:[{kind:'task',id:'a',parentId:null,name:'Original work',recipientKey:(choices as {recipientKey:string}[])[0]!.recipientKey,text:'Execute once'}]}};
  await expect(compose().run(identity,spec,plan)).rejects.toThrow('lost admission response');
  expect((await f.host.globalTaskSpace!(request,{taskSpaceId:space.taskSpaceId})).rootCount).toBe(1);expect(executes).toBe(0);expect(plans).toBe(1);
  expect(await facts.readTaskTreeIntent(identity,'execute-requested')).toBeUndefined();
  const recovered=compose();await recovered.control!(identity,'explicit-check');
  expect(await recovered.run(identity,spec,plan)).toBe(JSON.stringify({value:'canonical-result-1'}));expect(plans).toBe(1);expect(executes).toBe(1);expect(f.calls).toBe(1);
  const next={...identity,generation:1};dropAdmission=true;
  await expect(compose().run(next,spec,plan)).rejects.toThrow('lost admission response');
  await facts.recordTaskTreeIntent({schemaVersion:'eidolon.workflow-tasktree-intent/v1',identity:next,phase:'execute-requested',plannerCalls:1,specDigest:(await facts.readTaskTreeIntent(next,'planner-completed'))!.specDigest});
  await expect(compose().control!(next,'uncertain-check')).rejects.toThrow('execution_unknown');
  expect(executes).toBe(1);expect(f.calls).toBe(1);expect(plans).toBe(2);
 }finally{await f.cleanup()}
},30000);
