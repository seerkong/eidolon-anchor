import {expect,test} from 'bun:test';
import {bindWorkflowTaskTreeNodeRuntime} from '../../cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowTaskTreeNodeRuntime';
const identity={workflowRef:'resource://flow',instanceId:'instance',runId:'run',nodeId:'node',invocationKey:'node#0',generation:0};
test('shared binder freezes original identity and creates no tasks until the explicit authored call',async()=>{
 let calls=0,seen:unknown;const runtime={ai:{original:true}},port={async run(owner:typeof identity,spec:unknown,plan:(participants:unknown)=>Promise<unknown>){calls++;seen=owner;return plan({originalDirectory:true})}};
 expect(bindWorkflowTaskTreeNodeRuntime(runtime,identity)).toBe(runtime);
 const mutable={...identity},bound=bindWorkflowTaskTreeNodeRuntime(runtime,mutable,port) as typeof runtime&{taskTrees:{run:Function}};
 expect(calls).toBe(0);expect(bound.ai).toBe(runtime.ai);mutable.generation=99;
 expect(await bound.taskTrees.run({explicit:true},async(directory:unknown)=>directory)).toEqual({originalDirectory:true});expect(calls).toBe(1);expect(seen).toEqual(identity);expect(Object.isFrozen(seen)).toBe(true);
});
