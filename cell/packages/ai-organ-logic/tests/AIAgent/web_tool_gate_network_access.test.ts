import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import type { ToolDef } from "@cell/ai-core-contract/types";

import { aiAgentLoopStreaming, aiAgentCooperativeStep } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function tickAndFlush(driver: { tick: (now: number) => void }): Promise<void> {
  driver.tick(Date.now());
  await flushMicrotasks();
}

async function advanceUntil(params: {
  driver: { tick: (now: number) => void; getState: () => any };
  fiberId: string;
  predicate: (fiber: any) => boolean;
  maxSteps?: number;
}): Promise<void> {
  const max = typeof params.maxSteps === "number" && params.maxSteps > 0 ? params.maxSteps : 150;
  for (let i = 0; i < max; i++) {
    const s = params.driver.getState();
    const fiber = s.fibers[params.fiberId];
    if (fiber && params.predicate(fiber)) {
      return;
    }
    await tickAndFlush(params.driver);
  }
  throw new Error("advanceUntil: maxSteps exceeded");
}

function makeMockAdapter() {
  return {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield { ok: true };
      }
      return { stream: stream() };
    },
  };
}

describe("web tool gating (network_access)", () => {
  it("blocks webfetch in aiAgentLoopStreaming when network_access is disabled", async () => {
    const llmAdapter = makeMockAdapter();

    let calls = 0;
    const webfetchTool: ToolDef<any, string, Record<string, unknown>> = {
      schema: {
        type: "function",
        function: { name: "webfetch", description: "test", parameters: { type: "object" } },
      },
      briefPromptXnl: `<tool name="webfetch" />`,
      run: async () => {
        calls += 1;
        return "ok";
      },
    };

    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(webfetchTool as any);

    const actor = createActor({
      key: "main",
      llmClient: llmAdapter,
      modelConfig: { model: "mock" },
      ctrlOptions: { exitAfterToolResult: true },
      callbacks: {
        buildToolset: () => [webfetchTool.schema],
        processStream: async () => ({
          role: "assistant",
          tool_calls: [
            {
              id: "tc-web-1",
              function: { name: "webfetch", arguments: JSON.stringify({ url: "https://example.com" }) },
            },
          ],
        }),
      },
    });

    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
      outerCtx: {
        metadata: {
          sandbox_permissions: {
            network_access: "disabled",
          },
        },
      },
    });

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [] });
    const toolMsg = result.messages.find((m: any) => m?.role === "tool" && (m?.tool_call_id ?? m?.toolCallId) === "tc-web-1");
    expect(toolMsg).toBeTruthy();
    expect(String(toolMsg.content)).toContain("policy violation");
    expect(calls).toBe(0);
  });

  it("blocks webfetch in cooperative executor when network_access is disabled", async () => {
    const llmAdapter = makeMockAdapter();

    let calls = 0;
    const webfetchTool: ToolDef<any, string, Record<string, unknown>> = {
      schema: {
        type: "function",
        function: { name: "webfetch", description: "test", parameters: { type: "object" } },
      },
      briefPromptXnl: `<tool name="webfetch" />`,
      run: async () => {
        calls += 1;
        return "ok";
      },
    };

    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(webfetchTool as any);

    const actor = createActor({
      key: "main",
      llmClient: llmAdapter,
      modelConfig: { model: "mock" },
      ctrlOptions: { stopAfterTools: ["webfetch"] },
      callbacks: {
        buildToolset: () => [webfetchTool.schema],
        processStream: async () => ({
          role: "assistant",
          tool_calls: [
            {
              id: "tc-web-2",
              function: { name: "webfetch", arguments: JSON.stringify({ url: "https://example.com" }) },
            },
          ],
        }),
      },
    });

    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
      outerCtx: {
        metadata: {
          sandbox_permissions: {
            network_access: "disabled",
          },
        },
      },
    });

    const fiberId = `${actor.key}:${actor.id}`;
    const messages: any[] = [];
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

    actor.send("humanInput", "start");

    await advanceUntil({
      driver,
      fiberId,
      predicate: () => actor.messages.some((m: any) => m?.role === "tool" && (m?.tool_call_id ?? m?.toolCallId) === "tc-web-2"),
    });

    const toolMsg = actor.messages.find((m: any) => m?.role === "tool" && (m?.tool_call_id ?? m?.toolCallId) === "tc-web-2");
    expect(toolMsg).toBeTruthy();
    expect(String((toolMsg as any).content)).toContain("policy violation");
    expect(calls).toBe(0);
  });
});
