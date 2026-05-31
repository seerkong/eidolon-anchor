import { describe, expect, it } from "bun:test";

import {
  HEARTBEAT_SCHEDULE_KINDS,
  HEARTBEAT_SCHEDULE_STATUSES,
  createHeartbeatScheduleId,
  createHeartbeatWakePayload,
  normalizeCreateIntervalInput,
  normalizeCreateTimeoutInput,
  type HeartbeatSchedule,
} from "@cell/ai-core-contract/runtime/Heartbeat";
import { AI_AGENT_MAILBOXES, createActor, hydrateActor, serializeActor } from "@cell/ai-core-logic";

describe("heartbeat runtime contract", () => {
  it("defines auditable timeout and interval schedule records", () => {
    expect(HEARTBEAT_SCHEDULE_KINDS).toEqual({
      timeout: "timeout",
      interval: "interval",
    });
    expect(HEARTBEAT_SCHEDULE_STATUSES).toEqual({
      pending: "pending",
      active: "active",
      firing: "firing",
      cancelled: "cancelled",
      completed: "completed",
      expired: "expired",
      failed: "failed",
    });

    const schedule: HeartbeatSchedule = {
      scheduleId: createHeartbeatScheduleId("abc123"),
      kind: "timeout",
      name: "check-build-once",
      description: "Check build.log once and report whether the background build completed.",
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      targetActorKey: "main",
      targetActorId: "actor-main",
      status: "pending",
      createdAt: "2026-05-26T18:00:00.000Z",
      updatedAt: "2026-05-26T18:00:00.000Z",
      nextFireAt: "2026-05-26T18:01:00.000Z",
      delaySeconds: 60,
      intervalSeconds: null,
      fireCount: 0,
      maxFires: 1,
      lastFireAt: null,
      cancelledAt: null,
      cancelReason: null,
      message: "Check build status",
      payload: { logFile: "build.log" },
      version: 1,
      lastFireToken: null,
    };

    expect(schedule.scheduleId).toBe("sch_abc123");
    expect(schedule.name).toBe("check-build-once");
    expect(schedule.description).toContain("Check build.log");
  });

  it("normalizes create_timeout input and rejects missing name or description", () => {
    expect(() =>
      normalizeCreateTimeoutInput({
        name: "",
        description: "Check build.log once.",
        delaySeconds: 60,
        message: "Check build",
      }),
    ).toThrow(/name/i);

    expect(() =>
      normalizeCreateTimeoutInput({
        name: "check-build",
        description: "soon",
        delaySeconds: 60,
        message: "Check build",
      }),
    ).toThrow(/description/i);

    expect(() =>
      normalizeCreateTimeoutInput({
        name: "check-build",
        description: "Check build.log once and report whether the process completed.",
        delaySeconds: 0,
        message: "Check build",
      }),
    ).toThrow(/delay_seconds/i);

    expect(
      normalizeCreateTimeoutInput({
        name: " check-build ",
        description: " Check build.log once and report whether the process completed. ",
        delaySeconds: 60,
        targetActorKey: "main",
        message: " Check build ",
        payload: { logFile: "build.log" },
      }),
    ).toEqual({
      name: "check-build",
      description: "Check build.log once and report whether the process completed.",
      delaySeconds: 60,
      targetActorKey: "main",
      targetActorId: undefined,
      message: "Check build",
      payload: { logFile: "build.log" },
      maxFires: 1,
    });
  });

  it("normalizes create_interval input and requires a bounded interval", () => {
    expect(() =>
      normalizeCreateIntervalInput({
        name: "watch-deploy",
        description: "Watch deploy status until it succeeds or fails.",
        intervalSeconds: 1,
        message: "Check deploy",
      }),
    ).toThrow(/interval_seconds/i);

    expect(
      normalizeCreateIntervalInput({
        name: "watch-deploy",
        description: "Every minute check deploy status; cancel after success or failure.",
        intervalSeconds: 60,
        maxFires: 3,
        message: "Check deploy",
      }),
    ).toEqual({
      name: "watch-deploy",
      description: "Every minute check deploy status; cancel after success or failure.",
      intervalSeconds: 60,
      targetActorKey: undefined,
      targetActorId: undefined,
      message: "Check deploy",
      payload: {},
      maxFires: 3,
    });
  });

  it("defines heartbeat wake mailbox payload and durable snapshot defaults", () => {
    expect(AI_AGENT_MAILBOXES.control).toBeLessThan(AI_AGENT_MAILBOXES.heartbeatWake);
    expect(AI_AGENT_MAILBOXES.childDone).toBeLessThan(AI_AGENT_MAILBOXES.heartbeatWake);
    expect(AI_AGENT_MAILBOXES.heartbeatWake).toBeLessThan(AI_AGENT_MAILBOXES.humanInput);

    const actor = createActor({ key: "main", id: "actor-main" });
    const wake = createHeartbeatWakePayload({
      scheduleId: "sch_abc123",
      kind: "timeout",
      name: "check-build",
      description: "Check build.log once and report whether the process completed.",
      message: "Check build",
      payload: { logFile: "build.log" },
      fireCount: 1,
      firedAt: "2026-05-26T18:01:00.000Z",
    });
    actor.send("heartbeatWake", wake);

    const snapshot = serializeActor(actor);
    expect(snapshot.mailboxes.heartbeatWake).toEqual([wake]);
    expect(hydrateActor({ ...snapshot, mailboxes: { ...snapshot.mailboxes, heartbeatWake: undefined as any } }).peekMailbox("heartbeatWake")).toEqual([]);
    expect(hydrateActor(snapshot).peekMailbox("heartbeatWake")).toEqual([wake]);
  });
});
