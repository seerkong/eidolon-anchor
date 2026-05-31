export const HEARTBEAT_SCHEDULE_KINDS = {
  timeout: "timeout",
  interval: "interval",
} as const;

export type HeartbeatScheduleKind =
  (typeof HEARTBEAT_SCHEDULE_KINDS)[keyof typeof HEARTBEAT_SCHEDULE_KINDS];

export const HEARTBEAT_SCHEDULE_STATUSES = {
  pending: "pending",
  active: "active",
  firing: "firing",
  cancelled: "cancelled",
  completed: "completed",
  expired: "expired",
  failed: "failed",
} as const;

export type HeartbeatScheduleStatus =
  (typeof HEARTBEAT_SCHEDULE_STATUSES)[keyof typeof HEARTBEAT_SCHEDULE_STATUSES];

export type HeartbeatScheduleId = `sch_${string}`;

export type HeartbeatJsonPayload = Record<string, unknown>;

export type HeartbeatSchedule = {
  scheduleId: HeartbeatScheduleId;
  kind: HeartbeatScheduleKind;
  name: string;
  description: string;
  ownerActorKey: string;
  ownerActorId: string;
  targetActorKey: string;
  targetActorId: string;
  status: HeartbeatScheduleStatus;
  createdAt: string;
  updatedAt: string;
  nextFireAt: string | null;
  delaySeconds: number | null;
  intervalSeconds: number | null;
  fireCount: number;
  maxFires: number | null;
  lastFireAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  message: string;
  payload: HeartbeatJsonPayload;
  version: number;
  lastFireToken: string | null;
};

export type HeartbeatSchedulerRuntimeState = {
  schedules: Record<string, HeartbeatSchedule>;
  sequence: number;
};

export type HeartbeatWakePayload = {
  scheduleId: HeartbeatScheduleId;
  kind: HeartbeatScheduleKind;
  name: string;
  description: string;
  message: string;
  payload: HeartbeatJsonPayload;
  fireCount: number;
  firedAt: string;
};

export type CreateHeartbeatTimeoutInput = {
  name: string;
  description: string;
  delaySeconds?: number;
  delay_seconds?: number;
  targetActorKey?: string;
  targetActorId?: string;
  message: string;
  payload?: HeartbeatJsonPayload;
  maxFires?: number;
};

export type NormalizedCreateHeartbeatTimeoutInput = {
  name: string;
  description: string;
  delaySeconds: number;
  targetActorKey: string | undefined;
  targetActorId: string | undefined;
  message: string;
  payload: HeartbeatJsonPayload;
  maxFires: 1;
};

export type CreateHeartbeatIntervalInput = {
  name: string;
  description: string;
  intervalSeconds?: number;
  interval_seconds?: number;
  targetActorKey?: string;
  targetActorId?: string;
  message: string;
  payload?: HeartbeatJsonPayload;
  maxFires?: number | null;
  max_fires?: number | null;
};

export type NormalizedCreateHeartbeatIntervalInput = {
  name: string;
  description: string;
  intervalSeconds: number;
  targetActorKey: string | undefined;
  targetActorId: string | undefined;
  message: string;
  payload: HeartbeatJsonPayload;
  maxFires: number | null;
};

export type ListHeartbeatSchedulesInput = {
  status?: "active" | "terminal" | "all";
  kind?: HeartbeatScheduleKind | "all";
  ownerActorKey?: string;
  targetActorKey?: string;
};

export type CancelHeartbeatScheduleInput = {
  scheduleId?: string;
  schedule_id?: string;
  reason?: string;
};

export const HEARTBEAT_DEFAULT_LIMITS = {
  minDelaySeconds: 10,
  maxDelaySeconds: 3600,
  minIntervalSeconds: 10,
  maxIntervalSeconds: 3600,
  defaultMaxIntervalFires: 20,
} as const;

export function createHeartbeatScheduleId(value: string): HeartbeatScheduleId {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error("schedule_id is required");
  }
  return (trimmed.startsWith("sch_") ? trimmed : `sch_${trimmed}`) as HeartbeatScheduleId;
}

export function createHeartbeatWakePayload(input: HeartbeatWakePayload): HeartbeatWakePayload {
  const scheduleId = createHeartbeatScheduleId(input.scheduleId);
  const name = requireNonEmpty("name", input.name);
  const description = requireDetailedDescription(input.description);
  const message = requireNonEmpty("message", input.message);
  if (!Number.isInteger(input.fireCount) || input.fireCount < 1) {
    throw new Error("fire_count must be a positive integer");
  }
  const firedAt = requireNonEmpty("fired_at", input.firedAt);
  return {
    scheduleId,
    kind: normalizeKind(input.kind),
    name,
    description,
    message,
    payload: normalizePayload(input.payload),
    fireCount: input.fireCount,
    firedAt,
  };
}

export function normalizeCreateTimeoutInput(
  input: CreateHeartbeatTimeoutInput,
  limits = HEARTBEAT_DEFAULT_LIMITS,
): NormalizedCreateHeartbeatTimeoutInput {
  const delaySeconds = normalizeInteger(
    "delay_seconds",
    input.delaySeconds ?? input.delay_seconds,
    limits.minDelaySeconds,
    limits.maxDelaySeconds,
  );
  return {
    name: requireNonEmpty("name", input.name),
    description: requireDetailedDescription(input.description),
    delaySeconds,
    targetActorKey: normalizeOptionalString(input.targetActorKey),
    targetActorId: normalizeOptionalString(input.targetActorId),
    message: requireNonEmpty("message", input.message),
    payload: normalizePayload(input.payload),
    maxFires: 1,
  };
}

export function normalizeCreateIntervalInput(
  input: CreateHeartbeatIntervalInput,
  limits = HEARTBEAT_DEFAULT_LIMITS,
): NormalizedCreateHeartbeatIntervalInput {
  const intervalSeconds = normalizeInteger(
    "interval_seconds",
    input.intervalSeconds ?? input.interval_seconds,
    limits.minIntervalSeconds,
    limits.maxIntervalSeconds,
  );
  const rawMaxFires = input.maxFires ?? input.max_fires ?? limits.defaultMaxIntervalFires;
  const maxFires = rawMaxFires === null
    ? null
    : normalizeInteger("max_fires", rawMaxFires, 1, Number.MAX_SAFE_INTEGER);
  return {
    name: requireNonEmpty("name", input.name),
    description: requireDetailedDescription(input.description),
    intervalSeconds,
    targetActorKey: normalizeOptionalString(input.targetActorKey),
    targetActorId: normalizeOptionalString(input.targetActorId),
    message: requireNonEmpty("message", input.message),
    payload: normalizePayload(input.payload),
    maxFires,
  };
}

function normalizeKind(kind: HeartbeatScheduleKind): HeartbeatScheduleKind {
  if (kind !== HEARTBEAT_SCHEDULE_KINDS.timeout && kind !== HEARTBEAT_SCHEDULE_KINDS.interval) {
    throw new Error("kind must be timeout or interval");
  }
  return kind;
}

function requireNonEmpty(field: string, value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function requireDetailedDescription(value: unknown): string {
  const text = requireNonEmpty("description", value);
  if (text.length < 16) {
    throw new Error("description must describe wake purpose, check action, completion condition, or stop condition");
  }
  return text;
}

function normalizeInteger(field: string, value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  const n = value as number;
  if (n < min || n > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return n;
}

function normalizePayload(payload: unknown): HeartbeatJsonPayload {
  if (payload === undefined || payload === null) {
    return {};
  }
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload must be an object");
  }
  return { ...(payload as HeartbeatJsonPayload) };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text ? text : undefined;
}
