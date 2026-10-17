export type HostCapability = Readonly<{
    name: string;
    access: 'read' | 'write';
    description: string;
    inputSchemaJson: string;
}>;
export type HostContextProjection = Readonly<{
    version: number;
    observedAt: number;
    digestJson: string;
}>;
export type HostInteractionOperation = {
    operation: 'register';
    hostId: string;
    origin: string;
    expectedRevision: number;
    tools: HostCapability[];
} | {
    operation: 'context';
    hostId: string;
    context: HostContextProjection;
} | {
    operation: 'confirm' | 'start' | 'cancel';
    hostId: string;
    invocationId: string;
    expectedRevision: number;
} | {
    operation: 'receipt';
    hostId: string;
    invocationId: string;
    expectedRevision: number;
    receiptId: string;
    status: 'succeeded' | 'failed' | 'unknown';
    resultJson: string;
} | {
    operation: 'patch';
    hostId: string;
    invocationId: string;
    expectedRevision: number;
    bodyJson: string;
};
export type HostInteractionInvocation = Readonly<{
    invocationId: string;
    hostId: string;
    actorId: string;
    turnId: string;
    attemptId?: string;
    toolCallId: string;
    registrationRevision: number;
    toolName: string;
    inputJson: string;
    access: 'read' | 'write';
    revision: number;
    state: 'awaiting_confirmation' | 'ready' | 'executing' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    receipt?: {
        receiptId: string;
        status: 'succeeded' | 'failed' | 'unknown';
        resultJson: string;
    };
    card?: {
        cardId: string;
        kind: 'draft' | 'approval' | 'frontend_write_confirmation';
        title: string;
        bodyJson: string;
    };
}>;
export type HostInteractionView = Readonly<{
    sessionId: string;
    epoch: string;
    hosts: readonly {
        hostId: string;
        actorId: string;
        origin: string;
        revision: number;
        tools: readonly HostCapability[];
        context?: HostContextProjection;
    }[];
    invocations: readonly HostInteractionInvocation[];
}>;
const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype)
    throw Error('invalid_host_schema'); return v as Record<string, unknown>; };
const text = (v: unknown, max = 256): string => { if (typeof v !== 'string' || !v || new TextEncoder().encode(v).byteLength > max)
    throw Error('invalid_host_schema'); return v; };
const revision = (v: unknown) => { if (!Number.isSafeInteger(v) || Number(v) < 0)
    throw Error('invalid_host_revision'); };
const json = (v: unknown, max = 32768) => JSON.parse(text(v, max));
const exact = (v: Record<string, unknown>, keys: string[]) => { if (Object.keys(v).some(k => !keys.includes(k)))
    throw Error('invalid_host_schema'); };
function context(v: unknown) { const r = record(v); exact(r, ['version', 'observedAt', 'digestJson']); revision(r.version); revision(r.observedAt); if (r.version === 0)
    throw Error('invalid_host_revision'); json(r.digestJson, 7500); }
function tools(v: unknown) { if (!Array.isArray(v) || v.length > 32)
    throw Error('invalid_host_schema'); const names = new Set(); for (const t of v) {
    const r = record(t);
    exact(r, ['name', 'access', 'description', 'inputSchemaJson']);
    text(r.name, 128);
    text(r.description, 2048);
    if (!['read', 'write'].includes(String(r.access)))
        throw Error('invalid_host_schema');
    json(r.inputSchemaJson, 8192);
    if (names.has(r.name))
        throw Error('duplicate_host_tool');
    names.add(r.name);
} }
export function parseHostInteractionOperation(value: unknown): HostInteractionOperation {
    const r = record(value);
    text(r.hostId);
    const operation = text(r.operation);
    if (operation === 'register') {
        exact(r, ['operation', 'hostId', 'origin', 'expectedRevision', 'tools']);
        revision(r.expectedRevision);
        const origin = new URL(text(r.origin, 2048));
        if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== r.origin)
            throw Error('invalid_host_origin');
        tools(r.tools);
    }
    else if (operation === 'context') {
        exact(r, ['operation', 'hostId', 'context']);
        context(r.context);
    }
    else if (['confirm', 'start', 'cancel', 'receipt', 'patch'].includes(operation)) {
        exact(r, ['operation', 'hostId', 'invocationId', 'expectedRevision', ...(operation === 'receipt' ? ['receiptId', 'status', 'resultJson'] : operation === 'patch' ? ['bodyJson'] : [])]);
        text(r.invocationId);
        revision(r.expectedRevision);
        if (operation === 'receipt') {
            text(r.receiptId);
            if (!['succeeded', 'failed', 'unknown'].includes(String(r.status)))
                throw Error('invalid_host_schema');
            json(r.resultJson);
        }
        if (operation === 'patch')
            json(r.bodyJson);
    }
    else
        throw Error('unsupported_host_operation');
    return structuredClone(value) as HostInteractionOperation;
}
export function parseHostInteractionView(value: unknown): HostInteractionView {
    const r = record(value);
    exact(r, ['sessionId', 'epoch', 'hosts', 'invocations']);
    text(r.sessionId);
    text(r.epoch);
    if (!Array.isArray(r.hosts) || r.hosts.length > 16 || !Array.isArray(r.invocations) || r.invocations.length > 256)
        throw Error('invalid_host_schema');
    for (const raw of r.hosts) {
        const h = record(raw);
        exact(h, ['hostId', 'actorId', 'origin', 'revision', 'tools', 'context']);
        text(h.hostId);
        text(h.actorId);
        text(h.origin, 2048);
        revision(h.revision);
        tools(h.tools);
        if (h.context)
            context(h.context);
    }
    const ids = new Set();
    for (const raw of r.invocations) {
        const c = record(raw);
        exact(c, ['invocationId', 'hostId', 'actorId', 'turnId', 'attemptId', 'toolCallId', 'registrationRevision', 'toolName', 'inputJson', 'access', 'revision', 'state', 'receipt', 'card']);
        for (const k of ['invocationId', 'hostId', 'actorId', 'turnId', 'toolCallId', 'toolName'])
            text(c[k]);
        if (c.attemptId !== undefined)
            text(c.attemptId);
        revision(c.revision);
        revision(c.registrationRevision);
        json(c.inputJson);
        if (!['read', 'write'].includes(String(c.access)) || !['awaiting_confirmation', 'ready', 'executing', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(String(c.state)))
            throw Error('invalid_host_schema');
        if (ids.has(c.invocationId))
            throw Error('duplicate_host_invocation');
        ids.add(c.invocationId);
        if (c.receipt) {
            const p = record(c.receipt);
            exact(p, ['receiptId', 'status', 'resultJson']);
            text(p.receiptId);
            if (!['succeeded', 'failed', 'unknown'].includes(String(p.status)))
                throw Error('invalid_host_schema');
            json(p.resultJson);
        }
        if (c.card) {
            const p = record(c.card);
            exact(p, ['cardId', 'kind', 'title', 'bodyJson']);
            text(p.cardId);
            text(p.title, 2048);
            json(p.bodyJson);
            if (!['draft', 'approval', 'frontend_write_confirmation'].includes(String(p.kind)))
                throw Error('invalid_host_schema');
        }
    }
    return structuredClone(value) as HostInteractionView;
}
