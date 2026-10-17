import type { HostParticipantRecipient, HostParticipantTaskRef, HostExecutionOutput, HostParticipantDelivery, HostParticipantExecutionSource } from './Participant';
import type { Principal } from './Effects';
export type DaemonScheduleAction = Readonly<{
    recipient: HostParticipantRecipient;
    text: string;
    inputJson?: string;
    originChannelId?: string;
}>;
export type DaemonSchedule = Readonly<{
    scheduleId: string;
    revision: number;
    name: string;
    everyMinutes: number;
    enabled: boolean;
    principal: Principal;
    action: DaemonScheduleAction;
    createdAt: number;
    updatedAt: number;
    nextDueAt?: number;
}>;
/** Task execution state remains owned by the original participant TaskSpace. */
export type DaemonScheduleAttempt = Readonly<{
    attemptId: string;
    scheduleId: string;
    scheduleRevision: number;
    dueAt: number;
    createdAt: number;
    state: 'missed' | 'skipped' | 'unknown' | 'submitted' | 'completed' | 'failed' | 'cancelled';
    reason?: string;
    missedCount?: number;
    throughDueAt?: number;
    bindingKey?: string;
    commandId?: string;
    task?: HostParticipantTaskRef;
    delivery?: HostParticipantDelivery;
    taskStatus?: string;
    execution?: HostParticipantExecutionSource;
    result?: HostExecutionOutput;
}>;
export type DaemonScheduleCommand = Readonly<{
    commandId: string;
    expectedRevision: number;
    scheduleId: string;
}> & (Readonly<{
    kind: 'create';
    name: string;
    everyMinutes: number;
    action: DaemonScheduleAction;
}> | Readonly<{
    kind: 'edit';
    name: string;
    everyMinutes: number;
    action: DaemonScheduleAction;
}> | Readonly<{
    kind: 'enable' | 'disable';
}>);
export type DaemonScheduleReceipt = Readonly<{
    commandId: string;
    fingerprint: string;
    scheduleId: string;
    revision: number;
}>;
export type DaemonScheduleState = Readonly<{
    version: 1;
    revision: number;
    schedules: readonly DaemonSchedule[];
    attempts: readonly DaemonScheduleAttempt[];
    receipts: readonly DaemonScheduleReceipt[];
}>;
export type DaemonScheduleView = Readonly<{
    revision: number;
    schedules: readonly DaemonSchedule[];
    attempts: readonly DaemonScheduleAttempt[];
}>;
export interface DaemonScheduleStore {
    read(): DaemonScheduleState;
    commit(expectedRevision: number, state: DaemonScheduleState): void;
    close(): void;
}
