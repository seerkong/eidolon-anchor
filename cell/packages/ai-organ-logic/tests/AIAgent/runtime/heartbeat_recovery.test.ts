import { describe, expect, it } from "bun:test";

import {
  createActor,
  createHeartbeatIntervalSchedule,
  createHeartbeatTimeoutSchedule,
  createVM,
  hydrateVM,
  listHeartbeatSchedules,
  recoverHeartbeatSchedules,
  serializeVM,
} from "@cell/ai-core-logic";

describe("heartbeat scheduler recovery", () => {
  it("serializes and hydrates heartbeat schedules from VM snapshot", () => {
    const actor = createActor({ key: "main", id: "actor-main" });
    const vm = createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor } });
    const schedule = createHeartbeatTimeoutSchedule(vm, {
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

    const snapshot = serializeVM(vm);
    expect(snapshot.sessionState?.heartbeatSchedules?.[0]?.scheduleId).toBe(schedule.scheduleId);

    const restoredActor = createActor({ key: "main", id: "actor-main" });
    const restored = hydrateVM(snapshot, { main: restoredActor });
    expect(listHeartbeatSchedules(restored)[0]?.scheduleId).toBe(schedule.scheduleId);
    expect(listHeartbeatSchedules(restored)[0]?.nextFireAt).toBe("2026-05-26T18:01:00.000Z");
  });

  it("fires one missed interval during recovery without replaying unlimited history", () => {
    const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
    const actor = createActor({ key: "main", id: "actor-main" });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      effects: {
        log: (level, message, context) => logs.push({ level, message, context }),
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
    const interval = createHeartbeatIntervalSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: "2026-05-26T18:00:00.000Z",
      input: {
        name: "watch-deploy",
        description: "Every minute check deploy status and cancel after success or failure.",
        intervalSeconds: 60,
        maxFires: 5,
        message: "Check deploy",
      },
    });

    const recoveredFires: string[] = [];
    recoverHeartbeatSchedules(vm, {
      now: "2026-05-26T18:05:00.000Z",
      onRecoveredFire: (schedule) => {
        recoveredFires.push(schedule.scheduleId);
      },
    });

    expect(listHeartbeatSchedules(vm).map((s) => s.scheduleId)).toEqual([interval.scheduleId]);
    expect(listHeartbeatSchedules(vm)[0]?.fireCount).toBe(1);
    expect(listHeartbeatSchedules(vm)[0]?.nextFireAt).toBe("2026-05-26T18:06:00.000Z");
    expect(actor.peekMailbox("heartbeatWake")[0]?.scheduleId).toBe(interval.scheduleId);
    expect(actor.peekMailbox("heartbeatWake")[0]?.fireCount).toBe(1);
    expect(recoveredFires).toEqual([interval.scheduleId]);
    expect(listHeartbeatSchedules(vm, { status: "terminal" })[0]?.scheduleId).toBe(timeout.scheduleId);
    expect(listHeartbeatSchedules(vm, { status: "terminal" })[0]?.status).toBe("expired");
    expect(logs.map((entry) => entry.message)).toEqual([
      "heartbeat missed timeout expired during recovery",
      "heartbeat missed interval fired once during recovery",
    ]);
  });
});
