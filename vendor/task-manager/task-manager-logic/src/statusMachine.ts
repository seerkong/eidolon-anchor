import type { TaskStatus } from 'task-manager-contract';
import { TaskManagerError } from './errors.js';

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  Pending: Object.freeze(['Ready', 'Cancelled'] as const),
  Ready: Object.freeze(['Claimed', 'Cancelled', 'Pending'] as const),
  Claimed: Object.freeze(['Running', 'Ready', 'Cancelled'] as const),
  Running: Object.freeze(['Waiting', 'Ready', 'Succeeded', 'Failed', 'Cancelled'] as const),
  Waiting: Object.freeze(['Running', 'Ready', 'Succeeded', 'Failed', 'Cancelled'] as const),
  Succeeded: Object.freeze([] as const),
  Failed: Object.freeze([] as const),
  Cancelled: Object.freeze([] as const),
});

const TERMINAL_STATUSES = Object.freeze([
  'Succeeded',
  'Failed',
  'Cancelled',
] as const);

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: TaskStatus): status is Extract<TaskStatus, 'Succeeded' | 'Failed' | 'Cancelled'> {
  return (TERMINAL_STATUSES as readonly TaskStatus[]).includes(status);
}

export function assertTaskTransition(taskId: string, from: TaskStatus, to: TaskStatus): void {
  if (isTerminal(from)) {
    throw new TaskManagerError('terminal-task-immutable', `task ${taskId} is terminal (${from})`);
  }
  if (!canTransition(from, to)) {
    throw new TaskManagerError('invalid-task-transition', `task ${taskId} cannot transition ${from} -> ${to}`);
  }
}
