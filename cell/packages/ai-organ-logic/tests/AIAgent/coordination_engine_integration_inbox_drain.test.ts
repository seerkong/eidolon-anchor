import { describe, expect, it } from "bun:test";

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer";
import {
  AI_AGENT_COORDINATION_DECISIONS,
  AI_AGENT_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_NAMES,
  AI_AGENT_COORDINATION_STATUSES,
} from "@cell/ai-core-logic";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver";
import { getCoordinationEngine } from "@cell/ai-organ-logic/coordination/CoordinationEngine";
import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager";

function makeRecordingAdapter(record: (options: any) => void) {
  return {
    type: "openai" as const,
    async createStream(options: any) {
      record(options);
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

describe("Member coordination: inbox drain integration", () => {
  it("drains coordination envelopes into human-readable injected text and updates engine state", async () => {
    const recordedMessages: any[][] = [];
    const events: any[] = [];
    const adapter = makeRecordingAdapter((options) => {
      recordedMessages.push(options?.messages ?? []);
    });

    const bus = new AgentEventGraph();
    bus.addConsumer((event) => events.push(event));

    const control = createActor({
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
      controlActorKey: control.key,
      actors: { [control.key]: control },
      eventBus: bus,
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: { name: "code", description: "test agent", tools: "*", prompt: ["you are a member"] },
        } as any),
      },
    });

    const controlMessages: any[] = [{ role: "user", content: "hi" }];
    const controlFiberId = `${control.key}:${control.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: controlFiberId, vm, actor: control, messages: controlMessages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const members = getMemberManager();
    members.__resetForTest?.();
    const engine = getCoordinationEngine();
    engine.__resetForTest?.();

    const member = members.createMember({
      vm,
      driver,
      controlActor: control,
      name: "worker",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are worker"],
    });

    const outbound = engine.makeOutbound({
      coordination: AI_AGENT_COORDINATION_NAMES.planApproval,
      kind: AI_AGENT_COORDINATION_KINDS.planRequest,
      payload: { plan: "run dangerous thing" },
    });

    members.sendMessage({ vm, to: member.memberId, from: "control", text: outbound.text });

    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 });
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 });
    await flushMicrotasks();

    const rec = engine.get(vm, outbound.request_id);
    expect(rec?.coordination).toBe(AI_AGENT_COORDINATION_NAMES.planApproval);
    expect(rec?.status).toBe(AI_AGENT_COORDINATION_STATUSES.pending);

    const sawInjected = recordedMessages.some((msgs) =>
      msgs.some((m) =>
        String(m?.content ?? "").includes(
          `Coordination(${AI_AGENT_COORDINATION_NAMES.planApproval}) ${AI_AGENT_COORDINATION_KINDS.planRequest} ${outbound.request_id}`,
        ),
      ),
    );
    expect(sawInjected).toBe(true);
    expect(
      events.some(
        (event) => (event as any)?.event_type === "semantic_plan_approval_request" && (event as any)?.request_id === outbound.request_id,
      ),
    ).toBe(true);
  });

  it("auto-approves shutdown request, exits the member, and completes the coordination", async () => {
    const adapter = makeRecordingAdapter(() => {});
    const events: any[] = [];
    const bus = new AgentEventGraph();
    bus.addConsumer((event) => events.push(event));

    const control = createActor({
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
      controlActorKey: control.key,
      actors: { [control.key]: control },
      eventBus: bus,
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: { name: "code", description: "test agent", tools: "*", prompt: ["you are a member"] },
        } as any),
      },
    });

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${control.key}:${control.id}`, vm, actor: control, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const members = getMemberManager();
    members.__resetForTest?.();
    const engine = getCoordinationEngine();
    engine.__resetForTest?.();

    const member = members.createMember({
      vm,
      driver,
      controlActor: control,
      name: "worker-shutdown",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are worker"],
    });

    const outbound = engine.makeOutbound({
      coordination: AI_AGENT_COORDINATION_NAMES.shutdown,
      kind: AI_AGENT_COORDINATION_KINDS.shutdownRequest,
      payload: { reason: "done" },
    });
    members.sendMessage({ vm, to: member.memberId, from: "control", text: outbound.text });

    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 });
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 });
    await flushMicrotasks();

    const rec = engine.get(vm, outbound.request_id);
    expect(rec?.coordination).toBe(AI_AGENT_COORDINATION_NAMES.shutdown);
    expect(rec?.status).toBe(AI_AGENT_COORDINATION_STATUSES.completed);
    expect(rec?.decision).toBe(AI_AGENT_COORDINATION_DECISIONS.approve);

    const roster = members.listMembers({ vm });
    const entry = roster.find((t) => t.memberId === member.memberId);
    expect(entry?.lifecycleState).toBe("exited");
    expect(
      events.some(
        (event) => (event as any)?.event_type === "semantic_shutdown_result" && (event as any)?.request_id === outbound.request_id,
      ),
    ).toBe(true);
  });
});
