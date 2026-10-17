import {parseWorkflowValue,type HostRequest,type WorkflowTaskTreeOrigin,type WorkflowTaskTreeObservation} from '@cell/ai-runtime-host-contract';
import {canonicalOwnDataDigest,sha256Hex} from 'task-manager-contract';
import {taskRoot} from 'task-manager-logic';
import {HostProtocolFailure} from './commands';
import {readOwnedGlobalTaskSpace,type GlobalTaskSpaceRuntime} from './globalTaskSpaces';
import {workflowTaskTreeRootId,parseWorkflowTaskTreeSpec} from './workflowTaskTrees';

/** Derived only from canonical definition, claims, settlement receipts and content-addressed artifacts. */
export async function observeWorkflowTaskTree(runtime:GlobalTaskSpaceRuntime,request:HostRequest,input:{taskSpaceId:string;origin:WorkflowTaskTreeOrigin}):Promise<WorkflowTaskTreeObservation>{
    const snapshot=await readOwnedGlobalTaskSpace(runtime,request,input.taskSpaceId),rootId=workflowTaskTreeRootId(input.origin),root=snapshot.tasks.find(task=>task.taskId===rootId);
    const base={taskSpaceId:input.taskSpaceId,rootId,revision:snapshot.revision,controlRevision:root?.rootControl?.revision??0};
    if(!root)return {...base,state:'missing'};
    const fail=(code:string):never=>{throw new HostProtocolFailure(409,{code,requestId:request.requestId,retryable:false})};
    const proof=root.definition.profile.facts.workflowTaskTree as {origin?:unknown;spec?:unknown;principalId?:unknown}|undefined;
    if(!proof||proof.principalId!==request.principal.principalId||!proof.origin||canonicalOwnDataDigest(proof.origin)!==canonicalOwnDataDigest(input.origin))return fail('workflow_tasktree_origin_mismatch');
    const spec=parseWorkflowTaskTreeSpec(proof.spec),binding=root.rootControl?.binding;
    const view={...base,spec,paused:root.rootControl?.paused??true,...(binding?{bindingId:binding.bindingId}:{})};
    if(root.status==='Failed'||root.status==='Cancelled')return {...view,state:root.status==='Failed'?'failed':'cancelled'};
    const leaves=snapshot.tasks.filter(task=>task.definition.kind==='task'&&taskRoot(snapshot,task.taskId).taskId===rootId);
    if(root.status!=='Succeeded'){
        const active=binding&&runtime.execution?.isActive(binding.bindingId);
        return {...view,state:binding?(active?(leaves.some(task=>task.status==='Waiting')?'waiting':'running'):'unknown'):'ready'};
    }
    if(!binding||!leaves.length||leaves.length>spec.limits.maxTasks||leaves.some(task=>task.status!=='Succeeded'||task.activeClaim)||snapshot.historyEventIds.length>10000)fail('workflow_tasktree_settlement_missing');
    const history=await runtime.owner.readHistory(input.taskSpaceId),settlements:NonNullable<WorkflowTaskTreeObservation['settlements']>[number][]=[],values:unknown[]=[];
    let bytes=0;
    for(const task of leaves){
        const event=history.filter(event=>event.kind==='task.settled'&&event.taskId===task.taskId).at(-1);
        const receipt=event&&await runtime.owner.readReceiptByCommand(input.taskSpaceId,event.commandId);
        if(!receipt||receipt.kind!=='task-settlement-receipt'||receipt.taskId!==task.taskId||receipt.status!=='Succeeded'||!task.outputArtifacts.length||task.outputArtifacts.length>32)return fail('workflow_tasktree_settlement_missing');
        const outputs=[];
        for(const ref of task.outputArtifacts){
            if((bytes+=ref.sizeBytes)>65536||ref.mediaType!=='application/json')fail('workflow_tasktree_result_capacity');
            const body=await runtime.owner.readArtifact(input.taskSpaceId,ref.digest);
            if(!body||body.sizeBytes!==ref.sizeBytes||body.mediaType!==ref.mediaType)return fail('workflow_tasktree_artifact_missing');
            const raw=Buffer.from(body.data,'base64');
            if(raw.length!==ref.sizeBytes||`sha256:${sha256Hex(raw)}`!==ref.digest)fail('workflow_tasktree_artifact_changed');
            try{outputs.push(parseWorkflowValue(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),65536))}catch{fail('workflow_tasktree_result_invalid')}
        }
        values.push(outputs.length===1?outputs[0]:outputs);
        settlements.push({taskId:task.taskId,receiptId:receipt.receiptId,artifacts:task.outputArtifacts.map(ref=>ref.digest)});
    }
    const output=parseWorkflowValue(spec.aggregation==='last'?values.at(-1):Object.fromEntries(leaves.map((task,index)=>[task.taskId,values[index]])),65536);
    runtime.check(request,'read',input.taskSpaceId);
    return {...view,state:'succeeded',output,settlements};
}
