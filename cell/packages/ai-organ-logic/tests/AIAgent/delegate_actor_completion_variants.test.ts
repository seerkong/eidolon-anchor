import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";

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
  it("serializes assistant content in childDone outputText when possible", async () => {
    const parent = createActor({ key: "parent" });
    const child = createActor({ key: "child", type: "delegate" as any });
    const vm = createVM({ controlActorKey: "parent", actors: { parent, child } });

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
  });

  it("falls back when assistant content is non-serializable", async () => {
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
    expect(typeof payload.outputText).toBe("string");
    expect(payload.outputText.length).toBeGreaterThan(0);
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
  });
});
