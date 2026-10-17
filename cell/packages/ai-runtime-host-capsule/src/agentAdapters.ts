import { createHash } from 'node:crypto';
import type { AgentAdapterHost, AgentAdapterStore, AgentAdapterState, AgentAdapterSourceRef, AgentAdapterSelector, AgentAdapterSendCommand, AgentExecutionSnapshot, AgentDriver, AgentDriverResult, HostRequest, Principal, HostAuthorizationEffects, ExecutionEnvironmentEffects, HostResourceEffects, ResourceLease } from '@cell/ai-runtime-host-contract';
import { parseAgentAdapterConfigureCommand, parseAgentAdapterSendCommand, parseAgentAdapterSelector, parseAgentAdapterInterruptCommand, parseAgentExecutionHandle, parseAgentExecutionSnapshot } from '@cell/ai-runtime-host-contract';
import { HostProtocolFailure } from '@cell/ai-runtime-host-logic';
const clone = <T>(v: T): T => structuredClone(v);
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const same = (a: AgentAdapterSourceRef, b: AgentAdapterSourceRef) => canonical(a) === canonical(b);
export function createAgentAdapterHost(options: {
    daemonId: string;
    principal: Principal;
    authorization: HostAuthorizationEffects;
    environments: ExecutionEnvironmentEffects;
    resources: HostResourceEffects;
    driver: AgentDriver;
    store: AgentAdapterStore;
}): AgentAdapterHost {
    let closed = false, closing: Promise<void> | undefined, queue = Promise.resolve();
    const lifetime = new AbortController();
    const flights = new Map<string, {
        workspaceKey: string;
        run?: ReturnType<AgentDriver['start']>;
        done: Promise<void>;
        terminal?: AgentDriverResult;
    }>();
    const fail = (request: HostRequest, code: string, status = 409): never => { throw new HostProtocolFailure(status, { code, requestId: request.requestId, retryable: false }); };
    const key = (s: AgentAdapterSelector) => canonical([s.source, s.bindingKey, s.commandId]), bindingKey = (s: Pick<AgentAdapterSelector, 'source' | 'bindingKey'>) => canonical([s.source, s.bindingKey]);
    const check = (request: HostRequest, action: 'discover' | 'configure' | 'observe' | 'execute' | 'interrupt', adapterId?: string) => {
        if (closed)
            fail(request, 'agent_adapter_host_closed', 503);
        const p = request.principal;
        if (p.principalId !== options.principal.principalId || p.grantsVersion !== options.principal.grantsVersion || options.authorization.currentGrantsVersion(p.principalId) !== p.grantsVersion || !options.authorization.permits(p, action === 'discover' || action === 'configure' ? { kind: 'agent-adapters', action } : { kind: 'agent-adapter', adapterId: adapterId!, action }))
            fail(request, 'forbidden', 403);
    };
    const owned = (request: HostRequest, source: AgentAdapterSourceRef) => {
        if (source.daemonId !== options.daemonId)
            fail(request, 'agent_adapter_source_mismatch');
    };
    const ask = <T>(fn: () => T | Promise<T>): Promise<T> => { const result = queue.then(fn); queue = result.then(() => { }, () => { }); return result; };
    const commit = (state: AgentAdapterState, patch: Partial<AgentAdapterState>) => { const next = { ...state, ...patch, revision: state.revision + 1 }; options.store.commit(state.revision, next); return next; };
    const find = (request: HostRequest, state: AgentAdapterState, selector: AgentAdapterSelector) => {
        owned(request, selector.source);
        const record = state.executions.find(e => key(e.command) === key(selector));
        if (!record)
            fail(request, 'agent_execution_not_found', 404);
        return record!;
    };
    async function patch(request: HostRequest, selector: AgentAdapterSelector, change: Partial<AgentExecutionSnapshot>) {
        return ask(() => {
            const state = options.store.read(), record = find(request, state, selector), snapshot = parseAgentExecutionSnapshot({ ...record.snapshot, ...change, revision: record.snapshot.revision + 1 });
            if (record.snapshot.handle && canonical(record.snapshot.handle) !== canonical(snapshot.handle))
                throw Error('agent_execution_handle_conflict');
            commit(state, { executions: state.executions.map(e => e === record ? { ...e, snapshot } : e) });
            return snapshot;
        });
    }
    // Restart observes uncertain prior effects; it never creates another driver or provider turn.
    const restored = options.store.read();
    if (restored.executions.some(e => ['queued', 'sending', 'running'].includes(e.snapshot.state)) || restored.controls.some(c => c.state === 'sending'))
        commit(restored, { executions: restored.executions.map(e => ['queued', 'sending', 'running'].includes(e.snapshot.state) ? { ...e, snapshot: { ...e.snapshot, revision: e.snapshot.revision + 1, state: 'unknown', canInterrupt: false, errorCode: 'agent_execution_restart_unknown' } } : e), controls: restored.controls.map(c => c.state === 'sending' ? { ...c, state: 'unknown' } : c) });
    async function launch(request: HostRequest, command: AgentAdapterSendCommand, configuration: import('@cell/ai-runtime-host-contract').AgentAdapterConfiguration) {
        const identity = key(command);
        let finish!: () => void;
        const done = new Promise<void>(resolve => { finish = resolve; });
        const flight = { workspaceKey: configuration.environment.workspaceKey, done, run: undefined as ReturnType<AgentDriver['start']> | undefined, terminal: undefined as AgentDriverResult | undefined };
        flights.set(identity, flight);
        let lease: ResourceLease | undefined;
        try {
            check(request, 'execute', command.source.adapterId);
            const environment = await options.environments.resolve(request, configuration.environment, 'execute');
            lease = await options.resources.acquire({ workDir: environment.workspace.workDir, kind: 'unclassified', signal: lifetime.signal });
            await options.environments.resolve(request, configuration.environment, 'execute');
            check(request, 'execute', command.source.adapterId);
            if (closed)
                throw Error('agent_adapter_host_closed');
            const binding = options.store.read().bindings.find(b => bindingKey(b) === bindingKey(command));
            flight.run = options.driver.start({ command, configuration, environment, ...(configuration.provider !== 'grok' && binding?.sessionId ? { sessionId: binding.sessionId } : {}) }, async (event) => {
                if (event.kind === 'sending') {
                    check(request, 'execute', command.source.adapterId);
                    await options.environments.resolve(request, configuration.environment, 'execute');
                    await patch(request, command, { state: 'sending' });
                    return;
                }
                if (event.kind === 'running') {
                    await patch(request, command, { state: 'running', canInterrupt: true });
                    return;
                }
                if (event.kind === 'handle') {
                    const handle = parseAgentExecutionHandle(event.handle);
                    if (!same(handle.source, command.source) || handle.provider !== configuration.provider)
                        throw Error('agent_execution_source_mismatch');
                    const actual = options.store.read().bindings.find(b => bindingKey(b) === bindingKey(command));
                    if (actual?.sessionId !== handle.sessionId)
                        throw Error('agent_execution_session_mismatch');
                    await patch(request, command, { handle });
                    return;
                }
                await ask(() => {
                    const state = options.store.read(), current = state.bindings.find(b => bindingKey(b) === bindingKey(command));
                    if (!current)
                        throw Error('agent_binding_missing');
                    if (current.sessionId && current.sessionId !== event.sessionId && configuration.provider !== 'grok')
                        throw Error('agent_binding_session_mismatch');
                    const foreign = state.bindings.some(b => bindingKey(b) !== bindingKey(command) && b.sessionId === event.sessionId && state.executions.some(e => bindingKey(e.command) === bindingKey(b) && e.configuration.provider === configuration.provider)) || state.executions.some(e => bindingKey(e.command) !== bindingKey(command) && e.configuration.provider === configuration.provider && e.snapshot.handle?.sessionId === event.sessionId);
                    if (foreign)
                        throw Error('agent_cross_channel_session_forbidden');
                    commit(state, { bindings: state.bindings.map(b => b === current ? { ...b, sessionId: event.sessionId } : b) });
                });
            });
            const result = await flight.run.result;
            flight.terminal = result;
            if (result.handle && (!same(result.handle.source, command.source) || result.handle.provider !== configuration.provider))
                throw Error('agent_execution_source_mismatch');
            await patch(request, command, { state: result.state, canInterrupt: false, ...(result.handle ? { handle: result.handle } : {}), ...(result.state === 'completed' ? { result: result.text, errorCode: undefined } : { errorCode: result.errorCode }) });
        }
        catch (error) {
            await flight.run?.close().catch(() => { });
            await patch(request, command, { state: 'unknown', canInterrupt: false, errorCode: error instanceof Error && /^agent_[a-z_]+$/.test(error.message) ? error.message : 'agent_execution_outcome_unknown' }).catch(() => { });
        }
        finally {
            lease?.release();
            flights.delete(identity);
            finish();
        }
    }
    return {
        async directory(request) {
            check(request, 'discover');
            const state = options.store.read(), adapters = [], probes = new Map<string, ReturnType<AgentDriver['probe']>>();
            for (const registration of state.registrations) {
                if (!options.authorization.permits(request.principal, { kind: 'agent-adapter', adapterId: registration.source.adapterId, action: 'observe' }))
                    continue;
                const provider = registration.configuration.provider;
                let pending = probes.get(provider);
                if (!pending) {
                    pending = options.driver.probe(provider);
                    probes.set(provider, pending);
                }
                const probe = await pending;
                let reason: string | undefined;
                if (!registration.configuration.enabled)
                    reason = 'agent_adapter_disabled';
                else if (!probe.installed)
                    reason = 'agent_adapter_not_installed';
                else if (!options.authorization.permits(request.principal, { kind: 'agent-adapter', adapterId: registration.source.adapterId, action: 'execute' }))
                    reason = 'forbidden';
                else
                    try {
                        await options.environments.resolve(request, registration.configuration.environment, 'execute');
                    }
                    catch {
                        reason = 'agent_adapter_environment_unavailable';
                    }
                check(request, 'discover');
                adapters.push({ ...registration, canSubmit: !reason, ...(reason ? { unavailableReason: reason } : {}), ...(probe.version ? { installedVersion: probe.version } : {}), access: state.executions.some(e => same(e.command.source, registration.source) && e.snapshot.state === 'completed') ? 'observed' as const : 'unverified' as const, capabilities: probe.capabilities });
            }
            return { daemonId: options.daemonId, adapters };
        },
        async configure(request, input) {
            const command = clone(parseAgentAdapterConfigureCommand(input));
            check(request, 'configure');
            return ask(async () => {
                check(request, 'configure');
                const state = options.store.read(), fingerprint = digest(command), existing = state.receipts.find(r => r.commandId === command.commandId);
                if (existing) {
                    if (existing.fingerprint !== fingerprint)
                        fail(request, 'agent_adapter_command_conflict');
                    return clone(existing);
                }
                const current = state.registrations.find(r => r.source.adapterId === command.adapterId);
                if ((current?.source.revision ?? 0) !== command.expectedRevision)
                    fail(request, 'agent_adapter_revision_changed');
                await options.environments.resolve(request, command.configuration.environment, 'read');
                check(request, 'configure');
                const source: AgentAdapterSourceRef = { kind: 'agent-adapter', daemonId: options.daemonId, adapterId: command.adapterId, revision: command.expectedRevision + 1 }, registration = { source, configuration: command.configuration }, receipt = { commandId: command.commandId, adapterId: command.adapterId, revision: source.revision, fingerprint };
                commit(state, { registrations: current ? state.registrations.map(r => r === current ? registration : r) : [...state.registrations, registration], receipts: [...state.receipts, receipt] });
                return clone(receipt);
            });
        },
        async configurationResult(request, commandId) {
            check(request, 'configure');
            const receipt = options.store.read().receipts.find(r => r.commandId === commandId);
            if (!receipt)
                fail(request, 'agent_adapter_command_not_found', 404);
            return clone(receipt!);
        },
        async send(request, input) {
            const command = clone(parseAgentAdapterSendCommand(input));
            check(request, 'observe', command.source.adapterId);
            owned(request, command.source);
            return ask(async () => {
                const state = options.store.read(), fingerprint = digest(command), existing = state.executions.find(e => key(e.command) === key(command));
                if (existing) {
                    if (existing.snapshot.fingerprint !== fingerprint)
                        fail(request, 'agent_execution_command_conflict');
                    return clone(existing.snapshot);
                }
                check(request, 'execute', command.source.adapterId);
                const registration = state.registrations.find(r => same(r.source, command.source));
                if (!registration)
                    fail(request, 'agent_adapter_revision_changed');
                if (!registration!.configuration.enabled)
                    fail(request, 'agent_adapter_disabled');
                if (flights.size >= 8)
                    fail(request, 'agent_adapter_execution_capacity', 429);
                if (state.executions.some(e => bindingKey(e.command) === bindingKey(command) && ['queued', 'sending', 'running', 'unknown'].includes(e.snapshot.state)))
                    fail(request, 'agent_binding_busy');
                await options.environments.resolve(request, registration!.configuration.environment, 'execute');
                check(request, 'execute', command.source.adapterId);
                const snapshot: AgentExecutionSnapshot = { source: command.source, bindingKey: command.bindingKey, commandId: command.commandId, fingerprint, revision: 1, state: 'queued', canInterrupt: false }, binding = state.bindings.find(b => bindingKey(b) === bindingKey(command));
                commit(state, { executions: [...state.executions, { command, configuration: registration!.configuration, snapshot }], bindings: binding ? state.bindings : [...state.bindings, { source: command.source, bindingKey: command.bindingKey }] });
                void launch(request, command, registration!.configuration);
                return clone(snapshot);
            });
        },
        async observe(request, input) { const selector = clone(parseAgentAdapterSelector(input)); check(request, 'observe', selector.source.adapterId); return clone(find(request, options.store.read(), selector).snapshot); },
        async interrupt(request, input) {
            const command = clone(parseAgentAdapterInterruptCommand(input));
            check(request, 'interrupt', command.source.adapterId);
            let flight: ReturnType<typeof flights.get>;
            const control = await ask(() => {
                const state = options.store.read(), record = find(request, state, command), fingerprint = digest(command), old = state.controls.find(c => c.controlId === command.controlId);
                if (old) {
                    if (old.fingerprint !== fingerprint)
                        fail(request, 'agent_control_conflict');
                    return false;
                }
                if (record.snapshot.revision !== command.expectedRevision)
                    fail(request, 'agent_execution_revision_changed');
                flight = flights.get(key(command));
                if (!record.snapshot.canInterrupt || !flight?.run)
                    fail(request, 'agent_original_interrupt_unavailable');
                commit(state, { controls: [...state.controls, { controlId: command.controlId, fingerprint, source: command.source, bindingKey: command.bindingKey, commandId: command.commandId, state: 'sending' }] });
                return true;
            });
            if (control) {
                let accepted = false;
                try {
                    check(request, 'interrupt', command.source.adapterId);
                    await flight!.run!.interrupt();
                    accepted = true;
                }
                finally {
                    await ask(() => { const state = options.store.read(); commit(state, { controls: state.controls.map(c => c.controlId === command.controlId ? { ...c, state: accepted ? 'accepted' : 'unknown' } : c) }); });
                }
            }
            return clone(find(request, options.store.read(), command).snapshot);
        },
        busy(workspaceKey) { return [...flights.values()].some(f => f.workspaceKey === workspaceKey); },
        close: () => closing ??= (async () => { closed = true; lifetime.abort(); await queue; await Promise.allSettled([...flights.values()].map(async (f) => { await f.run?.close(); await f.done; })); await queue; options.store.close(); })(),
    };
}
