import { describe, expect, it } from "bun:test";

import { selectNextFiberId } from "depa-actor";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM, ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime";
import {
  createAiAgentOrchestratorDriver,
  createAiAgentOrchestratorDriverWithCooperative,
} from "@cell/ai-organ-logic/OrchestratorDriver";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import type { ToolDef } from "@cell/ai-core-contract/types";

async function flushMicrotasks(): Promise<void> {
  // ActorSystem drains mailboxes via queueMicrotask; allow a few turns.
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

describe("AiAgentOrchestratorDriver", () => {
  it("mounts vm runtime context through the vendor actor runtime facet", () => {
    const main = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
    });

    const runtimeContext = ensureVmRuntimeContext(vm);
    const facet = vm.actorRuntime.getFacet<typeof runtimeContext>("cell.vm.runtimeContext");
    let settled: { status: string; resultText: string | null } | null = null;

    runtimeContext.autonomousHolonTaskSignals.subscribe("task-1", (result) => {
      settled = result;
    });
    runtimeContext.autonomousHolonTaskSignals.resolve("task-1", {
      status: "completed",
      resultText: "ok",
    });

    expect(facet).toBe(runtimeContext);
    expect(settled).toEqual({ status: "completed", resultText: "ok" });
  });

  it("mounts orchestrator fiber contexts through the vendor runtime index hook", () => {
    const main = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
    });

    const fiberId = `${main.key}:${main.id}`;
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor: main, messages: [], basePriority: 1 }],
      runStep: async () => ({ kind: "complete" }),
    });

    const fiberIndex = driver.actorRuntime.getFacet<{
      get: (key: string) => { fiberId: string } | undefined;
      snapshot: () => Record<string, { fiberId: string }>;
    }>("cell.orchestrator.fiberIndex");

    expect(fiberIndex?.get(fiberId)?.fiberId).toBe(fiberId);
    expect(Object.keys(fiberIndex?.snapshot() ?? {})).toContain(fiberId);
  });

  it("schedules a ready fiber when a wake mailbox signal is emitted", async () => {
    const main = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
    });
    const fiberId = `${main.key}:${main.id}`;
    let invocations = 0;

    // P7: actor.messages is a read-only projection; this scripted runStep
    // collects drained inputs into its own working array.
    const drainedInputs: any[] = [];
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor: main, messages: drainedInputs, basePriority: 1 }],
      runStep: async (ctx) => {
        invocations += 1;
        for (const payload of ctx.actor.drainMailbox("humanInput")) {
          drainedInputs.push({ role: "user", content: String(payload) } as any);
        }
        return { kind: "suspend", reason: "idle_external" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.emitFiberSignal({
      fiberId,
      signalKind: "mailbox_enqueue",
      mailbox: { kind: "humanInput", payload: "continue" },
      idempotencyKey: `${fiberId}:humanInput:test-ready`,
      createdAt: 1,
    });

    await driver.tickUntilForegroundSettled({ now: 2, maxTicks: 10, maxWallMs: 500 });
    await flushMicrotasks();

    expect(invocations).toBe(1);
    expect(main.peekMailbox("humanInput")).toEqual([]);
    expect(drainedInputs).toContainEqual(expect.objectContaining({ role: "user", content: "continue" }));
    expect(driver.getState().fibers[fiberId].status).toBe("suspended");
  });

  it("waits for registered foreground async completion before foreground settle returns", async () => {
    const main = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
    });
    const fiberId = `${main.key}:${main.id}`;
    let invocations = 0;
    let taskStarted = false;

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{
        fiberId,
        vm,
        actor: main,
        messages: main.messages,
        basePriority: 1,
        execState: { phase: "wait_llm", inflight: { kind: "llm", opId: "llm:late" } },
      } as any],
      runStep: async (ctx, helpers) => {
        invocations += 1;
        if (ctx.actor.peekMailbox("asyncCompletion").length === 0) {
          if (!taskStarted) {
            taskStarted = true;
            ensureVmRuntimeContext(ctx.vm).currentOrchestrator?.registerBackgroundTask?.(
              new Promise<void>((resolve) => {
                setTimeout(() => {
                  helpers.emitFiberSignal({
                    fiberId,
                    signalKind: "async_completed",
                    mailbox: { kind: "asyncCompletion", payload: { kind: "llm_done", opId: "llm:late" } as any },
                    opId: "llm:late",
                    idempotencyKey: `${fiberId}:llm:late:asyncCompletion`,
                  });
                  resolve();
                }, 30);
              }),
            );
          }
          return { kind: "suspend", reason: "wait_llm_result" };
        }
        ctx.actor.drainMailbox("asyncCompletion");
        ctx.execState = { phase: "drain" };
        return { kind: "suspend", reason: "idle_external" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const startedAt = Date.now();
    await driver.tickUntilForegroundSettled({ now: 1, maxTicks: 10, maxWallMs: 500 });
    const elapsed = Date.now() - startedAt;

    expect(invocations).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(main.peekMailbox("asyncCompletion")).toEqual([]);
    expect(driver.getState().fibers[fiberId].status).toBe("suspended");
    expect(driver.inspectRuntime().fibers[fiberId]?.execState?.phase).toBe("drain");
  });

  it("persists per-fiber human suspend policy", async () => {
    const mockAdapter = {
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { ok: true };
        }
        return { stream: stream() };
      },
    };

    const main = createActor({
      key: "main",
      llmClient: mockAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({
          role: "assistant",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "Questionnaire",
                arguments: JSON.stringify({
                  questionnaireId: "q-1",
                  kind: "approval",
                  suspendPolicy: "pause_all",
                  questions: [{ id: "q1", prompt: "Proceed?", type: "yes_no" }],
                }),
              },
            },
          ],
        }),
      },
    });

    const toolRegistry = new ToolFuncRegistry();
    const questionnaireTool: ToolDef<any, string, Record<string, unknown>> = {
      schema: {
        type: "function",
        function: { name: "Questionnaire", description: "test", parameters: { type: "object" } },
      },
      briefPromptXnl: `<tool name="Questionnaire" />`,
      run: async (runtime: any, input: any) => {
        const toolCallId = String(runtime?.toolCallId ?? "");
        const questionnaireId = typeof input?.questionnaireId === "string" ? input.questionnaireId : toolCallId ? `q-${toolCallId}` : `q-${Date.now()}`;
        const payload: any = {
          questionnaireId,
          toolCallId: toolCallId || questionnaireId,
          kind: input?.kind ?? "freeform",
          title: input?.title,
          intro: input?.intro,
          suspendPolicy: input?.suspendPolicy === "continue_others" ? "continue_others" : "pause_all",
          questions: Array.isArray(input?.questions) && input.questions.length ? input.questions : [{ id: "q1", prompt: "User input required", type: "text" }],
        };
        runtime.actor.pendingQuestionnaires[questionnaireId] = payload;
        runtime.actor.send("control", {
          kind: "questionnaire_pending",
          toolCallId: payload.toolCallId,
          questionnaireId: payload.questionnaireId,
          suspendPolicy: payload.suspendPolicy,
        });
        runtime.vm.eventBus?.emitQuestionnaireRequest({ key: runtime.actor.key, id: runtime.actor.id }, payload);
        return "";
      },
    };
    toolRegistry.register(questionnaireTool as any);

    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
      registries: { toolRegistry },
    });

    const mainFiberId = `${main.key}:${main.id}`;

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: main, messages: [], basePriority: 1 }],
      options: {
        defaultSuspendPolicy: "continue_others",
        agingStep: 0,
      },
    });

    const now = Date.now();
    main.send("humanInput", "start");
    driver.resumeFiber(mainFiberId, now);

    for (let i = 0; i < 50; i += 1) {
      const current = driver.getState().fibers[mainFiberId]
      if (current?.status === "suspended" && current?.waitingReason === "human_approval") {
        break
      }
      await driver.tickUntilBlocked({ now: Date.now(), maxTicks: 10, maxWallMs: 250 })
      await flushMicrotasks()
    }

    const s = driver.getState();
    expect(s.fibers[mainFiberId].status).toBe("suspended");
    expect(s.fibers[mainFiberId].waitingReason).toBe("human_approval");
    expect(s.fibers[mainFiberId].suspendPolicy).toBe("pause_all");
  });

  it("maps questionnaire_wait to human wait + pause_all gating", async () => {
    const main = createActor({ key: "main" });
    const worker = createActor({ key: "worker" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main, worker },
    });

    const mainFiberId = `${main.key}:${main.id}`;
    const workerFiberId = `${worker.key}:${worker.id}`;

    let mainInvocations = 0;
    const driver = createAiAgentOrchestratorDriver({
      fibers: [
        { fiberId: mainFiberId, vm, actor: main, messages: [], basePriority: 1 },
        { fiberId: workerFiberId, vm, actor: worker, messages: [], basePriority: 2 },
      ],
      runStep: async (ctx, _helpers) => {
        if (ctx.fiberId === mainFiberId) {
          mainInvocations += 1;
          if (mainInvocations === 1) {
            ctx.actor.pendingQuestionnaires["q-1"] = {
              questionnaireId: "q-1",
              toolCallId: "tc-1",
              kind: "approval",
              suspendPolicy: "pause_all",
              questions: [{ id: "q1", prompt: "Proceed?", type: "yes_no" }],
            };
            ctx.actor.send("control", {
              kind: "questionnaire_pending",
              toolCallId: "tc-1",
              questionnaireId: "q-1",
              suspendPolicy: "pause_all",
            });
            return { kind: "suspend", reason: "human_approval", suspendPolicy: "pause_all" };
          }
          return { kind: "complete" };
        }
        return { kind: "complete" };
      },
      options: {
        // Ensure mixed per-fiber policy is exercised.
        defaultSuspendPolicy: "continue_others",
        agingStep: 0,
      },
    });

    driver.tick(0);
    await flushMicrotasks();

    const s1 = driver.getState();
    expect(s1.fibers[mainFiberId].status).toBe("suspended");
    expect(s1.fibers[mainFiberId].waitingReason).toBe("human_approval");
    expect(s1.fibers[mainFiberId].suspendPolicy).toBe("pause_all");

    // pause_all gating blocks all other ready fibers.
    expect(s1.fibers[workerFiberId].status).toBe("ready");
    expect(selectNextFiberId(s1)).toBeUndefined();

    // Resume main and allow it to complete on next step.
    driver.resumeFiber(mainFiberId, 1);
    await flushMicrotasks();
    driver.tick(2);
    await flushMicrotasks();

    const s2 = driver.getState();
    expect(s2.fibers[mainFiberId].status).toBe("completed");
  });

  it("allows other fibers to run when human wait policy is continue_others", async () => {
    const main = createActor({ key: "main" });
    const worker = createActor({ key: "worker" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main, worker },
    });

    const mainFiberId = `${main.key}:${main.id}`;
    const workerFiberId = `${worker.key}:${worker.id}`;

    const driver = createAiAgentOrchestratorDriver({
      fibers: [
        { fiberId: mainFiberId, vm, actor: main, messages: [], basePriority: 1 },
        { fiberId: workerFiberId, vm, actor: worker, messages: [], basePriority: 2 },
      ],
      runStep: async (ctx, _helpers) => {
        if (ctx.fiberId === mainFiberId) {
          ctx.actor.pendingQuestionnaires["q-1"] = {
            questionnaireId: "q-1",
            toolCallId: "tc-1",
            kind: "freeform",
            suspendPolicy: "continue_others",
            questions: [{ id: "q1", prompt: "Answer", type: "text" }],
          };
          ctx.actor.send("control", {
            kind: "questionnaire_pending",
            toolCallId: "tc-1",
            questionnaireId: "q-1",
            suspendPolicy: "continue_others",
          });
          return { kind: "suspend", reason: "human_answer", suspendPolicy: "continue_others" };
        }
        return { kind: "complete" };
      },
      options: {
        defaultSuspendPolicy: "continue_others",
        agingStep: 0,
      },
    });

    driver.tick(0);
    await flushMicrotasks();

    const s1 = driver.getState();
    expect(s1.fibers[mainFiberId].status).toBe("suspended");
    expect(s1.fibers[mainFiberId].waitingReason).toBe("human_answer");
    expect(s1.fibers[mainFiberId].suspendPolicy).toBe("continue_others");

    // continue_others does not block other ready fibers.
    expect(selectNextFiberId(s1)).toBe(workerFiberId);

    driver.tick(1);
    await flushMicrotasks();

    const s2 = driver.getState();
    expect(s2.fibers[workerFiberId].status).toBe("completed");
  });
});
