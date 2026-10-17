import { afterEach, describe, expect, it } from "bun:test";
import { AgentEventGraph, createActor, createVM } from "@cell/ai-core-logic";
import { ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { createAiAgentOrchestratorDriver, createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver";
import { createAiAgentRuntimeCoordinator } from "@cell/ai-organ-logic/runtime/AiAgentRuntimeCoordinator";
import { createInteractiveActor } from "@cell/ai-organ-logic/runtime/InteractiveActor";
import { processRuntimeIngressStream } from "@cell/ai-organ-logic/runtime/ShellRuntimeSupport";
import { createMockProviderCacheCostObservation } from "../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream";
import { projectInputContentText } from "@shared/composer";
import { evaluateAiAgentRuntimeSnapshotSafepoint } from "../../cell/packages/ai-runtime-control-logic/src/index";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  if (!predicate()) throw new Error(`Timed out: ${message}`);
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function realRuntime(interactiveCapacity?: Parameters<typeof createAiAgentRuntimeCoordinator>[0]["interactiveCapacity"]) {
  const eventBus = new AgentEventGraph();
  const started: string[] = [];
  const aborted: string[] = [];
  const abortCleanup = new Map<string, ReturnType<typeof deferred>>();
  const barriers = new Map<string, ReturnType<typeof deferred>>();
  const barrier = (text: string) => {
    if (!barriers.has(text)) barriers.set(text, deferred());
    return barriers.get(text)!;
  };
  const provider = {
    type: "openai",
    runtime: { adapterName: "openai", providerId: "interactive-test" },
    async createStream(options: any) {
      const input = options.messages.filter((message: any) => message.role === "user").at(-1);
      const text = projectInputContentText(input.content);
      started.push(text);
      async function* chunks() {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            aborted.push(text);
            const cleanup = abortCleanup.get(text);
            if (cleanup) void cleanup.promise.then(() => reject(new Error("cancelled")));
            else reject(new Error("cancelled"));
          };
          if (options.signal?.aborted) return abort();
          options.signal?.addEventListener("abort", abort, { once: true });
          void barrier(text).promise.then(() => {
            options.signal?.removeEventListener("abort", abort);
            resolve();
          });
        });
        yield { choices: [{ delta: { content: `reply:${text}` } }] };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      }
      return { stream: chunks(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) };
    },
  };
  const callbacks = {
    buildToolset: () => [],
    processStream: (_vm: any, actor: any, stream: any, options?: any) => processRuntimeIngressStream({
      stream, adapterType: "openai", eventBus,
      actorMeta: { agentKey: actor.key, agentActorId: actor.id },
      sessionId: "interactive-barriers", storageLogsEnabled: false, signal: options?.signal,
    }),
  };
  const main = createActor({ key: "main" });
  const vm = createVM({ controlActorKey: main.key, actors: { main }, eventBus,
    registries: { toolRegistry: new ToolFuncRegistry() }, options: { storage: { files: false, logs: false } },
    outerCtx: { metadata: { sessionId: "interactive-barriers" } },
  });
  const driver = createAiAgentOrchestratorDriverWithCooperative({
    fibers: [{ fiberId: "main", vm, actor: main, messages: [], basePriority: 1 }],
    options: { defaultSuspendPolicy: "continue_others", agingStep: 0 },
  });
  driver.suspendFiber("main", Date.now(), "idle_external" as any, "continue_others");
  let nextActorId = 0;
  const create = () => createInteractiveActor({ vm, driver, newId: () => `test-${++nextActorId}`, now: Date.now }, {
    llmClient: provider, callbacks, modelConfig: { model: "controlled", provider: "interactive-test", adapter: "openai" },
  });
  const coordinator = createAiAgentRuntimeCoordinator({ vm, driver, interactiveCapacity });
  cleanups.push(() => { for (const gate of [...barriers.values(), ...abortCleanup.values()]) gate.resolve(); coordinator.dispose(); eventBus.dispose(); });
  let turnSequence = 0;
  const send = (target: ReturnType<typeof create>, text: string) => {
    const turnId = `turn-${++turnSequence}`;
    return coordinator.admitInteractiveTurn({ actorId: target.actor.id, mainFiberId: target.fiberId, turnId,
      deliver: (signal) => {
        signal.throwIfAborted();
        driver.emitFiberSignal({ fiberId: target.fiberId, signalKind: "mailbox_enqueue",
          mailbox: { kind: "humanInput", payload: text }, idempotencyKey: turnId });
      },
    });
  };
  return { vm, driver, coordinator, create, send, started, aborted, release: (text: string) => barrier(text).resolve(),
    delayAbortCleanup: (text: string) => { const gate = deferred(); abortCleanup.set(text, gate); return gate.resolve; },
  };
}

