import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";

/**
 * Track harden-turn-settle-budget-contract, requirement
 * `settle-budget-is-not-turn-failure`.
 *
 * A settle call's `maxWallMs` is the budget for THIS pump slice, not a turn
 * failure criterion. When the budget runs out while foreground work is still
 * running, the call SHALL return a declared outcome; a long-running foreground
 * fiber (a real tool call in production) must not turn a healthy turn into an
 * exception named after the slice width.
 */

function createSlowFibersDriver(params: {
  slowMs: number;
  lane?: "interactive" | "detached";
}) {
  const main = createActor({ key: "main" });
  const vm = createVM({ controlActorKey: "main", actors: { main } });
  const fiberId = `${main.key}:${main.id}`;
  let steps = 0;

  const driver = createAiAgentOrchestratorDriver({
    fibers: [{ fiberId, vm, actor: main, messages: [], basePriority: 1, lane: params.lane } as any],
    // Each agent_step parks the fiber in `running` for longer than the settle
    // budget. This is the shape of a foreground tool/provider await that the
    // runtime has not yet converted into a typed wait.
    runStep: async () => {
      steps += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, params.slowMs));
      return { kind: "suspend" as const, reason: "idle_external" as any };
    },
    options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
  });

  return { driver, fiberId, vm, stepsObserved: () => steps };
}

describe("settle budget is a pump budget, not a turn failure", () => {
  it("foreground settle returns a declared outcome instead of throwing when the budget is exhausted", async () => {
    const { driver } = createSlowFibersDriver({ slowMs: 250 });

    const startedAt = Date.now();
    let thrown: unknown;
    let result: unknown;
    try {
      result = await driver.tickUntilForegroundSettled({ now: Date.now(), maxWallMs: 60 });
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - startedAt;

    // The old contract threw `Timeout after 60ms` and aborted the caller.
    expect(thrown).toBeUndefined();
    expect(elapsed).toBeLessThan(250);
    expect(result).toBeDefined();
    expect((result as any).status).toBe("budget_exhausted");
  });

  it("foreground settle reports settled when the lane converges inside the budget", async () => {
    const { driver } = createSlowFibersDriver({ slowMs: 0 });

    const result: any = await driver.tickUntilForegroundSettled({ now: Date.now(), maxWallMs: 2_000 });

    expect(result.status).toBe("settled");
  });

  it("an unbounded settle keeps its existing semantics", async () => {
    const { driver, fiberId } = createSlowFibersDriver({ slowMs: 5 });

    const result: any = await driver.tickUntilForegroundSettled({ now: Date.now() });

    expect(result.status).toBe("settled");
    expect(driver.getState().fibers[fiberId].status).toBe("suspended");
  });

  it("blocked settle returns a declared outcome instead of throwing when the budget is exhausted", async () => {
    const { driver } = createSlowFibersDriver({ slowMs: 250 });

    let thrown: unknown;
    let result: any;
    try {
      result = await driver.tickUntilBlocked({ now: Date.now(), maxWallMs: 60 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(result.status).toBe("budget_exhausted");
  });

  it("background settle returns a declared outcome instead of throwing when the budget is exhausted", async () => {
    const { driver } = createSlowFibersDriver({ slowMs: 250, lane: "detached" });

    let thrown: unknown;
    let result: any;
    try {
      result = await driver.tickUntilBackgroundSettled({ now: Date.now(), maxWallMs: 60 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(result.status).toBe("budget_exhausted");
  });
});
