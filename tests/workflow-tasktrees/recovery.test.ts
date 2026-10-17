import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkflowFactStore} from '../../cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowFactStore';
const identity={workflowRef:'resource://flow',instanceId:'instance',runId:'run',nodeId:'node',invocationKey:'node#0',generation:0};
test('original workflow fact owner durably admits one immutable planner intent and keeps completed proposal across reopening',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-tasktree-intents-'));
 try{
  let store=new WorkflowFactStore(root);
  const fact={schemaVersion:'eidolon.workflow-tasktree-intent/v1' as const,identity,specDigest:'sha256:spec',phase:'planner-requested' as const,plannerCalls:1 as const};
  const concurrent=await Promise.all([store.recordTaskTreeIntent(fact),store.recordTaskTreeIntent(fact)]);expect(concurrent.filter(Boolean)).toHaveLength(1);
  store=new WorkflowFactStore(root);expect(await store.readTaskTreeIntent(identity,'planner-requested')).toEqual(fact);
  expect(await store.readTaskTreeIntent(identity,'planner-completed')).toBeUndefined();
  const completed={...fact,phase:'planner-completed' as const,proposal:{nodes:[{id:'original'}]}};
  expect(await store.recordTaskTreeIntent(completed)).toBe(true);
  store=new WorkflowFactStore(root);expect(await store.recordTaskTreeIntent(completed)).toBe(false);expect(await store.readTaskTreeIntent(identity,'planner-completed')).toEqual(completed);
  await expect(store.recordTaskTreeIntent({...completed,proposal:{nodes:[{id:'replacement'}]}})).rejects.toThrow('identity_conflict');
  expect(await store.readTaskTreeIntent({...identity,generation:1},'planner-requested')).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true})}
});