describe("ordinary interactive actors on the real cooperative runtime", () => {
  it("starts A and B before either provider releases and lets C finish independently", async () => {
    const runtime = realRuntime();
    const [a, b, c] = [runtime.create(), runtime.create(), runtime.create()];
    const aTurn = runtime.send(a, "A");
    const bTurn = runtime.send(b, "B");
    await until(() => runtime.started.includes("A") && runtime.started.includes("B"), "both provider barriers");
    expect(runtime.vm.sessionState.memberRoster).toEqual({});
    expect(runtime.vm.sessionState.holons).toEqual({});
    expect([a.actor.type, b.actor.type, c.actor.type]).toEqual(["interactive", "interactive", "interactive"]);
    const cTurn = runtime.send(c, "C");
    runtime.release("C");
    expect((await cTurn.settled).status).toBe("settled");
    expect(runtime.coordinator.readInteractiveTurns().find((turn) => turn.turnId === aTurn.turnId)?.state).toBe("running");
    expect(c.actor.messages.map((message) => message.content)).toContain("reply:C");
    runtime.release("B");
    expect(await bTurn.settled).toEqual({ status: "settled", safepointSafe: false });
    runtime.release("A");
    expect((await aTurn.settled).status).toBe("settled");
    expect(a.actor.messages.map((message) => message.content)).not.toContain("reply:B");
  });

  it("keeps a second input out of the mailbox until the first turn settles", async () => {
    const runtime = realRuntime();
    const a = runtime.create();
    const first = runtime.send(a, "first");
    const second = runtime.send(a, "second");
    await until(() => runtime.started.includes("first"), "first starts");
    expect(runtime.started).toEqual(["first"]);
    expect(a.actor.peekMailbox("humanInput")).toEqual([]);
    expect(runtime.coordinator.readInteractiveTurns().find((turn) => turn.turnId === second.turnId)?.state).toBe("queued");
    runtime.release("first");
    await first.settled;
    await until(() => runtime.started.includes("second"), "second starts after first");
    runtime.release("second");
    await second.settled;
    expect(a.actor.messages.filter((message) => message.role === "user").map((message) => projectInputContentText(message.content))).toEqual(["first", "second"]);
  });

  it("cancels only the addressed active turn and retains that actor's queued turn", async () => {
    const runtime = realRuntime();
    const a = runtime.create();
    const b = runtime.create();
    const first = runtime.send(a, "cancel-A");
    const next = runtime.send(a, "next-A");
    const other = runtime.send(b, "keep-B");
    await until(() => runtime.started.includes("cancel-A") && runtime.started.includes("keep-B"), "both start");
    expect(runtime.coordinator.cancelInteractiveTurn({ actorId: b.actor.id, turnId: first.turnId }).status).toBe("not_found");
    expect(runtime.coordinator.cancelInteractiveTurn({ actorId: a.actor.id, turnId: first.turnId }).status).toBe("cancel_requested");
    expect((await first.settled).status).toBe("cancelled");
    await until(() => runtime.started.includes("next-A"), "queued A proceeds");
    expect(runtime.aborted).toEqual(["cancel-A"]);
    expect(runtime.coordinator.cancelInteractiveTurn({ actorId: a.actor.id, turnId: first.turnId }).status).toBe("already_terminal");
    runtime.release("next-A"); runtime.release("keep-B");
    expect((await next.settled).status).toBe("settled");
    expect((await other.settled).status).toBe("settled");
  });

  it("cancels a queued turn without delivering and handles a rejected asynchronous admission", async () => {
    const runtime = realRuntime();
    const a = runtime.create();
    const active = runtime.send(a, "active");
    const queued = runtime.send(a, "must-not-send");
    expect(runtime.coordinator.cancelInteractiveTurn({ actorId: a.actor.id, turnId: queued.turnId }).status).toBe("cancelled_before_delivery");
    expect((await queued.settled).status).toBe("cancelled");
    const b = runtime.create();
    const broken = runtime.coordinator.admitInteractiveTurn({ actorId: b.actor.id, mainFiberId: b.fiberId, turnId: "broken",
      deliver: async () => { throw new Error("storage unavailable"); },
    });
    expect((await broken.settled).status).toBe("failed");
    expect(runtime.started).not.toContain("must-not-send");
    runtime.release("active");
    await active.settled;
  });
});

