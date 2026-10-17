/** Original controller identity, bound by Native; authored code cannot choose its execution owner. */
export type WorkflowTaskTreeNodeIdentity=Readonly<{
    workflowRef:string;instanceId:string;runId:string;nodeId:string;invocationKey:string;generation:number;
}>;
/** Optional authored capability. The Native implementation validates closed Spec/proposal/result DTOs. */
export type WorkflowTaskTreeNodePort=Readonly<{
    run(identity:WorkflowTaskTreeNodeIdentity,spec:unknown,plan:(participants:unknown)=>Promise<unknown>):Promise<unknown>;
    control?(identity:WorkflowTaskTreeNodeIdentity,controlKey:string):Promise<void>;
}>;
/** Intent facts only. Task statuses and settlement remain in the original global owner. */
export type WorkflowTaskTreeIntentFact=Readonly<{
    schemaVersion:'eidolon.workflow-tasktree-intent/v1';
    identity:WorkflowTaskTreeNodeIdentity;specDigest:string;
    phase:'node-bound'|'root-admitted'|'planner-requested'|'planner-completed'|'execute-requested'|'control-requested';
    plannerCalls:0|1;proposal?:unknown;taskSpaceId?:string;rootId?:string;
}>;
