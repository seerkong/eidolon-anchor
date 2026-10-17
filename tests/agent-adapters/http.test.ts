import { test, expect } from 'bun:test';
import { fixture, security, workerCommand, client } from '../daemon/helpers';
import { serveDaemon } from '../../backend/packages/elysia/src/daemonServe';
import type { AgentDriver } from '@cell/ai-runtime-host-contract';
import { parseWireResponse, parseAgentAdapterDirectory, parseAgentExecutionSnapshot } from '@cell/ai-runtime-host-contract';
test('actual parent HTTP admits registered adapter source and retains original terminal proof across complete daemon restart without invoking another driver', async () => {
    const f = await fixture();
    let native: Awaited<ReturnType<typeof serveDaemon>> | undefined, calls = 0;
    const capabilities = { submit: true, interrupt: true, observeOriginal: true, nativeTaskSpace: false as const, nativeActorHistory: false as const, attachments: false as const, artifacts: false as const, tools: 'chat-only' as const, context: 'retained' as const };
    const driver: AgentDriver = { probe: async () => ({ installed: true, version: 'fixture', capabilities }), start(input, event) { calls++; const handle = { kind: 'agent-execution' as const, source: input.command.source, provider: input.configuration.provider, sessionId: 'original-thread', turnId: 'original-turn' }; const result = (async () => { await event({ kind: 'session', sessionId: handle.sessionId }); await event({ kind: 'sending' }); await event({ kind: 'handle', handle }); await event({ kind: 'running' }); return { state: 'completed' as const, handle, text: 'Complete original parent proof\n' }; })(); return { result, interrupt: async () => { }, close: async () => { await result; } }; } };
    const snapshot = (value: unknown) => { const { requestId, ...body } = parseWireResponse(value, parseAgentExecutionSnapshot); return body; };
    const start = () => serveDaemon({ globalRoot: f.globalRoot, workerCommand, security, agentDriver: driver, listen: { port: 0 }, runtimeConfig: { mcp: false } });
    try {
        native = await start();
        const workspace = await native.daemon.register(f.a);
        await native.daemon.open(workspace.workspaceKey);
        let request = client(native);
        const call = async (path: string, body?: unknown) => { const response = await request('/daemon/agent-adapters' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const value = await response.json(); expect(response.ok).toBe(true); return value; };
        const env = native.daemon.environments({ principal: { principalId: 'local-owner', grantsVersion: '1' }, requestId: 'test' }).environments[0]!.ref;
        const command = { commandId: 'configuration', adapterId: 'adapter', expectedRevision: 0, configuration: { provider: 'codex', name: 'Actual source', model: 'fixture', enabled: true, environment: env } };
        await call('/configure', command);
        const directory = parseWireResponse(await call(''), parseAgentAdapterDirectory);
        expect(directory.adapters[0]!.access).toBe('unverified');
        expect(directory.adapters[0]!.canSubmit).toBe(true);
        expect(directory.adapters[0]!.capabilities.nativeTaskSpace).toBe(false);
        const source = directory.adapters[0]!.source, send = { source, bindingKey: 'channel', commandId: 'execute', text: 'work', contextCut: { schemaVersion: 'bridge.im-context/v1', cutId: 'cut', messages: [] } }, selector = { source, bindingKey: 'channel', commandId: 'execute' };
        await call('/send', send);
        const end = Date.now() + 10000;
        let original: any;
        while (true) {
            original = snapshot(await call('/observe', selector));
            if (original.state === 'completed')
                break;
            if (Date.now() > end)
                throw Error('original_http_timeout');
            await Bun.sleep(50);
        }
        expect(original.result).toBe('Complete original parent proof\n');
        expect(calls).toBe(1);
        const wrong = await request('/daemon/agent-adapters/configure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...command, commandId: 'forged', configuration: { ...command.configuration, cwd: f.b } }) });
        expect(wrong.status).toBe(400);
        await native.close();
        native = await start();
        request = client(native);
        expect(snapshot(await call('/observe', selector))).toEqual(original);
        expect(snapshot(await call('/send', send))).toEqual(original);
        expect(calls).toBe(1);
    }
    finally {
        await native?.close();
        await f.cleanup();
    }
}, 30000);