it("bounds admissions atomically and forgets only terminal turns", async () => {
  const runtime = realRuntime({ maxOutstandingTurns: 3, maxQueuedTurnsPerActor: 1 });
  const a = runtime.create(), b = runtime.create();
  const first = runtime.send(a, "capacity-first");
  expect(() => runtime.send(a, "capacity-rejected")).toThrow("runtime_actor_turn_capacity");
  await until(() => runtime.started.includes("capacity-first"), "first delivered");
  const next = runtime.send(a, "capacity-next");
  const other = runtime.send(b, "capacity-other");
  expect(() => runtime.send(runtime.create(), "capacity-overflow")).toThrow("runtime_session_turn_capacity");
  expect(runtime.coordinator.forgetInteractiveTurn({ actorId: a.actor.id, turnId: first.turnId })).toBe(false);
  runtime.release("capacity-first");
  await first.settled;
  expect(runtime.coordinator.forgetInteractiveTurn({ actorId: b.actor.id, turnId: first.turnId })).toBe(false);
  expect(runtime.coordinator.forgetInteractiveTurn({ actorId: a.actor.id, turnId: first.turnId })).toBe(true);
  runtime.release("capacity-next"); runtime.release("capacity-other");
  await Promise.all([next.settled, other.settled]);
});

it("holds the actor queue until cancelled asynchronous delivery actually cleans up", async () => {
  const runtime = realRuntime();
  const a = runtime.create();
  const cleanup = deferred();
  let preparationStarted = false;
  let aborted = false;
  const first = runtime.coordinator.admitInteractiveTurn({
    actorId: a.actor.id, mainFiberId: a.fiberId, turnId: "slow-delivery",
    deliver: async (signal) => {
      preparationStarted = true;
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      await cleanup.promise;
      signal.throwIfAborted();
    },
  });
  const next = runtime.send(a, "after-cleanup");
  await until(() => preparationStarted, "preparation starts");
  runtime.coordinator.cancelInteractiveTurn({ actorId: a.actor.id, turnId: first.turnId });
  expect(aborted).toBe(true);
  expect(runtime.coordinator.readInteractiveTurns().find((turn) => turn.turnId === next.turnId)?.state).toBe("queued");
  expect(runtime.coordinator.readInteractiveTurns().find((turn) => turn.turnId === first.turnId)?.state).toBe("running");
  cleanup.resolve();
  expect((await first.settled).status).toBe("cancelled");
  await until(() => runtime.started.includes("after-cleanup"), "queue releases after cleanup");
  runtime.release("after-cleanup");
  await next.settled;
});

it("waits for real provider cleanup after abort before settling or starting the next human", async () => {
  const runtime = realRuntime();
  const a = runtime.create(), b = runtime.create();
  const finishCleanup = runtime.delayAbortCleanup("slow-abort");
  const first = runtime.send(a, "slow-abort");
  const next = runtime.send(a, "after-abort");
  await until(() => runtime.started.includes("slow-abort"), "provider starts");
  runtime.coordinator.cancelInteractiveTurn({ actorId: a.actor.id, turnId: first.turnId });
  await until(() => runtime.aborted.includes("slow-abort"), "provider receives abort");
  const other = runtime.send(b, "during-cleanup");
  runtime.release("during-cleanup");
  await other.settled;
  expect(runtime.coordinator.readInteractiveTurns().find((turn) => turn.turnId === first.turnId)?.state).toBe("running");
  expect(evaluateAiAgentRuntimeSnapshotSafepoint({ vm: runtime.vm, inspected: runtime.driver.inspectRuntime() }).safe).toBe(false);
  expect(runtime.started).not.toContain("after-abort");
  finishCleanup();
  expect((await first.settled).status).toBe("cancelled");
  await until(() => runtime.started.includes("after-abort"), "queue resumes after transport cleanup");
  runtime.release("after-abort");
  await next.settled;
});

it("shutdown rejects new admission and awaits actual provider and detached task cleanup", async () => {
  const runtime = realRuntime();
  const actor = runtime.create();
  const finishCleanup = runtime.delayAbortCleanup("shutdown");
  const first = runtime.send(actor, "shutdown");
  const queued = runtime.send(actor, "must-not-start");
  await until(() => runtime.started.includes("shutdown"), "provider starts");
  const detached = deferred();
  ensureVmRuntimeContext(runtime.vm).actorOrchestrators[actor.actor.id]!.registerBackgroundTask!(detached.promise);
  let closed = false;
  const closing = runtime.coordinator.shutdown().then(() => { closed = true; });
  expect(() => runtime.send(actor, "after-close")).toThrow("runtime_coordinator_disposed");
  await until(() => runtime.aborted.includes("shutdown"), "close aborts provider");
  expect(closed).toBe(false);
  expect((await queued.settled).status).toBe("cancelled");
  finishCleanup();
  expect((await first.settled).status).toBe("cancelled");
  await Bun.sleep(10);
  expect(closed).toBe(false);
  detached.resolve();
  await closing;
  expect(closed).toBe(true);
  expect(runtime.started).not.toContain("must-not-start");
});

