import fs from "fs";
import os from "os";
import path from "path";

import { describe, expect, it } from "bun:test";

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import { createLocalFileOrchestrationHistoryEffects } from "@cell/ai-support";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { StreamTranscript } from "@cell/symbiont-logic/stream/StreamTranscript";
import { createAutonomousHolonTaskRunner } from "@cell/ai-organ-logic/organization/AutonomousHolonTaskRunner";
import { TaskTreeManager } from "@cell/ai-organ-logic/plan/TaskTreeManager";
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver";
import { getCoordinationEngine } from "@cell/ai-organ-logic/coordination/CoordinationEngine";
import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager";

function makeTempSessionDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `eidolon-orch-history-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

describe("orchestration_history.jsonl integration", () => {
  it("records detached actor completion to logs/orchestration_history.jsonl", async () => {
    const sessionDir = makeTempSessionDir();
    const orchHistory = createLocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const adapter = makeMockAdapter();
    const callCount: Record<string, number> = {};
    const processStream = async (_vm: any, actor: any) => {
      const key = String(actor.key);
      callCount[key] = (callCount[key] ?? 0) + 1;

      if (actor.type === "delegate") {
        return { role: "assistant", content: "child result" };
      }
      if (callCount[key] === 1) {
        return {
          role: "assistant",
          tool_calls: [
            {
              id: "tc-detached-3",
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
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: { name: "code", description: "test", tools: "*", prompt: ["you are a test delegate actor"] },
        } as any),
      },
      effects: {
        orchestrationHistory: orchHistory,
      },
    });

    const messages: any[] = [{ role: "user", content: "hi" }];
    const mainFiberId = `${main.key}:${main.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: main, messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.resumeFiber(mainFiberId, Date.now());
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 });
    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 200, maxWallMs: 2000 });
    await flushMicrotasks();

    const filePath = path.join(sessionDir, "logs", "orchestration_history.jsonl");
    expect(fs.existsSync(filePath)).toBe(true);

    const parsed = StreamTranscript.parse(fs.readFileSync(filePath, "utf-8"));
    const detachedRec = parsed.records.find((r) => r.stream === "detached_actor");
    expect(detachedRec).toBeTruthy();
    const payload = JSON.parse(String(detachedRec?.payload ?? "{}"));
    expect(payload.kind).toBe("detached_actor_done");
    expect(payload.status).toBe("completed");
    expect(typeof payload.task_id).toBe("string");
  });

  it("records member messages to logs/orchestration_history.jsonl", async () => {
    const sessionDir = makeTempSessionDir();
    const orchHistory = createLocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const adapter = makeMockAdapter();
    const main = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    });

    const toolRegistry = composeToolRegistry();
    const vm = createVM({
      controlActorKey: main.key,
      actors: { [main.key]: main },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: { name: "code", description: "test", tools: "*", prompt: ["you are a member"] },
        } as any),
      },
      effects: {
        orchestrationHistory: orchHistory,
      },
    });

    const primaryFiberId = `${main.key}:${main.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: primaryFiberId, vm, actor: main, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const members = getMemberManager();
    members.__resetForTest?.();
    const mate = members.createMember({
      vm,
      driver,
      controlActor: main,
      name: "worker",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are worker"],
    });

    members.sendMessage({ vm, to: mate.memberId, from: "control", text: "hello" });
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 40, maxWallMs: 2000 });
    await flushMicrotasks();

    const filePath = path.join(sessionDir, "logs", "orchestration_history.jsonl");
    const parsed = StreamTranscript.parse(fs.readFileSync(filePath, "utf-8"));
    const rec = parsed.records.find((r) => r.stream === "member_message");
    expect(rec).toBeTruthy();
    const payload = JSON.parse(String(rec?.payload ?? "{}"));
    expect(payload.kind).toBe("member_message_sent");
    expect(payload.text).toBe("hello");
  });

  it("records coordination events to logs/orchestration_history.jsonl", async () => {
    const sessionDir = makeTempSessionDir();
    const orchHistory = createLocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const adapter = makeMockAdapter();
    const main = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    });

    const bus = new AgentEventGraph();
    const toolRegistry = composeToolRegistry();
    const vm = createVM({
      controlActorKey: main.key,
      actors: { [main.key]: main },
      eventBus: bus,
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: { name: "code", description: "test", tools: "*", prompt: ["you are a member"] },
        } as any),
      },
      effects: {
        orchestrationHistory: orchHistory,
      },
    });

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${main.key}:${main.id}`, vm, actor: main, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const members = getMemberManager();
    members.__resetForTest?.();
    const engine = getCoordinationEngine();
    engine.__resetForTest?.();

    const mate = members.createMember({
      vm,
      driver,
      controlActor: main,
      name: "worker-proto",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are worker"],
    });

    const outbound = engine.makeOutbound({
      coordination: "shutdown",
      kind: "shutdown_request",
      payload: { reason: "done" },
    });
    members.sendMessage({ vm, to: mate.memberId, from: "control", text: outbound.text });

    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 });
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 });
    await flushMicrotasks();

    const filePath = path.join(sessionDir, "logs", "orchestration_history.jsonl");
    const parsed = StreamTranscript.parse(fs.readFileSync(filePath, "utf-8"));
    const records = parsed.records.filter((r) => r.stream === "coordination_event");
    expect(records.length).toBeGreaterThan(0);
    const payloads = records.map((r) => JSON.parse(String(r.payload ?? "{}")));
    expect(payloads.some((payload) => payload.request_id === outbound.request_id && payload.coordination === "shutdown")).toBe(true);
  });

  it("records autonomous holon claim and idle-exit events to logs/orchestration_history.jsonl", async () => {
    const sessionDir = makeTempSessionDir();
    const orchHistory = createLocalFileOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
    });

    const adapter = makeMockAdapter();
    const root = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, actor) => {
          if (String(actor.key).startsWith("member:")) {
            return { role: "assistant", content: "done" };
          }
          return { role: "assistant", content: "ok" };
        },
      },
    });

    TaskTreeManager.apply(root.taskTree, {
      op: "replace_root",
      tasks: [{ content: "do something", status: "pending", activeForm: "main" }],
    });

    const bus = new AgentEventGraph();
    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      eventBus: bus,
      registries: {
        toolRegistry: composeToolRegistry(),
        agentRegistry: new AgentRegistry({
          code: { name: "code", description: "test agent", tools: "*", prompt: ["you are a worker"] },
        } as any),
      },
      effects: {
        orchestrationHistory: orchHistory,
      },
    });

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${root.key}:${root.id}`, vm, actor: root, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const members = getMemberManager();
    members.__resetForTest?.();
    members.createMember({
      vm,
      driver,
      controlActor: root,
      name: "worker-auto",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are worker"],
      lane: "autonomous_holon",
      shareTaskTree: true,
    });

    const runner = createAutonomousHolonTaskRunner({
      driver,
      vm,
      controlActor: root,
      members: members,
      idleTimeoutMs: 1,
    });

    await runner.tickOnce();
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 5));
    await runner.tickOnce();
    await flushMicrotasks();

    const filePath = path.join(sessionDir, "logs", "orchestration_history.jsonl");
    const parsed = StreamTranscript.parse(fs.readFileSync(filePath, "utf-8"));
    const records = parsed.records.filter((r) => r.stream === "autonomous_holon_event");
    const payloads = records.map((r) => JSON.parse(String(r.payload ?? "{}")));
    expect(payloads.some((payload) => payload.kind === "autonomous_holon_claim" && payload.member_id)).toBe(true);
    expect(payloads.some((payload) => payload.kind === "autonomous_holon_idle_exit" && payload.member_id)).toBe(true);
  });
});
