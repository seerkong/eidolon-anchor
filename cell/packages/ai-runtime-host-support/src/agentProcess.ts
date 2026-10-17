import { spawn } from 'node:child_process';
/** A fixed driver owns command construction. Browser input never reaches executable/argv/env. */
export type AgentProcess = Readonly<{
    lines: AsyncIterable<unknown>;
    write(value: unknown): Promise<void>;
    signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void;
    close(): Promise<void>;
}>;
export type AgentProcessEffects = Readonly<{
    spawn(command: readonly string[], cwd: string): Promise<AgentProcess>;
    version(provider: 'codex' | 'claude' | 'grok'): Promise<string | undefined>;
}>;
export function createAgentProcessEffects(): AgentProcessEffects {
    return {
        async version(provider) { try {
            const child = Bun.spawn([provider, '--version'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
            const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
            try {
                const chunks: Uint8Array[] = [];
                let size = 0;
                for await (const chunk of child.stdout) {
                    size += chunk.byteLength;
                    if (size > 4096) {
                        child.kill('SIGKILL');
                        await child.exited;
                        return;
                    }
                    chunks.push(chunk);
                }
                if (await child.exited !== 0)
                    return;
                return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim();
            }
            finally {
                clearTimeout(timeout);
            }
        }
        catch {
            return;
        } },
        async spawn(command, cwd) {
            if (process.platform === 'win32')
                throw Error('agent_process_platform_unavailable');
            const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env, CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '0' } });
            const exit = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
            void exit.catch(() => { });
            child.stdin.on('error', () => { });
            const pid = child.pid;
            if (!pid)
                throw Error('agent_process_not_started');
            let closing: Promise<void> | undefined;
            const signal = (value: 'SIGINT' | 'SIGTERM' | 'SIGKILL') => { try {
                process.kill(-pid, value);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                    throw error;
            } };
            // Drain without retaining or publishing stderr, which can contain credentials.
            const diagnostics = (async () => { for await (const _ of child.stderr) { } })();
            void diagnostics.catch(() => { });
            return { write: value => new Promise<void>((resolve, reject) => { const line = JSON.stringify(value) + '\n'; if (Buffer.byteLength(line) > 1024 * 1024)
                    return reject(Error('agent_process_input_capacity')); child.stdin.write(line, error => error ? reject(error) : resolve()); }), signal,
                lines: { async *[Symbol.asyncIterator]() { const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '', bytes = 0; for await (const chunk of child.stdout) {
                        bytes += chunk.byteLength;
                        if (bytes > 32 * 1024 * 1024)
                            throw Error('agent_process_output_capacity');
                        buffer += decoder.decode(chunk, { stream: true });
                        let end: number;
                        while ((end = buffer.indexOf('\n')) >= 0) {
                            const line = buffer.slice(0, end);
                            buffer = buffer.slice(end + 1);
                            if (Buffer.byteLength(line) > 8 * 1024 * 1024)
                                throw Error('agent_process_line_capacity');
                            if (line.trim())
                                yield JSON.parse(line);
                        }
                        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024)
                            throw Error('agent_process_line_capacity');
                    } buffer += decoder.decode(); if (buffer.trim())
                        throw Error('agent_process_truncated_frame'); } },
                close: () => closing ??= (async () => {
                    try {
                        child.stdin.end();
                    }
                    catch { }
                    try {
                        signal('SIGTERM');
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'EPERM')
                            throw error;
                        // macOS can reject a signal while an already-exiting child awaits reaping.
                        // Wait for that owned child's exit; a live permission failure remains an error.
                        let timer: ReturnType<typeof setTimeout> | undefined;
                        try {
                            await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error), 2000); })]);
                        }
                        finally {
                            clearTimeout(timer);
                        }
                    }
                    const timer = setTimeout(() => signal('SIGKILL'), 2000);
                    try {
                        await exit;
                        signal('SIGKILL');
                        await diagnostics;
                    }
                    finally {
                        clearTimeout(timer);
                    }
                })(),
            };
        }
    };
}
export function createAgentRpc(process: AgentProcess, onNotification: (value: any) => Promise<void>, onRequest: (value: any) => Promise<unknown>) {
    let id = 0, closed = false;
    const pending = new Map<number, {
        resolve: (value: any) => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    const error = () => Error('agent_transport_outcome_unknown');
    const pump = (async () => { try {
        for await (const message of process.lines) {
            const v = message as any;
            if (!v || typeof v !== 'object' || Array.isArray(v))
                throw Error('agent_protocol_invalid');
            if (v.method) {
                if (typeof v.method !== 'string')
                    throw Error('agent_protocol_invalid');
                if (v.id !== undefined) {
                    const result = await onRequest(v);
                    await process.write({ jsonrpc: '2.0', id: v.id, result });
                }
                else
                    await onNotification(v);
                continue;
            }
            if (typeof v.id !== 'number' || !pending.has(v.id))
                throw Error('agent_protocol_unmatched_reply');
            const request = pending.get(v.id)!;
            pending.delete(v.id);
            clearTimeout(request.timer);
            if (v.error)
                request.reject(Error('agent_provider_request_failed'));
            else if (Object.prototype.hasOwnProperty.call(v, 'result'))
                request.resolve(v.result);
            else
                request.reject(Error('agent_protocol_invalid'));
        }
    }
    catch (e) {
        for (const p of pending.values()) {
            clearTimeout(p.timer);
            p.reject(e);
        }
        throw e;
    }
    finally {
        closed = true;
        for (const p of pending.values()) {
            clearTimeout(p.timer);
            p.reject(error());
        }
        pending.clear();
    } })();
    // Callers observe pump explicitly; this prevents a rejected reader becoming a process-global error.
    void pump.catch(() => { });
    return { pump, notify: (method: string, params: unknown) => process.write({ jsonrpc: '2.0', method, params }),
        request(method: string, params: unknown, timeoutMs = 120000): Promise<any> { if (closed)
            return Promise.reject(error()); if (pending.size >= 32)
            return Promise.reject(Error('agent_rpc_capacity')); const next = ++id; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(next); reject(error()); }, timeoutMs); pending.set(next, { resolve, reject, timer }); void process.write({ jsonrpc: '2.0', id: next, method, params }).catch(e => { clearTimeout(timer); pending.delete(next); reject(e); }); }); },
    };
}