describe("independent turn human wait boundaries", () => {
  it("does not lose an answer delivered while the human wait step is still installing", async () => {
    const main = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: main.key, actors: { main }, options: { storage: { files: false, logs: false } } });
    const published = deferred(), installWait = deferred();
    let steps = 0, answered = false;
    const driver = createAiAgentOrchestratorDriver({ fibers: [], runStep: async ({ actor }) => {
      steps++;
      actor.drainMailbox("humanInput");
      if (steps === 1) {
        published.resolve(); await installWait.promise;
        return { kind: "suspend", reason: "human_answer" as any, suspendPolicy: "continue_others" };
      }
      answered = actor.drainMailbox("toolResult").length > 0;
      return { kind: "suspend", reason: "idle_external" as any, suspendPolicy: "continue_others" };
    } });
    const target = createInteractiveActor({ vm, driver, newId: () => "early-answer", now: Date.now }, {});
    const coordinator = createAiAgentRuntimeCoordinator({ vm, driver });
    cleanups.push(() => { installWait.resolve(); coordinator.dispose(); });
    const turn = coordinator.admitInteractiveTurn({ actorId: target.actor.id, mainFiberId: target.fiberId, turnId: "early-answer-turn",
      deliver: () => { driver.emitFiberSignal({ fiberId: target.fiberId, signalKind: "mailbox_enqueue", mailbox: { kind: "humanInput", payload: "question" }, idempotencyKey: "question" }); },
    });
    await published.promise;
    driver.emitFiberSignal({ fiberId: target.fiberId, signalKind: "mailbox_enqueue", mailbox: { kind: "toolResult", payload: { toolCallId: "question-tool", content: "answer" } }, idempotencyKey: "early-answer" });
    coordinator.resumeInteractiveTurn({ actorId: target.actor.id, turnId: turn.turnId });
    installWait.resolve();
    await until(() => answered, "early answer is consumed by the same turn");
    expect((await turn.settled).status).toBe("settled");
    expect(steps).toBe(2);
  });

  it("keeps A waiting and queued while B runs, then resumes the same turn", async () => {
    const main = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: main.key, actors: { main }, options: { storage: { files: false, logs: false } } });
    const observed: string[] = [];
    let answered = false;
    const driver = createAiAgentOrchestratorDriver({ fibers: [], runStep: async ({ actor }) => {
      for (const input of actor.drainMailbox("humanInput")) observed.push(String(input));
      return actor.agentName === "A" && !answered
        ? { kind: "suspend", reason: "human_answer" as any, suspendPolicy: "pause_all" }
        : { kind: "suspend", reason: "idle_external" as any, suspendPolicy: "continue_others" };
    } });
    let id = 0;
    const make = (displayName: string) => createInteractiveActor({ vm, driver, newId: () => `q-${++id}`, now: Date.now }, { displayName });
    const a = make("A"), b = make("B");
    const coordinator = createAiAgentRuntimeCoordinator({ vm, driver });
    cleanups.push(() => coordinator.dispose());
    const send = (target: typeof a, text: string) => coordinator.admitInteractiveTurn({
      actorId: target.actor.id, mainFiberId: target.fiberId, turnId: text,
      deliver: () => { driver.emitFiberSignal({ fiberId: target.fiberId, signalKind: "mailbox_enqueue", mailbox: { kind: "humanInput", payload: text }, idempotencyKey: text }); },
    });
    const first = send(a, "question");
    const queued = send(a, "later");
    await until(() => coordinator.readInteractiveTurns().find((turn) => turn.turnId === "question")?.state === "waiting_input", "question waits");
    const other = send(b, "B-while-A-waits");
    expect((await other.settled).status).toBe("settled");
    expect(observed).toEqual(["question", "B-while-A-waits"]);
    answered = true;
    expect(coordinator.resumeInteractiveTurn({ actorId: b.actor.id, turnId: first.turnId })).toBe(false);
    expect(coordinator.resumeInteractiveTurn({ actorId: a.actor.id, turnId: first.turnId })).toBe(true);
    await first.settled;
    await queued.settled;
    expect(observed).toEqual(["question", "B-while-A-waits", "later"]);
  });
});
