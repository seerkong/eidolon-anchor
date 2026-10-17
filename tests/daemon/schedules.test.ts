import { test, expect } from 'bun:test';
import { mkdtempSync, chmodSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonScheduleOwner } from '../../cell/packages/ai-runtime-host-capsule/src/schedules';
import { openDaemonScheduleStore } from '../../cell/packages/ai-runtime-host-support/src/schedules';
import { appendScheduleAttempt, emptyScheduleState, validateScheduleCommand } from '../../cell/packages/ai-runtime-host-logic/src/schedules';
import type { RuntimeHostPort, DaemonScheduleCommand, HostExecutionOutput, HostParticipantWork, HostParticipantRecipient } from '@cell/ai-runtime-host-contract';
const principal = { principalId: 'test-owner', grantsVersion: '1' };
const recipient: HostParticipantRecipient = { kind: 'member', ref: 'worker', ownerScopeRef: 'global', bindingRef: 'binding', bindingDigest: 'digest', admissionRef: 'admit' };
const create: DaemonScheduleCommand = { kind: 'create', commandId: 'create', expectedRevision: 0, scheduleId: 'hourly', name: '每小时资料', everyMinutes: 60, action: { recipient, text: '输出新增资料' } };
function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'eidolon-schedules-'));
    chmodSync(directory, 0o700);
    let time = 1000, counter = 0, sends = 0, throwSend = false, available = true, grant = '1', allowed = true;
    const work: HostParticipantWork[] = [], outputs: HostExecutionOutput[] = [], bindings: string[] = [];
    const port = { capabilities: () => ({ serverInstanceId: 'instance' }), participantDirectory: async () => ({ ownerScopeRef: 'global', registryRevision: '1', contacts: [{ recipient, name: 'worker', available, parentRefs: [] }] }),
        openParticipant: async (_r: any, c: any) => { bindings.push(c.bindingKey); return { bindingKey: c.bindingKey, recipient, sessionId: 'session' }; },
        submitExecution: async (_r: any, c: any) => { sends++; if (throwSend)
            throw new Error('lost response'); const task = { admissionId: c.commandId, taskSpaceId: 'original', taskId: c.commandId }; work.push({ commandId: c.commandId, task, revision: 1, status: 'Running', attempt: 1, canCancel: true, executions: [], questions: [] }); return { commandId: c.commandId, requestRef: c.commandId, task, state: 'submitted' }; },
        participantWork: async () => ({ bindingKey: 'binding', sessionId: 'session', work }), executionOutputPage: async () => ({ bindingKey: 'binding', sessionId: 'session', outputs, deliveries: [] }) } as unknown as RuntimeHostPort;
    const owner = () => createDaemonScheduleOwner({ store: openDaemonScheduleStore(directory), principal, authorization: { permits: () => allowed, currentGrantsVersion: () => grant }, port: async () => port, now: () => time, newId: () => `id-${++counter}` });
    return { directory, owner, work, outputs, bindings, setTime: (t: number) => { time = t; }, setThrow: () => { throwSend = true; }, setAvailable: (v: boolean) => { available = v; }, setGrant: (v: string) => { grant = v; }, setAllowed: (v: boolean) => { allowed = v; }, sends: () => sends, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
async function enabled(f: ReturnType<typeof setup>) { const o = f.owner(); await o.command(principal, create); await o.command(principal, { kind: 'enable', scheduleId: 'hourly', expectedRevision: 1, commandId: 'enable' }); return o; }
test('CAS and durable receipt; enabled input cannot be edited; other principal cannot read', async () => {
    const f = setup();
    let o = await enabled(f);
    try {
        expect(o.view(principal, 'hourly').schedules[0].nextDueAt).toBe(3601000);
        await expect(o.command(principal, { ...create, kind: 'edit', commandId: 'bad', expectedRevision: 2 })).rejects.toThrow('disable_before_edit');
        await expect(o.command(principal, { kind: 'disable', scheduleId: 'hourly', expectedRevision: 1, commandId: 'stale' })).rejects.toThrow('revision_conflict');
        await o.command(principal, { kind: 'disable', scheduleId: 'hourly', expectedRevision: 2, commandId: 'disable' });
        await expect(o.command(principal, { ...create, text: 'wrong' })).rejects.toThrow('invalid_schedule_schema');
        expect(() => o.view({ ...principal, principalId: 'other' })).toThrow('forbidden');
        await o.close();
        o = f.owner();
        expect(o.receipt(principal, 'create').revision).toBe(1);
        expect((await o.command(principal, create)).revision).toBe(1);
        expect(f.sends()).toBe(0);
    }
    finally {
        await o.close();
        f.cleanup();
    }
});
test('one canonical execution; overlap skips, waiting occupies, full result survives later failure', async () => {
    const f = setup(), o = await enabled(f);
    try {
        f.setTime(3601000);
        await o.tick();
        expect(f.sends()).toBe(1);
        f.work[0] = { ...f.work[0]!, status: 'Waiting' };
        f.setTime(7201000);
        await o.tick();
        expect(f.sends()).toBe(1);
        expect(o.view(principal, 'hourly').attempts.at(-1)?.reason).toBe('overlap');
        f.work[0] = { ...f.work[0]!, status: 'Succeeded' };
        await o.tick();
        expect(o.view(principal, 'hourly').attempts[0].state).toBe('submitted');
        const w = f.work[0]!;
        f.outputs.push({ outputId: 'result', revision: 1, ordinal: 1, recordedAt: 7201000, commandId: w.commandId, kind: 'result', text: '完整结果', artifactRefs: [], source: w.task });
        await o.tick();
        expect(o.view(principal, 'hourly').attempts[0].result?.text).toBe('完整结果');
        f.setTime(10801000);
        await o.tick();
        expect(f.sends()).toBe(2);
        f.work[1] = { ...f.work[1]!, status: 'Failed' };
        await o.tick();
        expect(o.view(principal, 'hourly').attempts.find(a => a.result)?.result?.text).toBe('完整结果');
        await o.command(principal, { kind: 'disable', scheduleId: 'hourly', commandId: 'disable', expectedRevision: 2 });
        await o.command(principal, { kind: 'enable', scheduleId: 'hourly', commandId: 'reenable', expectedRevision: 3 });
        f.setTime(14401000);
        await o.tick();
        expect(f.sends()).toBe(3);
        expect(new Set(f.bindings).size).toBe(1);
    }
    finally {
        await o.close();
        f.cleanup();
    }
});
test('restart collapses offline due range, observes original execution and never sends it again', async () => {
    const f = setup();
    let o = await enabled(f);
    try {
        f.setTime(3601000);
        await o.tick();
        expect(f.sends()).toBe(1);
        await o.close();
        f.setTime(36001000);
        o = f.owner();
        const missed = o.view(principal, 'hourly').attempts.find(a => a.state === 'missed')!;
        expect(missed.missedCount).toBe(9);
        expect(missed.throughDueAt).toBe(36001000);
        await o.tick();
        expect(f.sends()).toBe(1);
        f.setTime(39601000);
        await o.tick();
        expect(o.view(principal, 'hourly').attempts.at(-1)?.reason).toBe('overlap');
        expect(f.sends()).toBe(1);
    }
    finally {
        await o.close();
        f.cleanup();
    }
});
test('unknown stays occupied across restart and no response triggers no retry', async () => {
    const f = setup();
    let o = await enabled(f);
    try {
        f.setThrow();
        f.setTime(3601000);
        await o.tick();
        expect(o.view(principal, 'hourly').attempts[0].state).toBe('unknown');
        await o.close();
        o = f.owner();
        await o.tick();
        f.setTime(7201000);
        await o.tick();
        expect(f.sends()).toBe(1);
        expect(o.view(principal, 'hourly').attempts.at(-1)?.reason).toBe('overlap');
    }
    finally {
        await o.close();
        f.cleanup();
    }
});
test('revoked recipient or current authorization cannot dispatch; suspension is missed without catchup', async () => {
    const f = setup(), o = await enabled(f);
    try {
        f.setAvailable(false);
        f.setTime(3601000);
        await o.tick();
        expect(f.sends()).toBe(0);
        expect(o.view(principal, 'hourly').attempts.at(-1)?.reason).toBe('schedule_recipient_unavailable');
        f.setAvailable(true);
        f.setGrant('2');
        f.setTime(7201000);
        await o.tick();
        expect(f.sends()).toBe(0);
        f.setGrant('1');
        f.setTime(21601000);
        await o.tick();
        expect(f.sends()).toBe(0);
        expect(o.view(principal, 'hourly').attempts.at(-1)?.missedCount).toBe(4);
        f.setAllowed(false);
        expect(() => o.view(principal, 'hourly')).toThrow('forbidden');
    }
    finally {
        await o.close();
        f.cleanup();
    }
});
test('closed wire rejects implicit cloud/cwd fields and missing frozen admission', () => {
    expect(() => validateScheduleCommand({ ...create, cwd: '/tmp' })).toThrow('invalid_schedule_schema');
    expect(() => validateScheduleCommand({ ...create, action: { ...create.action, cloud: true } })).toThrow('invalid_schedule_schema');
    expect(() => validateScheduleCommand({ ...create, action: { ...create.action, recipient: { ...recipient, admissionRef: undefined } } })).toThrow('invalid_schedule_schema');
});
test('bounded history protects unknown and latest completed original result', () => {
    let state = emptyScheduleState();
    state = appendScheduleAttempt(state, { attemptId: 'active', scheduleId: 's', scheduleRevision: 1, createdAt: 1, dueAt: 1, state: 'unknown' });
    const result = { text: 'complete' } as HostExecutionOutput;
    state = appendScheduleAttempt(state, { attemptId: 'result', scheduleId: 's', scheduleRevision: 1, createdAt: 2, dueAt: 2, state: 'completed', result });
    for (let i = 3; i < 150; i++)
        state = appendScheduleAttempt(state, { attemptId: String(i), scheduleId: 's', scheduleRevision: 1, createdAt: i, dueAt: i, state: 'skipped' });
    expect(state.attempts).toHaveLength(100);
    expect(state.attempts.some(a => a.attemptId === 'active')).toBe(true);
    expect(state.attempts.find(a => a.attemptId === 'result')?.result).toBe(result);
});
test('store rejects symlink and broad permissions', () => {
    const f = setup();
    try {
        const target = join(f.directory, 'target');
        writeFileSync(target, '');
        symlinkSync(target, join(f.directory, 'schedules.sqlite'));
        expect(() => openDaemonScheduleStore(f.directory)).toThrow();
        chmodSync(f.directory, 0o755);
        expect(() => openDaemonScheduleStore(f.directory)).toThrow('unsafe_schedule_directory');
    }
    finally {
        f.cleanup();
    }
});
test('latest complete result follows durable admission order despite a backward wall clock',()=>{
 let state=emptyScheduleState();const old={attemptId:'older',scheduleId:'s',scheduleRevision:1,createdAt:9000,dueAt:9000,state:'completed' as const,result:{text:'older'} as HostExecutionOutput};
 state=appendScheduleAttempt(state,old);
 state=appendScheduleAttempt(state,{attemptId:'newer',scheduleId:'s',scheduleRevision:2,createdAt:1000,dueAt:1000,state:'completed',result:{text:'newer'} as HostExecutionOutput});
 expect(state.attempts.find(a=>a.result)?.result?.text).toBe('newer');
 state=appendScheduleAttempt(state,old);expect(state.attempts.find(a=>a.result)?.result?.text).toBe('newer');
});
