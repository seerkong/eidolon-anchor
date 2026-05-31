import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { aiAgentCooperativeStep, __setCompressionDepsForTest } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function advanceUntil(params: {
  driver: { tick: (now: number) => void; getState: () => any };
  predicate: () => boolean;
  maxSteps?: number;
}): Promise<void> {
  const max = typeof params.maxSteps === "number" && params.maxSteps > 0 ? params.maxSteps : 150;
  for (let i = 0; i < max; i++) {
    if (params.predicate()) {
      return;
    }
    params.driver.tick(Date.now());
    await flushMicrotasks();
  }
  throw new Error("advanceUntil: maxSteps exceeded");
}

describe("Stage 3 cooperative compression", () => {
  it("runs compression asynchronously and applies compressed history", async () => {
    const toolRegistry = new ToolFuncRegistry();
    const backupCalls: any[] = [];

    __setCompressionDepsForTest({
      estimateUsageRatio: () => 0.9,
      compressHistory: async () => {
        return [{ role: "system", content: "COMPRESSED" }];
      },
    });

    const llmAdapter = {
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { ok: true };
        }
        return { stream: stream() };
      },
    };

    const actor = createActor({
      key: "main",
      llmClient: llmAdapter,
      modelConfig: { model: "mock", inputLimit: 10 },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "done" }),
      },
    });

    const messages: any[] = [
      { role: "system", content: "seed" },
      { role: "user", content: "A".repeat(500) },
    ];

    const eventBus = new AgentEventGraph();
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      registries: { toolRegistry },
      eventBus,
      effects: {
        messageHistory: {
          appendMessage: () => {},
          backupHistory: async (params) => {
            backupCalls.push(params);
          },
        },
      },
    });

    const fiberId = `${actor.key}:${actor.id}`;
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages, basePriority: 1 }],
      runStep: async (ctx, helpers) => {
        return await aiAgentCooperativeStep({
          fiberId: ctx.fiberId,
          vm: ctx.vm,
          actor: ctx.actor,
          messages: ctx.messages,
          state: ctx.execState,
          setState: (s) => {
            ctx.execState = s;
          },
          resumeFiber: helpers.resume,
        });
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.resumeFiber(fiberId, Date.now());
    await flushMicrotasks();

    await advanceUntil({
      driver,
      predicate: () => messages.some((m) => m?.role === "system" && m?.content === "COMPRESSED"),
    });

    expect(messages[0]?.content).toBe("COMPRESSED");
    expect(backupCalls.length).toBeGreaterThan(0);
  });
});
