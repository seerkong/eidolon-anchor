import { describe, expect, it } from "bun:test";

import { createActor, createVM, startHeartbeatSchedulerWorker } from "@cell/ai-core-logic";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer";
import { drainHeartbeatFiredSchedules } from "../../src/AIAgent/TerminalRuntime";

describe("terminal heartbeat scheduler tools", () => {
  it("uses the composed terminal tool registry to create, list, cancel, and wake without new user input", async () => {
    const registry = composeToolRegistry({ includeInternalOnly: false }) as ToolFuncRegistry;
    const actor = createActor({ key: "main", id: "actor-main" });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
    });
    let now = Date.now();

    const created = await registry.call("create_timeout", vm, actor, {
      name: "check-build",
      description: "Check build.log once and report whether the process completed.",
      delay_seconds: 10,
      message: "Check build",
      payload: { logFile: "build.log" },
    }) as any;
    expect(created.status).toBe("created");

    const listed = await registry.call("list_schedules", vm, actor, {}) as any;
    expect(listed.schedules).toHaveLength(1);

    const worker = startHeartbeatSchedulerWorker(vm, {
      intervalMs: 5,
      now: () => now,
    });
    now = Date.now() + 11_000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    worker.dispose();

    expect(actor.peekMailbox("heartbeatWake")[0]?.scheduleId).toBe(created.schedule_id);

    const interval = await registry.call("create_interval", vm, actor, {
      name: "watch-tests",
      description: "Every minute check test status and cancel after success or failure.",
      interval_seconds: 60,
      max_fires: 5,
      message: "Check tests",
    }) as any;
    const cancelled = await registry.call("cancel_schedule", vm, actor, {
      schedule_id: interval.schedule_id,
      reason: "done",
    }) as any;
    expect(cancelled.status).toBe("cancelled");
  });

  it("drains fired heartbeat actors through the runtime queue until async work is blocked", async () => {
    const calls: string[] = [];
    let releaseAsyncWork = () => {};
    const asyncWork = new Promise<void>((resolve) => {
      releaseAsyncWork = resolve;
    });
    const driver = {
      resumeFiber: (fiberId: string) => {
        calls.push(`resume:${fiberId}`);
      },
      tickUntilBlocked: async () => {
        calls.push("tickUntilBlocked:start");
        await asyncWork;
        calls.push("tickUntilBlocked:done");
      },
      tickUntilBackgroundSettled: async () => {
        calls.push("tickUntilBackgroundSettled");
      },
    };
    const runtimeCoordinator = {
      enqueue: async <T>(fn: () => Promise<T>) => {
        calls.push("enqueue:start");
        const result = await fn();
        calls.push("enqueue:done");
        return result;
      },
    };

    const drain = drainHeartbeatFiredSchedules({
      fired: [
        { targetActorKey: "main", targetActorId: "actor-main" },
        { targetActorKey: "main", targetActorId: "actor-main" },
      ] as any,
      driver,
      runtimeCoordinator,
      maxWallMs: 500,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      "enqueue:start",
      "tickUntilBlocked:start",
    ]);

    releaseAsyncWork();
    await drain;
    expect(calls).toEqual([
      "enqueue:start",
      "tickUntilBlocked:start",
      "tickUntilBlocked:done",
      "tickUntilBackgroundSettled",
      "enqueue:done",
    ]);
  });
});
