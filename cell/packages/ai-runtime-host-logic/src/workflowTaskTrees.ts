import {parseWorkflowValue,type HostParticipantDirectory,type GlobalTaskRootPlan} from '@cell/ai-runtime-host-contract';
import type {WorkflowTaskTreeSpec,WorkflowTaskTreeProposal,WorkflowTaskTreeOrigin,WorkflowTaskTreeRelayIntent} from '@cell/ai-runtime-host-contract';
import {canonicalOwnDataDigest} from 'task-manager-contract';

export class WorkflowTaskTreeValidationError extends Error {
    constructor(readonly code:string){super(code);this.name='WorkflowTaskTreeValidationError';}
}
function fail(code:string):never{throw new WorkflowTaskTreeValidationError(code);}
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
    if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('tasktree_object_invalid');
    const data=value as Record<string,unknown>;
    if(Reflect.ownKeys(data).length!==keys.length||keys.some(key=>!Object.prototype.hasOwnProperty.call(data,key)))fail('tasktree_fields_invalid');
    for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(data,key);if(!descriptor||!('value' in descriptor)||!descriptor.enumerable)fail('tasktree_data_invalid');}
    return data;
}
function text(value:unknown,max:number,code:string):string{
    if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>max)fail(code);return value;
}
function integer(value:unknown,max:number,code:string):number{
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>max)fail(code);return value;
}
function mode(value:unknown):'all'|'sequential'{if(value!=='all'&&value!=='sequential')fail('tasktree_mode_invalid');return value;}
function id(value:unknown):string{const result=text(value,128,'tasktree_node_id_invalid');if(!/^[A-Za-z0-9_-]+$/.test(result))fail('tasktree_node_id_invalid');return result;}
/** Normalize own JSON data without evaluating an accessor or retaining caller mutation. */
function ownJSON(value:unknown):unknown{
    let remaining=4096;const active=new Set<object>();
    function visit(item:unknown,depth:number):unknown{
        if(--remaining<0||depth>32)fail('tasktree_value_budget_invalid');
        if(item===null||typeof item==='string'||typeof item==='boolean')return item;
        if(typeof item==='number'){if(!Number.isFinite(item))fail('tasktree_data_invalid');return item;}
        if(!item||typeof item!=='object'||active.has(item))fail('tasktree_data_invalid');
        active.add(item);
        try{
            if(Array.isArray(item)){
                if(item.length>4096||Reflect.ownKeys(item).length!==item.length+1)fail('tasktree_data_invalid');
                const output=[];for(let i=0;i<item.length;i++){const d=Object.getOwnPropertyDescriptor(item,String(i));if(!d||!('value' in d)||!d.enumerable)fail('tasktree_data_invalid');output.push(visit(d.value,depth+1));}return Object.freeze(output);
            }
            if(![Object.prototype,null].includes(Object.getPrototypeOf(item)))fail('tasktree_data_invalid');
            const output:Record<string,unknown>=Object.create(null);
            for(const key of Reflect.ownKeys(item)){if(typeof key!=='string')fail('tasktree_data_invalid');const d=Object.getOwnPropertyDescriptor(item,key);if(!d||!('value' in d)||!d.enumerable)fail('tasktree_data_invalid');output[key]=visit(d.value,depth+1);}return Object.freeze(output);
        }finally{active.delete(item);}
    }
    const output=visit(value,0);parseWorkflowValue(output,65536);return output;
}
export function parseWorkflowTaskTreeSpec(value:unknown):WorkflowTaskTreeSpec{
    const data=record(ownJSON(value),['schemaVersion','taskSpaceId','name','mode','limits','aggregation','resultSchema']);
    if(data.schemaVersion!=='eidolon.workflow-tasktree/v1')fail('tasktree_version_invalid');
    const taskSpaceId=text(data.taskSpaceId,128,'tasktree_space_invalid');if(!/^global-[a-f0-9]{32}-[a-f0-9]{32}$/.test(taskSpaceId))fail('tasktree_space_invalid');
    const limits=record(data.limits,['maxTasks','maxDepth','maxPlannerCalls']);
    if(data.aggregation!=='last'&&data.aggregation!=='by-task')fail('tasktree_aggregation_invalid');
    const resultSchema=parseWorkflowValue(data.resultSchema,16384);if(!resultSchema||typeof resultSchema!=='object'||Array.isArray(resultSchema))fail('tasktree_result_schema_invalid');
    return Object.freeze({schemaVersion:'eidolon.workflow-tasktree/v1',taskSpaceId,name:text(data.name,256,'tasktree_name_invalid'),mode:mode(data.mode),aggregation:data.aggregation,
        limits:Object.freeze({maxTasks:integer(limits.maxTasks,63,'tasktree_task_budget_invalid'),maxDepth:integer(limits.maxDepth,8,'tasktree_depth_budget_invalid'),maxPlannerCalls:integer(limits.maxPlannerCalls,4,'tasktree_planner_budget_invalid')}),resultSchema});
}
export function parseWorkflowTaskTreeProposal(value:unknown,spec:WorkflowTaskTreeSpec):WorkflowTaskTreeProposal{
    const data=record(ownJSON(value),['schemaVersion','nodes']);if(data.schemaVersion!=='eidolon.workflow-tasktree-proposal/v1')fail('tasktree_proposal_version_invalid');
    if(!Array.isArray(data.nodes)||!data.nodes.length||data.nodes.length>spec.limits.maxTasks)fail('tasktree_proposal_budget_invalid');
    // Reject getters, sparse arrays, non-JSON values and deep/large payloads before normalizing.
    for(let index=0;index<data.nodes.length;index++){const d=Object.getOwnPropertyDescriptor(data.nodes,String(index));if(!d||!('value' in d))fail('tasktree_data_invalid');}
    const nodes=data.nodes.map(raw=>{
        const kind=Object.getOwnPropertyDescriptor(raw??{},'kind')?.value;
        const item=record(raw,kind==='task'?['kind','id','parentId','name','recipientKey','text']:['kind','id','parentId','name','mode']);
        const base={id:id(item.id),parentId:item.parentId===null?null:id(item.parentId),name:text(item.name,256,'tasktree_name_invalid')};
        if(kind==='task')return Object.freeze({...base,kind:'task' as const,recipientKey:text(item.recipientKey,80,'tasktree_recipient_invalid'),text:text(item.text,32768,'tasktree_input_invalid')});
        if(kind!=='task-group')fail('tasktree_kind_invalid');return Object.freeze({...base,kind:'task-group' as const,mode:mode(item.mode)});
    });
    const byId=new Map(nodes.map(n=>[n.id,n]));if(byId.size!==nodes.length)fail('tasktree_duplicate_id');
    for(const node of nodes){
        const seen=new Set<string>();let current:typeof node|undefined=node,depth=0;
        while(current){if(seen.has(current.id))fail('tasktree_cycle');seen.add(current.id);if(++depth>spec.limits.maxDepth)fail('tasktree_depth_budget_invalid');
            if(current.parentId===null)break;const parent=byId.get(current.parentId);if(!parent||parent.kind!=='task-group')fail('tasktree_parent_invalid');current=parent;}
        if(node.kind==='task-group'&&!nodes.some(child=>child.parentId===node.id))fail('tasktree_empty_group');
    }
    if(!nodes.some(node=>node.kind==='task'))fail('tasktree_leaf_required');
    const result=Object.freeze({schemaVersion:'eidolon.workflow-tasktree-proposal/v1' as const,nodes:Object.freeze(nodes)});parseWorkflowValue(result,65536);return result;
}
export function workflowTaskTreeRecipientKey(recipient:HostParticipantDirectory['contacts'][number]['recipient']):string{
    return 'recipient-'+canonicalOwnDataDigest(recipient).slice(7,47);
}
export function parseWorkflowTaskTreeOrigin(value:unknown):WorkflowTaskTreeOrigin{
    const data=record(ownJSON(value),['daemonId','workspaceKey','workflowRef','instanceId','runId','nodeId','invocationKey','generation']);
    for(const key of ['daemonId','workspaceKey','workflowRef','instanceId','runId','nodeId','invocationKey'])text(data[key],1024,'tasktree_origin_invalid');
    if(typeof data.generation!=='number'||!Number.isSafeInteger(data.generation)||data.generation<0)fail('tasktree_origin_invalid');
    return data as WorkflowTaskTreeOrigin;
}
export function workflowTaskTreeRootId(origin:WorkflowTaskTreeOrigin):string{
    return 'workflow-root-'+canonicalOwnDataDigest(parseWorkflowTaskTreeOrigin(origin)).slice(7,47);
}
export function parseWorkflowTaskTreeRelayIntent(value:unknown):WorkflowTaskTreeRelayIntent{
    const input=ownJSON(value),kind=Object.getOwnPropertyDescriptor(input??{},'kind')?.value;
    const data=record(input,kind==='admit'?['kind','origin','spec','proposal','expectedRevision']:kind==='execute'?['kind','origin','taskSpaceId','expectedRevision','expectedControlRevision']:kind==='resume'?['kind','origin','taskSpaceId','controlKey','expectedRevision','expectedControlRevision']:kind==='resume-result'?['kind','origin','taskSpaceId','controlKey']:['kind','origin','taskSpaceId']);
    const origin=parseWorkflowTaskTreeOrigin(data.origin);
    if(kind==='admit'){
        if(typeof data.expectedRevision!=='number'||!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision<0)fail('tasktree_revision_invalid');
        const spec=parseWorkflowTaskTreeSpec(data.spec),proposal=parseWorkflowTaskTreeProposal(data.proposal,spec);
        return Object.freeze({kind,origin,spec,proposal,expectedRevision:data.expectedRevision});
    }
    if(!['directory','observe','execute-result','execute','resume','resume-result'].includes(kind))fail('tasktree_operation_invalid');
    const taskSpaceId=text(data.taskSpaceId,128,'tasktree_space_invalid');
    if(!/^global-[a-f0-9]{32}-[a-f0-9]{32}$/.test(taskSpaceId))fail('tasktree_space_invalid');
    if(kind==='resume-result')return Object.freeze({kind,origin,taskSpaceId,controlKey:text(data.controlKey,128,'tasktree_control_invalid')});
    if(kind==='execute'||kind==='resume'){
        for(const key of ['expectedRevision','expectedControlRevision'])if(typeof data[key]!=='number'||!Number.isSafeInteger(data[key])||(data[key] as number)<0)fail('tasktree_revision_invalid');
        return Object.freeze({kind,origin,taskSpaceId,...(kind==='resume'?{controlKey:text(data.controlKey,128,'tasktree_control_invalid')}:{}),expectedRevision:data.expectedRevision as number,expectedControlRevision:data.expectedControlRevision as number}) as WorkflowTaskTreeRelayIntent;
    }
    return Object.freeze({kind,origin,taskSpaceId}) as WorkflowTaskTreeRelayIntent;
}
export function workflowTaskTreeResumeCommandId(origin:WorkflowTaskTreeOrigin,controlKey:string):string{
    return 'workflow-tree-resume-'+canonicalOwnDataDigest([parseWorkflowTaskTreeOrigin(origin),text(controlKey,128,'tasktree_control_invalid')]).slice(7,47);
}
/** Compiles pure intent into the existing RootPlan; canonical admission remains the original owner. */
export function compileWorkflowTaskTreeProposal(spec:WorkflowTaskTreeSpec,proposal:WorkflowTaskTreeProposal,origin:WorkflowTaskTreeOrigin,directory:HostParticipantDirectory):GlobalTaskRootPlan{
    spec=parseWorkflowTaskTreeSpec(spec);proposal=parseWorkflowTaskTreeProposal(proposal,spec);
    const rootId=workflowTaskTreeRootId(origin),participants=new Map(directory.contacts.filter(c=>c.available&&c.recipient.kind==='holon'&&c.recipient.admissionRef).map(c=>[workflowTaskTreeRecipientKey(c.recipient),ownJSON(c.recipient) as HostParticipantDirectory['contacts'][number]['recipient']]));
    const taskId=(localId:string)=>'workflow-node-'+canonicalOwnDataDigest([rootId,localId]).slice(7,47);
    return Object.freeze({rootId,name:spec.name,mode:spec.mode,nodes:Object.freeze(proposal.nodes.map(node=>{
        const common={taskId:taskId(node.id),parentTaskId:node.parentId===null?rootId:taskId(node.parentId),name:node.name};
        if(node.kind==='task-group')return Object.freeze({...common,kind:'task-group' as const,mode:node.mode});
        const recipient=participants.get(node.recipientKey);if(!recipient)fail('tasktree_recipient_unavailable');
        return Object.freeze({...common,kind:'task' as const,recipient,text:node.text});
    }))});
}
