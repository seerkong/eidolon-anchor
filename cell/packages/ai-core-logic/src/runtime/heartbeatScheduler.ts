import {
  HEARTBEAT_DEFAULT_LIMITS,
  HEARTBEAT_SCHEDULE_STATUSES,
  createHeartbeatScheduleId,
  createHeartbeatWakePayload,
  normalizeCreateIntervalInput,
  normalizeCreateTimeoutInput,
  type CancelHeartbeatScheduleInput,
  type CreateHeartbeatIntervalInput,
  type CreateHeartbeatTimeoutInput,
  type HeartbeatSchedule,
  type HeartbeatScheduleStatus,
  type HeartbeatSchedulerRuntimeState,
  type HeartbeatWakePayload,
  type ListHeartbeatSchedulesInput,
} from "@cell/ai-core-contract/runtime/Heartbeat";
import type { ObservabilityRecord } from "@cell/ai-core-contract/runtime/Observability";
import type { ActorRefData } from "@cell/ai-core-contract/stream/common";
import { ensureVmRuntimeContext, type AiAgentVm } from "./runtime";
import { ensureVmRxData } from "./rxData";

export type HeartbeatSchedulerLimits = Partial<typeof HEARTBEAT_DEFAULT_LIMITS> & {
  maxActiveSchedules?: number;
};

export type CreateHeartbeatScheduleParams<TInput> = {
  ownerActorKey: string;
  ownerActorId: string;
  now: number | string | Date;
  input: TInput;
  limits?: HeartbeatSchedulerLimits;
};

export type TickDueHeartbeatSchedulesParams = {
  now: number | string | Date;
  deliver?: (event: { schedule: HeartbeatSchedule; wake: HeartbeatWakePayload }) => void | Promise<void>;
};

export type HeartbeatSchedulerWorker = {
  dispose: () => void;
  isDisposed: () => boolean;
};

export type RecoverHeartbeatSchedulesParams = {
  now: number | string | Date;
  deliver?: (event: { schedule: HeartbeatSchedule; wake: HeartbeatWakePayload }) => void;
  onRecoveredFire?: (schedule: HeartbeatSchedule) => void;
};

const TERMINAL_STATUSES: ReadonlySet<HeartbeatScheduleStatus> = new Set<HeartbeatScheduleStatus>([
  HEARTBEAT_SCHEDULE_STATUSES.cancelled,
  HEARTBEAT_SCHEDULE_STATUSES.completed,
  HEARTBEAT_SCHEDULE_STATUSES.expired,
  HEARTBEAT_SCHEDULE_STATUSES.failed,
]);

export function ensureHeartbeatSchedulerState(vm: AiAgentVm): HeartbeatSchedulerRuntimeState {
  const ctx = ensureVmRuntimeContext(vm);
  if (!ctx.heartbeatScheduler) {
    ctx.heartbeatScheduler = {
      schedules: {},
      sequence: 0,
    };
  }
  return ctx.heartbeatScheduler;
}

export function createHeartbeatTimeoutSchedule(
  vm: AiAgentVm,
  params: CreateHeartbeatScheduleParams<CreateHeartbeatTimeoutInput>,
): HeartbeatSchedule {
  const limits = materializeLimits(params.limits);
  assertActiveQuota(vm, limits.maxActiveSchedules);
  const input = normalizeCreateTimeoutInput(params.input, limits);
  const nowMs = toEpochMs(params.now);
  const schedule = createBaseSchedule(vm, {
    ownerActorKey: params.ownerActorKey,
    ownerActorId: params.ownerActorId,
    targetActorKey: input.targetActorKey,
    targetActorId: input.targetActorId,
    nowMs,
    kind: "timeout",
    status: "pending",
    name: input.name,
    description: input.description,
    message: input.message,
    payload: input.payload,
    delaySeconds: input.delaySeconds,
    intervalSeconds: null,
    maxFires: input.maxFires,
    nextFireAtMs: nowMs + input.delaySeconds * 1000,
  });
  ensureHeartbeatSchedulerState(vm).schedules[schedule.scheduleId] = schedule;
  emitHeartbeatRecord(vm, "heartbeat.create", "info", schedule);
  return cloneSchedule(schedule);
}

