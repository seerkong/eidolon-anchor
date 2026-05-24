import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import {
  AI_AGENT_ORCHESTRATOR_TICK_SCOPES,
  createAiAgentOrchestratorDriver,
} from "@cell/ai-organ-logic/OrchestratorDriver";

describe("AiAgentOrchestratorDriver.tickUntilBackgroundSettled", () => {
  it("advances detached fibers even when foreground is ready", async () => {
    const main = createActor({ key: "main" });
    const detached = createActor({ key: "detached" });
    const vm = createVM({ controlActorKey: "main", actors: { main, detached } });

    const mainFiberId = `${main.key}:${main.id}`;
    const detachedFiberId = `${detached.key}:${detached.id}`;

    let detachedSteps = 0;

    const driver = createAiAgentOrchestratorDriver({
      fibers: [
        { fiberId: mainFiberId, vm, actor: main, messages: [], basePriority: 1, lane: "interactive" },
        { fiberId: detachedFiberId, vm, actor: detached, messages: [], basePriority: 100, lane: "detached" },
      ],
      runStep: async (ctx) => {
        if (ctx.fiberId === detachedFiberId) {
          detachedSteps += 1;
          return { kind: "complete" };
        }
        // Keep foreground ready; do not complete in this test.
        return { kind: "yield" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxWallMs: 2000 });

    const s = driver.getState();
    expect(detachedSteps).toBeGreaterThan(0);
    expect(s.fibers[detachedFiberId].status).toBe("completed");
    expect(s.fibers[mainFiberId].status).toBe("ready");
  });

  it("accepts background as the live tick scope", async () => {
    const main = createActor({ key: "main" });
    const detached = createActor({ key: "detached" });
    const vm = createVM({ controlActorKey: "main", actors: { main, detached } });

    const mainFiberId = `${main.key}:${main.id}`;
    const detachedFiberId = `${detached.key}:${detached.id}`;

    let detachedSteps = 0;

    const driver = createAiAgentOrchestratorDriver({
      fibers: [
        { fiberId: mainFiberId, vm, actor: main, messages: [], basePriority: 1, lane: "interactive" },
        { fiberId: detachedFiberId, vm, actor: detached, messages: [], basePriority: 100, lane: "detached" },
      ],
      runStep: async (ctx) => {
        if (ctx.fiberId === detachedFiberId) {
          detachedSteps += 1;
          return { kind: "complete" };
        }
        return { kind: "yield" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.actorRuntime.sendFrom("client", driver.orchestratorId, "tick", {
      now: Date.now(),
      scope: AI_AGENT_ORCHESTRATOR_TICK_SCOPES.background,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = driver.getState();
    expect(detachedSteps).toBeGreaterThan(0);
    expect(state.fibers[detachedFiberId].status).toBe("completed");
    expect(state.fibers[mainFiberId].status).toBe("ready");
  });
});
