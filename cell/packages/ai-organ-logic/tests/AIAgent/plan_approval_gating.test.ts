import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import type { ToolDef } from "@cell/ai-core-contract/types";

import { aiAgentLoopStreaming, aiAgentCooperativeStep } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";
import { getCoordinationEngine } from "@cell/ai-organ-logic/coordination/CoordinationEngine";

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
  predicate: () => boolean;
  maxSteps?: number;
}): Promise<void> {
  const max = typeof params.maxSteps === "number" && params.maxSteps > 0 ? params.maxSteps : 150;
  for (let i = 0; i < max; i++) {
    if (params.predicate()) {
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

describe("plan approval gating enforcement", () => {
  it("blocks gated tools for a member until plan_review approves (streaming executor)", async () => {
    const engine = getCoordinationEngine();
    engine.__resetForTest?.();

    const llmAdapter = makeMockAdapter();

    let calls = 0;
    const bashTool: ToolDef<any, string, Record<string, unknown>> = {
      schema: {
        type: "function",
        function: { name: "bash", description: "test", parameters: { type: "object" } },
      },
      briefPromptXnl: `<tool name="bash" />`,
      run: async () => {
        calls += 1;
        return "ok";
      },
    };

    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(bashTool as any);

    const actor = createActor({
      key: "worker",
      llmClient: llmAdapter,
      modelConfig: { model: "mock" },
      ctrlOptions: { exitAfterToolResult: true },
      callbacks: {
        buildToolset: () => [bashTool.schema],
        processStream: async () => ({
          role: "assistant",
          tool_calls: [{ id: "tc-bash-1", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }],
        }),
      },
    });
    actor.identity = { kind: "member", memberId: "t1", name: "worker", role: "worker", lane: "member" } as any;

    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
    });

    // Establish an active, unapproved plan gate via coordination ingestion.
    const req = engine.makeOutbound({
      coordination: "plan_approval",
      kind: "plan_request",
      payload: { plan: "run dangerous thing" },
    });
    actor.send("memberInbox", { from: "control", text: req.text, ts: Date.now() });

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [] });
    const toolMsg = result.messages.find((m: any) => m?.role === "tool" && m?.tool_call_id === "tc-bash-1");
    expect(toolMsg).toBeTruthy();
    expect(String(toolMsg.content)).toContain("plan approval required");
    expect(String(toolMsg.content)).toContain(req.request_id);
    expect(calls).toBe(0);

    // Now approve and retry.
    const review = engine.makeOutbound({
      coordination: "plan_approval",
      kind: "plan_review",
      request_id: req.request_id,
      payload: { decision: "approve", feedback: "ok" },
    });
    actor.send("memberInbox", { from: "control", text: review.text, ts: Date.now() });

    const result2 = await aiAgentLoopStreaming({ vm, actor, messages: [] });
    const toolMsg2 = result2.messages.find((m: any) => m?.role === "tool" && m?.tool_call_id === "tc-bash-1");
    expect(toolMsg2).toBeTruthy();
    expect(String(toolMsg2.content)).toBe("ok");
    expect(calls).toBe(1);
  });

  it("blocks gated tools for a member until plan_review approves (cooperative executor)", async () => {
    const engine = getCoordinationEngine();
    engine.__resetForTest?.();

    const llmAdapter = makeMockAdapter();

    let calls = 0;
    const bashTool: ToolDef<any, string, Record<string, unknown>> = {
      schema: {
        type: "function",
        function: { name: "bash", description: "test", parameters: { type: "object" } },
      },
      briefPromptXnl: `<tool name="bash" />`,
      run: async () => {
        calls += 1;
        return "ok";
      },
    };
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(bashTool as any);

    const actor = createActor({
      key: "worker",
      llmClient: llmAdapter,
      modelConfig: { model: "mock" },
      ctrlOptions: { stopAfterTools: ["bash"] },
      callbacks: {
        buildToolset: () => [bashTool.schema],
        processStream: async () => ({
          role: "assistant",
          tool_calls: [{ id: "tc-bash-2", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }],
        }),
      },
    });
    actor.identity = { kind: "member", memberId: "t1", name: "worker", role: "worker", lane: "member" } as any;

    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
    });

    const req = engine.makeOutbound({ coordination: "plan_approval", kind: "plan_request", payload: { plan: "do it" } });
    actor.send("memberInbox", { from: "control", text: req.text, ts: Date.now() });

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

    await advanceUntil({
      driver,
      fiberId,
      predicate: () => messages.some((m) => m?.role === "tool" && m?.tool_call_id === "tc-bash-2"),
    });
    const toolMsg = messages.find((m) => m?.role === "tool" && m?.tool_call_id === "tc-bash-2");
    expect(toolMsg).toBeTruthy();
    expect(String((toolMsg as any).content)).toContain("plan approval required");
    expect(String((toolMsg as any).content)).toContain(req.request_id);
    expect(calls).toBe(0);

    // Approve, then run again.
    const review = engine.makeOutbound({
      coordination: "plan_approval",
      kind: "plan_review",
      request_id: req.request_id,
      payload: { decision: "approve", feedback: "ok" },
    });
    actor.send("memberInbox", { from: "control", text: review.text, ts: Date.now() });

    driver.resumeFiber(fiberId, Date.now());
    await flushMicrotasks();

    await advanceUntil({
      driver,
      fiberId,
      predicate: () => messages.filter((m) => m?.role === "tool" && m?.tool_call_id === "tc-bash-2").length >= 2,
    });

    const last = messages
      .filter((m) => m?.role === "tool" && m?.tool_call_id === "tc-bash-2")
      .slice(-1)[0];
    expect(String(last?.content ?? "")).toBe("ok");
    expect(calls).toBe(1);
  });
});