export function createHeartbeatIntervalSchedule(
  vm: AiAgentVm,
  params: CreateHeartbeatScheduleParams<CreateHeartbeatIntervalInput>,
): HeartbeatSchedule {
  const limits = materializeLimits(params.limits);
  assertActiveQuota(vm, limits.maxActiveSchedules);
  const input = normalizeCreateIntervalInput(params.input, limits);
  const nowMs = toEpochMs(params.now);
  const schedule = createBaseSchedule(vm, {
    ownerActorKey: params.ownerActorKey,
    ownerActorId: params.ownerActorId,
    targetActorKey: input.targetActorKey,
    targetActorId: input.targetActorId,
    nowMs,
    kind: "interval",
    status: "active",
    name: input.name,
    description: input.description,
    message: input.message,
    payload: input.payload,
    delaySeconds: null,
    intervalSeconds: input.intervalSeconds,
    maxFires: input.maxFires,
    nextFireAtMs: nowMs + input.intervalSeconds * 1000,
  });
  ensureHeartbeatSchedulerState(vm).schedules[schedule.scheduleId] = schedule;
  emitHeartbeatRecord(vm, "heartbeat.create", "info", schedule);
  return cloneSchedule(schedule);
}

export function listHeartbeatSchedules(
  vm: AiAgentVm,
  input: ListHeartbeatSchedulesInput = {},
): HeartbeatSchedule[] {
  const status = input.status ?? "active";
  const kind = input.kind ?? "all";
  return Object.values(ensureHeartbeatSchedulerState(vm).schedules)
    .filter((schedule) => {
      const terminal = TERMINAL_STATUSES.has(schedule.status);
      if (status === "active" && terminal) return false;
      if (status === "terminal" && !terminal) return false;
      if (kind !== "all" && schedule.kind !== kind) return false;
      if (input.ownerActorKey && schedule.ownerActorKey !== input.ownerActorKey) return false;
      if (input.targetActorKey && schedule.targetActorKey !== input.targetActorKey) return false;
      return true;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.scheduleId.localeCompare(b.scheduleId))
    .map(cloneSchedule);
}

export function cancelHeartbeatSchedule(
  vm: AiAgentVm,
  input: CancelHeartbeatScheduleInput,
  now: number | string | Date = Date.now(),
): HeartbeatSchedule {
  const scheduleId = createHeartbeatScheduleId(input.scheduleId ?? input.schedule_id ?? "");
  const state = ensureHeartbeatSchedulerState(vm);
  const schedule = state.schedules[scheduleId];
  if (!schedule) {
    throw new Error(`schedule not found: ${scheduleId}`);
  }
  if (!TERMINAL_STATUSES.has(schedule.status)) {
    schedule.status = "cancelled";
    schedule.cancelledAt = toIso(now);
    schedule.cancelReason = input.reason?.trim() || null;
    schedule.nextFireAt = null;
    schedule.updatedAt = schedule.cancelledAt;
    schedule.version += 1;
    emitHeartbeatRecord(vm, "heartbeat.cancel", "info", schedule, {
      reason: schedule.cancelReason,
    });
  }
  return cloneSchedule(schedule);
}

export async function tickDueHeartbeatSchedules(
  vm: AiAgentVm,
  params: TickDueHeartbeatSchedulesParams,
): Promise<HeartbeatSchedule[]> {
  const state = ensureHeartbeatSchedulerState(vm);
  const nowMs = toEpochMs(params.now);
  const fired: HeartbeatSchedule[] = [];

  const due = Object.values(state.schedules)
    .filter((schedule) => !TERMINAL_STATUSES.has(schedule.status))
    .filter((schedule) => schedule.nextFireAt !== null && toEpochMs(schedule.nextFireAt) <= nowMs)
    .sort((a, b) => String(a.nextFireAt).localeCompare(String(b.nextFireAt)) || a.scheduleId.localeCompare(b.scheduleId));

  for (const schedule of due) {
    const fireToken = `${schedule.scheduleId}:${schedule.version + 1}:${schedule.fireCount + 1}`;
    if (schedule.lastFireToken === fireToken) {
      continue;
    }

    schedule.status = "firing";
    schedule.version += 1;
    schedule.lastFireToken = fireToken;
    schedule.updatedAt = toIso(nowMs);

    const wake = createHeartbeatWakePayload({
      scheduleId: schedule.scheduleId,
      kind: schedule.kind,
      name: schedule.name,
      description: schedule.description,
      message: schedule.message,
      payload: schedule.payload,
      fireCount: schedule.fireCount + 1,
      firedAt: toIso(nowMs),
    });

    try {
      if (params.deliver) {
        await params.deliver({ schedule: cloneSchedule(schedule), wake });
      } else {
        const actor = vm.actors[schedule.targetActorKey];
        if (!actor) {
          throw new Error(`target actor not found: ${schedule.targetActorKey}`);
        }
        const alreadyPending = actor.peekMailbox("heartbeat").some((pending) => pending.scheduleId === schedule.scheduleId);
        if (alreadyPending) {
          coalescePendingWake(vm, schedule, nowMs);
          continue;
        }
        actor.send("heartbeat", wake);
      }
      applySuccessfulFire(schedule, nowMs);
      emitHeartbeatRecord(vm, "heartbeat.fire", "info", schedule, {
        fireCount: schedule.fireCount,
      });
      fired.push(cloneSchedule(schedule));
    } catch (error) {
      schedule.status = "failed";
      schedule.nextFireAt = null;
      schedule.updatedAt = toIso(nowMs);
      schedule.version += 1;
      emitHeartbeatRecord(vm, "heartbeat.fail", "error", schedule, undefined, error);
      vm.effects.log?.("error", "heartbeat schedule delivery failed", {
        scheduleId: schedule.scheduleId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return fired;
}

export function startHeartbeatSchedulerWorker(
  vm: AiAgentVm,
  options: {
    intervalMs?: number;
    now?: () => number | string | Date;
    deliver?: TickDueHeartbeatSchedulesParams["deliver"];
    afterTick?: (fired: HeartbeatSchedule[]) => void | Promise<void>;
  } = {},
): HeartbeatSchedulerWorker {
  let disposed = false;
  let ticking = false;
  const intervalMs = Math.max(1, options.intervalMs ?? 1000);
  const resolveNow = options.now ?? (() => Date.now());
  const timer = setInterval(() => {
    if (disposed || ticking) return;
    ticking = true;
    void tickDueHeartbeatSchedules(vm, { now: resolveNow(), deliver: options.deliver })
      .then((fired) => options.afterTick?.(fired))
      .catch((error) => {
        vm.effects.log?.("error", "heartbeat scheduler worker tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  const unref = (timer as any)?.unref;
  if (typeof unref === "function") {
    unref.call(timer);
  }
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
    isDisposed: () => disposed,
  };
}

export function recoverHeartbeatSchedules(
  vm: AiAgentVm,
  params: RecoverHeartbeatSchedulesParams,
): HeartbeatSchedule[] {
  const nowMs = toEpochMs(params.now);
  const recovered: HeartbeatSchedule[] = [];
  for (const schedule of Object.values(ensureHeartbeatSchedulerState(vm).schedules)) {
    if (TERMINAL_STATUSES.has(schedule.status) || schedule.nextFireAt === null) {
      continue;
    }
    if (toEpochMs(schedule.nextFireAt) > nowMs) {
      recovered.push(cloneSchedule(schedule));
      continue;
    }
    if (schedule.kind === "timeout") {
      schedule.status = "expired";
      schedule.nextFireAt = null;
      schedule.updatedAt = toIso(nowMs);
      schedule.version += 1;
      emitHeartbeatRecord(vm, "heartbeat.recover", "info", schedule, {
        missedPolicy: "expire_timeout",
      });
      vm.effects.log?.("warn", "heartbeat missed timeout expired during recovery", {
        scheduleId: schedule.scheduleId,
      });
      recovered.push(cloneSchedule(schedule));
      continue;
    }
    const fireToken = `${schedule.scheduleId}:${schedule.version + 1}:${schedule.fireCount + 1}`;
    schedule.status = "firing";
    schedule.version += 1;
    schedule.lastFireToken = fireToken;
    schedule.updatedAt = toIso(nowMs);

    const wake = createHeartbeatWakePayload({
      scheduleId: schedule.scheduleId,
      kind: schedule.kind,
      name: schedule.name,
      description: schedule.description,
      message: schedule.message,
      payload: schedule.payload,
      fireCount: schedule.fireCount + 1,
      firedAt: toIso(nowMs),
    });

    const actor = vm.actors[schedule.targetActorKey];
    if (!actor) {
      schedule.status = "failed";
      schedule.nextFireAt = null;
      schedule.updatedAt = toIso(nowMs);
      schedule.version += 1;
      emitHeartbeatRecord(vm, "heartbeat.fail", "error", schedule, {
        missedPolicy: "fire_interval_once_on_recovery",
      });
      vm.effects.log?.("error", "heartbeat recovered interval delivery failed", {
        scheduleId: schedule.scheduleId,
        targetActorKey: schedule.targetActorKey,
      });
      recovered.push(cloneSchedule(schedule));
      continue;
    }

    const alreadyPending = actor.peekMailbox("heartbeat").some((pending) => pending.scheduleId === schedule.scheduleId);
    if (alreadyPending) {
      coalescePendingWake(vm, schedule, nowMs);
      vm.effects.log?.("warn", "heartbeat missed interval coalesced during recovery", {
        scheduleId: schedule.scheduleId,
        nextFireAt: schedule.nextFireAt,
      });
      recovered.push(cloneSchedule(schedule));
      continue;
    }

    if (params.deliver) {
      params.deliver({ schedule: cloneSchedule(schedule), wake });
    } else {
      actor.send("heartbeat", wake);
    }
    applySuccessfulFire(schedule, nowMs);
    emitHeartbeatRecord(vm, "heartbeat.recover", "info", schedule, {
      missedPolicy: "fire_interval_once_on_recovery",
      nextFireAt: schedule.nextFireAt,
    });
    vm.effects.log?.("warn", "heartbeat missed interval fired once during recovery", {
      scheduleId: schedule.scheduleId,
      nextFireAt: schedule.nextFireAt,
      fireCount: schedule.fireCount,
    });
    const recoveredSchedule = cloneSchedule(schedule);
    params.onRecoveredFire?.(recoveredSchedule);
    recovered.push(recoveredSchedule);
  }
  return recovered;
}

function coalescePendingWake(vm: AiAgentVm, schedule: HeartbeatSchedule, nowMs: number): void {
  schedule.updatedAt = toIso(nowMs);
  schedule.version += 1;
  emitHeartbeatRecord(vm, "heartbeat.coalesce", "info", schedule);
  if (schedule.kind === "timeout") {
    schedule.status = "pending";
  } else {
    schedule.status = "active";
    schedule.nextFireAt = toIso(nowMs + Number(schedule.intervalSeconds) * 1000);
  }
  vm.effects.log?.("warn", "heartbeat schedule wake coalesced", {
    scheduleId: schedule.scheduleId,
    targetActorKey: schedule.targetActorKey,
  });
}

function createBaseSchedule(
  vm: AiAgentVm,
  params: {
    ownerActorKey: string;
    ownerActorId: string;
    targetActorKey?: string;
    targetActorId?: string;
    nowMs: number;
    kind: "timeout" | "interval";
    status: "pending" | "active";
    name: string;
    description: string;
    message: string;
    payload: Record<string, unknown>;
    delaySeconds: number | null;
    intervalSeconds: number | null;
    maxFires: number | null;
    nextFireAtMs: number;
  },
): HeartbeatSchedule {
  const state = ensureHeartbeatSchedulerState(vm);
  state.sequence += 1;
  const targetActorKey = params.targetActorKey ?? params.ownerActorKey;
  const targetActor = vm.actors[targetActorKey];
  if (!targetActor) {
    throw new Error(`target actor not found: ${targetActorKey}`);
  }
  return {
    scheduleId: createHeartbeatScheduleId(`${Date.now().toString(36)}_${state.sequence}`),
    kind: params.kind,
    name: params.name,
    description: params.description,
    ownerActorKey: params.ownerActorKey,
    ownerActorId: params.ownerActorId,
    targetActorKey,
    targetActorId: params.targetActorId ?? targetActor.id,
    status: params.status,
    createdAt: toIso(params.nowMs),
    updatedAt: toIso(params.nowMs),
    nextFireAt: toIso(params.nextFireAtMs),
    delaySeconds: params.delaySeconds,
    intervalSeconds: params.intervalSeconds,
    fireCount: 0,
    maxFires: params.maxFires,
    lastFireAt: null,
    cancelledAt: null,
    cancelReason: null,
    message: params.message,
    payload: { ...params.payload },
    version: 1,
    lastFireToken: null,
  };
}

function applySuccessfulFire(schedule: HeartbeatSchedule, nowMs: number): void {
  schedule.fireCount += 1;
  schedule.lastFireAt = toIso(nowMs);
  schedule.updatedAt = schedule.lastFireAt;
  schedule.version += 1;
  if (schedule.kind === "timeout") {
    schedule.status = "completed";
    schedule.nextFireAt = null;
    return;
  }
  if (schedule.maxFires !== null && schedule.fireCount >= schedule.maxFires) {
    schedule.status = "completed";
    schedule.nextFireAt = null;
    return;
  }
  schedule.status = "active";
  schedule.nextFireAt = toIso(nowMs + Number(schedule.intervalSeconds) * 1000);
}

function materializeLimits(limits?: HeartbeatSchedulerLimits) {
  return {
    ...HEARTBEAT_DEFAULT_LIMITS,
    ...(limits ?? {}),
  };
}

function assertActiveQuota(vm: AiAgentVm, maxActiveSchedules?: number): void {
  if (maxActiveSchedules === undefined) return;
  const activeCount = listHeartbeatSchedules(vm).length;
  if (activeCount >= maxActiveSchedules) {
    throw new Error(`active schedule limit reached: ${maxActiveSchedules}`);
  }
}

function emitHeartbeatRecord(
  vm: AiAgentVm,
  eventName: string,
  stage: "info" | "error",
  schedule: HeartbeatSchedule,
  payload?: Record<string, unknown>,
  error?: unknown,
): void {
  try {
    const { privateRxData } = ensureVmRxData(vm);
    const record: ObservabilityRecord = {
      eventName,
      source: "runtime",
      stage,
      actor: createHeartbeatActorRef(vm, schedule),
      payload: {
        scheduleId: schedule.scheduleId,
        kind: schedule.kind,
        name: schedule.name,
        status: schedule.status,
        ownerActorKey: schedule.ownerActorKey,
        targetActorKey: schedule.targetActorKey,
        nextFireAt: schedule.nextFireAt,
        ...(payload ?? {}),
      },
      error: error ? { message: error instanceof Error ? error.message : String(error) } : undefined,
      emittedAt: Date.now(),
    };
    privateRxData.observabilityRecords.append(record);
    if (stage === "error") {
      privateRxData.observabilityErrors.append(record);
    }
  } catch {
    // Observability must not affect scheduler state transitions.
  }
}

function createHeartbeatActorRef(vm: AiAgentVm, schedule: HeartbeatSchedule): ActorRefData {
  const actor = vm.actors[schedule.targetActorKey];
  return {
    actor_id: schedule.targetActorId,
    actor_name: schedule.targetActorKey,
    actor_kind: actor?.type ?? "unknown",
    agent_definition_name: actor?.agentName ?? null,
    agent_manifest_type: "unknown",
    role_label: actor?.identity?.kind ?? null,
    actor_projection: null,
    parent_actor_id: actor?.parentKey ?? null,
    root_actor_id: null,
  };
}

function cloneSchedule(schedule: HeartbeatSchedule): HeartbeatSchedule {
  return {
    ...schedule,
    payload: { ...schedule.payload },
  };
}

function toEpochMs(value: number | string | Date): number {
  if (typeof value === "number") {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid date: ${value}`);
  }
  return parsed;
}

function toIso(value: number | string | Date): string {
  return new Date(toEpochMs(value)).toISOString();
}
