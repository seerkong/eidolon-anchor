import type {HostAuthorizationEffects,HostResourceEffects,WorkflowTaskTreeOrigin,ResourceLease} from '@cell/ai-runtime-host-contract';
import {createWorkflowTaskTreeRelay,parseWorkflowTaskTreeOrigin,daemonFailure,type DaemonRuntime} from '@cell/ai-runtime-host-logic';

/** Global worker tool leases cross into a project only through the parent's registered identity and policy. */
export function createWorkflowTaskTreeResourceAdmission(options:Readonly<{
    runtime:DaemonRuntime;authorization:HostAuthorizationEffects;resources:HostResourceEffects;
}>){
    return async (raw:WorkflowTaskTreeOrigin,input:Omit<Parameters<HostResourceEffects['acquire']>[0],'workDir'>):Promise<ResourceLease>=>{
        const origin=parseWorkflowTaskTreeOrigin(raw),runtime=options.runtime;
        const request={requestId:runtime.effects.newId(),principal:{principalId:runtime.config.principalId,grantsVersion:runtime.config.grantsVersion}};
        if(options.authorization.currentGrantsVersion(request.principal.principalId)!==request.principal.grantsVersion||!options.authorization.permits(request.principal,{kind:'workflows',action:'resume',runId:origin.runId})||!options.authorization.permits(request.principal,{kind:'workflows',action:'read',runId:origin.runId}))return daemonFailure(403,'forbidden');
        const source=runtime.effects.registry.list().find(w=>w.workspaceKey===origin.workspaceKey),worker=runtime.workers.get(origin.workspaceKey);
        if(!source||!worker?.port.workflowRun||source.workspaceKey===runtime.globalWorkspaceKey)return daemonFailure(403,'workflow_tasktree_resource_source_unavailable');
        const view=await worker.port.workflowRun(request,{runId:origin.runId});
        const binding=view.taskTrees?.find(node=>node.nodeId===origin.nodeId&&node.generation===origin.generation&&node.invocationKey===origin.invocationKey&&node.admitted);
        if(view.workspaceId!==source.workspaceId||view.run.workflowRef!==origin.workflowRef||view.run.instanceId!==origin.instanceId||!binding)return daemonFailure(403,'workflow_tasktree_resource_origin_mismatch');
        let lease:ResourceLease|undefined;
        const relay=createWorkflowTaskTreeRelay({daemonId:runtime.effects.registry.daemonId,principalId:runtime.config.principalId,grantsVersion:runtime.config.grantsVersion,globalWorkspaceKey:runtime.globalWorkspaceKey,sourceWorkspace:source,authorization:options.authorization,
            currentWorkspace:key=>runtime.effects.registry.list().find(w=>w.workspaceKey===key),isSourceReady:()=>!runtime.closed&&runtime.states.get(source.workspaceKey)==='ready',canonicalDirectory:runtime.effects.canonicalDirectory,
            verifyWorkflowOrigin:async()=>true, // Exact original binding was read above; relay repeats identity/grants/directory checks around admission.
            async forward(_request,context){lease=await options.resources.acquire({...input,workDir:context.executionWorkspace.workDir});return lease},
        });
        try{return await relay(request,{kind:'execute',origin,taskSpaceId:binding.taskSpaceId,expectedRevision:0,expectedControlRevision:0}) as ResourceLease}
        catch(error){lease?.release();throw error}
    };
}
