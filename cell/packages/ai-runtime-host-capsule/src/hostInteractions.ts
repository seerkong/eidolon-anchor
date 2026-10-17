import { ensureVmSessionState } from '@cell/ai-core-logic/runtime/runtime';
import { ToolFuncRegistry } from '@cell/ai-core-logic/runtime/ToolFuncRegistry';
import { emptyHostInteractions, registerHost, publishHostContext, recordHostInvocation, transitionHostInvocation, recoverHostInteractions, boundedInteractionJson, assertHostInteractionCapacity } from '@cell/ai-core-logic/runtime/HostInteractions';
import { createHash } from 'node:crypto';
import type { RuntimeHostInvocation } from '@cell/ai-core-contract/runtime/HostInteractions';
import { parseHostInteractionOperation, parseHostInteractionView, type HostRequest, type HostInteractionView } from '@cell/ai-runtime-host-contract';
import { validateAgentExecutionValue, normalizeAgentExecutionSchema, normalizeAgentExecutionValue } from '@cell/ai-organ-logic/agent/AgentExecutionContract';
import type { SessionRuntimeReady } from './session/SessionRuntimeAssembly';
/** Adapter to the existing tool executor and VM snapshot; not an execution loop. */
export function createHostInteractions(options: {
    ready: SessionRuntimeReady;
    sessionId: string;
    epoch: string;
    now(): number;
    newId(): string;
    currentTurn(actorId: string): {
        turnId: string;
        attemptId?: string;
        request: HostRequest;
    } | undefined;
    authorize(request: HostRequest, actorId: string): void;
}) {
    const { ready } = options, session = ensureVmSessionState(ready.vm);
    const state = session.hostInteractions ??= emptyHostInteractions();
    recoverHostInteractions(state);
    const waiters = new Map<string, {
        resolve(value: string): void;
        reject(error: Error): void;
    }>();
    let closed = false;
    const persist = async () => { ready.activateSessionMaterialization(); await ready.persistSnapshot(); };
    const owned = (request: HostRequest, actorId: string, hostId: string) => {
        options.authorize(request, actorId);
        const host = state.hosts[hostId];
        if (!host || host.actorId !== actorId || host.principalId !== request.principal.principalId)
            throw Error('host_scope_mismatch');
        return host;
    };
    const cancelActor = (actorId: string, turnId?: string) => {
        for (const call of Object.values(state.invocations))
            if (call.actorId === actorId && (!turnId || call.turnId === turnId) && ['awaiting_confirmation', 'ready', 'executing'].includes(call.state)) {
                transitionHostInvocation(state, call.invocationId, call.revision, 'cancel');
                waiters.get(call.invocationId)?.reject(Error('host_invocation_cancelled'));
                waiters.delete(call.invocationId);
            }
    };
    async function invoke(runtime: any, args: any, card: boolean) {
        if (closed)
            throw Error('host_interactions_closed');
        runtime.signal?.throwIfAborted();
        const owner = options.currentTurn(runtime.actor.id);
        if (!owner)
            throw Error('host_turn_missing');
        const host = owned(owner.request, runtime.actor.id, String(args.hostId)), tool = host.tools.find(t => t.name === args.toolName);
        if (!tool)
            throw Error('host_tool_not_registered');
        const input = normalizeAgentExecutionValue(boundedInteractionJson(args.inputJson), 'Host tool input');
        validateAgentExecutionValue(normalizeAgentExecutionSchema(JSON.parse(tool.inputSchemaJson), 'Host tool'), input, 'Host tool input');
        const toolCallId = String(runtime.toolCallId || '');
        if (!toolCallId)
            throw Error('host_tool_identity_missing');
        const invocationId = 'host-' + createHash('sha256').update(JSON.stringify([options.sessionId, runtime.actor.id, owner.turnId, toolCallId])).digest('hex');
        const existing = state.invocations[invocationId];
        const candidate: RuntimeHostInvocation = { invocationId, hostId: host.hostId, actorId: runtime.actor.id, principalId: owner.request.principal.principalId, turnId: owner.turnId,
            ...(owner.attemptId ? { attemptId: owner.attemptId } : {}), toolCallId, registrationRevision: host.revision, toolName: tool.name, inputJson: JSON.stringify(input), access: tool.access, revision: 1,
            state: card || tool.access === 'write' ? 'awaiting_confirmation' : 'ready',
            ...(card ? { card: { cardId: invocationId, kind: args.kind ?? 'frontend_write_confirmation', title: String(args.title || tool.name), bodyJson: JSON.stringify(boundedInteractionJson(args.bodyJson ?? '{}')) } } : {}),
        };
        const { principalId, ...publicCandidate } = candidate;
        parseHostInteractionView({ sessionId: options.sessionId, epoch: options.epoch, hosts: [], invocations: [publicCandidate] });
        const call = recordHostInvocation(state, candidate);
        if (existing) {
            if (call.receipt)
                return JSON.stringify(call.receipt);
            throw Error('host_invocation_already_pending');
        }
        const result = new Promise<string>((resolve, reject) => waiters.set(invocationId, { resolve, reject }));
        const abort = () => cancelActor(runtime.actor.id, owner.turnId);
        runtime.signal?.addEventListener('abort', abort, { once: true });
        // Snapshot scheduling is owned by the existing coordinator. Do not wait here
        // inside the tool's executor step (that would deadlock its lane).
        void persist().catch(() => { call.state = 'unknown'; call.revision++; waiters.get(invocationId)?.reject(Error('host_checkpoint_failed')); waiters.delete(invocationId); });
        try {
            return await result;
        }
        finally {
            runtime.signal?.removeEventListener('abort', abort);
            waiters.delete(invocationId);
        }
    }
    const registry = ready.vm.registries.toolRegistry!;
    for (const [name, card] of [['HostTool', false], ['InteractionCard', true]] as const) {
        if (ToolFuncRegistry.get(registry, name))
            throw Error('host_tool_registry_conflict');
        ToolFuncRegistry.register(registry, { resourceEffect: 'orchestration', schema: { type: 'function', function: { name, description: card ? 'Present a versioned confirmation card, wait for its original host action receipt, then continue.' : 'Invoke an explicitly registered business host capability and wait for its original result. Never use this for arbitrary code.', parameters: { type: 'object', properties: { hostId: { type: 'string' }, toolName: { type: 'string' }, inputJson: { type: 'string' }, ...(card ? { kind: { type: 'string', enum: ['draft', 'approval', 'frontend_write_confirmation'] }, title: { type: 'string' }, bodyJson: { type: 'string' } } : {}) }, required: ['hostId', 'toolName', 'inputJson'], additionalProperties: false } } }, run: (runtime: any, args: any) => invoke(runtime, args, card) } as any);
    }
    const original = ready.actor.callbacks.buildToolset;
    const buildToolset: typeof original = (vm, actor) => {
        const principalId = options.currentTurn(actor.id)?.request.principal.principalId;
        const schemas = original(vm, actor), hosts = Object.values(state.hosts).filter(h => h.actorId === actor.id && h.principalId === principalId);
        if (!hosts.length)
            return schemas;
        const digest = hosts.map(h => ({ hostId: h.hostId, revision: h.revision, tools: h.tools, context: h.context }));
        return [...schemas, ...['HostTool', 'InteractionCard'].map(name => { const schema = ToolFuncRegistry.get(registry, name)!.schema; return { ...schema, function: { ...schema.function, description: schema.function.description + ' Registered host capabilities and current read-only business context: ' + JSON.stringify(digest) } }; })];
    };
    // Restored members may already hold the original callback. New members
    // inherit the control actor callback through the existing member factory.
    const wrappedActors = [ready.actor, ...Object.values(ready.vm.actors)]
        .filter((actor, index, actors) => actors.indexOf(actor) === index
            && actor.callbacks.buildToolset === original);
    for (const actor of wrappedActors) actor.callbacks.buildToolset = buildToolset;
    return {
        view(request: HostRequest): HostInteractionView {
            const hosts = Object.values(state.hosts).filter(h => h.principalId === request.principal.principalId && (() => { try {
                options.authorize(request, h.actorId);
                return true;
            }
            catch {
                return false;
            } })());
            const allowed = new Set(hosts.map(h => h.hostId));
            return parseHostInteractionView({ sessionId: options.sessionId, epoch: options.epoch, hosts: hosts.map(({ principalId, ...h }) => h), invocations: Object.values(state.invocations).filter(c => allowed.has(c.hostId) && c.principalId === request.principal.principalId).map(({ principalId, ...c }) => c) });
        },
        preflight(request: HostRequest, actorId: string, operationJson: string) {
            const op = parseHostInteractionOperation(JSON.parse(operationJson));
            options.authorize(request, actorId);
            if (op.operation !== 'register')
                owned(request, actorId, op.hostId);
            else {
                const previous = state.hosts[op.hostId];
                if (previous && (previous.principalId !== request.principal.principalId || previous.actorId !== actorId))
                    throw Error('host_scope_mismatch');
            }
        },
        async command(request: HostRequest, actorId: string, operationJson: string) {
            this.preflight(request, actorId, operationJson);
            const op = parseHostInteractionOperation(JSON.parse(operationJson));
            if (op.operation === 'register') {
                for (const tool of op.tools)
                    normalizeAgentExecutionSchema(JSON.parse(tool.inputSchemaJson), 'Host tool registration');
                registerHost(state, { hostId: op.hostId, origin: op.origin, tools: [...op.tools], actorId, principalId: request.principal.principalId, revision: op.expectedRevision + 1 }, op.expectedRevision);
            }
            else if (op.operation === 'context')
                publishHostContext(state, op.hostId, op.context);
            else {
                const call = state.invocations[op.invocationId];
                if (!call || call.hostId !== op.hostId || call.actorId !== actorId || call.principalId !== request.principal.principalId)
                    throw Error('host_scope_mismatch');
                if (op.operation === 'patch') {
                    if (!call.card || call.revision !== op.expectedRevision || !['awaiting_confirmation', 'ready'].includes(call.state))
                        throw Error('host_card_revision_conflict');
                    boundedInteractionJson(op.bodyJson);
                    const next = { ...call, card: { ...call.card, bodyJson: op.bodyJson }, revision: call.revision + 1 };
                    assertHostInteractionCapacity({ ...state, invocations: { ...state.invocations, [call.invocationId]: next } });
                    state.invocations[call.invocationId] = next;
                }
                else {
                    if (op.operation === 'start' && state.hosts[op.hostId].revision !== call.registrationRevision)
                        throw Error('host_registration_changed');
                    const transitioned = transitionHostInvocation(state, op.invocationId, op.expectedRevision, op.operation, op.operation === 'receipt' ? { receiptId: op.receiptId, status: op.status, resultJson: op.resultJson } : undefined);
                    // Persist the original result before unblocking the existing tool executor.
                    try {
                        await persist();
                    }
                    catch (error) {
                        const unsettled = state.invocations[call.invocationId];
                        unsettled.state = 'unknown';
                        unsettled.revision++;
                        waiters.get(call.invocationId)?.reject(Error('host_receipt_checkpoint_failed'));
                        waiters.delete(call.invocationId);
                        throw error;
                    }
                    if (op.operation === 'receipt')
                        waiters.get(call.invocationId)?.resolve(JSON.stringify(transitioned.receipt));
                    if (op.operation === 'cancel') {
                        waiters.get(call.invocationId)?.reject(Error('host_invocation_cancelled'));
                        waiters.delete(call.invocationId);
                    }
                    return;
                }
            }
            await persist();
        },
        cancelActor,
        close() { closed = true; for (const call of Object.values(state.invocations))
            if (waiters.has(call.invocationId)) {
                call.state = 'unknown';
                call.revision++;
                waiters.get(call.invocationId)!.reject(Error('host_interactions_closed'));
            } waiters.clear(); for (const actor of Object.values(ready.vm.actors).concat(ready.actor))
                if (actor.callbacks.buildToolset === buildToolset) actor.callbacks.buildToolset = original; },
    };
}
