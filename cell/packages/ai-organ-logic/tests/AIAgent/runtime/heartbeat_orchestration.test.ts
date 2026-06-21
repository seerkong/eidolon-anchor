import { describe, expect, it } from "bun:test";

import {
  createActor,
  createHeartbeatIntervalSchedule,
  createHeartbeatTimeoutSchedule,
  createVM,
  listHeartbeatSchedules,
  startHeartbeatSchedulerWorker,
  tickDueHeartbeatSchedules,
} from "@cell/ai-core-logic";
import { aiAgentCooperativeStep } from "@cell/ai-organ-logic/exec";

describe("heartbeat actor orchestration", () => {
  it("delivers due wake items through actor mailbox and cooperative step input", async () => {
    const actor = createActor({ key: "main", id: "actor-main" });
    const vm = createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor } });
    createHeartbeatTimeoutSchedule(vm, {
      ownerActorKey: "main",
      ownerActorId: "actor-main",
      now: "2026-05-26T18:00:00.000Z",
      input: {
        name: "check-build",
        description: "Check build.log once and report whether the process completed.",
        delaySeconds: 60,
        message: "Check build status",
        payload: { logFile: "build.log" },
      },
    });

    await tickDueHeartbeatSchedules(vm, { now: "2026-05-26T18:01:00.000Z" });

    const wake = actor.peekMailbox("heartbeat")[0];
    expect(wake?.name).toBe("check-build");

    const messages: any[] = [];
    const result = await aiAgentCooperativeStep({
      fiberId: "fiber-main",
      vm,
      actor,
      messages,
      setState: () => {},
      resumeFiber: () => {},
    });

    expect(result.kind).toBe("yield");
    expect(actor.peekMailbox("heartbeat")).toEqual([]);
    // P7: drained heartbeat wakes land in the conversation domains; observe
    // the read-only actor projection.
    const lastMessage: any = actor.messages.at(-1);
    expect(lastMessage?.role).toBe("user");
    expect(String(lastMessage?.content ?? "")).toContain("Heartbeat wake: check-build");
    expect(String(lastMessage?.content ?? "")).toContain("Check build.log once");
    expect(String(lastMessage?.content ?? "")).toContain("\"logFile\":\"build.log\"");
  });

  it("coalesces a due interval when the same schedule already has a pending wake", async () => {
    const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
    const actor = createActor({ key: "main", id: "actor-main" });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      effects: {
        log: (level, message, context) => {
          logs.push({ level, message, context });
        },
      },
    });
    const schedule = createHeartbeatIntervalSchedule(vm, {
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
    actor.send("heartbeat", {
      scheduleId: schedule.scheduleId,
      kind: "interval",
      name: "watch-deploy",
      description: "Every minute check deploy status and cancel after success or failure.",
      message: "Check deploy",
      payload: {},
      fireCount: 1,
      firedAt: "2026-05-26T18:01:00.000Z",
    });

    await tickDueHeartbeatSchedules(vm, { now: "2026-05-26T18:01:00.000Z" });

    expect(actor.peekMailbox("heartbeat").length).toBe(1);
    expect(listHeartbeatSchedules(vm)[0]?.fireCount).toBe(0);
    expect(listHeartbeatSchedules(vm)[0]?.nextFireAt).toBe("2026-05-26T18:02:00.000Z");
    expect(logs[0]?.message).toContain("coalesced");
    expect(logs[0]?.context?.scheduleId).toBe(schedule.scheduleId);
  });

  it("stops scheduler worker ticks after dispose", async () => {
    const actor = createActor({ key: "main", id: "actor-main" });
    const vm = createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor } });
    createHeartbeatTimeoutSchedule(vm, {
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

    let now = Date.parse("2026-05-26T18:00:00.000Z");
    const worker = startHeartbeatSchedulerWorker(vm, {
      intervalMs: 5,
      now: () => now,
    });
    worker.dispose();
    now = Date.parse("2026-05-26T18:01:00.000Z");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(actor.peekMailbox("heartbeat")).toEqual([]);
    expect(worker.isDisposed()).toBe(true);
  });
});
