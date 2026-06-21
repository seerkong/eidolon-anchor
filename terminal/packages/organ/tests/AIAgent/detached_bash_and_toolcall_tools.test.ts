import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer";
import { configureLocalPermissionConfigStore } from "@cell/ai-organ-logic";
import { LocalFilePermissionConfigStore } from "@cell/ai-support";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver";

configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

describe("s08 detached tools", () => {
  it("RunDetachedBash returns task_id and command runs in a detached actor", async () => {
    const workDir = makeTempDir("detached-bash-");
    const outPath = path.join(workDir, "out.txt");
    const cmd = `echo hello > ${JSON.stringify(outPath)}; echo hello`;

    const adapter = makeMockAdapter();

    const events: any[] = [];
    const bus = new AgentEventGraph();
    bus.addConsumer((ev) => events.push(ev as any));

    const callCount: Record<string, number> = {};
    const processStream = async (_vm: any, actor: any) => {
      const key = String(actor.key);
      callCount[key] = (callCount[key] ?? 0) + 1;
      const n = callCount[key];

      if (actor.type === "delegate" || actor.type === "detached") {
        if (n === 1) {
          const userText = String(actor.messages?.[actor.messages.length - 1]?.content ?? "");
          const payload = JSON.parse(userText);
          return {
            role: "assistant",
            tool_calls: [
              {
                id: "tc-sub-bash",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: payload.command }),
                },
              },
            ],
          };
        }
        return { role: "assistant", content: "bash done" };
      }

      if (n === 1) {
        return {
          role: "assistant",
          tool_calls: [
            {
                id: "tc-detached-bash-1",
              function: {
                name: "RunDetachedBash",
                arguments: JSON.stringify({ command: cmd, agent_type: "code" }),
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

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
      eventBus: bus,
      outerCtx: { workDir },
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

    const toolMsg = main.messages.find((m: any) => m?.role === "tool" && (m?.tool_call_id ?? m?.toolCallId) === "tc-detached-bash-1");
    expect(toolMsg).toBeTruthy();
    const started = JSON.parse(String((toolMsg as any)?.content ?? ""));
    expect(typeof started?.task_id).toBe("string");

    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 100, maxWallMs: 2000 });
    await flushMicrotasks();

    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath, "utf-8").trim()).toBe("hello");

    const doneEvent = events.find(
      (ev) =>
        (ev as any)?.event_type === "semantic_background_result"
        && (ev as any)?.background_result?.task_id === started.task_id,
    );
    expect(doneEvent).toBeTruthy();
    expect((doneEvent as any)?.background_result?.status).toBe("completed");

    const result = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorResult", vm, main, {
      task_id: started.task_id,
    })));
    expect(result.status).toBe("completed");
    expect(result.output_text).toContain("hello");
    expect(result.logs.entries.map((entry: any) => entry.text).join("")).toContain("hello");
  });

  it("DetachedToolCall returns task_id and runs a single tool call", async () => {
    const workDir = makeTempDir("detached-toolcall-");
    const filePath = path.join(workDir, "x.txt");

    const adapter = makeMockAdapter();

    const callCount: Record<string, number> = {};
    const processStream = async (_vm: any, actor: any) => {
      const key = String(actor.key);
      callCount[key] = (callCount[key] ?? 0) + 1;
      const n = callCount[key];

      if (actor.type === "delegate" || actor.type === "detached") {
        if (n === 1) {
          const userText = String(actor.messages?.[actor.messages.length - 1]?.content ?? "");
          const payload = JSON.parse(userText);
          return {
            role: "assistant",
            tool_calls: [
              {
                id: "tc-sub-tool",
                function: {
                  name: String(payload.tool_name),
                  arguments: JSON.stringify(payload.arguments ?? {}),
                },
              },
            ],
          };
        }
        return { role: "assistant", content: "tool done" };
      }

      if (n === 1) {
        return {
          role: "assistant",
          tool_calls: [
            {
                id: "tc-detached-tool-1",
              function: {
                name: "DetachedToolCall",
                arguments: JSON.stringify({
                  tool_name: "write",
                  arguments: { filePath: path.basename(filePath), content: "hi" },
                  agent_type: "code",
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

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
      outerCtx: { workDir },
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

    const toolMsg = main.messages.find((m: any) => m?.role === "tool" && (m?.tool_call_id ?? m?.toolCallId) === "tc-detached-tool-1");
    expect(toolMsg).toBeTruthy();
    const started = JSON.parse(String((toolMsg as any)?.content ?? ""));
    expect(typeof started?.task_id).toBe("string");

    expect(fs.existsSync(filePath)).toBe(false);

    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 100, maxWallMs: 2000 });
    await flushMicrotasks();

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8").trim()).toBe("hi");
  });

  it("RunDetachedBash runs directly without recursively exploring through a delegate actor", async () => {
    const workDir = makeTempDir("detached-bash-stop-");
    const adapter = makeMockAdapter();

    let delegateTurns = 0;
    let mainTurns = 0;
    const processStream = async (_vm: any, actor: any) => {
      if (actor.type === "delegate" || actor.type === "detached") {
        delegateTurns += 1;
        if (delegateTurns === 1) {
          return {
            role: "assistant",
            tool_calls: [
              {
                id: "tc-sub-bash-stop",
                function: { name: "bash", arguments: JSON.stringify({ command: "pwd" }) },
              },
            ],
          };
        }
        return {
          role: "assistant",
          tool_calls: [
            {
              id: "tc-sub-bash-recursive",
              function: { name: "bash", arguments: JSON.stringify({ command: "ls -la" }) },
            },
          ],
        };
      }

      mainTurns += 1;
      if (mainTurns === 1) {
        return {
          role: "assistant",
          tool_calls: [
            {
              id: "tc-detached-bash-stop-1",
              function: {
                name: "RunDetachedBash",
                arguments: JSON.stringify({ command: "pwd", agent_type: "code" }),
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

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
      outerCtx: { workDir },
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
    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 100, maxWallMs: 2000 });
    await flushMicrotasks();

    expect(delegateTurns).toBe(0);
  });
});
