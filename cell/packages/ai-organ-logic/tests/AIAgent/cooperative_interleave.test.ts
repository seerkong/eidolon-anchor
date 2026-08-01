import { describe, expect, it } from "bun:test";

import { selectNextFiberId } from "depa-actor";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import type { ToolDef } from "@cell/ai-core-contract/types";
import { aiAgentCooperativeStep } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";
import { getVmProviderCallDomain } from "@cell/ai-organ-logic/runtime/ProviderCallDomainRuntime";

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
  const max = typeof params.maxSteps === "number" && params.maxSteps > 0 ? params.maxSteps : 50;
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Stage 3 cooperative stepping", () => {
  it("runs other fibers while main waits for LLM", async () => {
    const llmDone = deferred<any>();
    const mockAdapter = {
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { ok: true };
        }
        return { stream: stream() };
      },
    };

    const toolRegistry = new ToolFuncRegistry();
    const main = createActor({
      key: "main",
      llmClient: mockAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => {
          return await llmDone.promise;
        },
      },
    });

    const worker = createActor({ key: "worker" });
    const vm = createVM({ controlActorKey: "main", actors: { main, worker }, registries: { toolRegistry } });

    const mainFiberId = `${main.key}:${main.id}`;
    const workerFiberId = `${worker.key}:${worker.id}`;

    const driver = createAiAgentOrchestratorDriver({
      fibers: [
        { fiberId: mainFiberId, vm, actor: main, messages: [], basePriority: 1 },
        { fiberId: workerFiberId, vm, actor: worker, messages: [], basePriority: 2 },
      ],
      runStep: async (ctx, helpers) => {
        if (ctx.fiberId === workerFiberId) {
          return { kind: "complete" };
        }
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

    main.send("humanInput", "start");

    await advanceUntil({
      driver,
      fiberId: mainFiberId,
      predicate: (fiber) => fiber.status === "suspended" && fiber.waitingReason === "wait_llm_result",
    });

    const s1 = driver.getState();
    expect(s1.fibers[mainFiberId].status).toBe("suspended");
    expect(s1.fibers[mainFiberId].waitingReason).toBe("wait_llm_result");

    // Main is waiting; worker should be runnable.
    expect(selectNextFiberId(s1)).toBe(workerFiberId);

    await tickAndFlush(driver);

    const s2 = driver.getState();
    expect(s2.fibers[workerFiberId].status).toBe("completed");

    llmDone.resolve({ role: "assistant", content: "hi" });
    await flushMicrotasks();

    // Let main consume the LLM result and reach a stable blocked state.
    await tickAndFlush(driver);

    const s3 = driver.getState();
    expect(["ready", "suspended"].includes(s3.fibers[mainFiberId].status)).toBe(true);
  });

  it("runs other fibers while main waits for tool result", async () => {
    const toolDone = deferred<string>();
    const mockAdapter = {
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { ok: true };
        }
        return { stream: stream() };
      },
    };

    const toolRegistry = new ToolFuncRegistry();
    const slowTool: ToolDef<any, string, Record<string, unknown>> = {
      schema: {
        type: "function",
        function: { name: "SlowTool", description: "test", parameters: { type: "object" } },
      },
      briefPromptXnl: `<tool name="SlowTool" />`,
      run: async () => {
        return await toolDone.promise;
      },
    };
    toolRegistry.register(slowTool as any);

    const main = createActor({
      key: "main",
      llmClient: mockAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [slowTool.schema],
        processStream: async () => ({
          role: "assistant",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "SlowTool",
                arguments: "{}",
              },
            },
          ],
        }),
      },
    });

    const worker = createActor({ key: "worker" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main, worker },
      registries: { toolRegistry },
    });

    const mainFiberId = `${main.key}:${main.id}`;
    const workerFiberId = `${worker.key}:${worker.id}`;

    const driver = createAiAgentOrchestratorDriver({
      fibers: [
        { fiberId: mainFiberId, vm, actor: main, messages: [], basePriority: 1 },
        { fiberId: workerFiberId, vm, actor: worker, messages: [], basePriority: 2 },
      ],
      runStep: async (ctx, helpers) => {
        if (ctx.fiberId === workerFiberId) {
          return { kind: "complete" };
        }
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

    main.send("humanInput", "start");

    await advanceUntil({
      driver,
      fiberId: mainFiberId,
      predicate: (fiber) => fiber.status === "suspended" && fiber.waitingReason === "wait_tool_result",
    });

    const s1 = driver.getState();
    expect(s1.fibers[mainFiberId].status).toBe("suspended");
    expect(s1.fibers[mainFiberId].waitingReason).toBe("wait_tool_result");

    expect(selectNextFiberId(s1)).toBe(workerFiberId);

    await tickAndFlush(driver);
    const s2 = driver.getState();
    expect(s2.fibers[workerFiberId].status).toBe("completed");

    toolDone.resolve("ok");
    await flushMicrotasks();

    await tickAndFlush(driver);
    const s3 = driver.getState();
    expect(["ready", "suspended"].includes(s3.fibers[mainFiberId].status)).toBe(true);
  });

  it("retries a cooperative provider turn once when the provider returns an empty assistant response", async () => {
    let createStreamCalls = 0;
    let processStreamCalls = 0;
    const requestedMessages: any[][] = [];
    const mockAdapter = {
      type: "openai" as const,
      async createStream(options?: any) {
        createStreamCalls += 1;
        requestedMessages.push(options?.messages ?? []);
        async function* stream() {
          yield { ok: true };
        }
        return { stream: stream() };
      },
    };

    const toolRegistry = new ToolFuncRegistry();
    const main = createActor({
      key: "main",
      llmClient: mockAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => {
          processStreamCalls += 1;
          return processStreamCalls === 1
            ? { role: "assistant", content: null }
            : { role: "assistant", content: "recovered" };
        },
      },
    });
    const vm = createVM({ controlActorKey: "main", actors: { main }, registries: { toolRegistry } });
    const fiberId = `${main.key}:${main.id}`;
    const turnEnds: string[] = [];
    vm.eventBus?.addConsumer((event: any) => {
      if (event?.event_type === "semantic_turn_end") {
        turnEnds.push(String(event.reason ?? ""));
      }
    });

    let execState: any;
    const step = async () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor: main,
      messages: [],
      state: execState,
      setState: (s) => {
        execState = s;
      },
      resumeFiber: () => {},
    });

    main.send("humanInput", "start");
    let waitResult: any = null;
    for (let i = 0; i < 10; i++) {
      const result = await step();
      if (result.kind === "suspend" && result.reason === "wait_llm_result") {
        waitResult = result;
        break;
      }
    }
    expect(waitResult).toMatchObject({ kind: "suspend", reason: "wait_llm_result" });
    await flushMicrotasks();
    const result = await step();

    expect(result).toMatchObject({ kind: "suspend", reason: "idle_external" });
    expect(createStreamCalls).toBe(2);
    expect(processStreamCalls).toBe(2);
    expect(JSON.stringify(requestedMessages[1])).toContain("previous assistant response was empty");
    expect(turnEnds).toContain("no_tool_calls");
    expect(turnEnds).not.toContain("provider_failed");
    const [record] = getVmProviderCallDomain(vm)?.getAllRecords() ?? [];
    expect(record?.status).toBe("completed");
  });

  it("does not finish a cooperative turn as no_tool_calls when the provider repeatedly returns an empty assistant response", async () => {
    let processStreamCalls = 0;
    const mockAdapter = {
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { ok: true };
        }
        return { stream: stream() };
      },
    };

    const toolRegistry = new ToolFuncRegistry();
    const main = createActor({
      key: "main",
      llmClient: mockAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => {
          processStreamCalls += 1;
          return { role: "assistant", content: null };
        },
      },
    });
    const vm = createVM({ controlActorKey: "main", actors: { main }, registries: { toolRegistry } });
    const fiberId = `${main.key}:${main.id}`;
    const turnEnds: string[] = [];
    vm.eventBus?.addConsumer((event: any) => {
      if (event?.event_type === "semantic_turn_end") {
        turnEnds.push(String(event.reason ?? ""));
      }
    });

    let execState: any;
    const step = async () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor: main,
      messages: [],
      state: execState,
      setState: (s) => {
        execState = s;
      },
      resumeFiber: () => {},
    });

    main.send("humanInput", "start");
    let waitResult: any = null;
    for (let i = 0; i < 10; i++) {
      const result = await step();
      if (result.kind === "suspend" && result.reason === "wait_llm_result") {
        waitResult = result;
        break;
      }
    }
    expect(waitResult).toMatchObject({ kind: "suspend", reason: "wait_llm_result" });
    await flushMicrotasks();
    const result = await step();

    expect(result).toMatchObject({ kind: "suspend", reason: "idle_external" });
    expect(processStreamCalls).toBe(2);
    expect(turnEnds).not.toContain("no_tool_calls");
    expect(turnEnds).toContain("provider_failed");
    const [record] = getVmProviderCallDomain(vm)?.getAllRecords() ?? [];
    expect(record?.status).toBe("failed");
    expect(record?.rawError).toContain("empty assistant response");
  });
});
