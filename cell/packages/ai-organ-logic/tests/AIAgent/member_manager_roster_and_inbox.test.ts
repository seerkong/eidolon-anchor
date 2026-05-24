import { describe, expect, it } from "bun:test";

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver";

import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager";
import { BUILTIN_MEMBER_ROLES } from "@cell/ai-organ-contract/organization/MemberRole";

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

describe("Members: session-scoped roster + inbox drain", () => {
  it("spawns a member into the owning session roster without cross-session leakage", async () => {
    const recorded: Array<{ messages: any[] }> = [];
    const adapter = makeRecordingAdapter((options) => {
      recorded.push({ messages: options?.messages ?? [] });
    });

    const control = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "control ok" }),
      },
    });

    const bus = new AgentEventGraph();
    const toolRegistry = composeToolRegistry();
    const vmA = createVM({
      controlActorKey: control.key,
      actors: { [control.key]: control },
      eventBus: bus,
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: {
            name: "code",
            description: "test agent",
            tools: "*",
            prompt: ["you are a test member"],
          },
        } as any),
      },
    });

    const controlMessages: any[] = [{ role: "user", content: "hi" }];
    const controlFiberId = `${control.key}:${control.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: controlFiberId, vm: vmA, actor: control, messages: controlMessages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const members = getMemberManager();
    members.__resetForTest?.();

    const member = members.createMember({
      vm: vmA,
      driver,
      controlActor: control,
      name: "worker-1",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are worker"],
    });

    const roster = members.listMembers({ vm: vmA });
    const ownEntry = roster.find((t) => t.memberId === member.memberId);
    expect(ownEntry).toBeTruthy();
    expect(ownEntry?.lane).toBe("member");
    expect(typeof ownEntry?.status).toBe("string");

    const vmB = createVM({
      controlActorKey: "other",
      actors: { other: createActor({ key: "other" }) },
      registries: { toolRegistry },
    });
    const rosterFromB = members.listMembers({ vm: vmB });
    const fromB = rosterFromB.find((t) => t.memberId === member.memberId);
    expect(fromB).toBeUndefined();

    members.sendMessage({
      vm: vmA,
      to: member.memberId,
      from: "control",
      text: "ping from control",
    });

    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 50, maxWallMs: 2000 });
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 50, maxWallMs: 2000 });
    await flushMicrotasks();

    const seen = recorded.some((r) => r.messages.some((m) => String(m?.content ?? "").includes("ping from control")));
    expect(seen).toBe(true);

    const seenIdentity = recorded.some((r) =>
      r.messages.some((m) => m?.role === "system" && String(m?.content ?? "").includes("<identity_block>")),
    );
    expect(seenIdentity).toBe(true);
  });

  it("member list exposes the latest member assistant summary after processing inbox work", async () => {
    const recorded: Array<{ messages: any[] }> = [];
    const adapter = makeRecordingAdapter((options) => {
      recorded.push({ messages: options?.messages ?? [] });
    });

    const control = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "control ok" }),
      },
    });

    const toolRegistry = composeToolRegistry();
    const vm = createVM({
      controlActorKey: control.key,
      actors: { [control.key]: control },
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

    const mate = members.createMember({
      vm,
      driver,
      controlActor: control,
      name: "worker-summary",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are worker-summary"],
    });

    members.sendMessage({ vm, to: mate.memberId, from: "control", text: "ping from control" });
    await driver.tickUntilBlocked({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 });
    await flushMicrotasks();

    const entry = members.listMembers({ vm }).find((t) => t.memberId === mate.memberId);
    expect(entry?.lastAssistantText).toBe("control ok");
    expect(typeof entry?.lastCompletedAt).toBe("number");

    const byName = members.getMemberView({ vm, query: "worker-summary" });
    expect(byName?.memberId).toBe(mate.memberId);
    expect(byName?.lastAssistantText).toBe("control ok");

    const byId = members.getMemberView({ vm, query: mate.memberId });
    expect(byId?.name).toBe("worker-summary");
  });

  it("preserves explicit primary member role when spawning members", async () => {
    const control = createActor({
      key: "control",
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "control ok" }),
      },
    });

    const toolRegistry = composeToolRegistry();
    const vm = createVM({
      controlActorKey: control.key,
      actors: { [control.key]: control },
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

    const mate = members.createMember({
      vm,
      driver,
      controlActor: control,
      name: "worker-summary",
      role: "primary",
      agentType: "code",
      systemPrompt: ["you are worker-summary"],
    });

    const entry = members.getMemberView({ vm, query: mate.memberId });
    expect(entry?.role).toBe(BUILTIN_MEMBER_ROLES.primary);
    expect(mate.actor.type).toBe("delegate");
    expect(mate.actor.identity?.kind).toBe("member");
    expect((mate.actor.identity as any)?.role).toBe(BUILTIN_MEMBER_ROLES.primary);
  });


  it("broadcast delivers a message to every member inbox", async () => {
    const recorded: Array<{ messages: any[] }> = [];
    const adapter = makeRecordingAdapter((options) => {
      recorded.push({ messages: options?.messages ?? [] });
    });

    const control = createActor({
      key: "control",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "control ok" }),
      },
    });

    const toolRegistry = composeToolRegistry();
    const vm = createVM({
      controlActorKey: control.key,
      actors: { [control.key]: control },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: { name: "code", description: "test agent", tools: "*", prompt: ["you are a member"] },
        } as any),
      },
    });

    const controlFiberId = `${control.key}:${control.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: controlFiberId, vm, actor: control, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    const members = getMemberManager();
    members.__resetForTest?.();

    const a = members.createMember({
      vm,
      driver,
      controlActor: control,
      name: "worker-a",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are worker-a"],
    });
    const b = members.createMember({
      vm,
      driver,
      controlActor: control,
      name: "worker-b",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are worker-b"],
    });

    members.broadcast({ vm, from: "control", text: "broadcast: hello" });

    expect(a.actor.hasPending("memberInbox" as any)).toBe(true);
    expect(b.actor.hasPending("memberInbox" as any)).toBe(true);

    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 120, maxWallMs: 2000 });
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 120, maxWallMs: 2000 });
    await flushMicrotasks();

    const sawA = recorded.some(
      (r) =>
        r.messages.some((m) => String(m?.content ?? "").includes("broadcast: hello")) &&
        r.messages.some((m) => m?.role === "system" && String(m?.content ?? "").includes("name: worker-a")),
    );
    const sawB = recorded.some(
      (r) =>
        r.messages.some((m) => String(m?.content ?? "").includes("broadcast: hello")) &&
        r.messages.some((m) => m?.role === "system" && String(m?.content ?? "").includes("name: worker-b")),
    );
    expect(sawA).toBe(true);
    expect(sawB).toBe(true);
  });
});
