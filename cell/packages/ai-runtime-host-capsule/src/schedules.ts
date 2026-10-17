import { createHash, randomUUID } from 'node:crypto';
import type { DaemonSchedule, DaemonScheduleAttempt, DaemonScheduleState, DaemonScheduleStore, DaemonScheduleView, HostAuthorizationEffects, HostRequest, Principal, RuntimeHostPort } from '@cell/ai-runtime-host-contract';
import { applyScheduleCommand, appendScheduleAttempt, missedScheduleRange, scheduleFailure, validateScheduleCommand } from '@cell/ai-runtime-host-logic';
export type DaemonScheduleEffects = {
    store: DaemonScheduleStore;
    authorization: HostAuthorizationEffects;
    principal: Principal;
    port(request: HostRequest): Promise<RuntimeHostPort>;
    now?: () => number;
    newId?: () => string;
};
/** One serialized parent owner. Durable intent precedes the only execution send. */
export function createDaemonScheduleOwner(e: DaemonScheduleEffects) {
    const now = e.now ?? Date.now, newId = e.newId ?? randomUUID;
    let state = e.store.read(), closed = false, tail: Promise<unknown> = Promise.resolve(), ticking: Promise<void> | undefined;
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => { const result = tail.then(() => { if (closed)
        return scheduleFailure('daemon_closing', 503); return fn(); }); tail = result.catch(() => { }); return result; };
    const commit = (next: DaemonScheduleState) => { if (next === state)
        return; e.store.commit(state.revision, next); state = next; };
    const attempt = (value: DaemonScheduleAttempt) => commit(appendScheduleAttempt(state, value));
    const check = (principal: Principal, action: 'read' | 'manage' | 'execute', scheduleId?: string) => {
        if (closed)
            return scheduleFailure('daemon_closing', 503);
        if (principal.principalId !== e.principal.principalId || principal.grantsVersion !== e.principal.grantsVersion || e.authorization.currentGrantsVersion(principal.principalId) !== principal.grantsVersion || !e.authorization.permits(principal, { kind: 'daemon-schedules', action, scheduleId }))
            return scheduleFailure('forbidden', 403);
    };
    const request = (plan: DaemonSchedule): HostRequest => ({ principal: plan.principal, requestId: newId() });
    const sameRecipient = (a: DaemonSchedule['action']['recipient'], b: DaemonSchedule['action']['recipient']) => ['kind', 'ref', 'ownerScopeRef', 'bindingRef', 'bindingDigest', 'admissionRef'].every(k => a[k as keyof typeof a] === b[k as keyof typeof b]);
    const sameTask = (a: {
        admissionId: string;
        taskSpaceId: string;
        taskId: string;
    }, b: typeof a) => a.admissionId === b.admissionId && a.taskSpaceId === b.taskSpaceId && a.taskId === b.taskId;
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
    const validateSource = async (plan: DaemonSchedule, port: RuntimeHostPort, r: HostRequest) => {
        if (!port.participantDirectory || !port.openParticipant || !port.submitExecution || !port.participantWork || !port.executionOutputPage)
            return scheduleFailure('schedule_execution_unavailable', 503);
        const directory = await port.participantDirectory(r);
        if (!directory.contacts.some(c => c.available && sameRecipient(c.recipient, plan.action.recipient)))
            return scheduleFailure('schedule_recipient_unavailable');
        check(plan.principal, 'execute', plan.scheduleId);
    };
    const observe = async (a: DaemonScheduleAttempt) => {
        if (!a.bindingKey || !a.commandId || !['unknown', 'submitted'].includes(a.state))
            return;
        const plan = state.schedules.find(s => s.scheduleId === a.scheduleId)!;
        try {
            check(plan.principal, 'read', plan.scheduleId);
            const r = request(plan), port = await e.port(r);
            if (!port.participantWork || !port.executionOutputPage)
                return;
            let work: Awaited<ReturnType<NonNullable<RuntimeHostPort['participantWork']>>>['work'][number] | undefined;
            let after: number | undefined;
            for (let page = 0; page < 128; page++) {
                const p = await port.participantWork(r, { bindingKey: a.bindingKey, after, limit: 100 });
                work = p.work.find(w => w.commandId === a.commandId);
                if (work || p.nextAfter === undefined)
                    break;
                if (p.nextAfter === after)
                    throw new Error('invalid_schedule_cursor');
                after = p.nextAfter;
            }
            if (!work)
                return;
            if (a.task && !sameTask(a.task, work.task))
                return scheduleFailure('schedule_task_mismatch');
            const execution = work.executions.at(-1);
            const next = { ...a, task: work.task, taskStatus: work.status, state: 'submitted' as const, ...(execution ? { execution } : {}) };
            if (work.status === 'Failed' || work.status === 'Cancelled') {
                attempt({ ...next, state: work.status === 'Failed' ? 'failed' : 'cancelled' });
                return;
            }
            if (work.status !== 'Succeeded') {
                if (JSON.stringify(next) !== JSON.stringify(a))
                    attempt(next);
                return;
            }
            after = undefined;
            for (let page = 0; page < 128; page++) {
                const p = await port.executionOutputPage(r, { bindingKey: a.bindingKey, after, limit: 100 });
                const result = p.outputs.find(o => o.commandId === a.commandId && o.kind === 'result' && sameTask(o.source, work!.task));
                if (result) {
                    check(plan.principal, 'read', plan.scheduleId);
                    attempt({ ...next, state: 'completed', result });
                    return;
                }
                if (p.nextAfter === undefined)
                    break;
                if (p.nextAfter === after)
                    throw new Error('invalid_schedule_cursor');
                after = p.nextAfter;
            }
            // A succeeded task without a published complete result stays occupied until observation proves it.
            if (JSON.stringify(next) !== JSON.stringify(a))
                attempt(next);
        }
        catch { /* Observation failure never permits another execution or invents a terminal state. */ }
    };
    const recoverMissed = () => {
        const time = now();
        for (const plan of state.schedules) {
            const range = missedScheduleRange(plan, time);
            if (!range)
                continue;
            // Advance and record in one transaction; a restart cannot lose the evidence interval.
            const next = appendScheduleAttempt(state, { attemptId: newId(), scheduleId: plan.scheduleId, scheduleRevision: plan.revision, createdAt: time, state: 'missed', reason: 'daemon_offline', dueAt: range.dueAt, throughDueAt: range.throughDueAt, missedCount: range.missedCount });
            commit({ ...next, schedules: next.schedules.map(s => s.scheduleId === plan.scheduleId ? { ...s, nextDueAt: range.nextDueAt } : s) });
        }
    };
    recoverMissed();
    return {
        view(principal: Principal, scheduleId?: string): DaemonScheduleView {
            check(principal, 'read', scheduleId);
            if (scheduleId && !state.schedules.some(s => s.scheduleId === scheduleId))
                return scheduleFailure('schedule_not_found', 404);
            const attempts = scheduleId ? state.attempts.filter(a => a.scheduleId === scheduleId) : state.schedules.flatMap(plan => {
                const all = state.attempts.filter(a => a.scheduleId === plan.scheduleId), last = all.at(-1), complete = all.find(a => a.result);
                return [...new Set([last, complete].filter((a): a is DaemonScheduleAttempt => Boolean(a)))].map(a => { const { result: _, ...summary } = a; return summary; });
            });
            return structuredClone({ revision: state.revision, schedules: scheduleId ? state.schedules.filter(s => s.scheduleId === scheduleId) : state.schedules, attempts });
        },
        receipt(principal: Principal, commandId: string) { check(principal, 'read'); const found = state.receipts.find(r => r.commandId === commandId); if (!found)
            return scheduleFailure('schedule_command_not_found', 404); return structuredClone(found); },
        command(principal: Principal, input: unknown) {
            return serialize(async () => {
                check(principal, 'manage');
                const c = validateScheduleCommand(input), fingerprint = createHash('sha256').update(JSON.stringify(canonical([principal, c]))).digest('hex');
                const known = state.receipts.find(r => r.commandId === c.commandId);
                if (known) {
                    commit(applyScheduleCommand(state, principal, c, now(), fingerprint));
                    return structuredClone(known);
                }
                if (c.kind === 'create' || c.kind === 'edit' || c.kind === 'enable') {
                    const old = state.schedules.find(s => s.scheduleId === c.scheduleId);
                    const plan = c.kind === 'create' || c.kind === 'edit' ? { principal, action: c.action, scheduleId: c.scheduleId } as DaemonSchedule : old;
                    if (!plan)
                        return scheduleFailure('schedule_not_found', 404);
                    check(principal, 'execute', c.scheduleId);
                    await validateSource(plan, await e.port(request(plan)), request(plan));
                }
                commit(applyScheduleCommand(state, principal, c, now(), fingerprint));
                return structuredClone(state.receipts.find(r => r.commandId === c.commandId)!);
            });
        },
        tick() {
            return ticking ??= serialize(async () => {
                for (const a of [...state.attempts])
                    await observe(a);
                const time = now();
                for (const plan of [...state.schedules]) {
                    const range = missedScheduleRange(plan, time);
                    if (!range)
                        continue;
                    // Suspension is offline time too. Collapse the whole range without catch-up execution.
                    if (range.missedCount > 1) {
                        const next = appendScheduleAttempt(state, { attemptId: newId(), scheduleId: plan.scheduleId, scheduleRevision: plan.revision, createdAt: time, state: 'missed', reason: 'daemon_suspended', dueAt: range.dueAt, throughDueAt: range.throughDueAt, missedCount: range.missedCount });
                        commit({ ...next, schedules: next.schedules.map(s => s.scheduleId === plan.scheduleId ? { ...s, nextDueAt: range.nextDueAt } : s) });
                        continue;
                    }
                    // Definition edits freeze each attempt, but unchanged recipients reuse their original binding.
                    const recipientDigest = createHash('sha256').update(JSON.stringify(canonical(plan.action.recipient))).digest('hex').slice(0, 40);
                    const dueAt = range.throughDueAt, bindingKey = `schedule:${plan.scheduleId}:${recipientDigest}`;
                    const a: DaemonScheduleAttempt = { attemptId: newId(), scheduleId: plan.scheduleId, scheduleRevision: plan.revision, dueAt, createdAt: time, state: 'unknown', bindingKey, commandId: newId() };
                    const busy = state.attempts.some(v => v.scheduleId === plan.scheduleId && ['unknown', 'submitted'].includes(v.state));
                    let port: RuntimeHostPort | undefined, r: HostRequest | undefined, reason: string | undefined;
                    if (busy)
                        reason = 'overlap';
                    else
                        try {
                            check(plan.principal, 'execute', plan.scheduleId);
                            r = request(plan);
                            port = await e.port(r);
                            await validateSource(plan, port, r);
                        }
                        catch (error) {
                            reason = error instanceof Error ? error.message : 'schedule_execution_unavailable';
                        }
                    const next = appendScheduleAttempt(state, reason ? { ...a, state: 'skipped', reason } : a);
                    commit({ ...next, schedules: next.schedules.map(s => s.scheduleId === plan.scheduleId ? { ...s, nextDueAt: range.nextDueAt } : s) });
                    if (reason)
                        continue;
                    try {
                        await port!.openParticipant!(r!, { bindingKey, recipient: plan.action.recipient, expectedServerInstanceId: port!.capabilities(r!).serverInstanceId });
                        check(plan.principal, 'execute', plan.scheduleId);
                    }
                    catch (error) {
                        // Bootstrap cannot submit a task. Its failure is proven to precede the execution send.
                        attempt({ ...a, state: 'failed', reason: error instanceof Error ? error.message : 'schedule_bootstrap_unavailable' });
                        continue;
                    }
                    try {
                        const delivery = await port!.submitExecution!(r!, { bindingKey, recipient: plan.action.recipient, commandId: a.commandId!, text: plan.action.text, ...(plan.action.inputJson === undefined ? {} : { inputJson: plan.action.inputJson }), contextCut: { schemaVersion: 'bridge.im-context/v1', cutId: a.attemptId, purpose: `本机定时计划 ${plan.scheduleId}，版本 ${plan.revision}，到期 ${dueAt}。`, messages: [] } });
                        attempt({ ...a, delivery, task: delivery.task, state: delivery.state === 'rejected' ? 'failed' : delivery.state === 'unknown' ? 'unknown' : 'submitted', ...(delivery.errorCode ? { reason: delivery.errorCode } : {}) });
                    }
                    catch { /* Persisted unknown remains query-only even if admission cannot be proved. */ }
                }
            }).finally(() => { ticking = undefined; });
        },
        async close() { closed = true; await tail; e.store.close(); },
    };
}
