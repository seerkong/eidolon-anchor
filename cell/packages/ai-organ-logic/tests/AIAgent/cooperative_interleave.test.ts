import { describe, expect, it } from "bun:test";

import { selectNextFiberId } from "depa-actor";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { createActorRuntimeFacetRegistry } from "@cell/ai-core-logic/runtime/ActorRuntimeFacet";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import type { ToolDef } from "@cell/ai-core-contract/types";
import { aiAgentCooperativeStep } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";
import { getVmProviderCallDomain } from "@cell/ai-organ-logic/runtime/ProviderCallDomainRuntime";
import { ProviderRequestAdmissionError } from "@cell/ai-organ-logic/llm/tool-schema/ProviderRequestAdmission";
import {
  createWorkflowLifecycleFacetRegistry,
  createWorkflowLifecycleFacetEnvelope,
  readWorkflowLifecycleFacet,
} from "@cell/ai-organ-logic/workflow/runtime/WorkflowLifecycleFacet";
import { withWorkflowDomainProgress } from "@cell/ai-organ-logic/workflow/runtime/WorkflowDomainProgress";

function testWorkflowFacet(input: { maxNoProgressTurns?: number; stageDeadlineMs?: number } = {}) {
  const material = "name: sys-eidolon-anchor-devops\nrevision: test-v1";
  const now = Date.now();
  return createWorkflowLifecycleFacetEnvelope({
    strategyRevision: "hybrid/v1",
    systemPrompts: [material],
    toolNames: [],
    progress: {
      stageStartedAt: now,
      deadlineAt: now + (input.stageDeadlineMs ?? 180_000),
      turnsSinceProgress: 0,
      maxNoProgressTurns: input.maxNoProgressTurns ?? 4,
      proofRepairAttempts: 0,
      maxProofRepairAttempts: 3,
      lastProgressAt: now,
    },
  });
}

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
  it("uses the same neutral facet order in the cooperative provider/tool loop", async () => {
    const facetId = "fixture.cooperative-order/v1";
    const schemaVersion = "1";
    const events: string[] = [];
    const registry = createActorRuntimeFacetRegistry([{
      facetId,
      schemaVersion,
      normalize: (value) => value,
      onEvent: ({ envelope, event }) => {
        events.push(event.kind);
        return event.kind === "aroundProvider"
          ? null
          : {
              expectedRevision: envelope.revision,
              nextValue: { count: Number((envelope.value as any).count) + 1 },
              reason: `fixture.${event.kind}`,
            };
      },
      aroundProvider: async (_context, runtime) => runtime.providerBoundary.run(),
    }]);
    const tool: ToolDef<any, string, Record<string, unknown>> = {
      schema: {
        type: "function",
        function: { name: "CooperativeFacetTool", description: "test", parameters: { type: "object" } },
      },
      briefPromptXnl: `<tool name="CooperativeFacetTool" />`,
      run: async () => "changed",
    };
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(tool);
    let completion = 0;
    const actor = createActor({
      key: "cooperative-facet-order",
      runtimeFacets: [{ facetId, schemaVersion, revision: 0, value: { count: 0 } }],
      llmClient: {
        type: "openai" as const,
        async createStream() {
          async function* stream() { yield { ok: true }; }
          return { stream: stream() };
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [tool.schema],
        processStream: async () => (++completion === 1
          ? {
              role: "assistant",
              tool_calls: [{ id: "coop-facet-tool-1", function: { name: "CooperativeFacetTool", arguments: "{}" } }],
            }
          : { role: "assistant", content: "done" }),
      },
    });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
      runtimeContext: { actorFacetRuntime: registry },
    });
    const fiberId = `${actor.key}:${actor.id}`;
    let execState: any;
    const step = () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor,
      messages: [],
      state: execState,
      setState: (next) => { execState = next; },
      resumeFiber: () => {},
    });
    actor.send("humanInput", "run");
    for (let index = 0; index < 40 && events.length < 5; index += 1) {
      await step();
      await flushMicrotasks();
    }

    expect(events).toEqual([
      "beforeTurn",
      "aroundProvider",
      "afterToolOutcome",
      "beforeTurn",
      "aroundProvider",
    ]);
    expect(actor.runtimeFacets[facetId]).toMatchObject({ revision: 3, value: { count: 3 } });
  });

  it("projects committed owner progress through the cooperative lifecycle hook", async () => {
    const output = JSON.stringify(withWorkflowDomainProgress({ ok: true }, {
      owner: "workflow.runtime",
      transition: "run_advanced",
      subjectId: "run-1",
      revision: "3",
    }));
    const tool: ToolDef<any, string, Record<string, unknown>> = {
      schema: {
        type: "function",
        function: { name: "CooperativeOwnerProgress", description: "test", parameters: { type: "object" } },
      },
      briefPromptXnl: `<tool name="CooperativeOwnerProgress" />`,
      run: async () => output,
    };
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(tool);
    let completion = 0;
    const actor = createActor({
      key: "cooperative-owner-progress",
      runtimeFacets: [{
        ...testWorkflowFacet({ maxNoProgressTurns: 4 }),
        value: { ...testWorkflowFacet({ maxNoProgressTurns: 4 }).value, turnsSinceProgress: 2 },
      }],
      llmClient: {
        type: "openai" as const,
        async createStream() {
          async function* stream() { yield { ok: true }; }
          return { stream: stream() };
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [tool.schema],
        processStream: async () => (++completion === 1
          ? {
              role: "assistant",
              tool_calls: [{ id: "coop-owner-progress-1", function: { name: "CooperativeOwnerProgress", arguments: "{}" } }],
            }
          : { role: "assistant", content: "done" }),
      },
    });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
      options: { exitAfterToolResult: true },
      runtimeContext: { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() },
    });
    const fiberId = `${actor.key}:${actor.id}`;
    let execState: any;
    const step = () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor,
      messages: [],
      state: execState,
      setState: (next) => { execState = next; },
      resumeFiber: () => {},
    });
    actor.send("humanInput", "run");
    for (let index = 0; index < 50; index += 1) {
      await step();
      await flushMicrotasks();
      if (readWorkflowLifecycleFacet(actor)?.lastOutcome === "running") break;
    }

    expect(readWorkflowLifecycleFacet(actor)).toMatchObject({
      turnsSinceProgress: 0,
      lastOutcome: "running",
    });
    expect(JSON.stringify(actor.runtimeFacets)).not.toContain(output);
  });

  it("suspends the interactive fiber after local projection rejection without assistant history", async () => {
    const mockAdapter = {
      type: "deepseek" as const,
      async createStream() {
        throw new ProviderRequestAdmissionError("invalid_provider_request_body", {
          path: "$/messages/4/internal",
          valueKind: "undefined",
        });
      },
    };
    const main = createActor({
      key: "main",
      llmClient: mockAdapter,
      modelConfig: { model: "mock", adapter: "deepseek" },
      callbacks: { buildToolset: () => [], processStream: async () => null },
    });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
      registries: { toolRegistry: new ToolFuncRegistry() },
    });
    const fiberId = `${main.key}:${main.id}`;
    let execState: any;
    const step = () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor: main,
      messages: [],
      state: execState,
      setState: (next) => { execState = next; },
      resumeFiber: () => {},
    });
    main.send("humanInput", "continue");
    let waiting: any;
    for (let index = 0; index < 10; index += 1) {
      waiting = await step();
      if (waiting.kind === "suspend" && waiting.reason === "wait_llm_result") break;
    }
    expect(waiting).toEqual({ kind: "suspend", reason: "wait_llm_result" });
    await flushMicrotasks();
    expect(await step()).toEqual({ kind: "suspend", reason: "idle_external" });
    const [record] = getVmProviderCallDomain(vm)?.getAllRecords() ?? [];
    expect(record).toMatchObject({
      status: "failed",
      failureKind: "local_projection_rejected",
      rawError: "invalid_provider_request_body",
    });
    expect(main.messages.some((message: any) =>
      message?.role === "assistant" && String(message?.content ?? "").includes("invalid_provider_request_body"),
    )).toBeFalse();
  });

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

    expect(result).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("empty assistant response"),
    });
    expect(processStreamCalls).toBe(2);
    expect(turnEnds).not.toContain("no_tool_calls");
    expect(turnEnds).toContain("provider_failed");
    const [record] = getVmProviderCallDomain(vm)?.getAllRecords() ?? [];
    expect(record?.status).toBe("failed");
    expect(record?.rawError).toContain("empty assistant response");
  });

  it("fails a delegate fiber when provider failure leaves no assistant outcome", async () => {
    const mockAdapter = {
      type: "openai" as const,
      async createStream() {
        async function* stream() { yield { ok: true }; }
        return { stream: stream() };
      },
    };
    const toolRegistry = new ToolFuncRegistry();
    const child = createActor({
      key: "workflow-child",
      type: "delegate",
      llmClient: mockAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: null }),
      },
    });
    const vm = createVM({ controlActorKey: child.key, actors: { [child.key]: child }, registries: { toolRegistry } });
    const fiberId = `${child.key}:${child.id}`;
    let execState: any;
    const step = async () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor: child,
      messages: [],
      state: execState,
      setState: (next) => { execState = next; },
      resumeFiber: () => {},
    });

    child.send("humanInput", "start");
    for (let i = 0; i < 10; i++) {
      const current = await step();
      if (current.kind === "suspend" && current.reason === "wait_llm_result") break;
    }
    await flushMicrotasks();
    expect(await step()).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("empty assistant response"),
    });
  });

  it("fails a delegate fiber when the current provider fails after prior assistant content", async () => {
    const mockAdapter = {
      type: "openai" as const,
      async createStream() {
        async function* stream() { yield { ok: true }; }
        return { stream: stream() };
      },
    };
    const toolRegistry = new ToolFuncRegistry();
    const child = createActor({
      key: "workflow-child-with-partial",
      type: "delegate",
      messages: [{ role: "assistant", content: "Capability confirmed; opening the workspace now." }],
      llmClient: mockAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => {
          throw new Error("invalid_tool_call_payload: invalid JSON arguments");
        },
      },
    });
    const vm = createVM({ controlActorKey: child.key, actors: { [child.key]: child }, registries: { toolRegistry } });
    const fiberId = `${child.key}:${child.id}`;
    let execState: any;
    const step = async () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor: child,
      messages: [...child.messages],
      state: execState,
      setState: (next) => { execState = next; },
      resumeFiber: () => {},
    });

    child.send("humanInput", "continue");
    for (let i = 0; i < 10; i++) {
      const current = await step();
      if (current.kind === "suspend" && current.reason === "wait_llm_result") break;
    }
    await flushMicrotasks();

    expect(await step()).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("invalid_tool_call_payload"),
    });
  });

  it("keeps provider failure terminal when a checkpoint completion loses its optional event field", async () => {
    const child = createActor({
      key: "workflow-child-checkpoint",
      type: "delegate",
      messages: [{ role: "assistant", content: "preparing workflow instance" }],
    });
    const toolRegistry = new ToolFuncRegistry();
    const vm = createVM({ controlActorKey: child.key, actors: { [child.key]: child }, registries: { toolRegistry } });
    const fiberId = `${child.key}:${child.id}`;
    const opId = `llm:${fiberId}:11`;
    let execState: any = {
      phase: "wait_llm",
      turn: 5,
      tools: [],
      toolCalls: [],
      toolIndex: 0,
      nextOpSeq: 12,
      pendingToolResults: [],
      pendingAiGenerated: [],
      providerFailure: {
        opId,
        error: "Error: invalid_tool_call_payload: invalid JSON arguments",
      },
      turnState: { kind: "wait_llm", turn: 5, opId, providerCallId: opId },
      inflight: { kind: "llm", opId, turn: 5, tools: [] },
      messageHistoryAttached: false,
    };
    child.send("asyncCompletion", {
      kind: "llm_done",
      opId,
      msg: { role: "assistant", content: "preparing workflow instance" },
    } as any);

    const result = await aiAgentCooperativeStep({
      fiberId,
      vm,
      actor: child,
      messages: [...child.messages],
      state: execState,
      setState: (next) => {
        execState = next;
      },
      resumeFiber: () => {},
    });

    expect(result).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("invalid_tool_call_payload"),
    });
  });

  it("fails a workflow delegate after the configured number of no-progress turns", async () => {
    const noProgressTool: ToolDef<any, string, Record<string, unknown>> = {
      schema: {
        type: "function",
        function: { name: "NoProgressTool", description: "test", parameters: { type: "object" } },
      },
      briefPromptXnl: `<tool name="NoProgressTool" />`,
      run: async () => "observed but unchanged",
    };
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register(noProgressTool as any);
    const child = createActor({
      key: "workflow-no-progress",
      type: "delegate",
      agentName: "workflow",
      systemPrompts: ["name: sys-eidolon-anchor-devops\nrevision: test-v1"],
      llmClient: {
        type: "openai" as const,
        async createStream() {
          async function* stream() { yield { ok: true }; }
          return { stream: stream() };
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [noProgressTool.schema],
        processStream: async () => ({
          role: "assistant",
          tool_calls: [{ id: "no-progress", function: { name: "NoProgressTool", arguments: "{}" } }],
        }),
      },
      runtimeFacets: [testWorkflowFacet({ maxNoProgressTurns: 1 })],
    });
    const vm = createVM({
      controlActorKey: child.key,
      actors: { [child.key]: child },
      registries: { toolRegistry },
      runtimeContext: { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() },
      outerCtx: { metadata: { aiWorkflow: { budget: { maxNoProgressTurns: 1 } } } },
    });
    const fiberId = `${child.key}:${child.id}`;
    let execState: any;
    const step = async () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor: child,
      messages: [],
      state: execState,
      setState: (next) => { execState = next; },
      resumeFiber: () => {},
    });

    child.send("humanInput", "start");
    let terminal: any;
    for (let index = 0; index < 30; index += 1) {
      terminal = await step();
      if (terminal.kind === "fail") break;
      await flushMicrotasks();
    }
    expect(terminal).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("workflow_no_progress"),
    });
  });

  it("fails a workflow delegate when its provider call crosses the stage deadline", async () => {
    const toolRegistry = new ToolFuncRegistry();
    const child = createActor({
      key: "workflow-deadline",
      type: "delegate",
      agentName: "workflow",
      systemPrompts: ["name: sys-eidolon-anchor-devops\nrevision: test-v1"],
      llmClient: {
        type: "openai" as const,
        async createStream() {
          async function* stream() { yield { ok: true }; }
          return { stream: stream() };
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => new Promise<never>(() => {}),
      },
      runtimeFacets: [testWorkflowFacet({ stageDeadlineMs: 5 })],
    });
    const vm = createVM({
      controlActorKey: child.key,
      actors: { [child.key]: child },
      registries: { toolRegistry },
      runtimeContext: { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() },
      outerCtx: { metadata: { aiWorkflow: { budget: { stageDeadlineMs: 5 } } } },
    });
    const fiberId = `${child.key}:${child.id}`;
    let execState: any;
    const step = async () => aiAgentCooperativeStep({
      fiberId,
      vm,
      actor: child,
      messages: [],
      state: execState,
      setState: (next) => { execState = next; },
      resumeFiber: () => {},
    });

    child.send("humanInput", "start");
    for (let index = 0; index < 10; index += 1) {
      const current = await step();
      if (current.kind === "suspend" && current.reason === "wait_llm_result") break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await flushMicrotasks();
    expect(await step()).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("workflow_stage_deadline"),
    });
  });
});
