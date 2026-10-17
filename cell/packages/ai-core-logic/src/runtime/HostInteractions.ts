import type { RuntimeHostInteractionState, RuntimeHostRegistration, RuntimeHostInvocation } from '@cell/ai-core-contract/runtime/HostInteractions';
export function emptyHostInteractions(): RuntimeHostInteractionState { return { version: 1, hosts: {}, invocations: {} }; }
export function assertHostInteractionCapacity(state: RuntimeHostInteractionState): void { if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 512 * 1024)
    throw Error('host_state_capacity'); }
export function boundedInteractionJson(text: string, limit = 32768): unknown {
    if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > limit)
        throw Error('host_json_capacity');
    return JSON.parse(text);
}
export function registerHost(state: RuntimeHostInteractionState, host: RuntimeHostRegistration, expectedRevision: number): void {
    const previous = state.hosts[host.hostId];
    if (previous && (previous.principalId !== host.principalId || previous.actorId !== host.actorId || previous.origin !== host.origin))
        throw Error('host_scope_mismatch');
    if ((previous?.revision ?? 0) !== expectedRevision)
        throw Error('host_revision_conflict');
    if (!previous && Object.keys(state.hosts).length >= 16)
        throw Error('host_capacity');
    if (host.tools.length > 32 || new Set(host.tools.map(t => t.name)).size !== host.tools.length)
        throw Error('host_capability_invalid');
    for (const tool of host.tools) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(tool.name) || !['read', 'write'].includes(tool.access))
            throw Error('host_capability_invalid');
        boundedInteractionJson(tool.inputSchemaJson, 8192);
    }
    const next = structuredClone({ ...host, revision: expectedRevision + 1 });
    assertHostInteractionCapacity({ ...state, hosts: { ...state.hosts, [host.hostId]: next } });
    state.hosts[host.hostId] = next;
}
export function publishHostContext(state: RuntimeHostInteractionState, hostId: string, context: NonNullable<RuntimeHostRegistration['context']>): void {
    const host = state.hosts[hostId];
    if (!host)
        throw Error('host_not_registered');
    boundedInteractionJson(context.digestJson, 7500);
    if (!Number.isSafeInteger(context.version) || context.version < 1 || !Number.isFinite(context.observedAt) || context.observedAt < 0)
        throw Error('host_context_invalid');
    if (host.context && context.version <= host.context.version) {
        if (JSON.stringify(context) === JSON.stringify(host.context))
            return;
        throw Error('host_context_version_conflict');
    }
    const next = { ...host, context: structuredClone(context) };
    assertHostInteractionCapacity({ ...state, hosts: { ...state.hosts, [hostId]: next } });
    state.hosts[hostId] = next;
}
export function recordHostInvocation(state: RuntimeHostInteractionState, record: RuntimeHostInvocation): RuntimeHostInvocation {
    const previous = state.invocations[record.invocationId];
    if (previous) {
        for (const key of ['hostId', 'actorId', 'principalId', 'turnId', 'attemptId', 'toolCallId', 'registrationRevision', 'toolName', 'inputJson'] as const)
            if (previous[key] !== record[key])
                throw Error('host_invocation_conflict');
        return previous;
    }
    if (Object.keys(state.invocations).length >= 256)
        throw Error('host_invocation_capacity');
    assertHostInteractionCapacity({ ...state, invocations: { ...state.invocations, [record.invocationId]: record } });
    state.invocations[record.invocationId] = structuredClone(record);
    return state.invocations[record.invocationId];
}
export function transitionHostInvocation(state: RuntimeHostInteractionState, id: string, expectedRevision: number, operation: 'confirm' | 'start' | 'cancel' | 'receipt', receipt?: RuntimeHostInvocation['receipt']): RuntimeHostInvocation {
    const original = state.invocations[id];
    if (!original)
        throw Error('host_invocation_missing');
    const call = structuredClone(original);
    if (operation === 'receipt' && call.receipt) {
        if (JSON.stringify(call.receipt) !== JSON.stringify(receipt))
            throw Error('host_receipt_conflict');
        if (call.state === 'unknown' && receipt!.status !== 'unknown') {
            const settled = { ...call, state: receipt!.status, revision: call.revision + 1 };
            state.invocations[id] = settled;
            return settled;
        }
        return call;
    }
    if (call.revision !== expectedRevision)
        throw Error('host_revision_conflict');
    if (operation === 'confirm') {
        if (call.state !== 'awaiting_confirmation')
            throw Error('host_action_terminal');
        call.state = 'ready';
    }
    if (operation === 'start') {
        if (call.state !== 'ready')
            throw Error('host_action_not_ready');
        call.state = 'executing';
    }
    if (operation === 'cancel') {
        if (!['awaiting_confirmation', 'ready', 'executing'].includes(call.state))
            throw Error('host_action_terminal');
        call.state = call.state === 'executing' ? 'unknown' : 'cancelled';
    }
    if (operation === 'receipt') {
        if (!receipt || !['succeeded', 'failed', 'unknown'].includes(receipt.status) || !['executing', 'unknown'].includes(call.state))
            throw Error('host_receipt_not_expected');
        boundedInteractionJson(receipt.resultJson);
        call.receipt = structuredClone(receipt);
        call.state = receipt.status;
    }
    call.revision++;
    assertHostInteractionCapacity({ ...state, invocations: { ...state.invocations, [id]: call } });
    state.invocations[id] = call;
    return call;
}
export function recoverHostInteractions(state: RuntimeHostInteractionState): void {
    for (const call of Object.values(state.invocations))
        if (['awaiting_confirmation', 'ready', 'executing'].includes(call.state)) {
            call.state = 'unknown';
            call.revision++;
        }
}
