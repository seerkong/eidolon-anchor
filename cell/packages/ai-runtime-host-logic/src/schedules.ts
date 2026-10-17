import type { DaemonSchedule, DaemonScheduleAttempt, DaemonScheduleCommand, DaemonScheduleState, Principal } from '@cell/ai-runtime-host-contract';
export function scheduleFailure(code: string, status = 409): never {
    throw Object.assign(new Error(code), { status, error: { code, retryable: false } });
}
export const emptyScheduleState = (): DaemonScheduleState => ({ version: 1, revision: 0, schedules: [], attempts: [], receipts: [] });
const samePrincipal = (a: Principal, b: Principal) => a.principalId === b.principalId && a.grantsVersion === b.grantsVersion;
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0');
export function validateScheduleCommand(value: unknown): DaemonScheduleCommand {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return scheduleFailure('invalid_schedule_schema', 400);
    const c = value as DaemonScheduleCommand;
    const base = ['kind', 'commandId', 'scheduleId', 'expectedRevision'], full = [...base, 'name', 'everyMinutes', 'action'];
    if (!['create', 'edit', 'enable', 'disable'].includes(c.kind) || Object.keys(c).some(k => !(c.kind === 'create' || c.kind === 'edit' ? full : base).includes(k)) || !text(c.commandId, 256) || !text(c.scheduleId, 128) || !/^[A-Za-z0-9_-]+$/.test(c.scheduleId) || !Number.isSafeInteger(c.expectedRevision) || c.expectedRevision < 0)
        return scheduleFailure('invalid_schedule_schema', 400);
    if (c.kind === 'create' || c.kind === 'edit') {
        if (!text(c.name, 512) || !Number.isSafeInteger(c.everyMinutes) || c.everyMinutes < 1 || c.everyMinutes > 525600 || !c.action || typeof c.action !== 'object' || Array.isArray(c.action) || Object.keys(c.action).some(k => !['recipient', 'text', 'inputJson', 'originChannelId'].includes(k)) || !text(c.action.text, 32768) || c.action.inputJson !== undefined && !text(c.action.inputJson, 65536) || c.action.originChannelId !== undefined && !text(c.action.originChannelId, 256))
            return scheduleFailure('invalid_schedule_schema', 400);
        const r = c.action.recipient;
        if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['kind', 'ref', 'ownerScopeRef', 'bindingRef', 'bindingDigest', 'admissionRef'].includes(k)) || !['member', 'holon'].includes(r.kind) || ![r.ref, r.ownerScopeRef, r.bindingDigest, r.admissionRef].every(v => text(v, 256)) || !text(r.bindingRef, 1024))
            return scheduleFailure('invalid_schedule_schema', 400);
        if (c.action.inputJson !== undefined)
            try {
                JSON.parse(c.action.inputJson);
            }
            catch {
                return scheduleFailure('invalid_schedule_schema', 400);
            }
    }
    return structuredClone(c);
}
export function applyScheduleCommand(state: DaemonScheduleState, principal: Principal, command: DaemonScheduleCommand, now: number, fingerprint: string): DaemonScheduleState {
    const receipt = state.receipts.find(r => r.commandId === command.commandId);
    if (receipt) {
        if (receipt.fingerprint !== fingerprint)
            return scheduleFailure('schedule_command_conflict');
        return state;
    }
    if (state.receipts.length >= 4096)
        return scheduleFailure('schedule_receipt_capacity', 429);
    const old = state.schedules.find(s => s.scheduleId === command.scheduleId);
    if (old && !samePrincipal(old.principal, principal))
        return scheduleFailure('forbidden', 403);
    if (command.expectedRevision !== (old?.revision ?? 0))
        return scheduleFailure('schedule_revision_conflict');
    if (command.kind === 'create' && old)
        return scheduleFailure('schedule_exists');
    if (command.kind !== 'create' && !old)
        return scheduleFailure('schedule_not_found', 404);
    if (command.kind === 'create' && state.schedules.length >= 128)
        return scheduleFailure('schedule_capacity', 429);
    if (command.kind === 'edit' && old!.enabled)
        return scheduleFailure('schedule_disable_before_edit');
    let schedule: DaemonSchedule;
    if (command.kind === 'create')
        schedule = { scheduleId: command.scheduleId, revision: 1, name: command.name, everyMinutes: command.everyMinutes, action: command.action, principal, enabled: false, createdAt: now, updatedAt: now };
    else if (command.kind === 'edit')
        schedule = { ...old!, revision: old!.revision + 1, name: command.name, everyMinutes: command.everyMinutes, action: command.action, updatedAt: now };
    else {
        const { nextDueAt: _, ...rest } = old!;
        schedule = { ...rest, revision: old!.revision + 1, enabled: command.kind === 'enable', updatedAt: now, ...(command.kind === 'enable' ? { nextDueAt: now + old!.everyMinutes * 60000 } : {}) };
    }
    return { ...state, revision: state.revision + 1, schedules: [...state.schedules.filter(s => s.scheduleId !== schedule.scheduleId), schedule], receipts: [...state.receipts, { commandId: command.commandId, fingerprint, scheduleId: schedule.scheduleId, revision: schedule.revision }] };
}
export function appendScheduleAttempt(state: DaemonScheduleState, attempt: DaemonScheduleAttempt): DaemonScheduleState {
    const terminal = (a: DaemonScheduleAttempt) => ['completed', 'failed', 'cancelled', 'missed', 'skipped'].includes(a.state);
    const all = state.attempts.some(a => a.attemptId === attempt.attemptId)
        ? state.attempts.map(a => a.attemptId === attempt.attemptId ? attempt : a) : [...state.attempts, attempt];
    // Insertion order is durable admission order. Wall-clock adjustments cannot promote an older result.
    const lastResult = all.filter(a => a.scheduleId === attempt.scheduleId && a.state === 'completed' && a.result).at(-1)?.attemptId;
    const removable = all.filter(a => a.scheduleId === attempt.scheduleId && terminal(a) && a.attemptId !== lastResult && a.attemptId !== attempt.attemptId);
    const remove = new Set(removable.slice(0, Math.max(0, all.filter(a => a.scheduleId === attempt.scheduleId).length - 100)).map(a => a.attemptId));
    return { ...state, revision: state.revision + 1, attempts: all.filter(a => !remove.has(a.attemptId)).map(a => {
            if (a.scheduleId !== attempt.scheduleId || a.attemptId === lastResult || !a.result)
                return a;
            const { result: _, ...history } = a;
            return history;
        }) };
}
/** Collapse a past due range into bounded evidence; no catch-up execution. */
export function missedScheduleRange(schedule: DaemonSchedule, now: number) {
    if (!schedule.enabled || schedule.nextDueAt === undefined || schedule.nextDueAt > now)
        return undefined;
    const count = Math.floor((now - schedule.nextDueAt) / (schedule.everyMinutes * 60000)) + 1;
    return { dueAt: schedule.nextDueAt, throughDueAt: schedule.nextDueAt + (count - 1) * schedule.everyMinutes * 60000, missedCount: count, nextDueAt: schedule.nextDueAt + count * schedule.everyMinutes * 60000 };
}
