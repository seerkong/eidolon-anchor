import { describe, expect, it } from "bun:test";

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver";
import { createMockProcessStream } from "./__test_support__/mockProcessStream";
import { projectInputContentText } from "@shared/composer";

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

describe("Stage 2: delegate actor childDone injection", () => {
  it("sync_wait: parent waits for child_done, resumes, and receives tool result injection", async () => {
    const adapter = makeMockAdapter();

    const callCount: Record<string, number> = {};
    const processStream = async (_vm: any, actor: any) => {
      const key = String(actor.key);
      callCount[key] = (callCount[key] ?? 0) + 1;
      const n = callCount[key];

      if (actor.type === "delegate") {
        return { role: "assistant", content: "child result" };
      }

      if (n === 1) {
        return {
          role: "assistant",
          tool_calls: [
            {
              id: "tc-sub-1",
              function: {
                name: "RunDelegateActor",
                arguments: JSON.stringify({
                  description: "do subtask",
                  prompt: "please do it",
                  agent_type: "code",
                  mode: "sync_wait",
                }),
              },
            },
          ],
        };
      }

      return { role: "assistant", content: "parent done" };
    };

    const main = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async (vm, actor) => processStream(vm, actor)),
      },
    });

    const toolRegistry = composeToolRegistry();
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

    const messages: any[] = [{ role: "user", content: "hi" }];
    const mainFiberId = `${main.key}:${main.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: main, messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const now = Date.now();
    driver.resumeFiber(mainFiberId, now);
    await driver.tickUntilBlocked({ now, maxTicks: 50, maxWallMs: 2000 });
    await flushMicrotasks();

    // Parent should have received the delegate actor completion as a tool message.
    const toolMsgs = main.messages.filter((m: any) => m?.role === "tool" && (m?.tool_call_id ?? m?.toolCallId) === "tc-sub-1");
    expect(toolMsgs).toHaveLength(1);
    expect(String(toolMsgs[0].content)).toBe("child result");

    const parentDone = main.messages.find((m: any) => m?.role === "assistant" && m?.content === "parent done");
    expect(parentDone).toBeTruthy();

    // The child fiber exists and is completed.
    const state = driver.getState();
    const childFiber = Object.values(state.fibers).find((f) => f.parentId === mainFiberId);
    expect(childFiber).toBeTruthy();
    expect((childFiber as any).status).toBe("completed");
  });

  it("sync_wait: provider failure becomes one non-empty error tool result on the parent", async () => {
    const adapter = makeMockAdapter();
    let parentTurns = 0;
    const processStream = async (_vm: any, actor: any) => {
      if (actor.type === "delegate") {
        throw new Error("invalid_tool_call_payload: invalid JSON arguments");
      }
      parentTurns += 1;
      if (parentTurns === 1) {
        return {
          role: "assistant",
          tool_calls: [{
            id: "tc-sub-failed",
            function: {
              name: "RunDelegateActor",
              arguments: JSON.stringify({
                description: "fail inside provider",
                prompt: "continue",
                agent_type: "code",
                mode: "sync_wait",
              }),
            },
          }],
        };
      }
      return { role: "assistant", content: "parent observed failure" };
    };
    const main = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async (vm, actor) => processStream(vm, actor)),
      },
    });
    const toolRegistry = composeToolRegistry();
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: {
            name: "code",
            description: "test failing delegate",
            tools: "*",
            prompt: ["you are a failing delegate actor"],
          },
        } as any),
      },
    });
    const semanticResults: any[] = [];
    vm.eventBus?.addConsumer((event: any) => {
      if (event?.event_type === "semantic_tool_call_result") semanticResults.push(event);
    });
    const mainFiberId = `${main.key}:${main.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: main, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.resumeFiber(mainFiberId, Date.now());
    await driver.tickUntilBlocked({ now: Date.now(), maxTicks: 80, maxWallMs: 3000 });
    await flushMicrotasks();

    const toolMsgs = main.messages.filter((message: any) =>
      message?.role === "tool" && (message?.tool_call_id ?? message?.toolCallId) === "tc-sub-failed");
    expect(toolMsgs).toHaveLength(1);
    expect(String(toolMsgs[0]?.content ?? "")).toContain("invalid_tool_call_payload");
    const matchingResult = semanticResults.find((event) => event?.tool_call?.tool_call_id === "tc-sub-failed");
    expect(matchingResult).toMatchObject({
      is_error: true,
      output_text: expect.stringContaining("invalid_tool_call_payload"),
      tool_call: { tool_name: "RunDelegateActor" },
    });
  });

  it("detached: parent does not wait, but childDone is processed before next user input", async () => {
    const adapter = makeMockAdapter();

    const callCount: Record<string, number> = {};
    const processStream = async (_vm: any, actor: any) => {
      const key = String(actor.key);
      callCount[key] = (callCount[key] ?? 0) + 1;
      const n = callCount[key];

      if (actor.type === "delegate") {
        return { role: "assistant", content: "child result" };
      }

      if (n === 1) {
        return {
          role: "assistant",
          tool_calls: [
            {
                id: "tc-sub-detached",
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

      // end the parent loop quickly
      return { role: "assistant", content: "parent idle" };
    };

    const main = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async (vm, actor) => processStream(vm, actor)),
      },
    });

    const toolRegistry = composeToolRegistry();
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

    const messages: any[] = [{ role: "user", content: "hi" }];
    const mainFiberId = `${main.key}:${main.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: main, messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const now = Date.now();
    driver.resumeFiber(mainFiberId, now);
    await driver.tickUntilBlocked({ now, maxTicks: 50, maxWallMs: 2000 });
    await flushMicrotasks();

    // ChildDone should be queued on the parent actor.
    expect(main.hasPending("childDone")).toBe(true);

    // Next user input should cause the parent to drain childDone before humanInput.
    main.send("humanInput", "next");
    driver.resumeFiber(mainFiberId, Date.now());
    await driver.tickUntilBlocked({ now: Date.now(), maxTicks: 20, maxWallMs: 2000 });
    await flushMicrotasks();

    const idxChild = main.messages.findIndex((m: any) => m?.role === "assistant" && String(m?.content ?? "").includes("Delegate actor"));
    const idxUser = main.messages.findIndex((m: any) => m?.role === "user" && projectInputContentText(m?.content) === "next");
    expect(idxChild).toBeGreaterThanOrEqual(0);
    expect(idxUser).toBeGreaterThanOrEqual(0);
    expect(idxChild).toBeLessThan(idxUser);
  });
});
