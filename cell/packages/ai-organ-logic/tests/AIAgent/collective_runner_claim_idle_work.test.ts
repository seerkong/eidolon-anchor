import { describe, expect, it } from "bun:test";

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { TaskTreeManager } from "@cell/ai-organ-logic/plan/TaskTreeManager";
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver";
import { getOrganizationManager } from "@cell/ai-organ-logic/organization/OrganizationManager";
import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager";
import { createAutonomousHolonTaskRunner } from "@cell/ai-organ-logic/organization/AutonomousHolonTaskRunner";

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

describe("AutonomousHolonTaskRunner: claim + execute loop", () => {
  it("claims a pending TaskTree task and drives a collective member to complete it", async () => {
    const adapter = makeMockAdapter();
    const events: any[] = [];
    const bus = new AgentEventGraph();
    bus.addConsumer((event) => events.push(event));

    const processStream = async (_vm: any, actor: any) => {
      if (String(actor.key).startsWith("member:")) {
        const lastUser = (actor.messages as any[]).filter((m) => m?.role === "user").slice(-1)[0];
        const text = String(lastUser?.content ?? "");
        const m = text.match(/TASK_ID=(task-\d+)/);
        const taskId = m?.[1] ?? "";
        if (taskId) {
          TaskTreeManager.apply(actor.taskTree, { op: "update_status", task_id: taskId, status: "completed" });
        }
        return { role: "assistant", content: "done" };
      }

      return { role: "assistant", content: "control idle" };
    };

    const root = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, actor) => processStream(vm, actor),
      },
    });

    TaskTreeManager.apply(root.taskTree, {
      op: "replace_root",
      tasks: [{ content: "do something", status: "pending", activeForm: "main" }],
    });
    const taskId = root.taskTree.root.children[0]?.id;
    expect(taskId).toBeTruthy();

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
    });

    const rootFiberId = `${root.key}:${root.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: rootFiberId, vm, actor: root, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const members = getMemberManager();
    members.__resetForTest?.();

    members.createMember({
      vm,
      driver,
      controlActor: root,
      name: "worker",
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
    });

    await runner.tickOnce();
    await flushMicrotasks();

    const updated = root.taskTree.root.children.find((t) => t.id === taskId);
    expect(updated?.status).toBe("completed");
    expect(
      events.some(
        (event) => (event as any)?.event_type === "semantic_notice" && String((event as any)?.message ?? "").includes(`Autonomous holon claim: ${taskId}`),
      ),
    ).toBe(true);
  });

  it("shuts down an idle collective member after idle timeout and emits an event", async () => {
    const adapter = makeMockAdapter();
    const events: any[] = [];
    const bus = new AgentEventGraph();
    bus.addConsumer((event) => events.push(event));

    const root = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "control idle" }),
      },
    });

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
    });

    const rootFiberId = `${root.key}:${root.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: rootFiberId, vm, actor: root, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const members = getMemberManager();
    members.__resetForTest?.();

    const member = members.createMember({
      vm,
      driver,
      controlActor: root,
      name: "worker-idle",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are idle worker"],
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

    await new Promise((r) => setTimeout(r, 5));
    await runner.tickOnce();
    await flushMicrotasks();

    const roster = members.listMembers({ vm });
    const entry = roster.find((t) => t.memberId === member.memberId);
    expect(entry).toBeTruthy();
    expect(entry?.lifecycleState).toBe("exited");
    expect(
      events.some(
        (event) => (event as any)?.event_type === "semantic_notice" && String((event as any)?.message ?? "").includes(`Autonomous holon idle exit: ${member.memberId}`),
      ),
    ).toBe(true);
  });

  it("routes collective-scoped pending work only to members inside that collective", async () => {
    const adapter = makeMockAdapter();
    const events: any[] = [];
    const bus = new AgentEventGraph();
    bus.addConsumer((event) => events.push(event));

    const processStream = async (_vm: any, actor: any) => {
      if (String(actor.key).startsWith("member:")) {
        const lastUser = (actor.messages as any[]).filter((m) => m?.role === "user").slice(-1)[0];
        const text = String(lastUser?.content ?? "");
        const m = text.match(/TASK_ID=(task-\d+)/);
        const taskId = m?.[1] ?? "";
        if (taskId) {
          TaskTreeManager.apply(actor.taskTree, { op: "update_status", task_id: taskId, status: "completed" });
        }
        return { role: "assistant", content: "done" };
      }
      return { role: "assistant", content: "control idle" };
    };

    const root = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, actor) => processStream(vm, actor),
      },
    });

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
    });

    const rootFiberId = `${root.key}:${root.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: rootFiberId, vm, actor: root, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const members = getMemberManager();
    members.__resetForTest?.();

    const outsider = members.createMember({
      vm,
      driver,
      controlActor: root,
      name: "outsider",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are outside the collective"],
      lane: "autonomous_holon",
      shareTaskTree: true,
    });
    const insider = members.createMember({
      vm,
      driver,
      controlActor: root,
      name: "insider",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are inside the collective"],
      lane: "autonomous_holon",
      shareTaskTree: true,
    });

    const holon = getOrganizationManager().createHolon(vm, "autonomous", "research");
    getOrganizationManager().addHolonMember(vm, holon.holonId, insider.memberId);

    TaskTreeManager.apply(root.taskTree, {
      op: "replace_root",
      tasks: [{ content: "collective only task", status: "pending", activeForm: `holon:autonomous:${holon.holonId}` }],
    });
    const taskId = root.taskTree.root.children[0]?.id;
    expect(taskId).toBeTruthy();

    const runner = createAutonomousHolonTaskRunner({
      driver,
      vm,
      controlActor: root,
      members: members,
    });

    await runner.tickOnce();
    await flushMicrotasks();

    const claim = events.find(
      (event) => (event as any)?.event_type === "semantic_notice" && String((event as any)?.message ?? "").includes(`Autonomous holon claim: ${taskId}`),
    );
    expect(claim).toBeTruthy();
    expect(String((claim as any)?.message ?? "")).toContain(insider.memberId);
    expect(String((claim as any)?.message ?? "")).not.toContain(outsider.memberId);
  });
});
