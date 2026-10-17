import type { GlobalTaskRootPlan, GlobalTaskSpaceCommand, GlobalTaskSpaceResult, GlobalTaskNodeView, GlobalTaskSpaceSummary, HostRequest } from '@cell/ai-runtime-host-contract';
import { canonicalOwnDataDigest, type TaskSpaceOwnerPort, type TaskSpaceDirectoryPort, type TaskSpaceSnapshot, type TaskNodeDefinition, type TaskRelation, type TaskCommandReceipt } from 'task-manager-contract';
import { createTaskSpace, replanTask, controlTaskRoot, taskRoot, TaskManagerError } from 'task-manager-logic';
import { HostProtocolFailure } from './commands';
import type {WorkflowTaskTreeTrustedContext} from '@cell/ai-runtime-host-contract';
import {workflowTaskTreeRootId} from './workflowTaskTrees';
type Cursor = {
    binding: string;
    offset: number;
    expiresAt: number;
};
export type GlobalRootCommand=Extract<GlobalTaskSpaceCommand,{kind:'pause'|'execute'|'resume'|'cancel'|'answer'}>;
export type GlobalRootCommandContext=Readonly<{snapshot:TaskSpaceSnapshot;commandId:string;intentDigest:`sha256:${string}`;occurredAt:string;workflowTaskTree?:WorkflowTaskTreeTrustedContext}>;
export type GlobalRootExecutionPort=Readonly<{
    command(request:HostRequest,input:GlobalRootCommand,context:GlobalRootCommandContext):Promise<TaskCommandReceipt>;
    isActive(bindingId:string):boolean;
    actorSource?(request:HostRequest,snapshot:TaskSpaceSnapshot,taskId:string,claimId:string):Readonly<{actorId:string;runtimeSessionKey:string}>|undefined;
    waits(request:HostRequest,snapshot:TaskSpaceSnapshot,taskId:string):readonly import('@cell/ai-runtime-host-contract').GlobalTaskWait[];
    inspectWaits?(request:HostRequest,snapshot:TaskSpaceSnapshot):Promise<ReadonlyMap<string,readonly import('@cell/ai-runtime-host-contract').GlobalTaskWait[]>>;
}>;
export type GlobalTaskSpaceRuntime = Readonly<{
    owner: TaskSpaceOwnerPort & TaskSpaceDirectoryPort;
    daemonScope: string;
    serverInstanceId: string;
    now(): number;
    newId(): string;
    cursors: Map<string, Cursor>;
    execution?:GlobalRootExecutionPort;
    check(request: HostRequest, action: 'list' | 'create' | 'read' | 'edit' | 'execute' | 'control', taskSpaceId?: string): void;
}>;
const processorConfig = { maxTasks: 1024, maxRelations: 4096, maxLeaseDurationMs: 86400000 };
export function globalTaskSpaceCommandAction(input: GlobalTaskSpaceCommand): 'create' | 'edit' | 'execute' | 'control' {
    switch (input.kind) {
        case 'create': return 'create';
        case 'add_root':
        case 'edit_root': return 'edit';
        case 'execute':
        case 'resume': return 'execute';
        case 'pause':
        case 'cancel': return 'control';
        case 'answer': return 'control';
    }
}
function fail(request: HostRequest, status: number, code: string): never { throw new HostProtocolFailure(status, { code, requestId: request.requestId, retryable: false }); }
function digest(value: unknown) { return canonicalOwnDataDigest(value).slice('sha256:'.length); }
function scope(runtime: GlobalTaskSpaceRuntime, request: HostRequest) { return `global-${digest([runtime.daemonScope, request.principal.principalId]).slice(0, 32)}-`; }
export function globalTaskSpaceIdentity(runtime: GlobalTaskSpaceRuntime, request: HostRequest, commandId: string) { return scope(runtime, request) + digest(commandId).slice(0, 32); }
function commandIdentity(request: HostRequest, id: string) { return `global-command-${digest([request.principal.principalId, id])}`; }
function owned(runtime: GlobalTaskSpaceRuntime, request: HostRequest, id: string) { if (!id.startsWith(scope(runtime, request)) || !/^global-[a-f0-9]{32}-[a-f0-9]{32}$/.test(id))
    fail(request, 404, 'global_taskspace_not_found'); }
