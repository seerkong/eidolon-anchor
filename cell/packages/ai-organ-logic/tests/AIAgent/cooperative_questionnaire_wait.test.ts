import { describe, expect, it } from "bun:test";

import { selectNextFiberId } from "depa-actor";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import type { ToolDef } from "@cell/ai-core-contract/types";
import { aiAgentCooperativeStep } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
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
  const max = typeof params.maxSteps === "number" && params.maxSteps > 0 ? params.maxSteps : 100;
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

describe("Stage 3 cooperative questionnaire wait", () => {
  it("suspends with human_answer + per-request continue_others policy", async () => {
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

    const main = createActor({
      key: "main",
      llmClient: mockAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [questionnaireTool.schema],
        processStream: async () => ({
          role: "assistant",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "Questionnaire",
                arguments: JSON.stringify({
                  questionnaireId: "q-1",
                  kind: "freeform",
                  suspendPolicy: "continue_others",
                  questions: [{ id: "q1", prompt: "Answer", type: "text" }],
                }),
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
      options: {
        agingStep: 0,
        defaultSuspendPolicy: "pause_all",
      },
    });

    main.send("humanInput", "start");

    await advanceUntil({
      driver,
      fiberId: mainFiberId,
      predicate: (fiber) => fiber.status === "suspended" && fiber.waitingReason === "human_answer",
    });

    const s1 = driver.getState();
    expect(s1.fibers[mainFiberId].status).toBe("suspended");
    expect(s1.fibers[mainFiberId].waitingReason).toBe("human_answer");
    expect(s1.fibers[mainFiberId].suspendPolicy).toBe("continue_others");

    // continue_others should not block other ready fibers.
    expect(selectNextFiberId(s1)).toBe(workerFiberId);
  });
});
