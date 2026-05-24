import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

describe("OrchestratorDriver: orchestrator action handling", () => {
  it("applies yield/suspend/resume/complete/fail/cancel", async () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const fiberId = `${actor.key}:${actor.id}`;

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }],
      runStep: async () => ({ kind: "yield" }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.actorRuntime.sendFrom("test", driver.orchestratorId, "fiber_result", {
      fiberId,
      now: Date.now(),
      kind: "yield",
    });
    await flushMicrotasks();
    expect(driver.getState().fibers[fiberId].status).toBe("ready");

    driver.actorRuntime.sendFrom("test", driver.orchestratorId, "fiber_result", {
      fiberId,
      now: Date.now(),
      kind: "suspend",
      reason: "human_answer",
      suspendPolicy: "continue_others",
    });
    await flushMicrotasks();
    expect(driver.getState().fibers[fiberId].status).toBe("suspended");
    expect(driver.getState().fibers[fiberId].waitingReason).toBe("human_answer");
    expect(driver.getState().fibers[fiberId].suspendPolicy).toBe("continue_others");

    driver.resumeFiber(fiberId, Date.now());
    await flushMicrotasks();
    expect(driver.getState().fibers[fiberId].status).toBe("ready");

    driver.actorRuntime.sendFrom("test", driver.orchestratorId, "fiber_result", {
      fiberId,
      now: Date.now(),
      kind: "complete",
    });
    await flushMicrotasks();
    expect(driver.getState().fibers[fiberId].status).toBe("completed");

    // New driver: separate instance to test fail/cancel.
    const actor2 = createActor({ key: "main2" });
    const vm2 = createVM({ controlActorKey: "main2", actors: { main2: actor2 } });
    const fiber2 = `${actor2.key}:${actor2.id}`;
    const driver2 = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: fiber2, vm: vm2, actor: actor2, messages: [], basePriority: 1 }],
      runStep: async () => ({ kind: "yield" }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver2.actorRuntime.sendFrom("test", driver2.orchestratorId, "fiber_result", {
      fiberId: fiber2,
      now: Date.now(),
      kind: "fail",
      error: "boom",
    });
    await flushMicrotasks();
    expect(driver2.getState().fibers[fiber2].status).toBe("failed");

    const actor3 = createActor({ key: "main3" });
    const vm3 = createVM({ controlActorKey: "main3", actors: { main3: actor3 } });
    const fiber3 = `${actor3.key}:${actor3.id}`;
    const driver3 = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: fiber3, vm: vm3, actor: actor3, messages: [], basePriority: 1 }],
      runStep: async () => ({ kind: "yield" }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver3.actorRuntime.sendFrom("test", driver3.orchestratorId, "fiber_result", {
      fiberId: fiber3,
      now: Date.now(),
      kind: "cancel",
      cancelReason: "stop",
      propagateCancelToChildren: false,
    });
    await flushMicrotasks();
    expect(driver3.getState().fibers[fiber3].status).toBe("cancelled");
  });

  it("latches resume_fiber when received before suspend", async () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const fiberId = `${actor.key}:${actor.id}`;

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }],
      runStep: async () => ({ kind: "yield" }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    // Fiber is ready; resume_fiber should be latched.
    driver.resumeFiber(fiberId, Date.now());
    await flushMicrotasks();

    driver.actorRuntime.sendFrom("test", driver.orchestratorId, "fiber_result", {
      fiberId,
      now: Date.now(),
      kind: "suspend",
      reason: "external",
    });
    await flushMicrotasks();

    // Latch should immediately resume it.
    expect(driver.getState().fibers[fiberId].status).toBe("ready");
  });
});
