import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseXnl } from "xnl-core";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import type { ToolDef } from "@cell/ai-core-contract/types";
import { aiAgentCooperativeStep, aiAgentLoopStreaming } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { deepSeekCompatibleChatEffectBundle } from "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles";
import { processRuntimeIngressStream } from "@cell/ai-organ-logic/runtime/ShellRuntimeSupport";
import { materializeConversationRuntimeMessagesFromVm } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime";

function interruptedTurnFixture(knownChat = true, interruptFirst = true, storage?: { sessionDir: string; logs: boolean }) {
  const requests: any[] = [];
  const toolInputs: unknown[] = [];
  const parsedMessages: any[] = [];
  const events: any[] = [];
  const eventBus = new AgentEventGraph();
  eventBus.addConsumer((event) => { events.push(event); });
  const tool: ToolDef<any, string, Record<string, unknown>> = {
    schema: {
      type: "function",
      function: {
        name: "RecoveryCommit",
        description: "Record the completed value",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
    },
    briefPromptXnl: '<tool name="RecoveryCommit" />',
    run: async (_context, input) => {
      toolInputs.push(input);
      return "committed-once";
    },
  };
  const toolRegistry = new ToolFuncRegistry();
  toolRegistry.register(tool);
  const adapter = {
    type: "openai" as const,
    ...(knownChat ? { chatCompletionsEffectBundle: deepSeekCompatibleChatEffectBundle } : {}),
    async createStream(options: any) {
      requests.push(structuredClone({
        messages: options.messages,
        tools: options.tools,
        extraBody: options.extraBody,
        providerRetryOwner: options.providerRetryOwner,
      }));
      const attempt = requests.length;
      async function* chunks() {
        if (interruptFirst && attempt === 1) {
          yield { choices: [{ delta: { role: "assistant", reasoning_content: "FAILED_REASONING_FRAGMENT" } }] };
          yield { choices: [{ delta: { content: "FAILED_CONTENT_FRAGMENT" } }] };
          yield { choices: [{ delta: { tool_calls: [{
            index: 0, id: "failed-partial-call", type: "function",
            function: { name: "RecoveryCommit", arguments: '{"value":"FAILED_JSON_FRAGMENT' },
          }] } }] };
          throw Object.assign(new Error("The socket connection was closed unexpectedly"), { code: "ECONNRESET" });
        }
        yield { choices: [{ delta: { role: "assistant", reasoning_content: "successful reasoning" } }] };
        yield { choices: [{ delta: { content: "successful content" } }] };
        yield { choices: [{ delta: { tool_calls: [{
          index: 0, id: "successful-call", type: "function",
          function: { name: "RecoveryCommit", arguments: '{"value":' },
        }] } }] };
        yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"accepted"}' } }] } }] };
        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
      }
      return { stream: chunks() };
    },
  };
  const actor = createActor({
    key: "main",
    llmClient: adapter,
    modelConfig: { model: "offline-recovery-fixture" },
    callbacks: {
      buildToolset: () => [tool.schema],
      processStream: async (_vm, streamActor, stream, options) => {
        const message = await processRuntimeIngressStream({
          stream,
          adapterType: adapter.type,
          llmAdapter: adapter,
          eventBus,
          actorMeta: { agentKey: streamActor.key, agentActorId: streamActor.id },
          storageLogsEnabled: false,
          signal: options?.signal,
        });
        parsedMessages.push(message);
        return message;
      },
    },
  });
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    registries: { toolRegistry },
    eventBus,
    ...(storage ? { outerCtx: { metadata: { sessionDir: storage.sessionDir, sessionId: "retry-fixture" } } } : {}),
    options: { exitAfterToolResult: true, ...(storage ? { storage: { logs: storage.logs } } : {}) },
  });
  return { actor, vm, requests, toolInputs, parsedMessages, events };
}

