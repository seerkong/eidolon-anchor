import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";
import { seedConversationDomainFromActorSeedMessages } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { ensureVmProviderCallDomain } from "@cell/ai-organ-logic/runtime/ProviderCallDomainRuntime";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function tickMany(driver: { tick: (now: number) => void }, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    driver.tick(Date.now());
    await flushMicrotasks();
  }
}

describe("OrchestratorDriver: delegate completion variants", () => {
  it("materializes childDone output from Conversation Domain instead of the actor mirror", async () => {
    const parent = createActor({ key: "parent" });
    // P7: the driver reads the child's own read-only message view, so the
    // assistant output is seeded on the actor (as a real delegate spawn does).
    const child = createActor({
      key: "child",
      type: "delegate" as any,
      messages: [{ role: "assistant", content: "stale compatibility mirror" }] as any,
    });
    const vm = createVM({ controlActorKey: "parent", actors: { parent, child } });
    seedConversationDomainFromActorSeedMessages({
      vm,
      actor: child,
      seedMessages: [{ role: "assistant", content: { x: 1 } }],
    });

    const parentFiberId = `${parent.key}:${parent.id}`;
    const childFiberId = `${child.key}:${child.id}`;

    const childMessages: any[] = [{ role: "assistant", content: { x: 1 } }];

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: parentFiberId, vm, actor: parent, messages: [], basePriority: 1 }],
      runStep: async (ctx) => {
        if (ctx.fiberId === childFiberId) {
          return { kind: "complete" };
        }
        return { kind: "suspend", reason: "child_done" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.spawnFiber({
      fiberId: childFiberId,
      vm,
      actor: child,
      messages: childMessages,
      basePriority: 0,
      parentFiberId,
      kind: "delegate",
      onDone: { parentFiberId, mode: "detached" },
    });

    await tickMany(driver, 5);

    expect(parent.hasPending("childDone")).toBe(true);
    const payload = parent.peekMailbox("childDone")[0] as any;
    expect(payload.mode).toBe("detached");
    expect(typeof payload.outputText).toBe("string");
    expect(payload.outputText).toContain('"x":1');
    expect(payload.outputText).not.toContain("stale compatibility mirror");
    expect(payload.status).toBe("completed");
  });

  it("rejects completion when the Conversation Domain has no assistant outcome", async () => {
    const parent = createActor({ key: "parent" });
    const child = createActor({ key: "child", type: "delegate" as any });
    const vm = createVM({ controlActorKey: "parent", actors: { parent, child } });

    const parentFiberId = `${parent.key}:${parent.id}`;
    const childFiberId = `${child.key}:${child.id}`;

    const circular: any = { ok: true };
    circular.self = circular;
    const childMessages: any[] = [{ role: "assistant", content: circular }];

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: parentFiberId, vm, actor: parent, messages: [], basePriority: 1 }],
      runStep: async (ctx) => {
        if (ctx.fiberId === childFiberId) {
          return { kind: "complete" };
        }
        return { kind: "suspend", reason: "child_done" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.spawnFiber({
      fiberId: childFiberId,
      vm,
      actor: child,
      messages: childMessages,
      basePriority: 0,
      parentFiberId,
      kind: "delegate",
      onDone: { parentFiberId, mode: "detached" },
    });

    await tickMany(driver, 5);

    expect(parent.hasPending("childDone")).toBe(true);
    const payload = parent.peekMailbox("childDone")[0] as any;
    expect(payload.mode).toBe("detached");
    expect(payload.status).toBe("failed");
    expect(payload.error).toContain("delegate_empty_success");
  });

  it("lets a failed provider fact override partial assistant content and a complete step", async () => {
    const parent = createActor({ key: "parent" });
    const child = createActor({ key: "workflow-child", type: "delegate" as any });
    const vm = createVM({ controlActorKey: "parent", actors: { parent, child } });
    seedConversationDomainFromActorSeedMessages({
      vm,
      actor: child,
      seedMessages: [{ role: "assistant", content: "opening authoring session" }],
    });
    const providerDomain = ensureVmProviderCallDomain(vm);
    providerDomain.startProviderCall({
      providerCallId: "llm:workflow-child:7",
      actorKey: child.key,
      turnId: 2,
      modelRef: "mock",
      modelParams: {},
      toolSchemas: [],
      startedAt: Date.now(),
    });
    providerDomain.failProviderCall({
      providerCallId: "llm:workflow-child:7",
      failureKind: "provider_invalid_response",
      rawError: "invalid_tool_call_payload: invalid JSON arguments",
      at: Date.now(),
    });

    const parentFiberId = `${parent.key}:${parent.id}`;
    const childFiberId = `${child.key}:${child.id}`;
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: parentFiberId, vm, actor: parent, messages: [], basePriority: 1 }],
      runStep: async (ctx) => ctx.fiberId === childFiberId
        ? { kind: "complete" }
        : { kind: "suspend", reason: "child_done" },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });
    driver.spawnFiber({
      fiberId: childFiberId,
      vm,
      actor: child,
      messages: [],
      basePriority: 0,
      parentFiberId,
      kind: "delegate",
      onDone: {
        parentFiberId,
        mode: "sync_wait",
        toolCallId: "tc-provider-failed",
        toolName: "WorkflowFulfill",
      },
    });

    await tickMany(driver, 8);

    const payload = parent.peekMailbox("childDone")[0] as any;
    expect(payload).toMatchObject({
      status: "failed",
      toolCallId: "tc-provider-failed",
      toolName: "WorkflowFulfill",
      error: expect.stringContaining("invalid_tool_call_payload"),
    });
    expect(payload.outputText).not.toContain("opening authoring session");
  });

  it("sends childDone and resumes parent for sync_wait on cancel", async () => {
    const parent = createActor({ key: "parent" });
    const child = createActor({ key: "child", type: "delegate" as any });
    const vm = createVM({ controlActorKey: "parent", actors: { parent, child } });

    const parentFiberId = `${parent.key}:${parent.id}`;
    const childFiberId = `${child.key}:${child.id}`;
    const parentMessages: any[] = [];
    const childMessages: any[] = [{ role: "assistant", content: "bye" }];

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: parentFiberId, vm, actor: parent, messages: parentMessages, basePriority: 2 }],
      runStep: async (ctx) => {
        if (ctx.fiberId === childFiberId) {
          return { kind: "cancel", reason: "test_cancel", propagateToChildren: false };
        }
        // Parent waits.
        return { kind: "suspend", reason: "child_done" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.spawnFiber({
      fiberId: childFiberId,
      vm,
      actor: child,
      messages: childMessages,
      basePriority: 0,
      parentFiberId,
      kind: "delegate",
      onDone: { parentFiberId, mode: "sync_wait", toolCallId: "tc-1" },
    });

    // Kick parent once.
    driver.resumeFiber(parentFiberId, Date.now());
    await flushMicrotasks();

    await tickMany(driver, 10);

    expect(parent.hasPending("childDone")).toBe(true);
    const payload = parent.peekMailbox("childDone")[0] as any;
    expect(payload.mode).toBe("sync_wait");
    expect(payload.toolCallId).toBe("tc-1");
    expect(payload.status).toBe("cancelled");
  });

  it("sends childDone for sync_wait on failure", async () => {
    const parent = createActor({ key: "parent" });
    const child = createActor({ key: "child", type: "delegate" as any });
    const vm = createVM({ controlActorKey: "parent", actors: { parent, child } });

    const parentFiberId = `${parent.key}:${parent.id}`;
    const childFiberId = `${child.key}:${child.id}`;

    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: parentFiberId, vm, actor: parent, messages: [], basePriority: 2 }],
      runStep: async (ctx) => {
        if (ctx.fiberId === childFiberId) {
          return { kind: "fail", error: "boom" };
        }
        return { kind: "suspend", reason: "child_done" };
      },
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    driver.spawnFiber({
      fiberId: childFiberId,
      vm,
      actor: child,
      messages: [{ role: "assistant", content: "ignored" }],
      basePriority: 0,
      parentFiberId,
      kind: "delegate",
      onDone: { parentFiberId, mode: "sync_wait", toolCallId: "tc-2" },
    });

    driver.resumeFiber(parentFiberId, Date.now());
    await flushMicrotasks();
    await tickMany(driver, 10);

    expect(parent.hasPending("childDone")).toBe(true);
    const payload = parent.peekMailbox("childDone")[0] as any;
    expect(String(payload.outputText)).toContain("failed");
    expect(payload.status).toBe("failed");
    expect(payload.error).toBe("boom");
  });
});
