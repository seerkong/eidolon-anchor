import { describe, expect, it } from "bun:test";

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

describe("Stage 3 cooperative questionnaire resume", () => {
  it("parses toolResult answer and appends tool message", async () => {
    const llmAdapter = {
      type: "openai" as const,
      async createStream(params: any) {
        const isParser = Array.isArray(params?.messages) && params.messages[0]?.role === "system";
        async function* stream() {
          if (isParser) {
            yield {
              choices: [
                {
                  delta: {
                    content: JSON.stringify({ status: "ok", answers: { q1: "hello" }, errors: [] }),
                  },
                },
              ],
            };
            return;
          }
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

    const actor = createActor({
      key: "main",
      llmClient: llmAdapter,
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
                  questionnaireId: "q-tc-1",
                  kind: "freeform",
                  suspendPolicy: "continue_others",
                  questions: [{ id: "q1", prompt: "Answer", type: "text", required: true }],
                }),
              },
            },
          ],
        }),
      },
    });

    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      registries: { toolRegistry },
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
      predicate: (f) => f.status === "suspended" && f.waitingReason === "human_answer",
    });

    // Provide answer.
    actor.send("toolResult", { toolCallId: "tc-1", questionnaireId: "q-tc-1", content: "hello" });
    driver.resumeFiber(fiberId, Date.now());
    await flushMicrotasks();

    await advanceUntil({
      driver,
      fiberId,
      predicate: () => messages.some((m) => m?.role === "tool" && m?.tool_call_id === "tc-1"),
    });

    const toolMsg = messages.find((m) => m?.role === "tool" && m?.tool_call_id === "tc-1");
    expect(toolMsg).toBeTruthy();
    expect(String(toolMsg.content)).toContain("\"status\":\"ok\"");
  });
});
