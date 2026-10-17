import type {WorkflowValue} from './Workflow';

/** Explicit optional policy. It identifies an existing space; it never creates one. */
export type WorkflowTaskTreeSpec=Readonly<{
    schemaVersion:'eidolon.workflow-tasktree/v1';
    taskSpaceId:string;
    name:string;
    mode:'all'|'sequential';
    limits:Readonly<{maxTasks:number;maxDepth:number;maxPlannerCalls:number}>;
    aggregation:'last'|'by-task';
    resultSchema:WorkflowValue;
}>;
export type WorkflowTaskTreeOrigin=Readonly<{
    daemonId:string;workspaceKey:string;workflowRef:string;instanceId:string;
    runId:string;nodeId:string;invocationKey:string;generation:number;
}>;
/** Native worker protocol, deliberately absent from the HTTP Host operation allowlist. */
export type WorkflowTaskTreeRelayIntent=Readonly<{origin:WorkflowTaskTreeOrigin}&(
    {kind:'directory'|'observe'|'execute-result';taskSpaceId:string}|
    {kind:'resume-result';taskSpaceId:string;controlKey:string}|
    {kind:'resume';taskSpaceId:string;controlKey:string;expectedRevision:number;expectedControlRevision:number}|
    {kind:'admit';spec:WorkflowTaskTreeSpec;proposal:WorkflowTaskTreeProposal;expectedRevision:number}|
    {kind:'execute';taskSpaceId:string;expectedRevision:number;expectedControlRevision:number}
)>;
export type WorkflowTaskTreeTrustedContext=Readonly<{
    origin:WorkflowTaskTreeOrigin;
    executionWorkspace:Readonly<{workspaceKey:string;workspaceId:string;workDir:string}>;
}>;
export type WorkflowTaskTreeEffects=Readonly<{
    call(request:import('./HostPort').HostRequest,intent:WorkflowTaskTreeRelayIntent):Promise<unknown>;
}>;
export type WorkflowTaskTreeOwnerCall=(request:import('./HostPort').HostRequest,context:WorkflowTaskTreeTrustedContext,intent:WorkflowTaskTreeRelayIntent)=>Promise<unknown>;
export type WorkflowTaskTreeObservation=Readonly<{
    taskSpaceId:string;rootId:string;revision:number;controlRevision:number;
    state:'missing'|'ready'|'running'|'waiting'|'succeeded'|'failed'|'cancelled'|'unknown';
    spec?:WorkflowTaskTreeSpec;bindingId?:string;paused?:boolean;output?:WorkflowValue;
    settlements?:readonly Readonly<{taskId:string;receiptId:string;artifacts:readonly string[]}>[];
}>;
/** A proposal cannot contain status, claim, lease, binding or executor instructions. */
export type WorkflowTaskTreeProposal=Readonly<{
    schemaVersion:'eidolon.workflow-tasktree-proposal/v1';
    nodes:readonly Readonly<{id:string;parentId:string|null;name:string}&(
        {kind:'task-group';mode:'all'|'sequential'}|
        {kind:'task';recipientKey:string;text:string}
    )>[];
}>;
