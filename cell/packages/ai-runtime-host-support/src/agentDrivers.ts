import { randomUUID } from 'node:crypto';
import type { AgentDriver, AgentDriverInput, AgentDriverResult, AgentDriverEvent, AgentExecutionHandle, AgentAdapterCapabilities } from '@cell/ai-runtime-host-contract';
import { parseAgentExecutionHandle } from '@cell/ai-runtime-host-contract';
import { createAgentProcessEffects, createAgentRpc, type AgentProcess, type AgentProcessEffects } from './agentProcess';
const capabilities: AgentAdapterCapabilities = { submit: true, interrupt: true, observeOriginal: true, nativeTaskSpace: false, nativeActorHistory: false, attachments: false, artifacts: false, tools: 'chat-only', context: 'retained' };
const text = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.length > 256)
        throw Error('agent_protocol_identity_invalid');
    return value;
};
function resultText(value: unknown): string {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 8 * 1024 * 1024)
        throw Error('agent_protocol_result_invalid');
    return value;
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); void promise.catch(() => { }); return { promise, resolve, reject }; }
function prompt(input: AgentDriverInput) { return JSON.stringify({ kind: 'bridge-current-agent-request', commandId: input.command.commandId, currentInput: input.command.text, conversation: input.command.contextCut }); }
/** Original provider protocols only. No Native TaskSpace, task, claim or Actor is fabricated. */
export function createAgentDrivers(effects: AgentProcessEffects = createAgentProcessEffects()): AgentDriver {
    return {
        async probe(provider) { const version = await effects.version(provider); return { installed: Boolean(version), ...(version ? { version } : {}), capabilities: { ...capabilities, tools: provider === 'codex' ? 'read-only' : 'chat-only', context: provider === 'grok' ? 'explicit-cut' : 'retained' } }; },
        start(input, onEvent) {
            let process: AgentProcess | undefined, stopping = false, interrupting = false, interruptEffect: (() => Promise<void>) | undefined, handle: AgentExecutionHandle | undefined;
            const notify = async (event: AgentDriverEvent) => {
                if (stopping)
                    throw Error('agent_driver_closed');
                await onEvent(event);
                if (event.kind === 'handle')
                    handle = parseAgentExecutionHandle(event.handle);
            };
            const identity = (sessionId: string, turnId?: string): AgentExecutionHandle => parseAgentExecutionHandle({ kind: 'agent-execution', source: input.command.source, provider: input.configuration.provider, sessionId, ...(turnId ? { turnId } : {}) });
            async function codex(): Promise<AgentDriverResult> {
                process = await effects.spawn(['codex', 'app-server', '--stdio', '--disable', 'shell_tool', '--disable', 'multi_agent'], input.environment.workspace.workDir);
                if (stopping) {
                    await process.close();
                    throw Error('agent_driver_closed');
                }
                const terminal = deferred<AgentDriverResult>(), frames: any[] = [], items = new Map<string, any>();
                let sessionId = '', turnId = '';
                const accept = async (v: any) => {
                    const p = v.params;
                    if (!p || p.threadId !== sessionId)
                        return;
                    if (p.turnId && turnId && p.turnId !== turnId)
                        return;
                    if (v.method === 'item/completed') {
                        if (p.turnId !== turnId)
                            throw Error('agent_protocol_turn_mismatch');
                        const item = p.item;
                        if (item?.type === 'agentMessage') {
                            text(item.id);
                            resultText(item.text);
                            if (!items.has(item.id) && items.size >= 4096)
                                throw Error('agent_protocol_event_capacity');
                            items.set(item.id, item);
                        }
                        return;
                    }
                    if (v.method !== 'turn/completed')
                        return;
                    const turn = p.turn;
                    if (!turn || text(turn.id) !== turnId)
                        throw Error('agent_protocol_turn_mismatch');
                    if (turn.status === 'completed') {
                        const full = new Map(items);
                        if (turn.items !== undefined && (!Array.isArray(turn.items) || turn.items.length > 4096))
                            throw Error('agent_protocol_event_capacity');
                        for (const item of turn.items ?? [])
                            if (item?.type === 'agentMessage') {
                                text(item.id);
                                resultText(item.text);
                                full.set(item.id, item);
                            }
                        const final = [...full.values()].filter(i => i.phase !== 'commentary');
                        if (!final.length)
                            terminal.resolve({ state: 'unknown', handle, errorCode: 'agent_original_result_missing' });
                        else
                            terminal.resolve({ state: 'completed', handle: identity(sessionId, turnId), text: resultText(final.map(i => i.text).join('')) });
                    }
                    else if (turn.status === 'interrupted')
                        terminal.resolve({ state: 'cancelled', handle: identity(sessionId, turnId), errorCode: 'agent_original_interrupted' });
                    else if (turn.status === 'failed')
                        terminal.resolve({ state: 'failed', handle: identity(sessionId, turnId), errorCode: 'agent_original_failed' });
                    else
                        throw Error('agent_protocol_terminal_invalid');
                };
                const rpc = createAgentRpc(process, async (v) => {
                    if (!turnId) {
                        if (frames.length >= 4096)
                            throw Error('agent_protocol_event_capacity');
                        frames.push(v);
                    }
                    else
                        await accept(v);
                }, async (v) => {
                    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(v.method))
                        return { decision: 'decline' };
                    throw Error('agent_permission_request_unsupported');
                });
                void rpc.pump.then(() => terminal.reject(Error('agent_transport_outcome_unknown')), e => terminal.reject(e));
                await rpc.request('initialize', { clientInfo: { name: 'eidolon_bridge', title: 'Eidolon Bridge', version: '0.1.0' }, capabilities: null });
                await rpc.notify('initialized', {});
                const params = { model: input.configuration.model, cwd: input.environment.workspace.workDir, approvalPolicy: 'never', sandbox: 'read-only', config: { features: { shell_tool: false, multi_agent: false }, mcp_servers: {}, web_search: 'disabled' } };
                const opened = await rpc.request(input.sessionId ? 'thread/resume' : 'thread/start', { ...params, ...(input.sessionId ? { threadId: input.sessionId } : {}) });
                sessionId = text(opened.thread?.id);
                if (input.sessionId && sessionId !== input.sessionId)
                    throw Error('agent_protocol_session_mismatch');
                await notify({ kind: 'session', sessionId });
                await notify({ kind: 'sending' });
                const started = await rpc.request('turn/start', { threadId: sessionId, clientUserMessageId: input.command.commandId, input: [{ type: 'text', text: prompt(input) }] });
                turnId = text(started.turn?.id);
                await notify({ kind: 'handle', handle: identity(sessionId, turnId) });
                await notify({ kind: 'running' });
                interruptEffect = async () => { await rpc.request('turn/interrupt', { threadId: sessionId, turnId }); };
                if (interrupting)
                    await interruptEffect();
                for (const frame of frames)
                    await accept(frame);
                return terminal.promise;
            }
            async function grok(): Promise<AgentDriverResult> {
                // MCP and every built-in effect tool are denied. ACP client filesystem/terminal permissions are absent.
                process = await effects.spawn(['grok', '--model', input.configuration.model, '--tools', '', '--no-subagents', '--disable-web-search', '--permission-mode', 'dontAsk', '--deny', 'MCPTool', '--deny', 'Bash', '--deny', 'Edit', '--deny', 'Read', '--deny', 'Grep', '--deny', 'WebFetch', '--deny', 'WebSearch', 'agent', '--no-leader', 'stdio'], input.environment.workspace.workDir);
                if (stopping) {
                    await process.close();
                    throw Error('agent_driver_closed');
                }
                let sessionId = '', body = '';
                const rpc = createAgentRpc(process, async (v) => {
                    if (v.method !== 'session/update')
                        return;
                    const p = v.params;
                    if (p?.sessionId !== sessionId)
                        throw Error('agent_protocol_session_mismatch');
                    const update = p.update;
                    if (update?.sessionUpdate === 'agent_message_chunk') {
                        if (update.content?.type !== 'text' || typeof update.content.text !== 'string')
                            throw Error('agent_protocol_result_invalid');
                        body = resultText(body + update.content.text);
                    }
                }, async (v) => {
                    if (v.method === 'session/request_permission')
                        return { outcome: { outcome: 'cancelled' } };
                    throw Error('agent_permission_request_unsupported');
                });
                await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'eidolon-bridge', version: '0.1.0' } });
                if (input.sessionId)
                    throw Error('agent_original_resume_unsupported');
                const opened = await rpc.request('session/new', { cwd: input.environment.workspace.workDir, mcpServers: [] });
                sessionId = text(opened.sessionId);
                await notify({ kind: 'session', sessionId });
                await notify({ kind: 'handle', handle: identity(sessionId) });
                interruptEffect = () => rpc.notify('session/cancel', { sessionId });
                await notify({ kind: 'sending' });
                await notify({ kind: 'running' });
                const running = rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt(input) }] }, 600000);
                if (interrupting)
                    await interruptEffect();
                const outcome = await running;
                if (outcome.stopReason === 'end_turn')
                    return { state: 'completed', handle: identity(sessionId), text: body };
                if (outcome.stopReason === 'cancelled')
                    return { state: 'cancelled', handle: identity(sessionId), errorCode: 'agent_original_interrupted' };
                return { state: 'failed', handle: identity(sessionId), errorCode: 'agent_original_incomplete' };
            }
            async function claude(): Promise<AgentDriverResult> {
                const sessionId = input.sessionId ?? randomUUID();
                process = await effects.spawn(['claude', '--print', '--bare', '--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', input.configuration.model, ...(input.sessionId ? ['--resume', sessionId] : ['--session-id', sessionId])], input.environment.workspace.workDir);
                if (stopping) {
                    await process.close();
                    throw Error('agent_driver_closed');
                }
                interruptEffect = async () => { process!.signal('SIGINT'); };
                await notify({ kind: 'sending' });
                await process.write({ type: 'user', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: prompt(input) } });
                if (interrupting)
                    await interruptEffect();
                let initialized = false;
                for await (const frame of process.lines) {
                    const v = frame as any;
                    if (v?.type === 'system' && v.subtype === 'init') {
                        if (text(v.session_id) !== sessionId)
                            throw Error('agent_protocol_session_mismatch');
                        initialized = true;
                        await notify({ kind: 'session', sessionId });
                        await notify({ kind: 'handle', handle: identity(sessionId) });
                        await notify({ kind: 'running' });
                        continue;
                    }
                    if (v?.type === 'control_request')
                        throw Error('agent_permission_request_unsupported');
                    if (v?.type !== 'result')
                        continue;
                    if (!initialized || text(v.session_id) !== sessionId)
                        throw Error('agent_protocol_session_mismatch');
                    if (v.subtype === 'success' && v.is_error === false)
                        return { state: 'completed', handle: identity(sessionId), text: resultText(v.result) };
                    if (v.is_error === true)
                        return { state: 'failed', handle: identity(sessionId), errorCode: 'agent_original_failed' };
                    throw Error('agent_protocol_terminal_invalid');
                }
                return { state: 'unknown', handle, errorCode: 'agent_transport_outcome_unknown' };
            }
            const result = (async () => {
                const timer = setTimeout(() => { stopping = true; void process?.close(); }, 600000);
                try {
                    return await (input.configuration.provider === 'codex' ? codex() : input.configuration.provider === 'grok' ? grok() : claude());
                }
                catch (error) {
                    const code = error instanceof Error && /^agent_[a-z_]+$/.test(error.message) ? error.message : 'agent_transport_outcome_unknown';
                    return { state: 'unknown' as const, ...(handle ? { handle } : {}), errorCode: code };
                }
                finally {
                    clearTimeout(timer);
                    await process?.close();
                }
            })();
            return { result, async interrupt() {
                    interrupting = true;
                    if (interruptEffect)
                        await interruptEffect();
                }, async close() { stopping = true; await process?.close(); await result; } };
        }
    };
}
