import type { ToolDef } from "@cell/ai-core-contract/types";
import {
  cancelHeartbeatSchedule,
  createHeartbeatIntervalSchedule,
  createHeartbeatTimeoutSchedule,
  listHeartbeatSchedules,
} from "@cell/ai-core-logic";

function toScheduleOutput(schedule: any): Record<string, unknown> {
  return {
    schedule_id: schedule.scheduleId,
    kind: schedule.kind,
    name: schedule.name,
    description: schedule.description,
    owner_actor_key: schedule.ownerActorKey,
    owner_actor_id: schedule.ownerActorId,
    target_actor_key: schedule.targetActorKey,
    target_actor_id: schedule.targetActorId,
    status: schedule.status,
    created_at: schedule.createdAt,
    updated_at: schedule.updatedAt,
    next_fire_at: schedule.nextFireAt,
    delay_seconds: schedule.delaySeconds,
    interval_seconds: schedule.intervalSeconds,
    fire_count: schedule.fireCount,
    max_fires: schedule.maxFires,
    last_fire_at: schedule.lastFireAt,
    cancelled_at: schedule.cancelledAt,
    cancel_reason: schedule.cancelReason,
    message: schedule.message,
    payload: schedule.payload,
  };
}

export function buildCreateTimeoutToolDef(): ToolDef<Record<string, unknown>, Record<string, unknown>> {
  return {
    schema: {
      type: "function",
      function: {
        name: "create_timeout",
        description: "Create a one-shot non-blocking heartbeat wake for the current or target actor.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            delay_seconds: { type: "number" },
            target_actor_key: { type: "string" },
            message: { type: "string" },
            payload: { type: "object" },
          },
          required: ["name", "description", "delay_seconds", "message"],
        },
      },
    },
    briefPromptXnl: "Use create_timeout to schedule a one-shot future actor wake without blocking the current turn.",
    detailPromptXnl: "Provide name, detailed description, delay_seconds, message, and optional payload. The runtime wakes the target actor later.",
    run: async (runtime, input) => {
      const schedule = createHeartbeatTimeoutSchedule(runtime.vm as any, {
        ownerActorKey: (runtime.actor as any).key,
        ownerActorId: (runtime.actor as any).id,
        now: Date.now(),
        input: {
          name: String(input.name ?? ""),
          description: String(input.description ?? ""),
          delay_seconds: Number(input.delay_seconds ?? input.delaySeconds),
          targetActorKey: typeof input.target_actor_key === "string" ? input.target_actor_key : typeof input.targetActorKey === "string" ? input.targetActorKey : undefined,
          targetActorId: typeof input.target_actor_id === "string" ? input.target_actor_id : typeof input.targetActorId === "string" ? input.targetActorId : undefined,
          message: String(input.message ?? ""),
          payload: input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload as Record<string, unknown> : {},
        },
      });
      return {
        ...toScheduleOutput(schedule),
        status: "created",
      };
    },
  };
}

export function buildCreateIntervalToolDef(): ToolDef<Record<string, unknown>, Record<string, unknown>> {
  return {
    schema: {
      type: "function",
      function: {
        name: "create_interval",
        description: "Create a repeated non-blocking heartbeat wake until cancelled or max_fires is reached.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            interval_seconds: { type: "number" },
            max_fires: { type: "number" },
            target_actor_key: { type: "string" },
            message: { type: "string" },
            payload: { type: "object" },
          },
          required: ["name", "description", "interval_seconds", "message"],
        },
      },
    },
    briefPromptXnl: "Use create_interval to schedule repeated future actor wakes without blocking the current turn.",
    detailPromptXnl: "Provide name, detailed description, interval_seconds, message, optional payload, and preferably max_fires to cap cost.",
    run: async (runtime, input) => {
      const schedule = createHeartbeatIntervalSchedule(runtime.vm as any, {
        ownerActorKey: (runtime.actor as any).key,
        ownerActorId: (runtime.actor as any).id,
        now: Date.now(),
        input: {
          name: String(input.name ?? ""),
          description: String(input.description ?? ""),
          interval_seconds: Number(input.interval_seconds ?? input.intervalSeconds),
          max_fires: input.max_fires === undefined && input.maxFires === undefined ? undefined : Number(input.max_fires ?? input.maxFires),
          targetActorKey: typeof input.target_actor_key === "string" ? input.target_actor_key : typeof input.targetActorKey === "string" ? input.targetActorKey : undefined,
          targetActorId: typeof input.target_actor_id === "string" ? input.target_actor_id : typeof input.targetActorId === "string" ? input.targetActorId : undefined,
          message: String(input.message ?? ""),
          payload: input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload as Record<string, unknown> : {},
        },
      });
      return {
        ...toScheduleOutput(schedule),
        status: "created",
      };
    },
  };
}

export function buildListSchedulesToolDef(): ToolDef<Record<string, unknown>, Record<string, unknown>> {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_schedules",
        description: "List pending/active heartbeat schedules by default, with optional history filters.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["active", "terminal", "all"] },
            kind: { type: "string", enum: ["timeout", "interval", "all"] },
            owner_actor_key: { type: "string" },
            target_actor_key: { type: "string" },
          },
        },
      },
    },
    briefPromptXnl: "Use list_schedules to inspect current heartbeat timeout and interval schedules.",
    detailPromptXnl: "Defaults to active schedules. Use status=terminal or status=all to include cancelled/completed/failed history.",
    run: async (runtime, input) => {
      const schedules = listHeartbeatSchedules(runtime.vm as any, {
        status: input.status as any,
        kind: input.kind as any,
        ownerActorKey: typeof input.owner_actor_key === "string" ? input.owner_actor_key : undefined,
        targetActorKey: typeof input.target_actor_key === "string" ? input.target_actor_key : undefined,
      }).map(toScheduleOutput);
      return { schedules };
    },
  };
}

export function buildCancelScheduleToolDef(): ToolDef<Record<string, unknown>, Record<string, unknown>> {
  return {
    schema: {
      type: "function",
      function: {
        name: "cancel_schedule",
        description: "Cancel a pending timeout or active interval by schedule_id.",
        parameters: {
          type: "object",
          properties: {
            schedule_id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["schedule_id"],
        },
      },
    },
    briefPromptXnl: "Use cancel_schedule to stop a heartbeat timeout or interval.",
    detailPromptXnl: "Pass schedule_id and optional reason. Cancelled schedules are hidden from default list_schedules output.",
    run: async (runtime, input) => {
      const schedule = cancelHeartbeatSchedule(runtime.vm as any, {
        schedule_id: String(input.schedule_id ?? input.scheduleId ?? ""),
        reason: typeof input.reason === "string" ? input.reason : undefined,
      });
      return toScheduleOutput(schedule);
    },
  };
}
