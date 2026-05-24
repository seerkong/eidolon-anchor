import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { aiAgentCooperativeStep } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";
import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

describe("Stage 3 cooperative cancel", () => {
  const llmAdapter = {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield { ok: true };
      }
      return { stream: stream() };
    },
  };

  it("keeps the main fiber resumable when control.cancel_requested is present", async () => {
    const toolRegistry = new ToolFuncRegistry();
    const actor = createActor({
      key: "main",
      llmClient: llmAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    });
    actor.send("control", { kind: "cancel_requested" });

    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      registries: { toolRegistry },
    });

    const fiberId = `${actor.key}:${actor.id}`;
    const messages: any[] = [{ role: "user", content: "hi" }];

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
    driver.tick(Date.now());
    await flushMicrotasks();

    const s = driver.getState();
    expect(s.fibers[fiberId].status).not.toBe("cancelled");
  });

  it("cancels a member main fiber when shutdown_requested is present", async () => {
    const toolRegistry = new ToolFuncRegistry();
    const members = getMemberManager();
    members.__resetForTest?.();

    const control = createActor({
      key: "control",
      llmClient: llmAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    });
    const vm = createVM({
      controlActorKey: "control",
      actors: { [control.key]: control },
      registries: { toolRegistry },
    });

    const dummyDriver = { getState: () => ({ fibers: {} }), spawnFiber: () => {}, suspendFiber: () => {} } as any;
    const rec = members.createMember({
      vm,
      driver: dummyDriver,
      controlActor: control,
      name: "worker",
      role: "worker",
      agentType: "code",
      lane: "member",
    });
    const actor = rec.actor;
    const fiberId = `${actor.key}:${actor.id}`;
    const messages: any[] = [{ role: "user", content: "hi" }];

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages, basePriority: 1 }],
      runStep: async (ctx, helpers) => {
        return await aiAgentCooperativeStep({
          fiberId: ctx.fiberId,
          vm: ctx.vm,
          actor: ctx.actor,
          messages: ctx.messages,
          state: ctx.execState,
          setState: (st) => {
            ctx.execState = st;
          },
          resumeFiber: helpers.resume,
        });
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    rec.driver = driver as any;
    members.markMemberShutdownRequested({ vm, memberId: rec.memberId, requestId: "req_1" });
    actor.send("control", { kind: "shutdown_requested" });

    driver.resumeFiber(fiberId, Date.now());
    await flushMicrotasks();
    driver.tick(Date.now());
    await flushMicrotasks();

    const state = driver.getState();
    expect(state.fibers[fiberId].status).toBe("cancelled");
  });

  it("keeps a delegate fiber resumable when only cancel_requested is present", async () => {
    const toolRegistry = new ToolFuncRegistry();
    const actor = createActor({
      key: "worker",
      type: "delegate" as any,
      llmClient: llmAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    });
    actor.send("control", { kind: "cancel_requested" });

    const vm = createVM({
      controlActorKey: "worker",
      actors: { worker: actor },
      registries: { toolRegistry },
    });

    const fiberId = `${actor.key}:${actor.id}`;
    const messages: any[] = [{ role: "user", content: "hi" }];

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages, basePriority: 1 }],
      runStep: async (ctx, helpers) => {
        return await aiAgentCooperativeStep({
          fiberId: ctx.fiberId,
          vm: ctx.vm,
          actor: ctx.actor,
          messages: ctx.messages,
          state: ctx.execState,
          setState: (s0) => {
            ctx.execState = s0;
          },
          resumeFiber: helpers.resume,
        });
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.resumeFiber(fiberId, Date.now());
    await flushMicrotasks();
    driver.tick(Date.now());
    await flushMicrotasks();

    const state = driver.getState();
    expect(state.fibers[fiberId].status).not.toBe("cancelled");
  });

  it("still cancels a delegate fiber when shutdown_requested is present", async () => {
    const toolRegistry = new ToolFuncRegistry();
    const actor = createActor({
      key: "worker",
      type: "delegate" as any,
      llmClient: llmAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    });
    actor.send("control", { kind: "shutdown_requested" });

    const vm = createVM({
      controlActorKey: "worker",
      actors: { worker: actor },
      registries: { toolRegistry },
    });

    const fiberId = `${actor.key}:${actor.id}`;
    const messages: any[] = [{ role: "user", content: "hi" }];

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages, basePriority: 1 }],
      runStep: async (ctx, helpers) => {
        return await aiAgentCooperativeStep({
          fiberId: ctx.fiberId,
          vm: ctx.vm,
          actor: ctx.actor,
          messages: ctx.messages,
          state: ctx.execState,
          setState: (s0) => {
            ctx.execState = s0;
          },
          resumeFiber: helpers.resume,
        });
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.resumeFiber(fiberId, Date.now());
    await flushMicrotasks();
    driver.tick(Date.now());
    await flushMicrotasks();

    const state = driver.getState();
    expect(state.fibers[fiberId].status).toBe("cancelled");
  });
});
