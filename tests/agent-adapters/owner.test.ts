import { test, expect } from 'bun:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentAdapterHost } from '../../cell/packages/ai-runtime-host-capsule/src/agentAdapters';
import { openAgentAdapterStore } from '../../cell/packages/ai-runtime-host-support/src/agentAdapterStore';
import type { AgentDriver, AgentDriverResult } from '@cell/ai-runtime-host-contract';
const request = { principal: { principalId: 'owner', grantsVersion: '1' }, requestId: 'test' }, environment = { kind: 'daemon-workspace' as const, daemonId: 'daemon', workspaceKey: 'workspace', revision: 1 }, configuration = { provider: 'codex' as const, name: 'Codex', model: 'fixture', enabled: true, environment };
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'original-adapters-'));
    await chmod(root, 0o700);
    let calls = 0, interrupts = 0, allowed = true, release!: (result: AgentDriverResult) => void, resolveLease: () => void = () => { };
    const pending = new Promise<AgentDriverResult>(r => { release = r; }), capabilities = { submit: true, interrupt: true, observeOriginal: true, nativeTaskSpace: false as const, nativeActorHistory: false as const, attachments: false as const, artifacts: false as const, tools: 'chat-only' as const, context: 'retained' as const };
    const driver: AgentDriver = { probe: async () => ({ installed: true, version: 'fixture', capabilities }), start(input, onEvent) { calls++; const handle = { kind: 'agent-execution' as const, source: input.command.source, provider: 'codex' as const, sessionId: 'original-thread', turnId: 'original-turn' }; const result = (async () => { await onEvent({ kind: 'session', sessionId: handle.sessionId }); await onEvent({ kind: 'sending' }); await onEvent({ kind: 'handle', handle }); await onEvent({ kind: 'running' }); return await pending; })(); return { result, interrupt: async () => { interrupts++; }, close: async () => { release({ state: 'unknown', handle, errorCode: 'agent_transport_outcome_unknown' }); await result; } }; } };
    const options = { daemonId: 'daemon', principal: request.principal, authorization: { currentGrantsVersion: () => '1', permits: () => allowed }, environments: { resolve: async () => ({ ref: environment, workspace: { workspaceKey: 'workspace', workspaceId: '/registered', workDir: '/registered', revision: 1, placement: 'workspace' as const } }) }, resources: { acquire: async (_input: any) => ({ release: () => { resolveLease(); } }) }, driver };
    let owner = createAgentAdapterHost({ ...options, store: openAgentAdapterStore(root) });
    const register = async () => { const receipt = await owner.configure(request, { commandId: 'configure', adapterId: 'adapter', expectedRevision: 0, configuration }); return { kind: 'agent-adapter' as const, daemonId: 'daemon', adapterId: 'adapter', revision: receipt.revision }; };
    return { root, options, register, owner: () => owner, calls: () => calls, interrupts: () => interrupts, setAllowed: (v: boolean) => { allowed = v; }, release, reopen: async () => { await owner.close(); owner = createAgentAdapterHost({ ...options, store: openAgentAdapterStore(root) }); return owner; }, cleanup: async () => { await owner.close(); await rm(root, { recursive: true, force: true }); } };
}
const selector = (command: any) => ({ source: command.source, bindingKey: command.bindingKey, commandId: command.commandId });
async function until(fn: () => Promise<boolean>) {
    const end = Date.now() + 5000;
    while (!await fn()) {
        if (Date.now() > end)
            throw Error('owner_timeout');
        await Bun.sleep(10);
    }
}
test('parent original receipts keep precise handles/full result and do not send again on retry or SQLite reopen', async () => {
    const f = await fixture();
    try {
        let owner = f.owner();
        const source = await f.register(), command = { source, bindingKey: 'channel', commandId: 'original', text: 'work', contextCut: { schemaVersion: 'bridge.im-context/v1' as const, cutId: 'cut', messages: [] } };
        expect((await owner.send(request, command)).state).toBe('queued');
        await until(async () => (await owner.observe(request, selector(command))).state === 'running');
        expect(owner.busy('workspace')).toBe(true);
        const handle = (await owner.observe(request, selector(command))).handle!;
        expect(handle.sessionId).toBe('original-thread');
        expect((handle as any).taskSpaceId).toBeUndefined();
        f.release({ state: 'completed', handle, text: 'Full original tail\n' });
        await until(async () => (await owner.observe(request, selector(command))).state === 'completed');
        const original = await owner.observe(request, selector(command));
        expect(original.result).toBe('Full original tail\n');
        expect(await owner.send(request, command)).toEqual(original);
        expect(f.calls()).toBe(1);
        await expect(owner.send(request, { ...command, text: 'changed' })).rejects.toThrow('conflict');
        owner = await f.reopen();
        expect(await owner.observe(request, selector(command))).toEqual(original);
        expect(await owner.send(request, command)).toEqual(original);
        expect(f.calls()).toBe(1);
    }
    finally {
        await f.cleanup();
    }
});
test('interrupt acknowledgment is not cancellation settlement; duplicate control never interrupts again', async () => {
    const f = await fixture();
    try {
        const owner = f.owner(), source = await f.register(), command = { source, bindingKey: 'channel', commandId: 'original', text: 'work', contextCut: { schemaVersion: 'bridge.im-context/v1' as const, cutId: 'cut', messages: [] } };
        await owner.send(request, command);
        await until(async () => (await owner.observe(request, selector(command))).canInterrupt);
        const before = await owner.observe(request, selector(command)), control = { ...command, controlId: 'interrupt', expectedRevision: before.revision };
        const { text, contextCut, ...cancelSelector } = control;
        const pending = await owner.interrupt(request, cancelSelector);
        expect(pending.state).toBe('running');
        expect(f.interrupts()).toBe(1);
        await owner.interrupt(request, cancelSelector);
        expect(f.interrupts()).toBe(1);
        f.release({ state: 'cancelled', handle: before.handle, errorCode: 'agent_original_interrupted' });
        await until(async () => (await owner.observe(request, selector(command))).state === 'cancelled');
        expect((await owner.observe(request, selector(command))).result).toBeUndefined();
    }
    finally {
        await f.cleanup();
    }
});
test('restart uncertainty only reads original facts and blocks a new turn in the same unknown binding', async () => {
    const f = await fixture();
    try {
        let owner = f.owner();
        const source = await f.register(), command = { source, bindingKey: 'channel', commandId: 'unknown', text: 'work', contextCut: { schemaVersion: 'bridge.im-context/v1' as const, cutId: 'cut', messages: [] } };
        await owner.send(request, command);
        await until(async () => (await owner.observe(request, selector(command))).state === 'running');
        owner = await f.reopen();
        expect((await owner.observe(request, selector(command))).state).toBe('unknown');
        expect((await owner.send(request, command)).state).toBe('unknown');
        await expect(owner.send(request, { ...command, commandId: 'replacement' })).rejects.toThrow('busy');
        expect(f.calls()).toBe(1);
        f.setAllowed(false);
        await expect(owner.observe(request, selector(command))).rejects.toThrow('forbidden');
    }
    finally {
        await f.cleanup();
    }
});
test('grant withdrawal after acquiring the real location lease prevents driver launch', async () => {
    const f = await fixture();
    try {
        const owner = f.owner(), source = await f.register();
        f.options.resources.acquire = async () => { f.setAllowed(false); return { release() { } }; };
        await owner.send(request, { source, bindingKey: 'channel', commandId: 'withdrawn', text: 'no effect', contextCut: { schemaVersion: 'bridge.im-context/v1', cutId: 'cut', messages: [] } });
        await Bun.sleep(20);
        expect(f.calls()).toBe(0);
        f.setAllowed(true);
        expect((await owner.observe(request, { source, bindingKey: 'channel', commandId: 'withdrawn' })).state).toBe('unknown');
    }
    finally {
        await f.cleanup();
    }
});
test('host close aborts a pending lease and does not launch a driver afterward', async () => {
    const f = await fixture();
    try {
        let entered = false;
        f.options.resources.acquire = async (input: any) => { entered = true; await new Promise<never>((_, reject) => input.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })); throw Error('unreachable'); };
        const owner = f.owner(), source = await f.register();
        await owner.send(request, { source, bindingKey: 'channel', commandId: 'pending-lease', text: 'no effect', contextCut: { schemaVersion: 'bridge.im-context/v1', cutId: 'cut', messages: [] } });
        await until(async () => entered);
        await owner.close();
        expect(f.calls()).toBe(0);
    }
    finally {
        await f.cleanup();
    }
});
test('an original provider session already owned by another channel cannot be reused', async () => {
    const f = await fixture();
    try {
        const owner = f.owner(), source = await f.register(), first = { source, bindingKey: 'first', commandId: 'first-command', text: 'first', contextCut: { schemaVersion: 'bridge.im-context/v1' as const, cutId: 'first-cut', messages: [] } };
        await owner.send(request, first);
        await until(async () => (await owner.observe(request, selector(first))).state === 'running');
        const handle = (await owner.observe(request, selector(first))).handle!;
        f.release({ state: 'completed', handle, text: 'First original result' });
        await until(async () => (await owner.observe(request, selector(first))).state === 'completed');
        const second = { ...first, bindingKey: 'second', commandId: 'second-command' };
        await owner.send(request, second);
        await until(async () => (await owner.observe(request, selector(second))).state === 'unknown');
        expect((await owner.observe(request, selector(second))).errorCode).toBe('agent_cross_channel_session_forbidden');
        expect((await owner.observe(request, selector(first))).result).toBe('First original result');
    }
    finally {
        await f.cleanup();
    }
});
