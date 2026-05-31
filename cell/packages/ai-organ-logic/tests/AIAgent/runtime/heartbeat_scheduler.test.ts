import { describe, expect, it } from "bun:test";

import {
  cancelHeartbeatSchedule,
  createActor,
  createHeartbeatIntervalSchedule,
  createHeartbeatTimeoutSchedule,
  createVM,
  ensureVmRxData,
  listHeartbeatSchedules,
  tickDueHeartbeatSchedules,
} from "@cell/ai-core-logic";

function makeVm() {
  const main = createActor({ key: "main", id: "actor-main" });
  return createVM({ controlActorKey: main.key, actors: { [main.key]: main } });
}

describe("heartbeat scheduler core", () => {
  it("creates, lists, cancels, and filters schedules per VM session", () => {
    const vm = makeVm();
    const otherVm = makeVm();

    const timeout = createHeartbeatTimeoutSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: "2026-05-26T18:00:00.000Z",
      input: {
        name: "check-build",
        description: "Check build.log once and report whether the process completed.",
        delaySeconds: 60,
        message: "Check build",
      },
    });
    const interval = createHeartbeatIntervalSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: "2026-05-26T18:00:00.000Z",
      input: {
        name: "watch-deploy",
        description: "Every minute check deploy status and cancel after success or failure.",
        intervalSeconds: 60,
        maxFires: 3,
        message: "Check deploy",
      },
    });

    expect(timeout.kind).toBe("timeout");
    expect(timeout.status).toBe("pending");
    expect(timeout.nextFireAt).toBe("2026-05-26T18:01:00.000Z");
    expect(interval.kind).toBe("interval");
    expect(interval.status).toBe("active");
    expect(listHeartbeatSchedules(vm).map((s) => s.scheduleId)).toEqual([timeout.scheduleId, interval.scheduleId]);
    expect(listHeartbeatSchedules(otherVm)).toEqual([]);

    const cancelled = cancelHeartbeatSchedule(vm, { scheduleId: timeout.scheduleId, reason: "build finished elsewhere" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("build finished elsewhere");
    expect(listHeartbeatSchedules(vm).map((s) => s.scheduleId)).toEqual([interval.scheduleId]);
    expect(listHeartbeatSchedules(vm, { status: "all" }).map((s) => s.scheduleId)).toEqual([timeout.scheduleId, interval.scheduleId]);
    expect(() => cancelHeartbeatSchedule(vm, { scheduleId: "sch_missing" })).toThrow(/not found/i);
  });

  it("enforces active quota and allowed ranges", () => {
    const vm = makeVm();

    createHeartbeatTimeoutSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: 0,
      limits: { maxActiveSchedules: 1 },
      input: {
        name: "check-build",
        description: "Check build.log once and report whether the process completed.",
        delaySeconds: 60,
        message: "Check build",
      },
    });

    expect(() =>
      createHeartbeatIntervalSchedule(vm, {
        ownerActorKey: "main",
        ownerActorId: "actor-main",
        now: 0,
        limits: { maxActiveSchedules: 1 },
        input: {
          name: "watch-deploy",
          description: "Every minute check deploy status and cancel after success or failure.",
          intervalSeconds: 60,
          message: "Check deploy",
        },
      }),
    ).toThrow(/active schedule/i);

    expect(() =>
      createHeartbeatTimeoutSchedule(makeVm(), {
        ownerActorKey: "main",
        ownerActorId: "actor-main",
        now: 0,
        input: {
          name: "bad-delay",
          description: "Check build.log once and report whether the process completed.",
          delaySeconds: 1,
          message: "Check build",
        },
      }),
    ).toThrow(/delay_seconds/i);
  });

  it("fires a timeout once and does not duplicate repeated ticks", async () => {
    const vm = makeVm();
    const fired: string[] = [];
    const timeout = createHeartbeatTimeoutSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: "2026-05-26T18:00:00.000Z",
      input: {
        name: "check-build",
        description: "Check build.log once and report whether the process completed.",
        delaySeconds: 60,
        message: "Check build",
      },
    });

    await tickDueHeartbeatSchedules(vm, {
      now: "2026-05-26T18:01:00.000Z",
      deliver: async ({ wake }) => {
        fired.push(wake.scheduleId);
      },
    });
    await tickDueHeartbeatSchedules(vm, {
      now: "2026-05-26T18:01:00.000Z",
      deliver: async ({ wake }) => {
        fired.push(wake.scheduleId);
      },
    });

    expect(fired).toEqual([timeout.scheduleId]);
    expect(listHeartbeatSchedules(vm)).toEqual([]);
    expect(listHeartbeatSchedules(vm, { status: "terminal" })[0]?.status).toBe("completed");
  });

  it("fires intervals until max_fires and supports cancellation", async () => {
    const vm = makeVm();
    const fires: number[] = [];
    const interval = createHeartbeatIntervalSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: "2026-05-26T18:00:00.000Z",
      input: {
        name: "watch-deploy",
        description: "Every minute check deploy status and cancel after success or failure.",
        intervalSeconds: 60,
        maxFires: 2,
        message: "Check deploy",
      },
    });

    await tickDueHeartbeatSchedules(vm, {
      now: "2026-05-26T18:01:00.000Z",
      deliver: async ({ wake }) => {
        fires.push(wake.fireCount);
      },
    });
    expect(listHeartbeatSchedules(vm)[0]?.nextFireAt).toBe("2026-05-26T18:02:00.000Z");

    await tickDueHeartbeatSchedules(vm, {
      now: "2026-05-26T18:02:00.000Z",
      deliver: async ({ wake }) => {
        fires.push(wake.fireCount);
      },
    });

    expect(fires).toEqual([1, 2]);
    expect(listHeartbeatSchedules(vm)).toEqual([]);
    expect(listHeartbeatSchedules(vm, { status: "terminal" })[0]?.scheduleId).toBe(interval.scheduleId);
    expect(listHeartbeatSchedules(vm, { status: "terminal" })[0]?.status).toBe("completed");

    const cancellable = createHeartbeatIntervalSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: "2026-05-26T18:03:00.000Z",
      input: {
        name: "watch-tests",
        description: "Every minute check test status and cancel after success or failure.",
        intervalSeconds: 60,
        maxFires: 5,
        message: "Check tests",
      },
    });
    cancelHeartbeatSchedule(vm, { scheduleId: cancellable.scheduleId });
    await tickDueHeartbeatSchedules(vm, {
      now: "2026-05-26T18:04:00.000Z",
      deliver: async ({ wake }) => {
        fires.push(wake.fireCount);
      },
    });
    expect(fires).toEqual([1, 2]);
  });

  it("marks delivery failures as failed and records diagnostics", async () => {
    const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
    const main = createActor({ key: "main", id: "actor-main" });
    const vm = createVM({
      controlActorKey: main.key,
      actors: { [main.key]: main },
      effects: {
        log: (level, message, context) => {
          logs.push({ level, message, context });
        },
      },
    });
    const timeout = createHeartbeatTimeoutSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: "2026-05-26T18:00:00.000Z",
      input: {
        name: "check-build",
        description: "Check build.log once and report whether the process completed.",
        delaySeconds: 60,
        message: "Check build",
      },
    });

    await tickDueHeartbeatSchedules(vm, {
      now: "2026-05-26T18:01:00.000Z",
      deliver: async () => {
        throw new Error("mailbox unavailable");
      },
    });

    const failed = listHeartbeatSchedules(vm, { status: "terminal" })[0];
    expect(failed?.scheduleId).toBe(timeout.scheduleId);
    expect(failed?.status).toBe("failed");
    expect(logs[0]?.level).toBe("error");
    expect(logs[0]?.context?.scheduleId).toBe(timeout.scheduleId);
  });

  it("emits observability records for create, fire, cancel, and failure", async () => {
    const vm = makeVm();
    const records: string[] = [];
    ensureVmRxData(vm).publicRxData.observabilityRecords.subscribe((record) => {
      records.push(`${record.eventName}:${record.payload?.scheduleId ?? ""}`);
    });

    const timeout = createHeartbeatTimeoutSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: "2026-05-26T18:00:00.000Z",
      input: {
        name: "check-build",
        description: "Check build.log once and report whether the process completed.",
        delaySeconds: 60,
        message: "Check build",
      },
    });
    await tickDueHeartbeatSchedules(vm, { now: "2026-05-26T18:01:00.000Z" });

    const interval = createHeartbeatIntervalSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: "2026-05-26T18:02:00.000Z",
      input: {
        name: "watch-deploy",
        description: "Every minute check deploy status and cancel after success or failure.",
        intervalSeconds: 60,
        message: "Check deploy",
      },
    });
    cancelHeartbeatSchedule(vm, { scheduleId: interval.scheduleId });

    const failing = createHeartbeatTimeoutSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: "2026-05-26T18:03:00.000Z",
      input: {
        name: "check-tests",
        description: "Check test.log once and report whether the process completed.",
        delaySeconds: 60,
        message: "Check tests",
      },
    });
    await tickDueHeartbeatSchedules(vm, {
      now: "2026-05-26T18:04:00.000Z",
      deliver: async () => {
        throw new Error("mailbox unavailable");
      },
    });

    expect(records).toContain(`heartbeat.create:${timeout.scheduleId}`);
    expect(records).toContain(`heartbeat.fire:${timeout.scheduleId}`);
    expect(records).toContain(`heartbeat.cancel:${interval.scheduleId}`);
    expect(records).toContain(`heartbeat.fail:${failing.scheduleId}`);
  });
});
