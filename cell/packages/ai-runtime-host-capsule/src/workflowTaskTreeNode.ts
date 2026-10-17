import type {HostRequest,HostParticipantDirectory,WorkflowTaskTreeEffects,WorkflowTaskTreeObservation,WorkflowTaskTreeOrigin} from '@cell/ai-runtime-host-contract';
import type {WorkflowTaskTreeNodePort,WorkflowTaskTreeNodeIdentity,WorkflowTaskTreeIntentFact} from '@cell/ai-organ-contract/workflow/WorkflowTaskTree';
import type {WorkflowFactStore} from '@cell/ai-organ-logic/workflow/runtime/WorkflowFactStore';
import {canonicalOwnDataDigest} from 'task-manager-contract';
import {parseWorkflowTaskTreeSpec,parseWorkflowTaskTreeProposal,workflowTaskTreeRecipientKey} from '@cell/ai-runtime-host-logic';

/** Coordinates intent references; the original global owner retains every task state and result. */
export function createWorkflowTaskTreeNodePort(options:Readonly<{
    effects:WorkflowTaskTreeEffects;authority:{daemonId:string;workspaceKey:string};
    facts:Pick<WorkflowFactStore,'readTaskTreeIntent'|'recordTaskTreeIntent'>;
    request(identity:WorkflowTaskTreeNodeIdentity):HostRequest;
    interrupted():boolean;pollMs?:number;
}>):WorkflowTaskTreeNodePort{
    const active=new Map<string,{digest:string;value:Promise<unknown>}>();
    async function execute(identity:WorkflowTaskTreeNodeIdentity,raw:unknown,plan:(participants:unknown)=>Promise<unknown>){
        const spec=parseWorkflowTaskTreeSpec(raw),specDigest=canonicalOwnDataDigest(spec),request=options.request(identity),origin:WorkflowTaskTreeOrigin={...options.authority,...identity};
        const observe=()=>options.effects.call(request,{kind:'observe',origin,taskSpaceId:spec.taskSpaceId}) as Promise<WorkflowTaskTreeObservation>;
        const fact=(phase:WorkflowTaskTreeIntentFact['phase'],proposal?:unknown):WorkflowTaskTreeIntentFact=>({schemaVersion:'eidolon.workflow-tasktree-intent/v1',identity,specDigest,phase,plannerCalls:1,...(proposal===undefined?{}:{proposal})});
        const read=async(phase:WorkflowTaskTreeIntentFact['phase'])=>{
            const value=await options.facts.readTaskTreeIntent(identity,phase);
            if(value&&(value.schemaVersion!=='eidolon.workflow-tasktree-intent/v1'||value.phase!==phase||value.specDigest!==specDigest||value.plannerCalls!==1||canonicalOwnDataDigest(value.identity)!==canonicalOwnDataDigest(identity)))throw new Error('workflow_tasktree_intent_identity_conflict');
            return value;
        };
        await options.facts.recordTaskTreeIntent({...fact('node-bound'),plannerCalls:0,taskSpaceId:spec.taskSpaceId});
        let observed=await observe();
        if(observed.state==='missing'){
            let completed=await read('planner-completed');
            if(!completed){
                if(await read('planner-requested'))throw new Error('workflow_tasktree_planner_unknown');
                const directory=await options.effects.call(request,{kind:'directory',origin,taskSpaceId:spec.taskSpaceId}) as HostParticipantDirectory;
                if(!await options.facts.recordTaskTreeIntent(fact('planner-requested')))throw new Error('workflow_tasktree_planner_unknown');
                const choices=directory.contacts.filter(contact=>contact.available&&contact.recipient.kind==='holon'&&contact.recipient.admissionRef).map(contact=>Object.freeze({name:contact.name,recipientKey:workflowTaskTreeRecipientKey(contact.recipient)}));
                const proposal=parseWorkflowTaskTreeProposal(await plan(Object.freeze(choices)),spec);
                completed=fact('planner-completed',proposal);await options.facts.recordTaskTreeIntent(completed);
            }
            const proposal=parseWorkflowTaskTreeProposal(completed.proposal,spec);
            for(let attempt=0;observed.state==='missing';attempt++){
                if(attempt>=3)throw new Error('workflow_tasktree_admission_conflict');
                try{await options.effects.call(request,{kind:'admit',origin,spec,proposal,expectedRevision:observed.revision})}catch(error){
                    if((error as {error?:{code?:string}}).error?.code!=='workflow_tasktree_revision_conflict')throw error;
                }
                observed=await observe();
            }
        }
        if(!observed.spec||canonicalOwnDataDigest(observed.spec)!==specDigest)throw new Error('workflow_tasktree_spec_changed');
        await options.facts.recordTaskTreeIntent({...fact('root-admitted'),taskSpaceId:spec.taskSpaceId,rootId:observed.rootId});
        if(observed.state==='ready'){
            if(await read('execute-requested')){
                try{await options.effects.call(request,{kind:'execute-result',origin,taskSpaceId:spec.taskSpaceId})}catch{throw new Error('workflow_tasktree_execution_unknown')}
            }else{
                if(!await options.facts.recordTaskTreeIntent(fact('execute-requested')))throw new Error('workflow_tasktree_execution_unknown');
                await options.effects.call(request,{kind:'execute',origin,taskSpaceId:spec.taskSpaceId,expectedRevision:observed.revision,expectedControlRevision:observed.controlRevision});
            }
            observed=await observe();
        }
        while(observed.state==='running'||observed.state==='waiting'){
            if(options.interrupted())throw new Error('workflow_tasktree_execution_interrupted');
            await new Promise(resolve=>setTimeout(resolve,options.pollMs??200));observed=await observe();
        }
        if(observed.state!=='succeeded')throw new Error(`workflow_tasktree_${observed.state}`);
        return observed.output;
    }
    return {async control(identity,controlKey){
        const bound=await options.facts.readTaskTreeIntent(identity,'node-bound');
        if(!bound?.taskSpaceId)throw new Error('workflow_tasktree_binding_missing');
        const origin:WorkflowTaskTreeOrigin={...options.authority,...identity},request=options.request(identity);
        const observed=await options.effects.call(request,{kind:'observe',origin,taskSpaceId:bound.taskSpaceId}) as WorkflowTaskTreeObservation;
        if(!observed.spec||canonicalOwnDataDigest(observed.spec)!==bound.specDigest)throw new Error('workflow_tasktree_spec_changed');
        if(observed.state==='succeeded'||(observed.state==='running'&&!observed.paused))return;
        if(observed.state==='ready'&&!observed.bindingId){
            const intent=await options.facts.readTaskTreeIntent(identity,'execute-requested');
            if(!intent)return;
            if(intent.specDigest!==bound.specDigest)throw new Error('workflow_tasktree_intent_identity_conflict');
            try{await options.effects.call(request,{kind:'execute-result',origin,taskSpaceId:bound.taskSpaceId})}catch{throw new Error('workflow_tasktree_execution_unknown')}
            return;
        }
        if(!observed.bindingId||observed.state==='failed'||observed.state==='cancelled')throw new Error('workflow_tasktree_control_unavailable');
        const controlIdentity={...identity,invocationKey:`${identity.invocationKey}/control:${controlKey}`};
        const created=await options.facts.recordTaskTreeIntent({schemaVersion:'eidolon.workflow-tasktree-intent/v1',identity:controlIdentity,phase:'control-requested',plannerCalls:0,specDigest:bound.specDigest,taskSpaceId:bound.taskSpaceId,rootId:observed.rootId});
        if(!created){await options.effects.call(request,{kind:'resume-result',origin,taskSpaceId:bound.taskSpaceId,controlKey});return}
        await options.effects.call(request,{kind:'resume',origin,taskSpaceId:bound.taskSpaceId,controlKey,expectedRevision:observed.revision,expectedControlRevision:observed.controlRevision});
    },run(identity,spec,plan){
        const key=canonicalOwnDataDigest(identity),digest=canonicalOwnDataDigest(parseWorkflowTaskTreeSpec(spec)),prior=active.get(key);
        if(prior){if(prior.digest!==digest)return Promise.reject(new Error('workflow_tasktree_spec_changed'));return prior.value}
        const value=execute(Object.freeze({...identity}),spec,plan);active.set(key,{digest,value});
        void value.finally(()=>{if(active.get(key)?.value===value)active.delete(key)}).catch(()=>{});return value;
    }};
}
