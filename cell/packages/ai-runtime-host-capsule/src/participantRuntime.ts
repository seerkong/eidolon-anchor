import { createHash } from 'node:crypto';
import type { HostAuthorizationEffects, HostRequest, HostParticipantBindingReceipt, HostParticipantSendCommand, HostParticipantDelivery, HostExecutionOutputPage, HostParticipantExecutionSource, HostParticipantWorkPage, HostParticipantWork, HostParticipantControlCommand } from '@cell/ai-runtime-host-contract';
import type { QuestionnairePublicationEffects } from '@cell/ai-core-contract';
import { parseHostParticipantWorkPage } from '@cell/ai-runtime-host-contract';
import { createActorSurfaceFacade } from '@cell/ai-core-logic/runtime/ActorSurface';
import { cancelQuestionnaireRow } from '@cell/ai-core-logic/runtime/QuestionnaireRows';
import { addressedExecutionControl } from '@cell/ai-organ-logic/agent/AddressedExecutionActivation';
import type { ActorCommittedMessageRef } from '@cell/ai-organ-contract';
import { getVmConversationDomainRuntime } from '@cell/ai-organ-logic/conversation/ConversationDomainRuntime';
import type { ExecutionOutputStore, StoredExecutionIntent } from '@cell/ai-runtime-host-support';
import { executionRequestRef, createPublicMessageRead, measurePublicMessage, readPublicMessageBytes } from '@cell/ai-runtime-host-support';
import { deriveHolonTaskRequestIdentity } from '@cell/ai-organ-logic/organization/HolonTaskRequestIdentity';
import type { HolonExecutionAdapterInput } from '@cell/ai-organ-logic/organization/HolonLocalActorRuntime';
import { HostProtocolFailure, AttachmentStoreFailure } from '@cell/ai-runtime-host-logic';
import type { createParticipantAttachments } from './participantAttachments';
import type { HolonTaskRuntimeInvocation, HolonTaskIdentitySelector } from '@cell/ai-organ-contract';
import { HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION } from '@cell/ai-organ-contract';
import { assignHolonTaskThroughMountedCapability } from '@cell/ai-organ-logic/organization/HolonTaskRuntimeCapability';
import type { SessionRuntimeReady } from './session/SessionRuntimeAssembly';
import type { OpenedLocalHolonTaskRuntime } from './session/LocalHolonTaskRuntimeBootstrap';
import { projectParticipantConversation } from './participantConversation';
import { projectParticipantResultText } from './participantResultText';
/** Application adapter over the existing admitted task service; owns no task state. */
export function createParticipantRuntime(runtime: Readonly<{
    ready: SessionRuntimeReady;
    holon: OpenedLocalHolonTaskRuntime;
    binding: HostParticipantBindingReceipt & {
        principalId: string;
    };
    authorization: HostAuthorizationEffects;
    now(): number;
    isClosed(): boolean;
    outputs?: ExecutionOutputStore;
    modelCatalog?: () => {
        models: readonly {
            providerId: string;
            modelId: string;
        }[];
        error?: string;
    };
    setModel?: (modelRef: string) => Promise<void>;
    attachments?: ReturnType<typeof createParticipantAttachments>;
}>) {
    let modelChanging = false, submitting = 0;
    const settings = () => {
        if (!runtime.modelCatalog)
            return undefined;
        const catalog = runtime.modelCatalog(), model = runtime.ready.actor.modelConfig, busy = modelChanging || submitting > 0 || runtime.holon.support.isBusy();
        let inputSchema: unknown;
        try { inputSchema = runtime.holon.inputSchema(runtime.binding.recipient.admissionRef!); }
        catch (error) { if (error instanceof Error && error.message === 'participant_admission_mismatch') return undefined; throw error; }
        const inputSchemaJson = JSON.stringify(inputSchema);
        if (!inputSchemaJson || inputSchemaJson.length > 65536)
            throw new Error('participant_input_schema_unavailable');
        return { models: catalog.models, ...(model.provider && model.model ? { modelRef: `${model.provider}/${model.model}` } : {}), canSetModel: !busy && !catalog.error,
            ...(busy ? { modelUnavailableReason: 'channel_busy' } : catalog.error ? { modelUnavailableReason: catalog.error } : {}), inputSchemaJson, ...runtime.attachments?.settings() };
    };
    const check = (request: HostRequest, action: 'observe' | 'send_text' | 'answer_question' | 'cancel_turn' | 'set_model' | 'upload_attachment') => {
        const target = { kind: 'actor' as const, sessionId: runtime.binding.sessionId, actorId: runtime.ready.actor.id, action };
        if (runtime.isClosed())
            throw new HostProtocolFailure(409, { code: 'session_closing', requestId: request.requestId, retryable: false });
        if (runtime.binding.principalId !== request.principal.principalId
            || runtime.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion
            || !runtime.authorization.permits(request.principal, target))
            throw new HostProtocolFailure(403, { code: 'forbidden', requestId: request.requestId, retryable: false });
    };
    const selector = (request: HostRequest, value: HolonTaskIdentitySelector) => {
        check(request, 'observe');
        if (value.admissionId !== runtime.binding.recipient.admissionRef)
            throw new HostProtocolFailure(409, { code: 'participant_admission_mismatch', requestId: request.requestId, retryable: false });
        return value;
    };
    const scope = { principalId: runtime.binding.principalId, bindingKey: runtime.binding.bindingKey };
    const liveSources = new Map<string, {
        commandId: string;
        source: HostParticipantExecutionSource;
    }>();
    const stopExecutions = () => {
        for (const actorId of liveSources.keys())
            addressedExecutionControl(runtime.ready.vm, actorId)?.stop('session_closing');
        liveSources.clear();
    };
    let outputLane = Promise.resolve();
    const completeText = (record: ActorCommittedMessageRef) => {
        const read = createPublicMessageRead(record), size = measurePublicMessage(read);
        if (size > 512 * 1024)
            throw new Error('participant_publication_too_large');
        const decoded = JSON.parse(Buffer.from(readPublicMessageBytes(read, 0, size)).toString('utf8'));
        return decoded.parts.filter((part: any) => part.kind === 'text').map((part: any) => part.text).join('\n') as string;
    };
    const delivery = ({ command: _command, ...value }: StoredExecutionIntent): HostParticipantDelivery => value;
    const checkpoint = () => {
        outputLane = outputLane.catch(() => { }).then(async () => { runtime.ready.activateSessionMaterialization(); await runtime.ready.persistSnapshot(); });
        void outputLane.catch(() => { });
        return outputLane;
    };
    const workRecord = async (intent: StoredExecutionIntent): Promise<HostParticipantWork> => {
        const store = runtime.outputs!, executions = store.sources(scope, intent.commandId);
        const observation = await runtime.holon.capability.service.observe(intent.task).catch(error => {
            // An unacknowledged intent may have no canonical Task yet. Other inspection failures remain visible.
            if (intent.state === 'accepted' || intent.state === 'unknown')
                return undefined;
            throw error;
        });
        const questions = store.questionSources(scope).filter(q => q.commandId === intent.commandId).flatMap(source => {
            const row = runtime.ready.vm.sessionState.questionnaires[source.questionnaireId];
            if (!row || row.ownerActorId !== source.execution.actorId)
                return [];
            const live = addressedExecutionControl(runtime.ready.vm, source.execution.actorId);
            const canAnswer = row.status === 'pending' && Boolean(live) && !['Succeeded', 'Failed', 'Cancelled'].includes(observation?.status ?? '');
            return [{ questionnaireId: row.questionnaireId, execution: source.execution, title: row.request.title ?? '需要你的答复',
                    ...(row.request.intro ? { intro: row.request.intro } : {}), state: row.status === 'pending' ? 'pending' as const : row.status === 'answered' ? 'answered' as const : 'cancelled' as const, canAnswer,
                    ...(row.status === 'pending' && !canAnswer ? { unavailableReason: 'execution_not_active' } : {}),
                    questions: row.request.questions.map(q => ({ id: q.id, prompt: q.prompt, type: q.type, required: Boolean(q.required), choices: (q.choices ?? []).map(c => typeof c === 'string' ? { value: c, label: c } : { value: c.value, label: c.label ?? c.value }) })) }];
        });
        return { commandId: intent.commandId, task: intent.task, revision: observation?.revision ?? 0, status: observation?.status ?? 'SubmissionUnknown', attempt: observation?.attempt ?? 0,
            canCancel: Boolean(observation && !['Succeeded', 'Failed', 'Cancelled'].includes(observation.status)), executions, questions };
    };
    const work = async (request: HostRequest, input: {
        after?: number;
        limit?: number;
    } = {}): Promise<HostParticipantWorkPage> => {
        check(request, 'observe');
        await outputLane;
        const after = input.after ?? 0, limit = input.limit ?? 100;
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            throw new HostProtocolFailure(400, { code: 'invalid_schema', requestId: request.requestId, retryable: false });
        const intents = runtime.outputs!.listIntents(scope);
        if (after > intents.length)
            throw new HostProtocolFailure(409, { code: 'participant_work_cursor_invalid', requestId: request.requestId, retryable: false });
        const records = [];
        let bytes = 0;
        for (const intent of intents.slice(after, after + limit)) {
            const record = await workRecord(intent), size = Buffer.byteLength(JSON.stringify(record));
            if (records.length && bytes + size > 350 * 1024)
                break;
            if (size > 350 * 1024)
                throw new Error('participant_work_too_large');
            records.push(record);
            bytes += size;
        }
        check(request, 'observe');
        return { bindingKey: runtime.binding.bindingKey, sessionId: runtime.binding.sessionId, work: records, ...(after + records.length < intents.length ? { nextAfter: after + records.length } : {}), ...(runtime.modelCatalog ? { settings: settings() } : {}) };
    };
    const questionnaires: QuestionnairePublicationEffects = {
        admit({ actor, request }) {
            const live = liveSources.get(actor.id), store = runtime.outputs;
            if (!live || !store || runtime.ready.vm.actors[actor.key]?.id !== actor.id || !addressedExecutionControl(runtime.ready.vm, actor.id))
                throw new Error('participant_question_owner_missing');
            const grantsVersion = runtime.authorization.currentGrantsVersion(runtime.binding.principalId);
            if (runtime.isClosed() || !grantsVersion || !runtime.authorization.permits({ principalId: runtime.binding.principalId, grantsVersion }, { kind: 'actor', sessionId: runtime.binding.sessionId, actorId: actor.id, action: 'answer_question' }))
                throw new Error('participant_question_forbidden');
            const sources = store.questionSources(scope);
            // A questionnaire ID identifies one immutable source, including after it was answered.
            // Refuse reuse before the core owner mutates its row or mailbox.
            if (sources.some(q => q.questionnaireId === request.questionnaireId) || runtime.ready.vm.sessionState.questionnaires[request.questionnaireId])
                throw new Error('participant_question_id_conflict');
            const prior = sources.filter(q => q.commandId === live.commandId);
            if (sources.length >= 4096 || prior.length >= 64)
                throw new Error('participant_question_capacity');
            const previousBytes = prior.reduce((total, source) => total + Buffer.byteLength(JSON.stringify(runtime.ready.vm.sessionState.questionnaires[source.questionnaireId]?.request ?? {})), 0);
            if (previousBytes + Buffer.byteLength(JSON.stringify(request)) > 256 * 1024)
                throw new Error('participant_question_capacity');
            // Validate the complete public projection synchronously, before core row/mailbox writes.
            parseHostParticipantWorkPage({ bindingKey: scope.bindingKey, sessionId: runtime.binding.sessionId, work: [{ commandId: live.commandId, task: store.intent(scope, live.commandId)!.task,
                        revision: 0, status: 'Running', attempt: live.source.attempt, canCancel: true, executions: [live.source], questions: [{
                                questionnaireId: request.questionnaireId, execution: live.source, title: request.title ?? '需要你的答复', ...(request.intro ? { intro: request.intro } : {}), state: 'pending', canAnswer: true,
                                questions: request.questions.map(q => ({ id: q.id, prompt: q.prompt, type: q.type, required: Boolean(q.required), choices: (q.choices ?? []).map(c => typeof c === 'string' ? { value: c, label: c } : { value: c.value, label: c.label ?? c.value }) })),
                            }] }] });
            let released = false;
            return { publish(row) {
                    if (released || row.ownerActorId !== actor.id || row.ownerActorKey !== actor.key || row.questionnaireId !== request.questionnaireId || row.status !== 'pending')
                        throw new Error('participant_question_owner_mismatch');
                    const intent = store.intent(scope, live.commandId)!;
                    store.questionSource(scope, { questionnaireId: row.questionnaireId, commandId: live.commandId, execution: live.source });
                    const key = `question:${row.questionnaireId}`;
                    store.prepare(scope, { key, message: { commandId: live.commandId, kind: 'question', text: [request.title, request.intro, ...request.questions.map(q => q.prompt)].filter(Boolean).join('\n'),
                            artifactRefs: [], source: intent.task, execution: live.source, questionnaireId: row.questionnaireId } });
                    outputLane = checkpoint().then(() => { if (!released)
                        store.confirm(scope, key, runtime.now()); });
                    void outputLane.catch(() => { });
                }, release() { released = true; } };
        },
        transitioned() { void checkpoint().catch(() => { }); },
    };
    const assign = async (request: HostRequest, input: {
        commandId: string;
        input: HolonTaskRuntimeInvocation['input'];
        intent?: StoredExecutionIntent;
    }) => {
        check(request, 'send_text');
        const admissionId = runtime.binding.recipient.admissionRef;
        if (!admissionId || !runtime.holon.admissionIds.includes(admissionId))
            throw new HostProtocolFailure(409, { code: 'participant_recipient_unavailable', requestId: request.requestId, retryable: false });
        if (typeof input.commandId !== 'string' || !input.commandId.trim() || input.commandId.length > 256)
            throw new HostProtocolFailure(400, { code: 'invalid_schema', requestId: request.requestId, retryable: false });
        const requestId = input.intent?.requestRef ?? `execution-${createHash('sha256').update(JSON.stringify([runtime.binding.bindingKey, input.commandId])).digest('hex').slice(0, 40)}`;
        const invocation: HolonTaskRuntimeInvocation = {
            kind: 'holon-task-runtime-invocation', schemaVersion: HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
            requestId, idempotencyKey: requestId, replyMode: 'none', occurredAt: new Date(runtime.now()).toISOString(),
            origin: { kind: 'product', surface: 'a2a-holon-participant', requestRef: requestId },
            taskRequest: { kind: 'derive', name: `Participant ${input.commandId}` }, input: input.input,
        };
        const receipt = await assignHolonTaskThroughMountedCapability(runtime.ready.vm, { kind: 'admission', admissionId }, invocation);
        runtime.ready.activateSessionMaterialization();
        await runtime.ready.persistSnapshot();
        check(request, 'send_text');
        return receipt;
    };
    const reconcile = async (request: HostRequest) => {
        check(request, 'observe');
        const store = runtime.outputs;
        if (!store)
            throw new Error('participant_outputs_unavailable');
        // Recovery only observes canonical subscriptions and settlement; it never wakes tool work.
        const subscriptions = await runtime.holon.support.listSubscriptions();
        check(request, 'observe');
        await outputLane.catch(() => { });
        if (store.candidates(scope).length) {
            runtime.ready.activateSessionMaterialization();
            await runtime.ready.persistSnapshot();
            check(request, 'observe');
        }
        // A crash between snapshot and outbox commit can finish publication from exact committed records.
        const histories = Object.values(getVmConversationDomainRuntime(runtime.ready.vm)?.historyStateSignal.get() ?? {});
        for (const candidate of store.candidates(scope)) {
            if (candidate.message.kind === 'question') {
                const row = runtime.ready.vm.sessionState.questionnaires[candidate.message.questionnaireId!];
                if (row && row.ownerActorId === candidate.message.execution?.actorId)
                    store.confirm(scope, candidate.key, runtime.now());
                continue;
            }
            const source = candidate.message.execution;
            const history = histories.find(h => h.actorId === source?.actorId);
            const record = history?.generations.flatMap(g => g.messages).find(m => m.recordId === candidate.message.sourceMessageId);
            if (record && record.message.role === 'assistant' && completeText(record) === candidate.message.text)
                store.confirm(scope, candidate.key, runtime.now());
        }
        for (const intent of store.listIntents(scope)) {
            const subscription = subscriptions.find(s => s.admissionId === intent.task.admissionId && s.taskSpaceId === intent.task.taskSpaceId
                && s.taskId === intent.task.taskId && s.origin.kind === 'product' && s.origin.requestRef === intent.requestRef);
            if (!subscription)
                continue;
            store.delivery(scope, intent.commandId, 'submitted');
            const terminal = await runtime.holon.support.terminalResult(intent.task.taskSpaceId, intent.task.taskId);
            check(request, 'observe');
            if (!terminal || terminal.receipt.status !== 'Succeeded')
                continue;
            const key = `settlement:${terminal.receipt.commandId}`;
            const artifactRefs = terminal.task.outputArtifacts.map(a => a.digest);
            const committed = store.committedOutput(scope, key);
            if (committed) {
                if (committed.kind !== 'result' || committed.commandId !== intent.commandId
                    || committed.source.admissionId !== intent.task.admissionId
                    || committed.source.taskSpaceId !== intent.task.taskSpaceId
                    || committed.source.taskId !== intent.task.taskId
                    || committed.artifactRefs.length !== artifactRefs.length
                    || committed.artifactRefs.some((ref, index) => ref !== artifactRefs[index]))
                    throw new Error('participant_committed_source_conflict');
                // Committed execution material is immutable, including across projector upgrades.
                continue;
            }
            // Output-schema validation and canonical settlement, never silence, EOF, or tool completion.
            const text = projectParticipantResultText(terminal.result, runtime.holon.outputSchema(intent.task.admissionId));
            const sources = store.sources(scope, intent.commandId);
            store.publish(scope, key, { commandId: intent.commandId, kind: 'result', text,
                artifactRefs, source: intent.task,
                ...(sources.length === 1 ? { execution: sources[0] } : {}) }, runtime.now());
        }
        check(request, 'observe');
    };
    return {
        assign, work, questionnaires,
        conversation(input: HolonExecutionAdapterInput) {
            const store = runtime.outputs;
            if (!store) throw new Error('participant_outputs_unavailable');
            const intent=store.listIntents(scope).find(intent=>intent.task.taskSpaceId===input.taskAttempt.taskSpaceId&&intent.task.taskId===input.taskAttempt.taskId);
            if (!intent || intent.task.admissionId !== runtime.binding.recipient.admissionRef) throw new Error('participant_origin_not_found');
            return projectParticipantConversation(store.material(scope, intent.commandId));
        },
        attachment(request: HostRequest, input: import('@cell/ai-runtime-host-contract').HostParticipantAttachmentCommand) {
            check(request, 'upload_attachment');
            if (input.bindingKey !== scope.bindingKey)
                throw new HostProtocolFailure(409, { code: 'participant_binding_conflict', requestId: request.requestId, retryable: false });
            if (!runtime.attachments)
                throw new HostProtocolFailure(415, { code: 'participant_attachments_unavailable', requestId: request.requestId, retryable: false });
            try {
                return runtime.attachments.operate(request, input.operation);
            }
            catch (error) {
                if (error instanceof AttachmentStoreFailure)
                    throw new HostProtocolFailure(error.status, { code: error.code, requestId: request.requestId, retryable: false });
                throw error;
            }
        },
        async artifact(request: HostRequest, input: import('@cell/ai-runtime-host-contract').HostParticipantArtifactRead): Promise<import('@cell/ai-runtime-host-contract').HostParticipantArtifactChunk> {
            check(request, 'observe');
            if (input.bindingKey !== scope.bindingKey)
                throw new HostProtocolFailure(409, { code: 'participant_binding_conflict', requestId: request.requestId, retryable: false });
            const publication = runtime.outputs?.output(scope, input.outputId);
            if (!publication?.artifactRefs.includes(input.artifactRef))
                throw new HostProtocolFailure(404, { code: 'participant_artifact_not_found', requestId: request.requestId, retryable: false });
            // Exact task/receipt inspection and declared output membership, never a browser file path.
            selector(request, publication.source);
            const terminal = await runtime.holon.support.terminalSettlement(publication.source.taskSpaceId, publication.source.taskId);
            const declared = terminal?.task.outputArtifacts.find(a => a.digest === input.artifactRef);
            if (terminal?.receipt.status !== 'Succeeded' || !declared)
                throw new HostProtocolFailure(409, { code: 'participant_artifact_source_unavailable', requestId: request.requestId, retryable: false });
            const body = await runtime.holon.support.taskManager.owner.readArtifact(publication.source.taskSpaceId, declared.digest);
            if (!body || body.digest !== input.artifactRef || body.encoding !== 'base64')
                throw new HostProtocolFailure(404, { code: 'participant_artifact_not_found', requestId: request.requestId, retryable: false });
            const bytes = Buffer.from(body.data, 'base64'), offset = input.offsetBytes ?? 0;
            if (bytes.length !== body.sizeBytes)
                throw new Error('participant_artifact_size_mismatch');
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length)
                throw new HostProtocolFailure(400, { code: 'invalid_schema', requestId: request.requestId, retryable: false });
            const chunk = bytes.subarray(offset, offset + 32768), next = offset + chunk.length;
            check(request, 'observe');
            return { bindingKey: scope.bindingKey, outputId: publication.outputId, artifactRef: body.digest, mediaType: body.mediaType, totalBytes: bytes.length, offsetBytes: offset, data: chunk.toString('base64'), ...(next < bytes.length ? { nextOffset: next } : {}) };
        },
        async control(request: HostRequest, input: HostParticipantControlCommand): Promise<HostParticipantWorkPage> {
            check(request, input.kind === 'answer' ? 'answer_question' : input.kind === 'set_model' ? 'set_model' : 'cancel_turn');
            await outputLane;
            if (input.bindingKey !== runtime.binding.bindingKey)
                throw new HostProtocolFailure(409, { code: 'participant_binding_conflict', requestId: request.requestId, retryable: false });
            if (input.kind === 'set_model') {
                const current = settings();
                if (!runtime.setModel || !current?.canSetModel)
                    throw new HostProtocolFailure(409, { code: current?.modelUnavailableReason ?? 'model_selection_unavailable', requestId: request.requestId, retryable: false });
                if (!current.models.some(m => `${m.providerId}/${m.modelId}` === input.modelRef))
                    throw new HostProtocolFailure(400, { code: 'model_not_available', requestId: request.requestId, retryable: false });
                modelChanging = true;
                try {
                    check(request, 'set_model');
                    await runtime.setModel(input.modelRef);
                    await checkpoint();
                }
                finally {
                    modelChanging = false;
                }
                return work(request);
            }
            const intent = runtime.outputs!.intent(scope, input.commandId);
            if (!intent)
                throw new HostProtocolFailure(404, { code: 'participant_work_not_found', requestId: request.requestId, retryable: false });
            const record = await workRecord(intent);
            if (input.kind === 'answer') {
                const question = record.questions.find(q => q.questionnaireId === input.questionnaireId);
                const row = runtime.ready.vm.sessionState.questionnaires[input.questionnaireId];
                if (question?.state === 'answered' && row?.result?.rawText === input.responseText)
                    return { bindingKey: runtime.binding.bindingKey, sessionId: runtime.binding.sessionId, work: [record] };
                if (!question?.canAnswer)
                    throw new HostProtocolFailure(409, { code: question?.unavailableReason ?? 'participant_question_not_pending', requestId: request.requestId, retryable: false });
                const surface = createActorSurfaceFacade(runtime.ready.vm, { now: runtime.now, emitFiberSignal(value) {
                        const control = addressedExecutionControl(runtime.ready.vm, value.actor.id);
                        if (!control || control.fiberId !== value.fiberId || value.actor.id !== question.execution.actorId)
                            throw new Error('participant_question_owner_mismatch');
                        control.signal({ signalKind: value.signalKind, mailbox: value.mailbox as any, idempotencyKey: `execution-answer:${question.questionnaireId}`, createdAt: value.createdAt });
                    } });
                const result = surface.submitQuestionnaireResponse(input.questionnaireId, input.responseText);
                if (result.status !== 'submitted')
                    throw new HostProtocolFailure(409, { code: 'participant_question_not_pending', requestId: request.requestId, retryable: false });
                await checkpoint();
            }
            else {
                try { await runtime.holon.cancelTask(intent.task, input); }
                catch (error) {
                    const code = (error as { code?: string }).code;
                    if (code === 'revision-conflict' || code === 'terminal-task-immutable')
                        throw new HostProtocolFailure(409, { code: code === 'revision-conflict' ? 'participant_work_revision_changed' : 'participant_work_terminal', requestId: request.requestId, retryable: false });
                    throw error;
                }
                for (const source of record.executions) {
                    const live = liveSources.get(source.actorId);
                    if (live?.commandId !== intent.commandId || live.source.claimId !== source.claimId)
                        continue;
                    const actor = Object.values(runtime.ready.vm.actors).find(a => a.id === source.actorId);
                    if (actor)
                        for (const q of record.questions.filter(q => q.execution.actorId === actor.id && q.state === 'pending'))
                            cancelQuestionnaireRow({ vm: runtime.ready.vm, actor, questionnaireId: q.questionnaireId });
                    const control = addressedExecutionControl(runtime.ready.vm, source.actorId);
                    control?.signal({ signalKind: 'interrupt_requested', idempotencyKey: `execution-cancel:${input.controlId}`, createdAt: runtime.now() });
                    control?.stop('participant_work_cancelled');
                    liveSources.delete(source.actorId);
                }
                await checkpoint();
            }
            check(request, 'observe');
            return { bindingKey: runtime.binding.bindingKey, sessionId: runtime.binding.sessionId, work: [await workRecord(intent)] };
        },
        stop: stopExecutions,
        async shutdown() {
            await outputLane;
            // The TaskSpace owner must settle admitted work before its execution and
            // coordinator disappear. Stopping a fiber alone leaves durable Running work.
            for (const intent of runtime.outputs?.listIntents(scope) ?? []) {
                for (let attempt = 0; attempt < 8; attempt++) {
                    const record = await workRecord(intent);
                    if (!record.canCancel) break;
                    try {
                        await runtime.holon.cancelTask(intent.task, {
                            controlId: `session-close:${intent.commandId}:${record.revision}`,
                            expectedRevision: record.revision,
                            occurredAt: new Date(runtime.now()).toISOString(), reason: 'session_closing',
                        });
                        break;
                    } catch (error) {
                        const code = (error as { code?: string }).code;
                        if (code !== 'revision-conflict' && code !== 'terminal-task-immutable') throw error;
                        if (attempt === 7) throw error;
                    }
                }
            }
            stopExecutions();
            await checkpoint();
        },
        admitted(input: HolonExecutionAdapterInput, reference: {
            actorId: string;
        }) {
            const store = runtime.outputs;
            if (!store)
                return;
            const task = input.taskAttempt;
            const intent = store.listIntents(scope).find(i => i.task.taskSpaceId === task.taskSpaceId && i.task.taskId === task.taskId);
            if (!intent)
                throw new Error('participant_origin_not_found');
            const source = { ...intent.task, sessionId: runtime.binding.sessionId, actorId: reference.actorId,
                claimId: task.claimId, attempt: task.attempt, executionSessionRef: input.sessionRef,...(runtime.binding.executionEnvironment?{executionEnvironment:runtime.binding.executionEnvironment}:{}) };
            store.execution(scope, intent.commandId, source);
            liveSources.set(reference.actorId, { commandId: intent.commandId, source });
        },
        completed(input: HolonExecutionAdapterInput) {
            for (const [actorId, live] of liveSources) {
                if (live.source.executionSessionRef === input.sessionRef && live.source.claimId === input.taskAttempt.claimId && live.source.attempt === input.taskAttempt.attempt)
                    liveSources.delete(actorId);
            }
        },
        committed(actorId: string, record: ActorCommittedMessageRef) {
            const live = liveSources.get(actorId), store = runtime.outputs;
            // Narrative committed alongside tool calls is a complete stage message. The terminal
            // recipe answer waits for its validated task settlement, avoiding duplicate/failing raw replies.
            if (!live || !store || record.message.role !== 'assistant' || !record.message.toolCalls?.length)
                return;
            const text = completeText(record);
            if (!text.trim())
                return;
            const key = `committed:${actorId}:${record.recordId}`;
            store.prepare(scope, { key, message: { commandId: live.commandId, kind: 'stage', text, artifactRefs: [], source: { admissionId: live.source.admissionId,
                        taskSpaceId: live.source.taskSpaceId, taskId: live.source.taskId }, execution: live.source, sourceMessageId: record.recordId } });
            outputLane = outputLane.catch(() => { }).then(async () => {
                runtime.ready.activateSessionMaterialization();
                await runtime.ready.persistSnapshot();
                store.confirm(scope, key, runtime.now());
            });
            void outputLane.catch(() => { });
        },
        async flush() { await outputLane; },
        async send(request: HostRequest, command: HostParticipantSendCommand): Promise<HostParticipantDelivery> {
            check(request, 'send_text');
            if (modelChanging)
                throw new HostProtocolFailure(409, { code: 'model_selection_pending', requestId: request.requestId, retryable: false });
            const r = command.recipient, b = runtime.binding.recipient;
            if (command.bindingKey !== runtime.binding.bindingKey || ['kind', 'ref', 'ownerScopeRef', 'bindingRef', 'bindingDigest', 'admissionRef'].some(k => r[k as keyof typeof r] !== b[k as keyof typeof b]))
                throw new HostProtocolFailure(409, { code: 'participant_binding_conflict', requestId: request.requestId, retryable: false });
            const store = runtime.outputs;
            if (!store)
                throw new Error('participant_outputs_unavailable');
            const requestRef = executionRequestRef(scope, command.commandId);
            const derived = deriveHolonTaskRequestIdentity(runtime.binding.recipient.admissionRef!, requestRef, requestRef);
            const task = { admissionId: runtime.binding.recipient.admissionRef!, taskSpaceId: derived.taskSpaceId, taskId: derived.taskId };
            // Reconcile a durable duplicate before touching expired upload handles. Never replay work.
            if (store.intent(scope, command.commandId)) {
                store.accept(scope, command, runtime.now(), task);
                await reconcile(request);
                return delivery(store.intent(scope, command.commandId)!);
            }
            let input: unknown;
            let attached: ReturnType<ReturnType<typeof createParticipantAttachments>['prepare']> | undefined;
            try {
                if (command.attachmentIds || command.attachments) {
                    check(request, 'upload_attachment');
                    if (!runtime.attachments)
                        throw new AttachmentStoreFailure(415, 'participant_attachments_unavailable');
                    attached = command.attachments ? runtime.attachments.prepareMaterial(command) : runtime.attachments.prepare(request, command);
                    input = attached.input;
                }
                else
                    input = command.inputJson === undefined ? runtime.holon.projectTextInput(runtime.binding.recipient.admissionRef!, command.text) : JSON.parse(command.inputJson);
            }
            catch (error) {
                if (error instanceof HostProtocolFailure)
                    throw error;
                if (error instanceof AttachmentStoreFailure)
                    throw new HostProtocolFailure(error.status, { code: error.code, requestId: request.requestId, retryable: false });
                throw new HostProtocolFailure(400, { code: 'participant_structured_input_required', requestId: request.requestId, retryable: false });
            }
            let accepted: ReturnType<ExecutionOutputStore['accept']>;
            try {
                accepted = store.accept(scope, command, runtime.now(), task, attached?.attachments);
            }
            catch (error) {
                attached?.release();
                throw error;
            }
            if (!accepted.created) {
                attached?.release();
                await reconcile(request);
                return delivery(store.intent(scope, command.commandId)!);
            }
            submitting++;
            try {
                const receipt = await assign(request, { commandId: command.commandId, input: input as HolonTaskRuntimeInvocation['input'], intent: accepted.intent });
                const expected = accepted.intent.task;
                if (receipt.admissionId !== expected.admissionId || receipt.task.taskSpaceId !== expected.taskSpaceId || receipt.task.taskId !== expected.taskId)
                    throw new Error('participant_task_receipt_mismatch');
                return delivery(store.delivery(scope, command.commandId, 'submitted'));
            }
            catch (cause) {
                const code=(cause as {error?:{code?:unknown};code?:unknown})?.error?.code??(cause as {code?:unknown})?.code;
                store.delivery(scope, command.commandId, 'unknown', typeof code==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code)?code:'participant_submission_unknown');
                const failure = new HostProtocolFailure(503, { code: 'participant_submission_unknown', requestId: request.requestId, retryable: false, state: 'unknown' });
                Object.defineProperty(failure, 'cause', { value: cause });
                throw failure;
            }
            finally {
                submitting--;
                attached?.release();
            }
        },
        async outputs(request: HostRequest, input: {
            after?: number;
            limit?: number;
        } = {}): Promise<HostExecutionOutputPage> {
            await reconcile(request);
            const store = runtime.outputs!;
            return { bindingKey: runtime.binding.bindingKey, sessionId: runtime.binding.sessionId, ...store.outputs(scope, input.after, input.limit),
                deliveries: store.listIntents(scope).slice(-100).map(delivery) };
        },
        async observe(request: HostRequest, value: HolonTaskIdentitySelector) { return runtime.holon.capability.service.observe(selector(request, value)); },
        async settlement(request: HostRequest, value: HolonTaskIdentitySelector) {
            const exact = selector(request, value);
            // Verify exact admission/task correlation through the canonical inspection service first.
            await runtime.holon.capability.service.observe(exact);
            return runtime.holon.support.terminalSettlement(exact.taskSpaceId, exact.taskId);
        },
        isBusy: () => runtime.holon.support.isBusy(),
    };
}
