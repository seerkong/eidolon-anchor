import { test, expect } from 'bun:test';
import { createAgentDrivers } from '../../cell/packages/ai-runtime-host-support/src/agentDrivers';
import type { AgentProcess, AgentProcessEffects } from '../../cell/packages/ai-runtime-host-support/src/agentProcess';
import { parseAgentAdapterSourceRef, parseAgentAdapterConfiguration, parseAgentExecutionSnapshot, type AgentAdapterKind, type AgentDriverInput } from '@cell/ai-runtime-host-contract';
const exact = 'Complete original response\n  whitespace and Unicode.\n';
function input(provider: AgentAdapterKind): AgentDriverInput { const environment = { kind: 'daemon-workspace' as const, daemonId: 'daemon', workspaceKey: 'workspace', revision: 1 }; return { command: { source: { kind: 'agent-adapter', daemonId: 'daemon', adapterId: 'adapter', revision: 1 }, bindingKey: 'original-channel-binding', commandId: 'command', text: 'current task', contextCut: { schemaVersion: 'bridge.im-context/v1', cutId: 'cut', messages: [] } }, configuration: { provider, name: provider, model: 'fixture-model', environment, enabled: true }, environment: { ref: environment, workspace: { workspaceKey: 'workspace', workDir: '/registered/workspace', workspaceId: '/registered/workspace', revision: 1, placement: 'workspace' } } }; }
function transport(onWrite: (value: any, emit: (value: any) => void) => Promise<void> | void) {
    const values: any[] = [], writes: any[] = [], commands: readonly string[][] = [] as any;
    let awake!: () => void, closed = false, signals: string[] = [];
    const emit = (value: any) => { values.push(value); awake?.(); };
    const process: AgentProcess = { lines: { async *[Symbol.asyncIterator]() { while (!closed || values.length) {
                if (values.length)
                    yield values.shift();
                else
                    await new Promise<void>(r => { awake = r; });
            } } }, write: async (v) => { writes.push(v); await onWrite(v, emit); }, signal: s => { signals.push(s); }, close: async () => { closed = true; awake?.(); } };
    const effects: AgentProcessEffects = { version: async () => 'fixture-version', spawn: async (cmd, cwd) => { (commands as string[][]).push([...cmd]); expect(cwd).toBe('/registered/workspace'); return process; } };
    return { effects, writes, commands, signals, emit };
}
for (const provider of ['codex', 'claude', 'grok'] as const)
    test(provider + ' driver preserves actual original handles and complete result rather than admission/deltas', async () => {
        const f = transport((v, emit) => {
            if (provider === 'claude') {
                expect(v.type).toBe('user');
                emit({ type: 'system', subtype: 'init', session_id: v.session_id });
                emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'not the result' } } });
                emit({ type: 'result', subtype: 'success', is_error: false, session_id: v.session_id, result: exact });
                return;
            }
            if (v.method === 'initialized')
                return;
            if (v.method === 'initialize') {
                emit({ jsonrpc: '2.0', id: v.id, result: { agentCapabilities: { loadSession: false } } });
                return;
            }
            if (v.method === 'thread/start') {
                expect(v.params.sandbox).toBe('read-only');
                expect(v.params.approvalPolicy).toBe('never');
                emit({ id: v.id, result: { thread: { id: 'actual-thread' } } });
                return;
            }
            if (v.method === 'turn/start') {
                emit({ method: 'item/agentMessage/delta', params: { threadId: 'actual-thread', turnId: 'actual-turn', delta: 'not the result' } });
                emit({ method: 'turn/completed', params: { threadId: 'actual-thread', turn: { id: 'actual-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'actual-message', phase: 'final_answer', text: exact }] } } });
                emit({ id: v.id, result: { turn: { id: 'actual-turn' } } });
                return;
            }
            if (v.method === 'session/new') {
                expect(v.params.mcpServers).toEqual([]);
                emit({ jsonrpc: '2.0', id: v.id, result: { sessionId: 'actual-acp-session' } });
                return;
            }
            if (v.method === 'session/prompt') {
                emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'actual-acp-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: exact } } } });
                emit({ jsonrpc: '2.0', id: v.id, result: { stopReason: 'end_turn' } });
                return;
            }
            throw Error('unexpected request ' + v.method);
        });
        const events: any[] = [], driver = createAgentDrivers(f.effects), run = driver.start(input(provider), async (e) => { events.push(e); });
        const result = await run.result;
        expect(result.state).toBe('completed');
        expect((result as any).text).toBe(exact);
        expect(result.handle?.provider).toBe(provider);
        expect(result.handle?.source).toEqual(input(provider).command.source);
        expect(result.handle?.sessionId).toBeTruthy();
        if (provider === 'codex')
            expect(result.handle?.turnId).toBe('actual-turn');
        expect(events.some(e => e.kind === 'sending')).toBe(true);
        expect(events.some(e => e.kind === 'handle')).toBe(true);
        expect((result as any).taskSpaceId).toBeUndefined();
        await run.close();
    }, 5000);
test('foreign provider session never becomes a complete original result', async () => {
    const f = transport((v, emit) => { emit({ type: 'system', subtype: 'init', session_id: 'another-channel' }); emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'another-channel', result: exact }); });
    const run = createAgentDrivers(f.effects).start(input('claude'), async () => { });
    expect((await run.result).state).toBe('unknown');
    await run.close();
});
test('external wire forbids executable, path, credentials, broad capabilities and fabricated Native task identity', () => {
    const fixture = input('codex');
    for (const key of ['cwd', 'command', 'argv', 'credentials', 'permissions'])
        expect(() => parseAgentAdapterConfiguration({ ...fixture.configuration, [key]: 'forged' })).toThrow();
    for (const key of ['taskSpaceId', 'claimId', 'endpointId', 'cwd'])
        expect(() => parseAgentAdapterSourceRef({ ...fixture.command.source, [key]: 'forged' })).toThrow();
    expect(() => parseAgentExecutionSnapshot({ source: fixture.command.source, bindingKey: 'binding', commandId: 'command', fingerprint: 'hash', revision: 1, state: 'completed', result: 'fake', canInterrupt: false })).toThrow();
});
test('Codex interrupt RPC acknowledgment cannot settle cancellation without the original terminal turn', async () => {
    let active = false, settled = false;
    const f = transport((v, emit) => {
        if (v.method === 'initialize')
            emit({ id: v.id, result: {} });
        else if (v.method === 'thread/start')
            emit({ id: v.id, result: { thread: { id: 'thread' } } });
        else if (v.method === 'turn/start')
            emit({ id: v.id, result: { turn: { id: 'turn' } } });
        else if (v.method === 'turn/interrupt')
            emit({ id: v.id, result: {} });
        else if (v.method !== 'initialized')
            throw Error('unexpected');
    });
    const run = createAgentDrivers(f.effects).start(input('codex'), async (e) => { if (e.kind === 'running')
        active = true; });
    void run.result.then(() => settled = true);
    try {
        const end = Date.now() + 2000;
        while (!active) {
            if (Date.now() > end)
                throw Error('not running');
            await Bun.sleep(5);
        }
        await run.interrupt();
        await Bun.sleep(10);
        expect(settled).toBe(false);
        f.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } });
        expect((await run.result).state).toBe('cancelled');
    }
    finally {
        await run.close();
    }
});
