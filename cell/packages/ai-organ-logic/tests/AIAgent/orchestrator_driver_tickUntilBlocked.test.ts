import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";

describe("AiAgentOrchestratorDriver.tickUntilBlocked", () => {
  it("waits for inflight async IO before returning", async () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const fiberId = `${actor.key}:${actor.id}`;
    const messages: any[] = [];

    let step = 0;

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages, basePriority: 1 }],
      runStep: async (ctx, helpers) => {
        step += 1;
        if (step === 1) {
          ctx.execState = { ...(ctx.execState ?? {}), inflight: { kind: "llm", opId: "x" } };
          setTimeout(() => {
            ctx.execState = { ...(ctx.execState ?? {}), inflight: undefined };
            helpers.resume(ctx.fiberId);
          }, 10);
          return { kind: "suspend", reason: "external" };
        }
        return { kind: "complete" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const now = Date.now();
    driver.resumeFiber(fiberId, now);

    await driver.tickUntilBlocked({ now, maxWallMs: 2000 });

    const s = driver.getState();
    expect(s.fibers[fiberId].status).toBe("completed");
  });
});