export async function readOwnedGlobalTaskSpace(runtime: GlobalTaskSpaceRuntime, request: HostRequest, id: string) {
    runtime.check(request, 'read', id);
    owned(runtime, request, id);
    const snapshot = await runtime.owner.readSnapshot(id);
    runtime.check(request, 'read', id);
    if (!snapshot)
        fail(request, 404, 'global_taskspace_not_found');
    return snapshot;
}
const read=readOwnedGlobalTaskSpace;
function summary(snapshot: TaskSpaceSnapshot): GlobalTaskSpaceSummary { return { taskSpaceId: snapshot.taskSpaceId, name: snapshot.definition.name, revision: snapshot.revision, taskCount: snapshot.tasks.length, rootCount: snapshot.definition.relations.filter(r => r.kind === 'parent-child' && r.parentTaskId === null).length, updatedAt: snapshot.updatedAt }; }
function page(runtime: GlobalTaskSpaceRuntime, request: HostRequest, input: {
    after?: string;
    limit?: number;
}, identity: unknown, length: number, sizes?:readonly number[]) {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || input.after !== undefined && (typeof input.after !== 'string' || input.after.length > 256))
        fail(request, 400, 'invalid_schema');
    const binding = digest([runtime.serverInstanceId, request.principal, identity]);
    let offset = 0;
    if (input.after) {
        const cursor = runtime.cursors.get(input.after);
        if (!cursor || cursor.binding !== binding || cursor.expiresAt < runtime.now())
            fail(request, 409, 'global_taskspace_cursor_changed');
        offset = cursor.offset;
    }
    let end = Math.min(offset + limit, length);
    if(sizes){let bytes=0,index=offset;for(;index<end;index++){const size=sizes[index]!;if(size>110000)fail(request,503,'global_task_projection_capacity');if(bytes+size>110000)break;bytes+=size}end=index;}
    let nextCursor: string | undefined;
    if (end < length) {
        if (runtime.cursors.size >= 256)
            runtime.cursors.delete(runtime.cursors.keys().next().value!);
        nextCursor = runtime.newId();
        runtime.cursors.set(nextCursor, { binding, offset: end, expiresAt: runtime.now() + 300000 });
    }
    return { offset, end, ...(nextCursor ? { nextCursor } : {}) };
}
export async function listGlobalTaskSpaces(runtime: GlobalTaskSpaceRuntime, request: HostRequest, input: {
    after?: string;
    limit?: number;
}) {
    runtime.check(request, 'list');
    const ids = (await runtime.owner.listTaskSpaceIds({ maxEntries: 1000 })).filter(id => id.startsWith(scope(runtime, request)));
    const summaries: GlobalTaskSpaceSummary[] = [];
    for (const id of ids) {
        const snapshot = await read(runtime, request, id);
        summaries.push(summary(snapshot));
    }
    runtime.check(request, 'list');
    const { offset, end, ...cursor } = page(runtime, request, input, summaries.map(s => [s.taskSpaceId, s.revision]), summaries.length);
    return { spaces: summaries.slice(offset, end), ...cursor };
}
export async function readGlobalTaskSpace(runtime: GlobalTaskSpaceRuntime, request: HostRequest, input: {
    taskSpaceId: string;
    after?: string;
    limit?: number;
}) {
    const snapshot = await read(runtime, request, input.taskSpaceId);
    const recoveredWaits=await runtime.execution?.inspectWaits?.(request,snapshot);
    const allNodes = snapshot.tasks.map(task => {
        const relation = snapshot.definition.relations.find(r => r.kind === 'parent-child' && r.childTaskId === task.taskId);
        if (!relation || relation.kind !== 'parent-child')
            fail(request, 503, 'global_taskspace_corrupt');
        const control = task.rootControl;
        const root=taskRoot(snapshot,task.taskId),workflowProof=root.definition.profile.facts.workflowTaskTree as {origin?:import('@cell/ai-runtime-host-contract').WorkflowTaskTreeOrigin}|undefined;
        const waits=[...(recoveredWaits?.get(task.taskId)??[]),...(runtime.execution?.waits(request,snapshot,task.taskId)??[])];
        const node: GlobalTaskNodeView = { taskId: task.taskId, parentTaskId: relation.parentTaskId, kind: task.definition.kind, name: task.definition.name, order: task.definition.order, status: task.status,
            planMutable: !workflowProof&&!['Succeeded','Failed','Cancelled'].includes(task.status) && !task.activeClaim && task.attempt === 0 && !task.preparationReceiptId,
            ...(task.taskId===root.taskId&&workflowProof?.origin?{workflow:workflowProof.origin}:{}),
            ...(waits.length?{waits}:{}),
            ...(task.definition.kind === 'task-group' ? { mode: task.definition.mode } : {}),
            ...(relation.parentTaskId === null ? { executionState: rootExecutionState(runtime,snapshot,task), controlRevision: control?.revision ?? 0, paused: control?.paused ?? true, ...(control?.binding ? { bindingId: control.binding.bindingId } : {}) } : {}) };
        return node;
    });
    const { offset, end, ...cursor } = page(runtime, request, input, [snapshot.taskSpaceId, snapshot.revision,digest(allNodes)], allNodes.length,allNodes.map(node=>new TextEncoder().encode(JSON.stringify(node)).length));
    runtime.check(request,'read',snapshot.taskSpaceId);
    return { ...summary(snapshot), nodes:allNodes.slice(offset,end), ...cursor };
}
export async function readGlobalTaskRootPlan(runtime: GlobalTaskSpaceRuntime, request: HostRequest, input: {taskSpaceId:string;rootId:string}): Promise<import('@cell/ai-runtime-host-contract').GlobalTaskRootPlanView> {
    const snapshot = await read(runtime, request, input.taskSpaceId);
    const root = snapshot.tasks.find(task => task.taskId === input.rootId);
    const relation = snapshot.definition.relations.find(r => r.kind === 'parent-child' && r.childTaskId === input.rootId);
    if (!root || root.definition.kind !== 'task-group' || !relation || relation.kind !== 'parent-child' || relation.parentTaskId !== null)
        fail(request, 404, 'global_root_not_found');
    if (root.definition.mode === 'any') fail(request, 503, 'global_plan_projection_unavailable');
    const nodes: import('@cell/ai-runtime-host-contract').GlobalTaskNodePlan[] = [];
    const visit = (parentTaskId: string) => {
        const children = snapshot.definition.relations.filter((r): r is Extract<TaskRelation,{kind:'parent-child'}> => r.kind === 'parent-child' && r.parentTaskId === parentTaskId).sort((a,b) => a.order - b.order);
        for (const child of children) {
            const task = snapshot.tasks.find(t => t.taskId === child.childTaskId);
            if (!task || nodes.length >= 256) fail(request, 503, 'global_plan_projection_capacity');
            const base = {taskId:task.taskId,parentTaskId,name:task.definition.name};
            if (task.definition.kind === 'task-group') {
                if (task.definition.mode === 'any') fail(request,503,'global_plan_projection_unavailable');
                nodes.push({...base,kind:'task-group',mode:task.definition.mode});
                visit(task.taskId);
            } else {
                const profile = task.definition.profile;
                if (profile.profileKind !== 'eidolon.global-task-plan') fail(request,503,'global_plan_projection_unavailable');
                nodes.push({...base,kind:'task',recipient:profile.facts.recipient as unknown as import('@cell/ai-runtime-host-contract').HostParticipantRecipient,text:profile.facts.text as string});
            }
        }
    };
    visit(root.taskId);
    const value = {taskSpaceId:snapshot.taskSpaceId,revision:snapshot.revision,controlRevision:root.rootControl?.revision ?? 0,paused:root.rootControl?.paused ?? true,root:{rootId:root.taskId,name:root.definition.name,mode:root.definition.mode,nodes}};
    if (new TextEncoder().encode(JSON.stringify(value)).length > 131072) fail(request,503,'global_plan_projection_capacity');
    runtime.check(request,'read',snapshot.taskSpaceId);
    return value;
}
export async function readGlobalTaskDetail(runtime:GlobalTaskSpaceRuntime,request:HostRequest,input:{taskSpaceId:string;taskId:string;after?:string;limit?:number}):Promise<import('@cell/ai-runtime-host-contract').GlobalTaskDetail>{
    const snapshot=await read(runtime,request,input.taskSpaceId),task=snapshot.tasks.find(t=>t.taskId===input.taskId);
    if(!task)fail(request,404,'global_task_not_found');
    if(snapshot.historyEventIds.length>10000)fail(request,429,'global_history_capacity');
    const events=(await runtime.owner.readHistory(input.taskSpaceId)).filter(event=>'taskId' in event&&event.taskId===task.taskId);
    const lastClaim=events.filter(event=>event.kind==='task.claimed').at(-1);
    const claimId=task.activeClaim?.claimId??(lastClaim?.kind==='task.claimed'?lastClaim.claim.claimId:undefined);
    const root=taskRoot(snapshot,task.taskId),binding=root.rootControl?.binding;
    const actor=claimId?runtime.execution?.actorSource?.(request,snapshot,task.taskId,claimId):undefined;
    const execution=binding?{bindingId:binding.bindingId,executionRef:binding.executionRef,...(claimId?{claimId}:{}),...(actor??{actorUnavailableReason:'original_actor_mapping_unavailable'})}:undefined;
    const history=events.map(event=>({eventId:event.eventId,commandId:event.commandId,kind:event.kind,occurredAt:event.occurredAt,...('fromStatus' in event?{fromStatus:event.fromStatus}:{}),...('toStatus' in event?{toStatus:event.toStatus}:{})}));
    const {offset,end,...cursor}=page(runtime,request,input,[snapshot.taskSpaceId,task.taskId,snapshot.revision,'history'],history.length);
    const profile=task.definition.profile;
    runtime.check(request,'read',input.taskSpaceId);
    return {taskSpaceId:input.taskSpaceId,taskId:task.taskId,rootId:taskRoot(snapshot,task.taskId).taskId,revision:snapshot.revision,status:task.status,attempt:task.attempt,...(execution?{execution}:{}),...(profile.profileKind==='eidolon.global-task-plan'?{plan:{recipient:profile.facts.recipient as unknown as import('@cell/ai-runtime-host-contract').HostParticipantRecipient,text:profile.facts.text as string}}:{}),outputArtifacts:task.outputArtifacts.map(({digest,mediaType,sizeBytes})=>({digest,mediaType,sizeBytes})),history:history.slice(offset,end),...cursor};
}
export async function readGlobalTaskArtifact(runtime:GlobalTaskSpaceRuntime,request:HostRequest,input:{taskSpaceId:string;taskId:string;digest:string;offsetBytes?:number;limitBytes?:number}):Promise<import('@cell/ai-runtime-host-contract').GlobalTaskArtifactChunk>{
    const snapshot=await read(runtime,request,input.taskSpaceId),task=snapshot.tasks.find(t=>t.taskId===input.taskId),reference=task?.outputArtifacts.find(artifact=>artifact.digest===input.digest);
    if(!reference)fail(request,404,'global_artifact_not_found');
    if(reference.sizeBytes>1024*1024)fail(request,413,'global_artifact_capacity');
    const body=await runtime.owner.readArtifact(input.taskSpaceId,reference.digest);
    if(!body||body.sizeBytes!==reference.sizeBytes||body.mediaType!==reference.mediaType)fail(request,503,'global_artifact_unavailable');
    const bytes=Uint8Array.from(atob(body.data),char=>char.charCodeAt(0)),offset=input.offsetBytes??0,limit=input.limitBytes??32768;
    if(bytes.length!==body.sizeBytes)fail(request,503,'global_artifact_unavailable');
    if(!Number.isSafeInteger(offset)||offset<0||offset>bytes.length||!Number.isSafeInteger(limit)||limit<1||limit>32768)fail(request,400,'invalid_schema');
    const end=Math.min(offset+limit,bytes.length);
    runtime.check(request,'read',input.taskSpaceId);
    return {taskSpaceId:input.taskSpaceId,taskId:input.taskId,digest:input.digest,mediaType:body.mediaType,sizeBytes:body.sizeBytes,offsetBytes:offset,bytesBase64:btoa(String.fromCharCode(...bytes.slice(offset,end))),...(end<bytes.length?{nextOffsetBytes:end}:{})};
}
function rootExecutionState(runtime:GlobalTaskSpaceRuntime,snapshot:TaskSpaceSnapshot,root:TaskSpaceSnapshot['tasks'][number]):GlobalTaskNodeView['executionState']{
    const control=root.rootControl;
    if(!control?.binding)return 'unbound';
    if(['Succeeded','Failed','Cancelled'].includes(root.status))return 'settled';
    if(control.paused)return 'paused';
    if(snapshot.tasks.some(task=>task.attempt>0&&!task.activeClaim&&!['Succeeded','Failed','Cancelled'].includes(task.status)&&taskRoot(snapshot,task.taskId).taskId===root.taskId))return 'unknown';
    if(runtime.execution?.isActive(control.binding.bindingId))return 'running';
    if(snapshot.tasks.some(task=>task.activeClaim&&taskRoot(snapshot,task.taskId).taskId===root.taskId))return 'unknown';
    return 'needs_resume';
}
function subtree(snapshot: TaskSpaceSnapshot, rootId: string) {
    const found = new Set([rootId]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const r of snapshot.definition.relations)
            if (r.kind === 'parent-child' && r.parentTaskId !== null && found.has(r.parentTaskId) && !found.has(r.childTaskId)) {
                found.add(r.childTaskId);
                grew = true;
            }
    }
    return found;
}
export function proposeGlobalTaskRoot(snapshot: TaskSpaceSnapshot, request: HostRequest, plan: GlobalTaskRootPlan, edit: boolean) {
    const root = snapshot.tasks.find(t => t.taskId === plan.rootId);
    const relation = snapshot.definition.relations.find(r => r.kind === 'parent-child' && r.childTaskId === plan.rootId);
    if (edit ? (!root || !relation || relation.kind !== 'parent-child' || relation.parentTaskId !== null) : Boolean(root))
        fail(request, 409, 'global_root_identity_conflict');
    if (root?.rootControl && !root.rootControl.paused)
        fail(request, 409, 'global_root_pause_required');
    if (root?.definition.profile.facts.workflowTaskTree)
        fail(request, 409, 'global_workflow_root_plan_frozen');
    if (!plan.nodes.length)
        fail(request, 400, 'global_root_empty');
    const removed = edit ? subtree(snapshot, plan.rootId) : new Set<string>();
    const ids = new Set<string>([plan.rootId]);
    for (const node of plan.nodes) {
        if (ids.has(node.taskId) || snapshot.tasks.some(t => t.taskId === node.taskId && !removed.has(t.taskId)))
            fail(request, 409, 'global_task_identity_conflict');
        ids.add(node.taskId);
    }
    const rootOrder = root?.definition.order ?? snapshot.definition.relations.filter(r => r.kind === 'parent-child' && r.parentTaskId === null).length;
    const tasks: TaskNodeDefinition[] = [...snapshot.definition.tasks.filter(t => !removed.has(t.taskId)), {
            kind: 'task-group', taskId: plan.rootId, name: plan.name, order: rootOrder, mode: plan.mode,
            profile: { kind: 'task-profile', profileKind: 'eidolon.global-task-root', schemaVersion: 1, facts: {} }, inputArtifacts: [],
        }];
    const relations: TaskRelation[] = [...snapshot.definition.relations.filter(r => r.kind === 'parent-child' ? !removed.has(r.childTaskId) && !removed.has(r.parentTaskId ?? '') : !removed.has(r.predecessorTaskId) && !removed.has(r.successorTaskId)), {
            kind: 'parent-child', relationId: `global-parent:${plan.rootId}`, parentTaskId: null, childTaskId: plan.rootId, order: rootOrder,
        }];
    const childOrders = new Map<string, number>();
    for (const node of plan.nodes) {
        if (!ids.has(node.parentTaskId) || node.taskId === node.parentTaskId)
            fail(request, 400, 'global_task_parent_invalid');
        const order = childOrders.get(node.parentTaskId) ?? 0;
        childOrders.set(node.parentTaskId, order + 1);
        if (node.kind === 'task' && (node.recipient.kind !== 'holon' || !node.recipient.admissionRef))
            fail(request, 400, 'global_task_recipient_invalid');
        tasks.push({ kind: node.kind, taskId: node.taskId, name: node.name, order, ...(node.kind === 'task-group' ? { mode: node.mode } : {}),
            profile: { kind: 'task-profile', profileKind: node.kind === 'task-group' ? 'eidolon.global-task-root' : 'eidolon.global-task-plan', schemaVersion: 1,
                facts: node.kind === 'task' ? { recipient: node.recipient as unknown as Record<string, string>, text: node.text } : {} }, inputArtifacts: [] } as TaskNodeDefinition);
        relations.push({ kind: 'parent-child', relationId: `global-parent:${node.taskId}`, parentTaskId: node.parentTaskId, childTaskId: node.taskId, order });
    }
    return { tasks, relations };
}
function result(commandId: string, receipt: TaskCommandReceipt, replayed: boolean): GlobalTaskSpaceResult { return { commandId, taskSpaceId: receipt.taskSpaceId, revision: receipt.toRevision, receiptId: receipt.receiptId, replayed }; }
export async function readGlobalTaskSpaceResult(runtime: GlobalTaskSpaceRuntime, request: HostRequest, input: {
    taskSpaceId: string;
    commandId: string;
}) {
    await read(runtime, request, input.taskSpaceId);
    const receipt = await runtime.owner.readReceiptByCommand(input.taskSpaceId, commandIdentity(request, input.commandId));
    runtime.check(request, 'read', input.taskSpaceId);
    if (!receipt)
        fail(request, 404, 'global_taskspace_result_not_found');
    return result(input.commandId, receipt, true);
}
export async function commandGlobalTaskSpace(runtime: GlobalTaskSpaceRuntime, request: HostRequest, input: GlobalTaskSpaceCommand,workflowTaskTree?:WorkflowTaskTreeTrustedContext): Promise<GlobalTaskSpaceResult> {
    const id = input.kind === 'create' ? globalTaskSpaceIdentity(runtime, request, input.commandId) : input.taskSpaceId;
    const action = globalTaskSpaceCommandAction(input);
    runtime.check(request, action, id);
    owned(runtime, request, id);
    if (input.expectedServerInstanceId !== runtime.serverInstanceId)
        fail(request, 409, 'server_instance_mismatch');
    const commandId = commandIdentity(request, input.commandId);
    const { expectedServerInstanceId, ...intent } = input;
    const intentDigest = canonicalOwnDataDigest(intent);
    if(workflowTaskTree){
        if((input.kind!=='execute'&&input.kind!=='resume')||input.rootId!==workflowTaskTreeRootId(workflowTaskTree.origin))fail(request,403,'workflow_tasktree_origin_mismatch');
        const snapshot=await read(runtime,request,id),proof=snapshot.tasks.find(task=>task.taskId===input.rootId)?.definition.profile.facts.workflowTaskTree as {origin?:unknown;principalId?:unknown}|undefined;
        if(!proof||proof.principalId!==request.principal.principalId||canonicalOwnDataDigest(proof.origin)!==canonicalOwnDataDigest(workflowTaskTree.origin))fail(request,403,'workflow_tasktree_origin_mismatch');
    }
    const priorReceipt = await runtime.owner.readReceiptByCommand(id, commandId);
    if (priorReceipt) {
        if (priorReceipt.intentDigest !== intentDigest)
            fail(request, 409, 'global_command_identity_conflict');
        runtime.check(request, action, id);
        return result(input.commandId, priorReceipt, true);
    }
    const at = new Date(runtime.now()).toISOString();
    runtime.check(request, action, id);
    const accepted=(receipt:TaskCommandReceipt,replayed:boolean)=>{
        try{runtime.check(request,action,id)}catch(error){
            if(error instanceof HostProtocolFailure)throw new HostProtocolFailure(error.status,{...error.error,state:'unknown'});
            throw new HostProtocolFailure(409,{code:'global_command_outcome_unknown',requestId:request.requestId,retryable:false,state:'unknown'});
        }
        return result(input.commandId,receipt,replayed);
    };
    try {
        if (input.kind === 'create') {
            if ((await runtime.owner.listTaskSpaceIds({ maxEntries: 1000 })).length >= 1000)
                fail(request, 429, 'global_taskspace_capacity');
            const created = await createTaskSpace(runtime, { kind: 'task-space.create', commandId, intentDigest, taskSpaceId: id, createdAt: at, definition: { kind: 'task-space-definition', taskSpaceId: id, name: input.name, schemaVersion: 1, allowEmpty: true, tasks: [], relations: [] } }, processorConfig);
            return accepted(created.receipt,created.replayed);
        }
        const snapshot = await read(runtime, request, id);
        if (input.kind === 'add_root' || input.kind === 'edit_root') {
            const proposal = proposeGlobalTaskRoot(snapshot, request, input.root, input.kind === 'edit_root');
            const replanned = await replanTask(runtime, { kind: 'task.replan', commandId, intentDigest, taskSpaceId: id, expectedRevision: input.expectedRevision, replannedAt: at, plan: { kind: 'task-plan', planId: commandId, reason: `Global ${input.kind}`, ...proposal } }, processorConfig);
            return accepted(replanned.receipt,replanned.replayed);
        }
        if(input.kind==='execute'&&!workflowTaskTree&&snapshot.tasks.find(task=>task.taskId===input.rootId)?.definition.profile.facts.workflowTaskTree)
            fail(request,409,'global_workflow_root_owned');
        if (input.kind === 'pause') {
            const controlled = await controlTaskRoot(runtime, { kind: 'task.root-control', commandId, intentDigest, taskSpaceId: id, taskId: input.rootId, expectedRevision: input.expectedRevision, expectedControlRevision: input.expectedControlRevision, occurredAt: at, action: { kind: 'pause' } }, processorConfig);
            return accepted(controlled.receipt,controlled.replayed);
        }
        if(!runtime.execution)fail(request, 503, 'global_task_execution_unavailable');
        if(!('rootId' in input))fail(request,400,'invalid_schema');
        const receipt=await runtime.execution.command(request,input,{snapshot,commandId,intentDigest,occurredAt:at,...(workflowTaskTree?{workflowTaskTree}:{})});
        return accepted(receipt,false);
    }
    catch (error) {
        if (error instanceof TaskManagerError)
            fail(request, error.code === 'invalid-task-definition' || error.code === 'cyclic-task-forest' ? 400 : 409, `global_${error.code.replace(/-/g, '_')}`);
        throw error;
    }
}
