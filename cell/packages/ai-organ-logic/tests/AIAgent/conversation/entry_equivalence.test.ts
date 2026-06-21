import { describe, expect, it } from "bun:test";

import type { ToolDef } from "@cell/ai-core-contract/types";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { aiAgentLoopStreaming } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver";

import { createMockProcessStream } from "./../__test_support__/mockProcessStream";

/**
 * spec ai-turn-execution-spine / conformance-tests / loop-equivalence-test:
 * the SAME scripted provider script driven through the two real entrypoints —
 * the blocking streaming entry (aiAgentLoopStreaming) and the cooperative
 * fiber step (aiAgentCooperativeStep, via the orchestrator driver) — produces
 * the same conversation (assistant turns + tool result), since both drive one
 * turnReducer-backed phase machine. This replaces the prior harness that only
 * compared the reducer to a hand-rolled mirror of itself.
 */

function echoTool(): ToolDef<any, string, Record<string, unknown>> {
  return {
    schema: {
      type: "function",
      function: { name: "echo", description: "echo test tool", parameters: { type: "object", properties: {} } },
    },
    briefPromptXnl: `<tool name="echo" />`,
    run: async () => "ECHO_OUTPUT",
  };
}

// Turn 1 → assistant requests the echo tool; turn 2 → assistant finishes.
function scriptedProcessStream() {
  let turn = 0;
  return createMockProcessStream(async () => {
    turn += 1;
    return turn === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "tc-echo", function: { name: "echo", arguments: "{}" } }] }
      : { role: "assistant", content: "all done" };
  });
}

function makeActorVm() {
  const toolRegistry = new ToolFuncRegistry();
  toolRegistry.register(echoTool());
  const adapter = {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield { ok: true };
      }
      return { stream: stream() };
    },
  };
  const actor = createActor({
    key: "main",
    llmClient: adapter,
    modelConfig: { model: "mock-model" },
    callbacks: {
      buildToolset: () => [echoTool().schema],
      processStream: scriptedProcessStream(),
    },
  });
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    registries: { toolRegistry },
  });
  return { actor, vm };
}

// Stable projection of the conversation: assistant + tool messages only, by
// role + text content (ignoring volatile id/timestamp/tool-call-shape fields).
function projectConversation(messages: readonly any[]): Array<{ role: string; content: string }> {
  return messages
    .filter((message) => message?.role === "assistant" || message?.role === "tool")
    .map((message) => ({
      role: String(message.role),
      content: typeof message.content === "string" ? message.content : message.content == null ? "" : String(message.content),
    }));
}

async function runStreamingEntry(): Promise<Array<Record<string, unknown>>> {
  const { actor, vm } = makeActorVm();
  await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "hi" } as any] });
  return projectConversation([...actor.messages]);
}

async function runCooperativeEntry(): Promise<Array<Record<string, unknown>>> {
  const { actor, vm } = makeActorVm();
  const fiberId = `${actor.key}:${actor.id}`;
  const driver = createAiAgentOrchestratorDriverWithCooperative({
    fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }],
    options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
  });
  actor.send("humanInput", "hi");
  const now = Date.now();
  driver.resumeFiber(fiberId, now);
  await driver.tickUntilForegroundSettled({ now, maxTicks: 80, maxWallMs: 4000 });
  return projectConversation([...actor.messages]);
}

describe("streaming and cooperative entrypoints are behavior-equivalent", () => {
  it("produces the same assistant/tool conversation for one scripted tool round", async () => {
    const streaming = await runStreamingEntry();
    const cooperative = await runCooperativeEntry();

    // The expected shared shape: tool-call assistant turn (no text) → echo tool
    // result → final assistant turn.
    expect(streaming).toEqual([
      { role: "assistant", content: "" },
      { role: "tool", content: "ECHO_OUTPUT" },
      { role: "assistant", content: "all done" },
    ]);
    expect(cooperative).toEqual(streaming);
  });
});
