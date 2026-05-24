import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";

describe("AiAgentOrchestratorDriver.tickUntilForegroundSettled", () => {
  it("returns without waiting for background inflight async", async () => {
    const main = createActor({ key: "main" });
    const detached = createActor({ key: "detached" });
    const vm = createVM({
      controlActorKey: "main",
      actors: {
        main,
        detached,
      },
    });

    const mainFiberId = `${main.key}:${main.id}`;
    const detachedFiberId = `${detached.key}:${detached.id}`;
    const messages: any[] = [];

    const driver = createAiAgentOrchestratorDriver({
      fibers: [
        { fiberId: mainFiberId, vm, actor: main, messages, basePriority: 10, lane: "interactive" },
        { fiberId: detachedFiberId, vm, actor: detached, messages: [], basePriority: 0, lane: "detached" },
      ],
      runStep: async (ctx, helpers) => {
        if (ctx.fiberId === detachedFiberId) {
          ctx.execState = { ...(ctx.execState ?? {}), inflight: { kind: "llm", opId: "detached" } };
          return { kind: "suspend", reason: "external" };
        }
        return { kind: "complete" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const now = Date.now();
    // First, run a single global tick so the detached lane becomes suspended with inflight IO.
    await driver.tickUntilBlocked({ now, maxTicks: 1, maxWallMs: 500 });

    const start = Date.now();
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxWallMs: 2000 });
    const elapsed = Date.now() - start;

    const s = driver.getState();
    expect(s.fibers[mainFiberId].status).toBe("completed");
    expect(s.fibers[detachedFiberId].status).toBe("suspended");
    expect(elapsed).toBeLessThan(200);
  });
});
