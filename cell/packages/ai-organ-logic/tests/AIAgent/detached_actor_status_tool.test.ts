import { describe, expect, it } from "bun:test";

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver";

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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

describe("DetachedActorStatus tool", () => {
  it("returns JSON status for a detached actor (running -> completed)", async () => {
    const adapter = makeMockAdapter();

    const callCount: Record<string, number> = {};
    const processStream = async (_vm: any, actor: any) => {
      const key = String(actor.key);
      callCount[key] = (callCount[key] ?? 0) + 1;
      const n = callCount[key];

      if (actor.type === "delegate" || actor.type === "detached") {
        return { role: "assistant", content: "child result" };
      }

      if (n === 1) {
        return {
          role: "assistant",
          tool_calls: [
            {
              id: "tc-detached-2",
              function: {
                name: "RunDelegateActor",
                arguments: JSON.stringify({
                  description: "do subtask",
                  prompt: "please do it",
                  agent_type: "code",
                  mode: "detached",
                }),
              },
            },
          ],
        };
      }

      return { role: "assistant", content: "parent idle" };
    };

    const main = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, actor) => processStream(vm, actor),
      },
    });

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: {
            name: "code",
            description: "test agent",
            tools: "*",
            prompt: ["you are a test delegate actor"],
          },
        } as any),
      },
    });

    const messages: any[] = [];
    const mainFiberId = `${main.key}:${main.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: main, messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const now = Date.now();
    main.send("humanInput", "hi");
    driver.resumeFiber(mainFiberId, now);
    await driver.tickUntilForegroundSettled({ now, maxTicks: 50, maxWallMs: 2000 });
    await flushMicrotasks();

    const toolMsg = messages.find((m) => m?.role === "tool" && m?.tool_call_id === "tc-detached-2");
    expect(toolMsg).toBeTruthy();
    const started = JSON.parse(String((toolMsg as any)?.content ?? ""));
    expect(typeof started?.task_id).toBe("string");

    const detachedActor = Object.values(vm.actors).find(
      (actor) => actor.type === "detached" && actor.detachedTask?.taskId === started.task_id,
    );
    expect(detachedActor).toBeTruthy();

    const detachedActorStatus = JSON.parse(
      String(await toolRegistry.call("ActorStatus", vm, main, { target: detachedActor!.key })),
    );
    expect(detachedActorStatus.ok).toBe(true);
    expect(detachedActorStatus.actor_type).toBe("detached");
    expect(detachedActorStatus.detached_task).toMatchObject({
      task_id: started.task_id,
      kind: "delegate",
    });

    const status1 = await toolRegistry.call("DetachedActorStatus", vm, main, { task_id: started.task_id });
    const st1 = JSON.parse(String(status1 ?? ""));
    expect(st1?.ok).toBe(true);
    expect(st1?.task_id).toBe(started.task_id);
    expect(["pending", "running"].includes(String(st1?.status ?? ""))).toBe(true);
    expect(st1?.kind).toBe("delegate");
    expect(st1?.kind_formal).toBe("delegate");

    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 50, maxWallMs: 2000 });
    await flushMicrotasks();

    const status2 = await toolRegistry.call("DetachedActorStatus", vm, main, { task_id: started.task_id });
    const st2 = JSON.parse(String(status2 ?? ""));
    expect(st2?.ok).toBe(true);
    expect(st2?.status).toBe("completed");
    expect(st2?.kind_formal).toBe("delegate");

    const detachedActorAfterCompletion = vm.actors[detachedActor!.key];
    expect(detachedActorAfterCompletion?.type).toBe("detached");
    expect(detachedActorAfterCompletion?.detachedTask?.status).toBe("completed");
  });

  it("reports suspended while a detached fiber is waiting on inflight IO", async () => {
    const adapter = makeMockAdapter();

    const llmDone: { promise: Promise<any>; resolve: (v: any) => void } = (() => {
      let resolve!: (v: any) => void;
      const promise = new Promise<any>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();

    const callCount: Record<string, number> = {};
    const processStream = async (_vm: any, actor: any) => {
      const key = String(actor.key);
      callCount[key] = (callCount[key] ?? 0) + 1;
      const n = callCount[key];

      if (actor.type === "delegate" || actor.type === "detached") {
        return await llmDone.promise;
      }

      if (n === 1) {
        return {
          role: "assistant",
          tool_calls: [
            {
              id: "tc-detached-3",
              function: {
                name: "RunDelegateActor",
                arguments: JSON.stringify({
                  description: "do subtask",
                  prompt: "please do it",
                  agent_type: "code",
                  mode: "detached",
                }),
              },
            },
          ],
        };
      }

      return { role: "assistant", content: "parent idle" };
    };

    const main = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, actor) => processStream(vm, actor),
      },
    });

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: {
            name: "code",
            description: "test agent",
            tools: "*",
            prompt: ["you are a test delegate actor"],
          },
        } as any),
      },
    });

    const messages: any[] = [];
    const mainFiberId = `${main.key}:${main.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: main, messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const now = Date.now();
    main.send("humanInput", "hi");
    driver.resumeFiber(mainFiberId, now);
    await driver.tickUntilForegroundSettled({ now, maxTicks: 50, maxWallMs: 2000 });
    await flushMicrotasks();

    const toolMsg = messages.find((m) => m?.role === "tool" && m?.tool_call_id === "tc-detached-3");
    expect(toolMsg).toBeTruthy();
    const started = JSON.parse(String((toolMsg as any)?.content ?? ""));
    expect(typeof started?.task_id).toBe("string");

    // Pump the background lane once: it should start and then suspend on inflight IO.
    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 5, maxWallMs: 500 });
    await flushMicrotasks();

    const status1 = await toolRegistry.call("DetachedActorStatus", vm, main, { task_id: started.task_id });
    const st1 = JSON.parse(String(status1 ?? ""));
    expect(st1?.ok).toBe(true);
    expect(["running", "suspended"].includes(String(st1?.status ?? ""))).toBe(true);
    expect(st1?.kind_formal).toBe("delegate");

    llmDone.resolve({ role: "assistant", content: "child result" });
    await flushMicrotasks();

    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 50, maxWallMs: 2000 });
    await flushMicrotasks();

    const status2 = await toolRegistry.call("DetachedActorStatus", vm, main, { task_id: started.task_id });
    const st2 = JSON.parse(String(status2 ?? ""));
    expect(st2?.ok).toBe(true);
    expect(st2?.status).toBe("completed");
    expect(st2?.kind_formal).toBe("delegate");
  });

  it("prefers actor-owned detached state over stale detached registry mirrors", async () => {
    const adapter = makeMockAdapter();
    const main = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    });
    const detached = createActor({
      key: "detached:bg-1",
      type: "detached",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "done" }),
      },
      detachedTask: {
        taskId: "bg-1",
        kind: "delegate",
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
        outputText: "actor truth",
      },
    });

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true });
    const vm = createVM({
      controlActorKey: main.key,
      actors: { [main.key]: main, [detached.key]: detached },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({} as any),
      },
    });

    vm.sessionState.detachedActors["bg-1"] = {
      taskId: "bg-1",
      kind: "delegate",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      outputText: "stale mirror",
    };

    const status = JSON.parse(String(await toolRegistry.call("DetachedActorStatus", vm, main, { task_id: "bg-1" })));
    expect(status.ok).toBe(true);
    expect(status.status).toBe("completed");
    expect(status.output_text).toBe("actor truth");

    const actorStatus = JSON.parse(String(await toolRegistry.call("ActorStatus", vm, main, { target: detached.key })));
    expect(actorStatus.ok).toBe(true);
    expect(actorStatus.lifecycle_state).toBe("exited");
    expect(actorStatus.detached_task).toMatchObject({
      task_id: "bg-1",
      status: "completed",
      kind: "delegate",
    });
  });
});
