import {expect,test} from 'bun:test';
import {mkdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {globalFixture,globalRequest as request} from '../global-taskspaces/fixture';
import {createWorkflowTaskTreeNodePort} from '../../cell/packages/ai-runtime-host-capsule/src/workflowTaskTreeNode';
import {WorkflowFactStore} from '../../cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowFactStore';
import type {WorkflowTaskTreeOwnerCall} from '@cell/ai-runtime-host-contract';

test('shared Native node component plans once, consumes original settled result and reopens without repeating planner or tools',async()=>{
 let owner!:WorkflowTaskTreeOwnerCall;const f=await globalFixture(undefined,false,{onTaskTreeOwner:call=>{owner=call}});
 try{
  const project=join(f.options.globalRoot!,'..','project');await mkdir(project);const cwd=await realpath(project);
  const created=await f.host.commandGlobalTaskSpace!(request,{kind:'create',commandId:'space',expectedServerInstanceId:f.host.capabilities(request).serverInstanceId,name:'Original space'});
  const identity={workflowRef:'resource://flow',instanceId:'instance',runId:'run',nodeId:'node',invocationKey:'node#0',generation:0},authority={daemonId:'controlled-fixture',workspaceKey:'project'};
  const root=join(f.options.globalRoot!,'..','workflow-facts'),facts=new WorkflowFactStore(root);
  const compose=(facts:WorkflowFactStore)=>createWorkflowTaskTreeNodePort({authority,facts,request:()=>request,interrupted:()=>false,pollMs:10,effects:{call(request,intent){return owner(request,{origin:intent.origin,executionWorkspace:{workspaceKey:'project',workspaceId:cwd,workDir:cwd}},intent)}}});
  const spec={schemaVersion:'eidolon.workflow-tasktree/v1',taskSpaceId:created.taskSpaceId,name:'Complex node',mode:'sequential',limits:{maxTasks:4,maxDepth:3,maxPlannerCalls:1},aggregation:'last',resultSchema:{type:'string'}};
  let plans=0;const plan=async(choices:unknown)=>{plans++;return {schemaVersion:'eidolon.workflow-tasktree-proposal/v1',nodes:[{kind:'task',id:'a',parentId:null,name:'Original work',recipientKey:(choices as {recipientKey:string}[])[0]!.recipientKey,text:'Execute once'}]}};
  const port=compose(facts),first=port.run(identity,spec,plan),second=port.run(identity,spec,plan);expect(second).toBe(first);
  expect(await first).toBe(JSON.stringify({value:'canonical-result-1'}));expect(plans).toBe(1);expect(f.calls).toBe(1);
  const reopened=compose(new WorkflowFactStore(root));expect(await reopened.run(identity,spec,plan)).toBe(await first);expect(plans).toBe(1);expect(f.calls).toBe(1);
  const next={...identity,generation:1};await facts.recordTaskTreeIntent({schemaVersion:'eidolon.workflow-tasktree-intent/v1',identity:next,specDigest:(await facts.readTaskTreeIntent(identity,'planner-requested'))!.specDigest,phase:'planner-requested',plannerCalls:1});
  await expect(reopened.run(next,spec,plan)).rejects.toThrow('planner_unknown');expect(plans).toBe(1);expect(f.calls).toBe(1);
 }finally{await f.cleanup()}
},30000);
