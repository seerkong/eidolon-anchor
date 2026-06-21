import { describe, expect, it } from "bun:test";

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
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

function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

describe("s08 detached actor tasks: registry + completion injection", () => {
  it("detached delegate-task spawn returns a stable task_id and emits a semantic completion event on finish", async () => {
    const adapter = makeMockAdapter();

    const events: any[] = [];
    const bus = new AgentEventGraph();
    bus.addConsumer((ev) => {
      events.push(ev as any);
    });

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
              id: "tc-detached-1",
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

    const toolRegistry = composeToolRegistry();
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
      eventBus: bus,
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
    await driver.tickUntilForegroundSettled({ now, maxTicks: 50, maxWallMs: 2000 });
    await flushMicrotasks();

    // Tool output should contain a machine-parseable task_id for detached work.
    const toolMsg = main.messages.find((m: any) => m?.role === "tool" && (m?.tool_call_id ?? m?.toolCallId) === "tc-detached-1");
    expect(toolMsg).toBeTruthy();
    const parsed = safeJsonParse(String((toolMsg as any)?.content ?? ""));
    expect(typeof parsed?.task_id).toBe("string");
    expect(String(parsed?.task_id ?? "").length).toBeGreaterThan(0);

    // Background lane should be able to complete without unblocking foreground.
    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 50, maxWallMs: 2000 });
    await flushMicrotasks();

    // Completion should not be injected mid-turn; it should wait for a safe boundary.
    const hasCompletionTextEarly = messages.some(
      (m) => m?.role === "assistant" && String(m?.content ?? "").includes("child result"),
    );
    expect(hasCompletionTextEarly).toBe(false);

    // Expect a detached completion event.
    const doneEvent = events.find((ev) => (ev as any)?.event_type === "semantic_background_result" && (ev as any)?.background_result?.task_id);
    expect(doneEvent).toBeTruthy();

    // Completion should become visible at the next safe boundary (next turn start).
    main.send("humanInput", "next");
    driver.resumeFiber(mainFiberId, Date.now());
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 50, maxWallMs: 2000 });
    await flushMicrotasks();

    const idxChild = main.messages.findIndex((m: any) => m?.role === "assistant" && String(m?.content ?? "").includes("Delegate actor"));
    const idxUser = main.messages.findIndex((m: any) => m?.role === "user" && m?.content === "next");
    expect(idxChild).toBeGreaterThanOrEqual(0);
    expect(idxUser).toBeGreaterThanOrEqual(0);
    expect(idxChild).toBeLessThan(idxUser);
  });
});
