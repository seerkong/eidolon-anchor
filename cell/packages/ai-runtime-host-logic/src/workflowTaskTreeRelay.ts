import type {HostRequest,HostAuthorizationEffects,WorkspaceRegistration,WorkflowTaskTreeOrigin,WorkflowTaskTreeRelayIntent,WorkflowTaskTreeTrustedContext} from '@cell/ai-runtime-host-contract';
import {HostProtocolFailure} from './commands';
import {parseWorkflowTaskTreeRelayIntent} from './workflowTaskTrees';

/** Parent owns registration, principal and policy closures; child input cannot replace them. */
export function createWorkflowTaskTreeRelay(options:Readonly<{
    daemonId:string;principalId:string;grantsVersion:string;globalWorkspaceKey:string;
    sourceWorkspace:WorkspaceRegistration;
    authorization:HostAuthorizationEffects;
    currentWorkspace(key:string):WorkspaceRegistration|undefined;
    isSourceReady():boolean;
    canonicalDirectory(path:string):Promise<string>;
    verifyWorkflowOrigin(request:HostRequest,origin:WorkflowTaskTreeOrigin):Promise<boolean>;
    forward(request:HostRequest,context:WorkflowTaskTreeTrustedContext,intent:WorkflowTaskTreeRelayIntent):Promise<unknown>;
}>){
    const source=Object.freeze({...options.sourceWorkspace});
    return async (request:HostRequest,raw:unknown)=>{
        const fail=(code:string,status=403):never=>{throw new HostProtocolFailure(status,{code,requestId:request.requestId,retryable:false})};
        const intent=parseWorkflowTaskTreeRelayIntent(raw),spaceId=intent.kind==='admit'?intent.spec.taskSpaceId:intent.taskSpaceId;
        const check=()=>{
            if(request.principal.principalId!==options.principalId||request.principal.grantsVersion!==options.grantsVersion||options.authorization.currentGrantsVersion(options.principalId)!==options.grantsVersion)fail('forbidden');
            if(!options.isSourceReady()||source.workspaceKey===options.globalWorkspaceKey)fail('workflow_tasktree_source_unavailable',409);
            const current=options.currentWorkspace(source.workspaceKey);
            if(!current||current.workspaceId!==source.workspaceId||current.workDir!==source.workDir||current.revision!==source.revision)fail('workflow_tasktree_workspace_changed',409);
            if(intent.origin.daemonId!==options.daemonId||intent.origin.workspaceKey!==source.workspaceKey)fail('workflow_tasktree_origin_mismatch');
            if(!options.authorization.permits(request.principal,{kind:'workflows',action:intent.kind==='admit'||intent.kind==='execute'||intent.kind==='resume'?'resume':'read',runId:intent.origin.runId})||
               !options.authorization.permits(request.principal,{kind:'global-taskspace',taskSpaceId:spaceId,action:intent.kind==='admit'?'edit':intent.kind==='execute'||intent.kind==='resume'?'execute':'read'}))fail('forbidden');
        };
        check();
        if(await options.canonicalDirectory(source.workDir)!==source.workspaceId)fail('workflow_tasktree_workspace_changed',409);
        if(!await options.verifyWorkflowOrigin(request,intent.origin))fail('workflow_tasktree_origin_unavailable',409);
        check();
        const context=Object.freeze({origin:intent.origin,executionWorkspace:Object.freeze({workspaceKey:source.workspaceKey,workspaceId:source.workspaceId,workDir:source.workDir})});
        const value=await options.forward(request,context,intent);
        try{check()}catch(error){
            if((intent.kind==='admit'||intent.kind==='execute'||intent.kind==='resume')&&error instanceof HostProtocolFailure)throw new HostProtocolFailure(error.status,{...error.error,state:'unknown'});
            throw error;
        }
        return value;
    };
}
