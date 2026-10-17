import type {HostRequest,HostParticipantDirectory,WorkflowTaskTreeOrigin,WorkflowTaskTreeSpec,WorkflowTaskTreeProposal} from '@cell/ai-runtime-host-contract';
import {canonicalOwnDataDigest} from 'task-manager-contract';
import {replanTask,TaskManagerError} from 'task-manager-logic';
import {HostProtocolFailure} from './commands';
import {readOwnedGlobalTaskSpace,proposeGlobalTaskRoot,type GlobalTaskSpaceRuntime} from './globalTaskSpaces';
import {parseWorkflowTaskTreeSpec,parseWorkflowTaskTreeProposal,parseWorkflowTaskTreeOrigin,compileWorkflowTaskTreeProposal} from './workflowTaskTrees';

/** Internal Native admission. The parent supplies origin after authorizing the registered workspace. */
export async function admitWorkflowTaskTree(runtime:GlobalTaskSpaceRuntime,request:HostRequest,input:Readonly<{
    spec:WorkflowTaskTreeSpec;proposal:WorkflowTaskTreeProposal;origin:WorkflowTaskTreeOrigin;
    directory:HostParticipantDirectory;expectedRevision:number;
}>){
    const spec=parseWorkflowTaskTreeSpec(input.spec),proposal=parseWorkflowTaskTreeProposal(input.proposal,spec),origin=parseWorkflowTaskTreeOrigin(input.origin);
    const plan=compileWorkflowTaskTreeProposal(spec,proposal,origin,input.directory);
    const proof={kind:'eidolon.workflow-tasktree-binding' as const,schemaVersion:1,principalId:request.principal.principalId,origin,spec,proposalDigest:canonicalOwnDataDigest(proposal)};
    const intentDigest=canonicalOwnDataDigest(proof),commandId=`workflow-tree-admit-${canonicalOwnDataDigest([spec.taskSpaceId,proof.principalId,origin]).slice(7)}`;
    const failure=(code:string,status=409):never=>{throw new HostProtocolFailure(status,{code,requestId:request.requestId,retryable:false})};
    runtime.check(request,'edit',spec.taskSpaceId);
    const snapshot=await readOwnedGlobalTaskSpace(runtime,request,spec.taskSpaceId);
    const prior=await runtime.owner.readReceiptByCommand(spec.taskSpaceId,commandId);
    if(prior){
        if(prior.intentDigest!==intentDigest)failure('workflow_tasktree_identity_conflict');
        runtime.check(request,'edit',spec.taskSpaceId);
        return {taskSpaceId:spec.taskSpaceId,rootId:plan.rootId,receiptId:prior.receiptId,revision:prior.toRevision,replayed:true};
    }
    const next=proposeGlobalTaskRoot(snapshot,request,plan,false);
    // Freeze provenance inside the canonical definition, in the same CAS as the root admission.
    const tasks=next.tasks.map(task=>task.taskId===plan.rootId?{...task,profile:{...task.profile,facts:{...task.profile.facts,workflowTaskTree:proof}}}:task);
    runtime.check(request,'edit',spec.taskSpaceId);
    try{
        const accepted=await replanTask(runtime,{kind:'task.replan',commandId,intentDigest,taskSpaceId:spec.taskSpaceId,expectedRevision:input.expectedRevision,replannedAt:new Date(runtime.now()).toISOString(),plan:{kind:'task-plan',planId:commandId,reason:'Explicit workflow TaskTree proposal',tasks,relations:next.relations}}, {maxTasks:1024,maxRelations:4096,maxLeaseDurationMs:86400000});
        try{runtime.check(request,'edit',spec.taskSpaceId)}catch{throw new HostProtocolFailure(409,{code:'workflow_tasktree_admission_unknown',requestId:request.requestId,retryable:false,state:'unknown'})}
        return {taskSpaceId:spec.taskSpaceId,rootId:plan.rootId,receiptId:accepted.receipt.receiptId,revision:accepted.receipt.toRevision,replayed:accepted.replayed};
    }catch(error){
        if(error instanceof TaskManagerError)failure(`workflow_tasktree_${error.code.replace(/-/g,'_')}`);
        throw error;
    }
}
