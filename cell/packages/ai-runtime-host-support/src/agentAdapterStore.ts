import { Database } from 'bun:sqlite';
import { constants, openSync, closeSync, fstatSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapterState, AgentAdapterStore } from '@cell/ai-runtime-host-contract';
import { parseAgentAdapterConfigureReceipt, parseAgentAdapterConfiguration, parseAgentAdapterSourceRef, parseAgentAdapterSendCommand, parseAgentExecutionSnapshot } from '@cell/ai-runtime-host-contract';
export function validateAgentAdapterState(s: AgentAdapterState) {
    if (s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0)
        throw Error('invalid_agent_adapter_store');
    for (const [name, max] of [['registrations', 128], ['receipts', 4096], ['bindings', 1024], ['executions', 4096], ['controls', 4096]] as const)
        if (!Array.isArray(s[name]) || s[name].length > max)
            throw Error('agent_adapter_store_capacity');
    const unique = (values: readonly string[]) => { if (new Set(values).size !== values.length)
        throw Error('invalid_agent_adapter_store'); };
    unique(s.registrations.map(r => r.source.adapterId));
    unique(s.receipts.map(r => r.commandId));
    unique(s.bindings.map(b => JSON.stringify([b.source, b.bindingKey])));
    unique(s.executions.map(e => JSON.stringify([e.command.source, e.command.bindingKey, e.command.commandId])));
    unique(s.controls.map(c => c.controlId));
    for (const r of s.registrations) {
        parseAgentAdapterSourceRef(r.source);
        parseAgentAdapterConfiguration(r.configuration);
    }
    for (const r of s.receipts)
        parseAgentAdapterConfigureReceipt(r);
    for (const b of s.bindings) {
        parseAgentAdapterSourceRef(b.source);
        if (typeof b.bindingKey !== 'string' || !b.bindingKey || b.bindingKey.length > 256 || b.sessionId !== undefined && (typeof b.sessionId !== 'string' || !b.sessionId || b.sessionId.length > 256))
            throw Error('invalid_agent_adapter_store');
    }
    for (const e of s.executions) {
        parseAgentAdapterSendCommand(e.command);
        parseAgentAdapterConfiguration(e.configuration);
        parseAgentExecutionSnapshot(e.snapshot);
        if (e.command.bindingKey !== e.snapshot.bindingKey || e.command.commandId !== e.snapshot.commandId || ['kind', 'daemonId', 'adapterId', 'revision'].some(k => (e.command.source as any)[k] !== (e.snapshot.source as any)[k]))
            throw Error('invalid_agent_adapter_store');
    }
    for (const c of s.controls) {
        parseAgentAdapterSourceRef(c.source);
        if (!['sending', 'accepted', 'unknown'].includes(c.state) || ![c.controlId, c.commandId, c.bindingKey, c.fingerprint].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256))
            throw Error('invalid_agent_adapter_store');
    }
}
/** The daemon parent writer lease owns this SQLite store; no browser or worker writes it. */
export function openAgentAdapterStore(directory: string): AgentAdapterStore {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid())
        throw Error('unsafe_agent_adapter_directory');
    const filename = join(directory, 'agent-adapters.sqlite'), fd = openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
        const f = fstatSync(fd);
        if (!f.isFile() || (f.mode & 0o077) !== 0 || process.getuid && f.uid !== process.getuid())
            throw Error('unsafe_agent_adapter_store');
    }
    finally {
        closeSync(fd);
    }
    const db = new Database(filename, { strict: true });
    db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS agent_adapter_state (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL)');
    const initial: AgentAdapterState = { version: 1, revision: 0, registrations: [], receipts: [], bindings: [], executions: [], controls: [] };
    db.query('INSERT OR IGNORE INTO agent_adapter_state VALUES(1,0,?)').run(JSON.stringify(initial));
    return { read() { const s = JSON.parse(db.query<{
            body: string;
        }, [
        ]>('SELECT body FROM agent_adapter_state WHERE id=1').get()!.body) as AgentAdapterState; validateAgentAdapterState(s); return s; }, commit: db.transaction((expected: number, s: AgentAdapterState) => { validateAgentAdapterState(s); const body = JSON.stringify(s); if (Buffer.byteLength(body) > 256 * 1024 * 1024)
            throw Error('agent_adapter_store_capacity'); if (s.revision !== expected + 1)
            throw Error('invalid_agent_adapter_revision'); if (db.query('UPDATE agent_adapter_state SET revision=?,body=? WHERE id=1 AND revision=?').run(s.revision, body, expected).changes !== 1)
            throw Error('agent_adapter_store_conflict'); }), close: () => db.close() };
}
