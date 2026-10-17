import type {WorkflowTaskTreeNodeIdentity,WorkflowTaskTreeNodePort} from '@cell/ai-organ-contract/workflow/WorkflowTaskTree';

/** Both original flow drivers use one capability binder; constructing a runtime creates no task facts. */
export function bindWorkflowTaskTreeNodeRuntime<Runtime extends object>(runtime:Runtime,identity:WorkflowTaskTreeNodeIdentity,port?:WorkflowTaskTreeNodePort):Runtime{
    if(!port)return runtime;
    const owner=Object.freeze({...identity});
    return Object.freeze({...runtime,taskTrees:Object.freeze({
        run(spec:unknown,plan:(participants:unknown)=>Promise<unknown>){
            if(typeof plan!=='function')throw new Error('workflow_tasktree_planner_required');
            return port.run(owner,spec,plan);
        },
    })});
}