describe("interrupted provider turn recovery", () => {
  for (const logs of [true, false]) {
    it(`persists value-safe retry decisions only when logs=${logs}`, async () => {
      const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "eidolon-retry-diagnostics-"));
      const { actor, vm } = interruptedTurnFixture(true, true, { sessionDir, logs });
      actor.send("humanInput", "Record accepted exactly once");
      await aiAgentLoopStreaming({ vm, actor, messages: [] });
      const logPath = path.join(sessionDir, "logs", "diagnostics.xnl");
      if (!logs) {
        expect(await fs.exists(logPath)).toBe(false);
        return;
      }
      const raw = await fs.readFile(logPath, "utf8");
      const events = parseXnl(raw).nodes.filter((node: any) => node.metadata?.eventType === "provider_retry_diagnostic");
      expect(events).toHaveLength(1);
      expect((events[0] as any).attributes.payload).toMatchObject({
        actorId: actor.id, classificationReason: "transport_socket_closed_retryable",
        terminationReason: "retry_scheduled", attemptNumber: 1, cumulativeBackoffSeconds: 0,
        replaySafety: "safe_pre_tool_dispatch",
      });
      expect((events[0] as any).attributes.payload.operationId).toBeTruthy();
      expect((events[0] as any).attributes.payload).not.toHaveProperty("error");
      expect(raw).not.toContain("FAILED_");
    });
  }
  it("control: the real stream parser dispatches a complete fragmented tool call", async () => {
    const { actor, vm, requests, toolInputs, parsedMessages } = interruptedTurnFixture(true, false);
    actor.send("humanInput", "Record accepted exactly once");
    await aiAgentLoopStreaming({ vm, actor, messages: [] });
    expect(requests).toHaveLength(1);
    expect(toolInputs).toEqual([{ value: "accepted" }]);
    expect(parsedMessages[0]).toMatchObject({
      content: "successful content",
      reasoning_content: "successful reasoning",
    });
    const canonical = materializeConversationRuntimeMessagesFromVm({ vm, actorKey: actor.key });
    expect(canonical.filter((message: any) => message.role === "tool")).toHaveLength(1);
    expect(JSON.stringify(canonical)).toContain("successful-call");
  });

  for (const mode of ["streaming", "cooperative"] as const) {
    it(`${mode} recreates the Chat parser and dispatches only the successful tool call`, async () => {
      const fixture = interruptedTurnFixture();
      const { actor, vm, requests, parsedMessages, toolInputs } = fixture;
      actor.send("humanInput", "Record accepted exactly once");
      if (mode === "streaming") {
        await aiAgentLoopStreaming({ vm, actor, messages: [] });
      } else {
        let state: any;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const result = await aiAgentCooperativeStep({
            fiberId: `${actor.key}:${actor.id}`,
            vm,
            actor,
            messages: [],
            state,
            setState: (next) => { state = next; },
            resumeFiber: () => {},
          });
          if (result.kind === "suspend" && result.reason === "idle_external") break;
          if (result.kind === "complete" || result.kind === "fail") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[0].providerRetryOwner).toBe("assistant_turn");
      expect(parsedMessages).toHaveLength(1);
      expect(parsedMessages[0]).toMatchObject({
        role: "assistant",
        content: "successful content",
        reasoning_content: "successful reasoning",
        tool_calls: [{ id: "successful-call", function: { name: "RecoveryCommit", arguments: '{"value":"accepted"}' } }],
      });
      expect(toolInputs).toEqual([{ value: "accepted" }]);
      const canonical = materializeConversationRuntimeMessagesFromVm({ vm, actorKey: actor.key });
      expect(canonical.filter((message: any) => message.role === "tool")).toHaveLength(1);
      expect(JSON.stringify(canonical)).toContain("successful-call");
      for (const messages of [parsedMessages, canonical, actor.messages]) {
        expect(JSON.stringify(messages)).not.toContain("FAILED_");
        expect(JSON.stringify(messages)).not.toContain("failed-partial-call");
      }
    }, 10_000);
  }

  it("keeps an undeclared adapter conservative after partial output", async () => {
    const { actor, vm, requests, toolInputs } = interruptedTurnFixture(false);
    actor.send("humanInput", "Record accepted exactly once");
    await expect(aiAgentLoopStreaming({ vm, actor, messages: [] })).rejects.toThrow("socket connection");
    expect(requests).toHaveLength(1);
    expect(requests[0].providerRetryOwner).toBeUndefined();
    expect(toolInputs).toEqual([]);
  });
});
