import { createHmac, randomBytes } from 'node:crypto';
import type { HostRequest, HostResourceEffects, WorkflowCommand, WorkflowCommandResult, WorkflowRunView, WorkflowMaterial, WorkflowEventPage, WorkflowMaterialRead, WorkflowExecutionSource } from '@cell/ai-runtime-host-contract';
import { HostProtocolFailure, workflowDefinition, workflowRunStructure, workflowRunResult, workflowExecutionGenerationCurrent, workflowNodes, workflowPublicValue, workflowRunSummary } from '@cell/ai-runtime-host-logic';
import { openWorkflowWorkbenchStore, workflowDigest, type WorkflowAdmissionRecord } from '@cell/ai-runtime-host-support';
import { getWorkflowRuntimeService } from '@cell/ai-organ-logic/workflow';
import { createSessionRuntimeAssembly, type SessionRuntimeConfig, type SessionRuntimeReady } from './session/SessionRuntimeAssembly';
import { createActorSurfaceFacade } from '@cell/ai-core-logic/runtime/ActorSurface';
import { getLocalPermissionApprovalContext, getWorkspaceAccessGrantContext } from '@cell/ai-organ-logic/permissions/LocalPermissionRuntime';
import { readWorkflowPublicRuntimeEvidence } from '@cell/ai-organ-logic/workflow';
import { addressedExecutionControl } from '@cell/ai-organ-logic/agent/AddressedExecutionActivation';
import type {WorkflowTaskTreeEffects} from '@cell/ai-runtime-host-contract';
import {createWorkflowTaskTreeNodePort} from './workflowTaskTreeNode';
import {workflowTaskTreeRootId} from '@cell/ai-runtime-host-logic';
type Store = Awaited<ReturnType<typeof openWorkflowWorkbenchStore>>;
type RuntimeService = ReturnType<typeof getWorkflowRuntimeService>;
type Scope = {
    store: Store;
    service: RuntimeService;
    ready: SessionRuntimeReady;
    bridge: NonNullable<Awaited<ReturnType<typeof createSessionRuntimeAssembly>>>;
    lane: Promise<unknown>;
    active: number;
    executions: Map<string, Promise<WorkflowCommandResult>>;
    admissions: Map<string, () => void>;
    requests: Map<string, HostRequest>;
    readonly observationLane: Promise<void>;
    readonly observationError: unknown;
};
const unsupported = ['human_node_protocol', 'workflow_definition_edit', 'automatic_unknown_retry', 'arbitrary_files'];
function missing(request: HostRequest, code: string, status = 404): never { throw new HostProtocolFailure(status, { code, requestId: request.requestId, retryable: false }); }
/** Capsule owns composition and admission; original runtime owns every execution/checkpoint. */
export function createWorkflowWorkbench(options: {
    workDir: string;
    stateDir: string;
    globalRoot?: string;
    runtimeConfig?: Omit<SessionRuntimeConfig, 'workDir' | 'globalRoot' | 'profileId'>;
    resources: HostResourceEffects;
    check: (request: HostRequest, action: 'discover' | 'read' | 'start' | 'resume', runId?: string) => void;
    serverInstanceId: string;
    taskTreeEffects?:WorkflowTaskTreeEffects;
    taskTreeAuthority?:Readonly<{daemonId:string;workspaceKey:string}>;
}) {
    const scopes = new Map<string, Promise<Scope>>(), cursorSecret = randomBytes(32);
    let closed = false, pendingRequests = 0, activeExecutions = 0;
    async function scope(request: HostRequest) {
        if (closed)
            missing(request, 'host_closed', 503);
        const key = request.principal.principalId, existing = scopes.get(key);
        if (existing)
            return existing;
        if (scopes.size >= 32)
            missing(request, 'workflow_runtime_capacity', 429);
        const opening = (async () => {
            const store = await openWorkflowWorkbenchStore(options.stateDir, key);
            let ready!: SessionRuntimeReady;
            const bridge = await createSessionRuntimeAssembly({ sessionKey: 'workflow-' + workflowDigest([options.workDir, key]).slice(0, 40), ownedSessionDir: store.sessionDir,
                requireExplicitGoalActivation: true, preserveRecoveredModel: true, toolResources: options.resources,
                config: { ...options.runtimeConfig, workDir: options.workDir, globalRoot: options.globalRoot, profileId: 'ai-coding' }, onRuntimeReady(value) { ready = value; } });
            if (!bridge)
                missing(request, 'workflow_runtime_unavailable', 503);
            const admissions = new Map<string, () => void>(), requests = new Map<string, HostRequest>();
            let service!: RuntimeService, observationLane = Promise.resolve(), observationError: unknown;
            const questionIdentities = new Map<string, Set<string>>();
            const observeQuestion = (row: import('@cell/ai-core-contract/runtime/Questionnaire').QuestionnaireRow) => {
                const copied = JSON.parse(JSON.stringify(row)) as typeof row;
                observationLane = observationLane.then(async () => {
                    const evidence = readWorkflowPublicRuntimeEvidence(ready.vm).find(run => run.nodeExecutions.some(node => node.actorId === copied.ownerActorId && node.actorKey === copied.ownerActorKey));
                    if (!evidence)
                        throw new Error('workflow_question_owner_unavailable');
                    const admitted = (await service.facts.readRunEvents(evidence.runId)).find(event => event.type === 'workflow.actor.admitted' && (event.payload as any)?.actorId === copied.ownerActorId && (event.payload as any)?.actorKey === copied.ownerActorKey);
                    if (!admitted)
                        throw new Error('workflow_question_source_unavailable');
                    const backend = Boolean(getLocalPermissionApprovalContext(copied.request) || getWorkspaceAccessGrantContext(copied.request));
                    const payload = { authority: 'derived-questionnaire-observation', actorId: copied.ownerActorId, actorKey: copied.ownerActorKey, questionnaireId: copied.questionnaireId, kind: backend ? 'backend_approval' : 'domain_question', state: copied.status, title: copied.request.title ?? 'Input required', ...(backend ? {} : { questions: workflowPublicValue(copied.request.questions) }) };
                    const eventId = 'question:' + workflowDigest([admitted.eventId, payload]);
                    if (!(await service.facts.readRunEvents(evidence.runId)).some(event => event.eventId === eventId))
                        await service.facts.appendRunEvent({ workflow: { ref: evidence.definitionRef, scheme: 'resource' }, runId: evidence.runId, generation: admitted.generation }, { eventId, runId: evidence.runId, generation: admitted.generation, nodeId: admitted.nodeId, type: 'workflow.question.observed', atMs: Date.now(), payload });
                }).catch(error => { observationError = error; });
            };
            ready.vm.effects.questionnaires = { admit({ actor, request: question }) {
                    const evidence = readWorkflowPublicRuntimeEvidence(ready.vm).find(run => run.nodeExecutions.some(node => node.actorId === actor.id && node.actorKey === actor.key));
                    const current = evidence && requests.get(evidence.runId);
                    if (!evidence || !current || !addressedExecutionControl(ready.vm, actor.id))
                        throw new Error('workflow_question_owner_unavailable');
                    options.check(current, 'resume', evidence.runId);
                    const rows = Object.values(ready.vm.sessionState.questionnaires);
                    if (rows.length >= 512 || rows.some(row => row.questionnaireId === question.questionnaireId) || rows.filter(row => row.ownerActorId === actor.id).length >= 8 || Buffer.byteLength(JSON.stringify(question)) > 16384)
                        throw new Error('workflow_question_capacity');
                    workflowPublicValue(question);
                    const identities = questionIdentities.get(actor.id) ?? new Set<string>();
                    if (identities.size >= 8 && !identities.has(question.questionnaireId))
                        throw new Error('workflow_question_capacity');
                    questionIdentities.set(actor.id, identities);
                    return { publish(row) { if (row.ownerActorId !== actor.id || row.ownerActorKey !== actor.key)
                            throw new Error('workflow_question_identity_mismatch'); identities.add(row.questionnaireId); observeQuestion(row); }, release() { } };
                }, transitioned: observeQuestion };
            const taskTrees=options.taskTreeEffects&&options.taskTreeAuthority?createWorkflowTaskTreeNodePort({effects:options.taskTreeEffects,authority:options.taskTreeAuthority,
                facts:{readTaskTreeIntent:(...args)=>service.facts.readTaskTreeIntent(...args),recordTaskTreeIntent:(...args)=>service.facts.recordTaskTreeIntent(...args)},interrupted:()=>closed,request(identity){
                    const current=requests.get(identity.runId)??request;options.check(current,'resume',identity.runId);return current;
                }}):undefined;
            service = getWorkflowRuntimeService({ vm: ready.vm, actor: ready.actor } as any, { observeCheckpoints: true, onExecutionPaused: async () => { await ready.checkpointWithoutExecution(); }, onCheckpointObserved: async (checkpoint) => { admissions.get(checkpoint.runId)?.(); },...(taskTrees?{taskTrees}:{}) });
            return { store, ready, bridge, service, lane: Promise.resolve(), active: 0, executions: new Map<string, Promise<WorkflowCommandResult>>(), admissions, requests, get observationLane() { return observationLane; }, get observationError() { return observationError; } };
        })();
        scopes.set(key, opening);
        opening.catch(() => { if (scopes.get(key) === opening)
            scopes.delete(key); });
        return opening;
    }
    async function inLane<T>(request: HostRequest, action: 'discover' | 'read' | 'start' | 'resume', runId: string | undefined, body: (scope: Scope) => Promise<T>): Promise<T> {
        options.check(request, action, runId);
        const runtime = await scope(request);
        if (runtime.active >= 32)
            missing(request, 'workflow_request_capacity', 429);
        runtime.active++;
        pendingRequests++;
        const invoke = async () => { options.check(request, action, runId); if (closed)
            missing(request, 'host_closed', 503); return body(runtime); };
        // Queries observe original atomic checkpoints while the model/effect is live.
        const mutation = action === 'start' || action === 'resume';
        const next = mutation ? runtime.lane.then(invoke) : invoke();
        if (mutation)
            runtime.lane = next.catch(() => { });
        try {
            const value = await next;
            try {
                options.check(request, action, runId);
            }
            catch (error) {
                if (action === 'start' || action === 'resume')
                    throw new HostProtocolFailure(403, { code: 'forbidden', requestId: request.requestId, retryable: false, state: 'unknown' });
                throw error;
            }
            return value;
        }
        finally {
            runtime.active--;
            pendingRequests--;
        }
    }
    function cursor(request: HostRequest, kind: string, offset: number) {
        const body = Buffer.from(JSON.stringify([request.principal.principalId, request.principal.grantsVersion, kind, offset])).toString('base64url');
        return body + '.' + createHmac('sha256', cursorSecret).update(body).digest('base64url');
    }
    function offset(request: HostRequest, kind: string, value?: string) {
        if (!value)
            return 0;
        const [body, signature, ...extra] = value.split('.');
        if (extra.length || signature !== createHmac('sha256', cursorSecret).update(body ?? '').digest('base64url'))
            missing(request, 'workflow_cursor_invalid', 409);
        const binding = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
        if (binding[0] !== request.principal.principalId || binding[1] !== request.principal.grantsVersion || binding[2] !== kind || !Number.isSafeInteger(binding[3]) || binding[3] < 0)
            missing(request, 'workflow_cursor_invalid', 409);
        return binding[3] as number;
    }
    async function ownedRun(runtime: Scope, request: HostRequest, runId: string) {
        const record = (await runtime.store.list()).find(item => item.command.kind === 'start' && item.runId === runId);
        if (!record)
            missing(request, 'workflow_run_not_found');
        const observation = await runtime.service.observeCheckpoint(runId), status = observation?.status;
        if (!status)
            missing(request, 'workflow_run_outcome_unknown', 409);
        if (status.instance_id !== record.instanceId)
            missing(request, 'workflow_run_identity_mismatch', 409);
        return { record, status, observation: observation! };
    }
    async function materials(runtime: Scope, request: HostRequest, runId: string): Promise<WorkflowMaterial[]> {
        await ownedRun(runtime, request, runId);
        const receipt = await runtime.service.facts.loadRunReceipt(runId);
        if (!receipt)
            return [];
        const refs = [...receipt.inputMaterials.map(binding => ({ direction: 'input' as const, nodeId: binding.nodeId, port: binding.port, ...binding.material })), ...receipt.outputMaterials.map(ref => ({ direction: 'output' as const, ...ref }))];
        if (refs.length > 64)
            missing(request, 'workflow_material_capacity', 413);
        return Promise.all(refs.map(async (ref) => {
            const material = await runtime.service.materials.inspect(ref);
            if (material.manifest.length > 256)
                missing(request, 'workflow_material_capacity', 413);
            const nodeId = 'nodeId' in ref ? ref.nodeId : typeof material.provenance.nodeId === 'string' ? material.provenance.nodeId : undefined;
            return { ...ref, ...(nodeId ? { nodeId } : {}), files: material.manifest.map(file => ({ ...file })) };
        }));
    }
    async function executionSources(runtime: Scope, request: HostRequest, runId: string,currentStatus?:Record<string,any>): Promise<WorkflowExecutionSource[]> {
        await runtime.observationLane;
        if (runtime.observationError)
            missing(request, 'workflow_event_history_gap', 409);
        const events = await runtime.service.facts.readRunEvents(runId);
        if (events.length > 16384)
            missing(request, 'workflow_event_capacity', 413);
        const status=currentStatus??(await runtime.service.observeCheckpoint(runId))?.status;
        const surface = await runtime.bridge.getActorSurface!(), sources: WorkflowExecutionSource[] = [];
        for (const event of events) {
            if (event.type !== 'workflow.actor.admitted')
                continue;
            const payload = event.payload as any;
            if (typeof event.nodeId !== 'string' || !['actorId', 'actorKey', 'agentDefinitionRef'].every(key => typeof payload?.[key] === 'string'))
                missing(request, 'workflow_execution_source_invalid', 409);
            const actor = runtime.ready.vm.actors[payload.actorKey], owner = actor?.id === payload.actorId ? actor : undefined;
            const lane = surface.actorLanes.find(lane => lane.actorId === payload.actorId && lane.actorKey === payload.actorKey);
            const questions = surface.questionnaireSurface.filter(row => row.ownerActorId === payload.actorId && row.ownerActorKey === payload.actorKey).map(row => {
                const backend = Boolean(getLocalPermissionApprovalContext(row.request) || getWorkspaceAccessGrantContext(row.request));
                const current=Boolean(status&&workflowExecutionGenerationCurrent(status,{nodeId:event.nodeId!,generation:event.generation}));
                const canAnswer = current && !backend && row.lifecycleState === 'pending' && Boolean(owner && addressedExecutionControl(runtime.ready.vm, owner.id));
                return { questionnaireId: row.questionnaireId, kind: backend ? 'backend_approval' as const : 'domain_question' as const, state: row.lifecycleState, title: row.request.title ?? 'Input required', ...(backend ? {} : { questions: workflowPublicValue(row.request.questions) }), canAnswer, ...(canAnswer ? {} : { unavailableReason: backend ? 'backend_approval_required' : !current?'workflow_node_generation_changed':row.lifecycleState === 'pending' ? 'original_execution_not_active' : 'question_not_pending' }) };
            });
            const historical = new Map<string, typeof questions[number]>();
            for (const questionEvent of events) {
                const fact = questionEvent.payload as any;
                if (questionEvent.type !== 'workflow.question.observed' || questionEvent.generation !== event.generation || questionEvent.nodeId !== event.nodeId || fact?.actorId !== payload.actorId || fact.actorKey !== payload.actorKey)
                    continue;
                historical.set(fact.questionnaireId, { questionnaireId: fact.questionnaireId, kind: fact.kind, state: fact.state, title: fact.title, ...(fact.kind === 'domain_question' ? { questions: workflowPublicValue(fact.questions) } : {}), canAnswer: false, unavailableReason: fact.state === 'pending' ? 'original_execution_not_active' : 'question_not_pending' });
            }
            for (const question of questions)
                historical.set(question.questionnaireId, question);
            questions.splice(0, questions.length, ...historical.values());
            if (questions.length > 8)
                missing(request, 'workflow_question_capacity', 413);
            sources.push({ sourceRef: event.eventId, nodeId: event.nodeId, generation: event.generation, actorId: payload.actorId, actorKey: payload.actorKey, agentDefinitionRef: payload.agentDefinitionRef, status: lane?.runtimeStatus ?? 'owner_unavailable', questions });
            if (sources.length > 128)
                missing(request, 'workflow_execution_source_capacity', 413);
        }
        return sources;
    }
    async function result(runtime: Scope, request: HostRequest, record: WorkflowAdmissionRecord): Promise<WorkflowCommandResult> {
        if (record.result)
            return { ...record.result, replayed: true };
        // A pending start may have reached the original owner. Only observe; start can dispatch.
        if (record.command.kind === 'start') {
            const status = (await runtime.service.observeCheckpoint(record.runId))?.status;
            if (status?.instance_id === record.instanceId) {
                const recovered: WorkflowCommandResult = { commandId: record.commandId, state: 'completed', runId: record.runId, instanceId: record.instanceId, replayed: true };
                await runtime.store.save({ ...record, result: recovered });
                return recovered;
            }
        }
        return { commandId: record.commandId, state: 'unknown', runId: record.runId, instanceId: record.instanceId, replayed: true, errorCode: 'workflow_command_outcome_unknown' };
    }
    return {
        async definitions(request: HostRequest) {
            return inLane(request, 'discover', undefined, async (runtime) => {
                const native = await runtime.service.listTypes();
                if (native.length > 128)
                    missing(request, 'workflow_definition_capacity', 413);
                const definitions = await Promise.all(native.map(item => runtime.service.previewInstanceDefinition(item.workflowRef).then(workflowDefinition)));
                return { workspaceId: options.workDir, definitions, unsupported };
            });
        },
        async runs(request: HostRequest, input: {
            after?: string;
            limit?: number;
        }) {
            return inLane(request, 'read', undefined, async (runtime) => {
                const records = (await runtime.store.list()).filter(item => item.command.kind === 'start').reverse(), start = offset(request, 'runs', input.after), selected = records.slice(start, start + (input.limit ?? 50));
                const runs = [];
                for (const record of selected) {
                    const status = (await runtime.service.observeCheckpoint(record.runId))?.status;
                    if (status) {
                        options.check(request, 'read', record.runId);
                        runs.push(workflowRunSummary(status, record.createdAt, record.source));
                    }
                }
                return { workspaceId: options.workDir, runs, ...(start + selected.length < records.length ? { nextCursor: cursor(request, 'runs', start + selected.length) } : {}) };
            });
        },
        async run(request: HostRequest, runId: string): Promise<WorkflowRunView> {
            return inLane(request, 'read', runId, async (runtime) => {
                const { record, status, observation } = await ownedRun(runtime, request, runId), instance = await runtime.service.getInstance(record.instanceId), nativeResult = workflowRunResult(status);
                let canResume=false;try{options.check(request,'resume',runId);canResume=true}catch{}
                const waits = (status.open_wait_handles ?? []).map((handle: any) => ({ signalKind: handle.signalKind, signalKey: handle.signalKey, resumeToken: handle.resumeToken, canResume:canResume&&handle.metadata?.taskTree?.kind!=='eidolon.workflow-tasktree-wait', ...(typeof handle.nodeKey === 'string' ? { nodeId: handle.nodeKey } : {}),...(handle.metadata?.taskTree?.kind==='eidolon.workflow-tasktree-wait'?{taskTree:true}:{}) }));
                const executing = runtime.executions.has(runId);
                const dataResumes = observation.dataResumes.map(contract => executing && contract.canResume ? { ...contract, canResume: false, unavailableReason: 'workflow_execution_in_progress' } : contract);
                const frozenDefinition=workflowDefinition(await runtime.service.instanceDefinition(record.instanceId));
                const taskTrees=options.taskTreeAuthority?await Promise.all((await runtime.service.facts.listTaskTreeNodeBindings(runId)).map(async fact=>{
                    const current=status.form==='AICtrlWorkflow'?status.open_wait_handles?.some((h:any)=>h.nodeKey===fact.identity.nodeId&&h.invocationKey===fact.identity.invocationKey&&h.metadata?.taskTree?.kind==='eidolon.workflow-tasktree-wait'):dataResumes.some(row=>row.nodeId===fact.identity.nodeId&&row.unavailableReason==='workflow_tasktree_result_required')&&workflowExecutionGenerationCurrent(status,{nodeId:fact.identity.nodeId,generation:fact.identity.generation});
                    let permitted=true;try{options.check(request,'resume',runId)}catch{permitted=false}
                    return {nodeId:fact.identity.nodeId,generation:fact.identity.generation,invocationKey:fact.identity.invocationKey,taskSpaceId:fact.taskSpaceId!,rootId:workflowTaskTreeRootId({...options.taskTreeAuthority!,...fact.identity}),admitted:Boolean(await runtime.service.facts.readTaskTreeIntent(fact.identity,'root-admitted')),canResume:Boolean(current&&!status.terminal&&permitted)};
                })):undefined;
                const executionState = executing ? 'active' : status.terminal || waits.length > 0 || observation.dataResumes.some(contract => contract.canResume) ? 'idle' : 'interrupted';
                return { workspaceId: options.workDir, run: workflowRunSummary(status, record.createdAt, record.source), definition:frozenDefinition,structure:workflowRunStructure(observation.checkpoint.profile,frozenDefinition), input: workflowPublicValue(instance?.input), executionState, executionSources: await executionSources(runtime, request, runId,status),...(taskTrees?{taskTrees}:{}), nodes: workflowNodes(status), waits, result: workflowPublicValue(nativeResult), materials: await materials(runtime, request, runId), dataResumes, unsupported };
            });
        },
        async events(request: HostRequest, input: {
            runId: string;
            after?: string;
            limit?: number;
        }): Promise<WorkflowEventPage> {
            return inLane(request, 'read', input.runId, async (runtime) => {
                await ownedRun(runtime, request, input.runId);
                await runtime.observationLane;
                if (runtime.observationError)
                    missing(request, 'workflow_event_history_gap', 409);
                let native: Awaited<ReturnType<RuntimeService['events']>>;
                try {
                    native = await runtime.service.events(input.runId);
                }
                catch (error) {
                    if (error instanceof SyntaxError)
                        missing(request, 'workflow_event_history_gap', 409);
                    throw error;
                }
                const all = native?.entries ?? [], start = offset(request, 'events:' + input.runId, input.after);
                if (all.length > 16384)
                    missing(request, 'workflow_event_capacity', 413);
                if (start > all.length)
                    missing(request, 'workflow_cursor_gap', 409);
                const selected = all.slice(start, start + (input.limit ?? 50)), next = cursor(request, 'events:' + input.runId, start + selected.length);
                const entries = selected.map((event: any, index: number) => ({ eventId: event.eventId, seq: start + index, runId: input.runId, generation: event.generation, ...(typeof event.nodeId === 'string' ? { nodeId: event.nodeId } : {}), kind: event.type, ...(Number.isSafeInteger(event.atMs) ? { occurredAt: new Date(event.atMs).toISOString() } : {}), data: workflowPublicValue(event) }));
                return { runId: input.runId, entries, cursor: next, hasMore: start + selected.length < all.length, ...(start + selected.length < all.length ? { nextCursor: next } : {}) };
            });
        },
        async command(request: HostRequest, command: WorkflowCommand): Promise<WorkflowCommandResult> {
            return inLane(request, command.kind === 'start' ? 'start' : 'resume', command.kind === 'start' ? undefined : command.runId, async (runtime) => {
                const previous = await runtime.store.read(command.commandId);
                if (previous) {
                    if (previous.fingerprint !== workflowDigest(command))
                        missing(request, 'workflow_command_identity_conflict', 409);
                    return result(runtime, request, previous);
                }
                if (command.expectedServerInstanceId !== options.serverInstanceId)
                    missing(request, 'server_instance_mismatch', 409);
                if (command.kind !== 'answer_question' && runtime.executions.size >= 8)
                    missing(request, 'workflow_execution_capacity', 429);
                const identity = workflowDigest([options.workDir, request.principal.principalId, command.commandId]).slice(0, 40);
                let runId = 'workflow-' + identity, instanceId = 'instance-' + identity, source = command.kind === 'start' ? command.source : undefined;
                if (command.kind !== 'start') {
                    if (command.kind !== 'answer_question' && runtime.executions.has(command.runId))
                        missing(request, 'workflow_execution_in_progress', 409);
                    const owned = await ownedRun(runtime, request, command.runId);
                    if (owned.status.generation !== command.expectedGeneration)
                        missing(request, 'workflow_generation_conflict', 409);
                    if (owned.status.terminal)
                        missing(request, 'workflow_run_terminal', 409);
                    if (command.kind === 'resume_ctrl') {
                        if (owned.status.form !== 'AICtrlWorkflow' || !owned.status.open_wait_handles?.some((handle: any) => handle.signalKind === command.signalKind && handle.signalKey === command.signalKey && handle.resumeToken === command.resumeToken))
                            missing(request, 'workflow_wait_changed', 409);
                        const handle=owned.status.open_wait_handles.find((h:any)=>h.resumeToken===command.resumeToken);
                        if(handle?.metadata?.taskTree?.kind==='eidolon.workflow-tasktree-wait')missing(request,'workflow_tasktree_result_required',409);
                    }
                    else if(command.kind==='resume_tasktree'){
                        const bindings=await runtime.service.facts.listTaskTreeNodeBindings(command.runId);
                        if(!bindings.some(fact=>fact.identity.nodeId===command.nodeId&&fact.identity.invocationKey===command.invocationKey&&workflowExecutionGenerationCurrent(owned.status,{nodeId:command.nodeId,generation:fact.identity.generation})))missing(request,'workflow_tasktree_wait_changed',409);
                        const waiting=owned.status.form==='AICtrlWorkflow'?owned.status.open_wait_handles?.some((h:any)=>h.nodeKey===command.nodeId&&h.invocationKey===command.invocationKey&&h.metadata?.taskTree?.kind==='eidolon.workflow-tasktree-wait'):owned.observation.dataResumes.some(row=>row.nodeId===command.nodeId&&row.unavailableReason==='workflow_tasktree_result_required');
                        if(!waiting)missing(request,'workflow_tasktree_wait_changed',409);
                    }
                    else if (command.kind === 'resume_data') {
                        if (owned.status.form !== 'AIDataWorkflow')
                            missing(request, 'workflow_wait_changed', 409);
                        const contract = await runtime.service.dataNodeResumeContract(command.runId, command.nodeId);
                        if (!contract?.canResume)
                            missing(request, contract?.unavailableReason ?? 'workflow_wait_changed', 409);
                        try {
                            await runtime.service.validateDataNodeResume(command.runId, command.nodeId, command.output);
                        }
                        catch {
                            missing(request, 'workflow_output_schema_invalid', 400);
                        }
                    }
                    if (command.kind === 'answer_question') {
                        const original = (await executionSources(runtime, request, command.runId,owned.status)).find(source => source.sourceRef === command.sourceRef && source.nodeId === command.nodeId && workflowExecutionGenerationCurrent(owned.status,source) && source.actorId === command.actorId);
                        if (!original?.questions.some(question => question.questionnaireId === command.questionnaireId && question.canAnswer))
                            missing(request, 'workflow_question_not_pending', 409);
                    }
                    runId = command.runId;
                    instanceId = owned.record.instanceId;
                    source = owned.record.source;
                }
                const record: WorkflowAdmissionRecord = { commandId: command.commandId, fingerprint: workflowDigest(command), command, runId, instanceId, source: source!, createdAt: Date.now() };
                await runtime.store.save(record);
                try {
                    if (command.kind === 'start') {
                        await runtime.service.createInstance({ workflowRef: command.workflowRef, instanceId, initialInput: command.input, idempotencyKey: command.commandId, expectedDefinitionRevision: command.definitionRevision });
                        runtime.ready.activateSessionMaterialization();
                        await runtime.ready.persistSnapshot();
                    }
                    options.check(request, command.kind === 'start' ? 'start' : 'resume', runId);
                    if (command.kind === 'answer_question') {
                        const facade = createActorSurfaceFacade(runtime.ready.vm, { emitFiberSignal(value) {
                                const control = addressedExecutionControl(runtime.ready.vm, value.actor.id);
                                if (value.actor.id !== command.actorId || !control || control.fiberId !== value.fiberId)
                                    missing(request, 'workflow_question_owner_unavailable', 409);
                                control.signal({ signalKind: value.signalKind, mailbox: value.mailbox as any, toolCallId: value.toolCallId, idempotencyKey: 'workflow-answer:' + command.commandId, createdAt: value.createdAt });
                            } });
                        if (facade.submitQuestionnaireResponse(command.questionnaireId, command.responseText).status !== 'submitted')
                            missing(request, 'workflow_question_not_pending', 409);
                        const receipt: WorkflowCommandResult = { commandId: command.commandId, state: 'completed', runId, instanceId, replayed: false };
                        await runtime.store.save({ ...record, result: receipt });
                        return receipt;
                    }
                    runtime.requests.set(runId, request);
                    let admitted!: () => void;
                    const admission = new Promise<void>(resolve => { admitted = resolve; });
                    runtime.admissions.set(runId, admitted);
                    const completed: WorkflowCommandResult = { commandId: command.commandId, state: 'completed', runId, instanceId, replayed: false };
                    activeExecutions++;
                    const execution = (async (): Promise<WorkflowCommandResult> => {
                        try {
                            if (command.kind === 'start')
                                await runtime.service.start({ instanceId, runId, confirmed: true });
                            else if (command.kind === 'resume_ctrl')
                                await runtime.service.resume(runId, { signalKind: command.signalKind, signalKey: command.signalKey, resumeToken: command.resumeToken, outcome: command.outcome, payload: command.payload });
                            else if(command.kind==='resume_tasktree')
                                await runtime.service.continueTaskTreeNode(runId,command.nodeId,command.invocationKey,workflowDigest([request.principal.principalId,command.commandId]));
                            else
                                await runtime.service.resumeDataNode(runId, command.nodeId, command.output);
                            await runtime.observationLane;
                            if (runtime.observationError)
                                throw runtime.observationError;
                            await runtime.ready.persistSnapshot();
                            return completed;
                        }
                        catch {
                            return { commandId: command.commandId, state: 'unknown', runId, instanceId, errorCode: 'workflow_command_outcome_unknown', replayed: false };
                        }
                        finally {
                            activeExecutions--;
                            runtime.admissions.delete(runId);
                            runtime.executions.delete(runId);
                            runtime.requests.delete(runId);
                        }
                    })();
                    runtime.executions.set(runId, execution);
                    // Completion here is durable command admission, not workflow terminal status.
                    const receipt = await Promise.race([admission.then(() => completed), execution]);
                    await runtime.store.save({ ...record, result: receipt });
                    return receipt;
                }
                catch (error) {
                    if (error instanceof Error && error.message === 'workflow_definition_revision_conflict') {
                        const rejected: WorkflowCommandResult = { commandId: command.commandId, state: 'rejected', errorCode: 'workflow_definition_revision_conflict', replayed: false };
                        await runtime.store.save({ ...record, result: rejected });
                        return rejected;
                    }
                    // Persisted intent has crossed the execution boundary. Never classify arbitrary failures as retryable.
                    return { commandId: command.commandId, state: 'unknown', runId, instanceId, errorCode: 'workflow_command_outcome_unknown', replayed: false };
                }
            });
        },
        async commandResult(request: HostRequest, commandId: string) {
            return inLane(request, 'read', undefined, async (runtime) => {
                const record = await runtime.store.read(commandId);
                if (!record)
                    missing(request, 'workflow_command_not_found');
                return result(runtime, request, record);
            });
        },
        async material(request: HostRequest, input: WorkflowMaterialRead) {
            return inLane(request, 'read', input.runId, async (runtime) => {
                const owned = (await materials(runtime, request, input.runId)).find(ref => ref.materialRef === input.materialRef && ref.revision === input.revision), file = owned?.files.find(file => file.path === input.path);
                if (!owned || !file)
                    missing(request, 'workflow_material_not_found');
                const start = input.offsetBytes ?? 0, bytes = await runtime.store.materialBytes(runtime.service.facts.materialContentRoot(input.revision), input.path, file.digest, file.size, start, input.limitBytes ?? 32768), end = start + bytes.byteLength;
                return { runId: input.runId, materialRef: input.materialRef, revision: input.revision, path: input.path, digest: file.digest, sizeBytes: file.size, offsetBytes: start, bytesBase64: bytes.toString('base64'), ...(end < file.size ? { nextOffsetBytes: end } : {}) };
            });
        },
        isBusy() { return pendingRequests > 0 || activeExecutions > 0; },
        async close() {
            closed = true;
            for (const opening of scopes.values()) {
                const runtime = await opening.catch(() => undefined);
                if (runtime) {
                    for (const actor of Object.values(runtime.ready.vm.actors))
                        addressedExecutionControl(runtime.ready.vm, actor.id)?.stop('workflow_host_shutdown');
                    await runtime.lane;
                    await Promise.allSettled(runtime.executions.values());
                    await runtime.observationLane;
                    await runtime.bridge.dispose();
                }
            }
            scopes.clear();
        },
    };
}
