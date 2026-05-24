import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function advanceUntil(params: {
  getState: () => any;
  step: () => void;
  predicate: () => boolean;
  maxSteps?: number;
}): Promise<void> {
  const max = typeof params.maxSteps === "number" && params.maxSteps > 0 ? params.maxSteps : 50;
  for (let i = 0; i < max; i++) {
    if (params.predicate()) return;
    params.step();
    await flushMicrotasks();
  }
  throw new Error("advanceUntil: maxSteps exceeded");
}

describe("AiAgentOrchestratorDriver: cancel + resume race", () => {
  it("latches resume_fiber when it arrives before suspend", async () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const fiberId = `${actor.key}:${actor.id}`;

    let invocations = 0;
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }],
      runStep: async (ctx, helpers) => {
        invocations += 1;
        // Simulate the async-runner finishing and issuing resume BEFORE the step
        // returns and reports back a suspend.
        helpers.resume(ctx.fiberId);
        await new Promise<void>((r) => setTimeout(r, 0));
        return { kind: "suspend", reason: "external" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.tick(Date.now());
    await flushMicrotasks();

    await advanceUntil({
      getState: driver.getState,
      step: () => driver.tick(Date.now()),
      predicate: () => {
        const s = driver.getState();
        const f = s.fibers[fiberId];
        return f && f.status !== "running";
      },
    });

    const s = driver.getState();
    expect(invocations).toBeGreaterThanOrEqual(1);
    // The resume latch should prevent the fiber from getting stuck in suspended.
    expect(s.fibers[fiberId].status).toBe("ready");
  });

  it("propagates cancel to children when requested", async () => {
    const parent = createActor({ key: "parent" });
    const child = createActor({ key: "child" });
    const vm = createVM({ controlActorKey: "parent", actors: { parent, child } });

    const parentFiberId = `${parent.key}:${parent.id}`;
    const childFiberId = `${child.key}:${child.id}`;

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: parentFiberId, vm, actor: parent, messages: [], basePriority: 1 }],
      runStep: async (ctx) => {
        if (ctx.fiberId === parentFiberId) {
          return { kind: "cancel", reason: "test_cancel", propagateToChildren: true };
        }
        return { kind: "complete" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.spawnFiber({
      fiberId: childFiberId,
      vm,
      actor: child,
      messages: [],
      basePriority: 1,
      parentFiberId: parentFiberId,
      kind: "delegate",
    });

    driver.tick(Date.now());
    await flushMicrotasks();

    await advanceUntil({
      getState: driver.getState,
      step: () => driver.tick(Date.now()),
      predicate: () => {
        const s = driver.getState();
        return s.fibers[parentFiberId]?.status === "cancelled";
      },
    });

    const s = driver.getState();
    expect(s.fibers[parentFiberId].status).toBe("cancelled");
    expect(s.fibers[childFiberId].status).toBe("cancelled");
  });
});
