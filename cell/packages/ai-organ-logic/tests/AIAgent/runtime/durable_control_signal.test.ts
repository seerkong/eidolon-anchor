import { describe, expect, it } from "bun:test";

import {
  createEmptyDurableControlSignalStore,
  createVM,
  emitDurableControlSignal,
  ensureVmRxData,
  getPendingDurableControlSignals,
  markDurableControlSignalConsumed,
  normalizeDurableControlSignal,
} from "@cell/ai-core-logic/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { hydrateVM, serializeVM } from "@cell/ai-core-logic/runtime/snapshot";
import {
  createAiAgentOrchestratorDriver,
  configureRuntimePersistenceSupport,
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
} from "@cell/ai-organ-logic";
import { aiAgentCooperativeStep } from "@cell/ai-organ-logic/exec";
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support";
import fs from "fs";
import os from "os";
import path from "path";

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
});

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-durable-control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createSuspendedDriver(params: { vm: ReturnType<typeof createVM>; actor: ReturnType<typeof createActor>; fiberId: string }) {
  const driver = createAiAgentOrchestratorDriver({
    fibers: [{ fiberId: params.fiberId, vm: params.vm, actor: params.actor, messages: params.actor.messages, basePriority: 1 }],
    runStep: async () => ({ kind: "complete" as const }),
    options: {
      agingStep: 0,
      defaultSuspendPolicy: "continue_others",
    },
  });
  driver.suspendFiber(params.fiberId, 100, "external" as any);
  return driver;
}

describe("durable control signals", () => {
  it("normalizes event identity and idempotency fields", () => {
    const signal = normalizeDurableControlSignal(
      {
        actorKey: "main",
        fiberId: "fiber-1",
        mailboxKind: "toolResult",
        signalKind: "mailbox_enqueue",
        opId: "tool-op-1",
        toolCallId: "call-1",
        correlationId: "turn-1",
      },
      { sequence: 7, now: 123 },
    );

    expect(signal.eventId).toBe("ctrl_7");
    expect(signal.idempotencyKey).toBe("main:fiber-1:mailbox_enqueue:toolResult:tool-op-1:call-1:turn-1");
    expect(signal.signalClass).toBe("wake");
    expect(signal.priority).toBe(10);
    expect(signal.createdAt).toBe(123);
  });

  it("deduplicates repeated emissions by idempotency key", () => {
    const store = createEmptyDurableControlSignalStore();

    const first = emitDurableControlSignal(store, {
      actorKey: "main",
      fiberId: "fiber-1",
      mailboxKind: "toolResult",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "same-tool-result",
    });
    const second = emitDurableControlSignal(store, {
      actorKey: "main",
      fiberId: "fiber-1",
      mailboxKind: "toolResult",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "same-tool-result",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.signal.eventId).toBe(first.signal.eventId);
    expect(store.events).toHaveLength(1);
  });

  it("orders pending signals by interrupt, wake, then ordinary classes", () => {
    const store = createEmptyDurableControlSignalStore();
    emitDurableControlSignal(store, {
      actorKey: "main",
      signalKind: "suspend_recorded",
      idempotencyKey: "ordinary",
      createdAt: 1,
    });
    emitDurableControlSignal(store, {
      actorKey: "main",
      mailboxKind: "toolResult",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "wake",
      createdAt: 2,
    });
    emitDurableControlSignal(store, {
      actorKey: "main",
      mailboxKind: "control",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "interrupt",
      payload: { kind: "cancel_requested" },
      createdAt: 3,
    });

    expect(getPendingDurableControlSignals(store).map((signal) => signal.idempotencyKey)).toEqual([
      "interrupt",
      "wake",
      "ordinary",
    ]);
  });

  it("keeps consumed signals out of actor pending projections", () => {
    const store = createEmptyDurableControlSignalStore();
    const mainSignal = emitDurableControlSignal(store, {
      actorKey: "main",
      fiberId: "fiber-main",
      mailboxKind: "humanInput",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "main-input",
    }).signal;
    emitDurableControlSignal(store, {
      actorKey: "delegate",
      fiberId: "fiber-delegate",
      mailboxKind: "humanInput",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "delegate-input",
    });

    markDurableControlSignalConsumed(store, mainSignal.eventId);

    expect(getPendingDurableControlSignals(store, { actorKey: "main" })).toEqual([]);
    expect(getPendingDurableControlSignals(store, { actorKey: "delegate" })).toHaveLength(1);
  });

  it("advances the consumed checkpoint only across contiguous consumed sequences", () => {
    const store = createEmptyDurableControlSignalStore();
    const first = emitDurableControlSignal(store, {
      actorKey: "main",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "first",
    }).signal;
    const second = emitDurableControlSignal(store, {
      actorKey: "main",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "second",
    }).signal;

    markDurableControlSignalConsumed(store, second.eventId);
    expect(store.consumedCheckpoint?.sequence).toBe(0);
    expect(getPendingDurableControlSignals(store).map((signal) => signal.eventId)).toEqual([first.eventId]);

    markDurableControlSignalConsumed(store, first.eventId);
    expect(store.consumedCheckpoint?.sequence).toBe(2);
    expect(getPendingDurableControlSignals(store)).toEqual([]);
  });

  it("stores durable control signals at the session vm level across snapshots", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
    });

    emitDurableControlSignal(vm.sessionState.controlSignals, {
      actorKey: "main",
      actorId: actor.id,
      fiberId: "fiber-1",
      mailboxKind: "toolResult",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "tool-result-1",
      createdAt: 99,
    });

    const snapshot = serializeVM(vm);
    const restored = hydrateVM(snapshot, { main: actor });

    expect(snapshot.sessionState?.controlSignals?.events).toHaveLength(1);
    expect(restored.sessionState.controlSignals.events[0]?.idempotencyKey).toBe("tool-result-1");
    expect(restored.sessionState.controlSignals.events[0]?.actorKey).toBe("main");
  });

  it("serializes vm control signals without full llm or tool payloads", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
    });

    emitDurableControlSignal(vm.sessionState.controlSignals, {
      actorKey: "main",
      actorId: actor.id,
      fiberId: "fiber-1",
      mailboxKind: "asyncCompletion",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "llm-done-1",
      payload: {
        kind: "llm_done",
        opId: "llm:fiber-1:1",
        response: {
          id: "resp-1",
          reasoning_content: "provider private chain of thought must not enter vm.json",
          output_text: "assistant final text",
        },
        tools: [
          {
            type: "function",
            function: {
              name: "expensive_tool",
              parameters: {
                type: "object",
                properties: {
                  secretPayloadShape: { type: "string" },
                },
              },
            },
          },
        ],
      },
    });
    emitDurableControlSignal(vm.sessionState.controlSignals, {
      actorKey: "main",
      actorId: actor.id,
      fiberId: "fiber-1",
      mailboxKind: "toolResult",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "tool-done-1",
      payload: {
        kind: "tool_done",
        toolCallId: "call-1",
        outputText: "complete tool output must not be duplicated in vm.json",
      },
    });

    const snapshotJson = JSON.stringify(serializeVM(vm));
    const events = serializeVM(vm).sessionState?.controlSignals?.events ?? [];

    expect(events).toHaveLength(2);
    expect(snapshotJson).not.toContain("reasoning_content");
    expect(snapshotJson).not.toContain("provider private chain of thought");
    expect(snapshotJson).not.toContain("complete tool output must not be duplicated");
    expect(snapshotJson).not.toContain("secretPayloadShape");
    expect(events.every((event) => !("payload" in event))).toBe(true);
    expect(events.every((event) => "payloadSummary" in event)).toBe(true);
  });

  it("keeps consumed control signal snapshot growth bounded by compacting full payload history", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
    });
    const payloadText = "x".repeat(8_000);

    for (let index = 0; index < 80; index += 1) {
      const signal = emitDurableControlSignal(vm.sessionState.controlSignals, {
        actorKey: "main",
        actorId: actor.id,
        fiberId: "fiber-1",
        mailboxKind: "toolResult",
        signalKind: "mailbox_enqueue",
        idempotencyKey: `consumed-tool-${index}`,
        payload: {
          kind: "tool_done",
          toolCallId: `call-${index}`,
          outputText: `${payloadText}-${index}`,
        },
      }).signal;
      markDurableControlSignalConsumed(vm.sessionState.controlSignals, signal.eventId);
    }

    const snapshot = serializeVM(vm);
    const snapshotJson = JSON.stringify(snapshot);

    expect(snapshot.sessionState?.controlSignals?.events).toEqual([]);
    expect(snapshot.sessionState?.controlSignals?.consumedCheckpoint?.sequence).toBeGreaterThanOrEqual(80);
    expect(snapshotJson.length).toBeLessThan(80_000);
    expect(snapshotJson).not.toContain(payloadText);
  });

  it("preserves bounded pending signal metadata while omitting the runtime delivery payload", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
    });

    emitDurableControlSignal(vm.sessionState.controlSignals, {
      actorKey: "main",
      actorId: actor.id,
      fiberId: "fiber-1",
      mailboxKind: "toolResult",
      signalKind: "async_completed",
      opId: "tool:fiber-1:1",
      toolCallId: "call-1",
      idempotencyKey: "pending-tool-1",
      payload: {
        kind: "tool_done",
        outputText: "runtime-only payload",
      },
    });

    const signal = serializeVM(vm).sessionState?.controlSignals?.events[0];

    expect(signal).toMatchObject({
      eventId: "ctrl_1",
      sequence: 1,
      actorKey: "main",
      fiberId: "fiber-1",
      mailboxKind: "toolResult",
      signalKind: "async_completed",
      signalClass: "wake",
      opId: "tool:fiber-1:1",
      toolCallId: "call-1",
      idempotencyKey: "pending-tool-1",
    });
    expect(signal?.payloadSummary?.byteLength).toBeGreaterThan(0);
    expect(signal?.payloadSummary?.digest).toStartWith("fnv1a32:");
    expect(signal).not.toHaveProperty("payload");
  });

  it("hydrates legacy full-payload signals and lazily normalizes them on the next save", () => {
    const actor = createActor({ key: "main" });
    const baseVm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
    });
    const legacySnapshot = serializeVM(baseVm);
    legacySnapshot.sessionState = {
      ...legacySnapshot.sessionState,
      controlSignals: {
        events: [
          {
            eventId: "ctrl_7",
            actorKey: "main",
            actorId: actor.id,
            fiberId: "fiber-1",
            mailboxKind: "humanInput",
            signalKind: "mailbox_enqueue",
            signalClass: "wake",
            priority: 10,
            idempotencyKey: "legacy-input-1",
            createdAt: 123,
            payload: "legacy full payload",
          },
        ],
        idempotencyIndex: { "legacy-input-1": "ctrl_7" },
        consumedEventIds: {},
      },
    };

    const restored = hydrateVM(legacySnapshot, { main: actor });
    const restoredSignal = getPendingDurableControlSignals(restored.sessionState.controlSignals)[0];
    const normalizedJson = JSON.stringify(serializeVM(restored));

    expect(restoredSignal?.payload).toBe("legacy full payload");
    expect(restoredSignal?.sequence).toBe(7);
    expect(restoredSignal?.payloadSummary?.digest).toStartWith("fnv1a32:");
    expect(normalizedJson).not.toContain("legacy full payload");
    expect(normalizedJson).not.toContain("\"payload\":");
  });

  it("fails fast instead of saving an unrecoverable suspended external fiber", async () => {
    const sessionDir = makeTempSessionDir();
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const driver = createSuspendedDriver({ vm, actor, fiberId: "fiber-main" });

    try {
      await expect(saveAiAgentRuntimeSnapshot({
        sessionDir,
        sessionId: "session-1",
        vm,
        driver,
      })).rejects.toThrow("unrecoverable_suspended_fiber");
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("allows suspended idle_external fibers as stable idle safepoints", async () => {
    const sessionDir = makeTempSessionDir();
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const driver = createSuspendedDriver({ vm, actor, fiberId: "fiber-main" });
    driver.suspendFiber("fiber-main", 101, "idle_external" as any);

    try {
      await saveAiAgentRuntimeSnapshot({
        sessionDir,
        sessionId: "session-1",
        vm,
        driver,
      });
      expect(fs.existsSync(path.join(sessionDir, "runtime_state", "manifest.json"))).toBe(true);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("allows suspended external fibers when a matching durable control signal can recover them", async () => {
    const sessionDir = makeTempSessionDir();
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const driver = createSuspendedDriver({ vm, actor, fiberId: "fiber-main" });

    emitDurableControlSignal(vm.sessionState.controlSignals, {
      actorKey: "main",
      actorId: actor.id,
      fiberId: "fiber-main",
      mailboxKind: "toolResult",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "recover-tool-result",
      createdAt: 101,
    });

    try {
      await saveAiAgentRuntimeSnapshot({
        sessionDir,
        sessionId: "session-1",
        vm,
        driver,
      });
      expect(fs.existsSync(path.join(sessionDir, "runtime_state", "manifest.json"))).toBe(true);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("emits through the driver boundary, enqueues once, and wakes suspended fibers", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const driver = createSuspendedDriver({ vm, actor, fiberId: "fiber-main" });
    const seenControlEvents: string[] = [];
    const { publicRxData } = ensureVmRxData(vm);
    publicRxData.controlSignals.subscribe((event) => seenControlEvents.push(event.idempotencyKey));

    const first = driver.emitFiberSignal({
      fiberId: "fiber-main",
      signalKind: "mailbox_enqueue",
      mailbox: { kind: "humanInput", payload: "hello" },
      idempotencyKey: "input-1",
      createdAt: 10,
    });
    const second = driver.emitFiberSignal({
      fiberId: "fiber-main",
      signalKind: "mailbox_enqueue",
      mailbox: { kind: "humanInput", payload: "hello again" },
      idempotencyKey: "input-1",
      createdAt: 11,
    });

    expect(first?.eventId).toBe(second?.eventId);
    expect(vm.sessionState.controlSignals.events).toHaveLength(0);
    expect(vm.sessionState.controlSignals.consumedTombstones?.[first!.eventId]?.idempotencyKey).toBe("input-1");
    expect(vm.sessionState.controlSignals.consumedEventIds[first!.eventId]).toBe(true);
    expect(actor.peekMailbox("humanInput")).toEqual(["hello"]);
    expect(driver.getState().fibers["fiber-main"]?.status).toBe("ready");
    expect(seenControlEvents).toEqual(["input-1"]);
    expect(publicRxData.scheduler.get().readyFiberIds).toContain("fiber-main");
  });

  it("emits interrupts without actor reentry and aborts current inflight work", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: "fiber-main", vm, actor, messages: actor.messages, basePriority: 1 }],
      runStep: async () => ({ kind: "suspend", reason: "external" as any }),
      options: {
        agingStep: 0,
        defaultSuspendPolicy: "continue_others",
      },
    });

    const llmAbortController = new AbortController();
    const toolAbortController = new AbortController();
    actor.llmAbortController = llmAbortController;
    (driver.inspectRuntime().fibers["fiber-main"] as any).execState = {
      inflight: { abortController: toolAbortController },
    };
    (driver.getState().fibers["fiber-main"] as any).status = "running";

    driver.emitFiberSignal({
      fiberId: "fiber-main",
      signalKind: "mailbox_enqueue",
      mailbox: { kind: "control", payload: { kind: "cancel_requested" } },
      idempotencyKey: "cancel-1",
    });

    expect(driver.getState().fibers["fiber-main"]?.status).toBe("running");
    expect(driver.inspectRuntime().pendingResumes).toEqual(["fiber-main"]);
    expect(llmAbortController.signal.aborted).toBe(true);
    expect(toolAbortController.signal.aborted).toBe(true);
    expect(actor.peekMailbox("control")).toEqual([{ kind: "cancel_requested" }]);
  });

  it("settles an interrupted cooperative fiber at an idle boundary", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: "fiber-main", vm, actor, messages: actor.messages, basePriority: 1 }],
      runStep: async () => ({ kind: "suspend", reason: "external" as any }),
      options: {
        agingStep: 0,
        defaultSuspendPolicy: "continue_others",
      },
    });
    const abortController = new AbortController();
    const ctx = driver.inspectRuntime().fibers["fiber-main"] as any;
    ctx.execState = {
      phase: "wait_llm",
      tools: [{ type: "function", function: { name: "x" } }],
      toolCalls: [{ id: "call-1" }],
      toolIndex: 0,
      pendingToolResults: [{ toolCallId: "call-1", content: "old" }],
      pendingAiGenerated: [{ kind: "llm_done", opId: "old" }],
      inflight: { kind: "llm", opId: "llm:fiber-main:1", abortController },
    };
    driver.suspendFiber("fiber-main", 100, "wait_llm_result" as any);
    driver.emitFiberSignal({
      fiberId: "fiber-main",
      signalKind: "interrupt_requested",
      mailbox: { kind: "control", payload: { kind: "cancel_requested" } },
      idempotencyKey: "cancel-settle",
      createdAt: 101,
    });

    driver.settleInterruptedFiber({
      fiberId: "fiber-main",
      now: 102,
      reason: "idle_external" as any,
      controlKinds: ["cancel_requested"],
    });

    expect(abortController.signal.aborted).toBe(true);
    expect(actor.peekMailbox("control")).toEqual([]);
    expect(ctx.execState.phase).toBe("drain");
    expect(ctx.execState.inflight).toBeUndefined();
    expect(ctx.execState.tools).toEqual([]);
    expect(ctx.execState.pendingAiGenerated).toEqual([]);
    expect(driver.getState().fibers["fiber-main"]?.status).toBe("suspended");
    expect(driver.getState().fibers["fiber-main"]?.waitingReason).toBe("idle_external");
    expect(driver.inspectRuntime().pendingResumes).toEqual([]);
  });

  it("redelivers pending durable signals during recovery and wakes the matching fiber", async () => {
    const sessionDir = makeTempSessionDir();
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const driver = createSuspendedDriver({ vm, actor, fiberId: "fiber-main" });

    const signal = emitDurableControlSignal(vm.sessionState.controlSignals, {
      actorKey: "main",
      actorId: actor.id,
      fiberId: "fiber-main",
      mailboxKind: "humanInput",
      signalKind: "mailbox_enqueue",
      idempotencyKey: "recover-human-input",
      createdAt: 101,
    }).signal;
    actor.send("humanInput", "resume from durable mailbox");

    try {
      await saveAiAgentRuntimeSnapshot({
        sessionDir,
        sessionId: "session-1",
        vm,
        driver,
      });

      const recovered = await recoverAiAgentRuntime({
        sessionDir,
        sessionId: "session-1",
      });

      expect(recovered?.controlActor.peekMailbox("humanInput")).toEqual(["resume from durable mailbox"]);
      expect(recovered?.driver.getState().fibers["fiber-main"]?.status).toBe("ready");
      expect(recovered?.vm.sessionState.controlSignals.consumedEventIds[signal.eventId]).toBe(true);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("does not redeliver consumed durable signals twice during recovery", async () => {
    const sessionDir = makeTempSessionDir();
    const actor = createActor({ key: "main" });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const driver = createSuspendedDriver({ vm, actor, fiberId: "fiber-main" });

    driver.emitFiberSignal({
      fiberId: "fiber-main",
      signalKind: "mailbox_enqueue",
      mailbox: { kind: "humanInput", payload: "already delivered" },
      idempotencyKey: "already-delivered-input",
    });
    driver.suspendFiber("fiber-main", 100, "idle_external" as any);

    try {
      await saveAiAgentRuntimeSnapshot({
        sessionDir,
        sessionId: "session-1",
        vm,
        driver,
      });

      const recovered = await recoverAiAgentRuntime({
        sessionDir,
        sessionId: "session-1",
      });

      expect(recovered?.controlActor.peekMailbox("humanInput")).toEqual(["already delivered"]);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("consumes committed humanInput durable signal and removes stale mailbox copy during recovery", async () => {
    const sessionDir = makeTempSessionDir();
    const actor = createActor({
      key: "main",
      messages: [{ role: "user", content: "already committed" }] as any[],
      mailboxes: {
        humanInput: ["already committed"],
      },
    });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const driver = createSuspendedDriver({ vm, actor, fiberId: "fiber-main" });
    const signal = emitDurableControlSignal(vm.sessionState.controlSignals, {
      actorKey: "main",
      fiberId: "fiber-main",
      signalKind: "mailbox_enqueue",
      signalClass: "wake",
      mailboxKind: "humanInput",
      payload: "already committed",
      idempotencyKey: "already-committed-input",
      createdAt: 101,
    }).signal;

    try {
      await saveAiAgentRuntimeSnapshot({
        sessionDir,
        sessionId: "session-1",
        vm,
        driver,
      });

      const recovered = await recoverAiAgentRuntime({
        sessionDir,
        sessionId: "session-1",
      });

      expect(recovered?.controlActor.peekMailbox("humanInput")).toEqual([]);
      expect(recovered?.vm.sessionState.controlSignals.consumedEventIds[signal.eventId]).toBe(true);
      expect(getPendingDurableControlSignals(recovered!.vm.sessionState.controlSignals)).toEqual([]);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("does not save ready wait_llm state when the matching asyncCompletion is already pending", async () => {
    const sessionDir = makeTempSessionDir();
    const actor = createActor({
      key: "main",
      id: "actor-ready-wait",
      ctrlOptions: {
        exitAfterToolResult: true,
      },
      mailboxes: {
        asyncCompletion: [
          {
            kind: "llm_done",
            opId: "llm:fiber-main:1",
            msg: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-read",
                  type: "function",
                  function: {
                    name: "ReadFile",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    let readFileCalls = 0;
    const toolRegistry = new ToolFuncRegistry();
    toolRegistry.register({
      schema: {
        type: "function",
        function: { name: "ReadFile", description: "read", parameters: { type: "object" } },
      },
      briefPromptXnl: `<tool name="ReadFile" />`,
      run: async () => {
        readFileCalls += 1;
        return "file contents";
      },
    } as any);
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      registries: { toolRegistry },
    });
    const execState: any = {
      phase: "wait_llm",
      turn: 1,
      tools: [
        {
          type: "function",
          function: { name: "ReadFile", description: "read", parameters: { type: "object" } },
        },
      ],
      toolCalls: [],
      toolIndex: 0,
      nextOpSeq: 2,
      pendingToolResults: [],
      pendingAiGenerated: [],
      inflight: { kind: "llm", opId: "llm:fiber-main:1", turn: 1, tools: [] },
      messageHistoryAttached: false,
    };
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId: "fiber-main", vm, actor, messages: actor.messages, basePriority: 1, execState }],
      runStep: async (ctx, helpers) => await aiAgentCooperativeStep({
        fiberId: ctx.fiberId,
        vm: ctx.vm,
        actor: ctx.actor,
        messages: ctx.messages,
        state: ctx.execState,
        setState: (next) => {
          ctx.execState = next;
        },
        resumeFiber: helpers.resume,
        emitFiberSignal: helpers.emitFiberSignal,
      }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });
    const signal = driver.emitFiberSignal({
      fiberId: "fiber-main",
      signalKind: "async_completed",
      mailbox: {
        kind: "asyncCompletion",
        payload: {
          kind: "llm_done",
          opId: "llm:fiber-main:1",
          msg: { role: "assistant", content: null },
        } as any,
      },
      idempotencyKey: "fiber-main:llm:fiber-main:1:asyncCompletion",
      createdAt: 123,
    });
    if (signal) {
      actor.drainMailbox("asyncCompletion");
      actor.send("asyncCompletion", {
        kind: "llm_done",
        opId: "llm:fiber-main:1",
        msg: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-read",
              type: "function",
              function: { name: "ReadFile", arguments: "{}" },
            },
          ],
        },
      } as any);
    }
    expect(vm.sessionState.controlSignals.consumedEventIds[signal!.eventId]).toBe(true);
    expect(driver.getState().fibers["fiber-main"]?.status).toBe("ready");

    try {
      const result = await saveAiAgentRuntimeSnapshot({
        sessionDir,
        sessionId: "session-consumed-async-mailbox",
        vm,
        driver,
      });

      expect(result.status).toBe("skipped_non_safepoint");
      expect(fs.existsSync(path.join(sessionDir, "runtime_state", "manifest.json"))).toBe(false);
      expect(readFileCalls).toBe(0);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("uses typed wait reasons for cooperative async boundaries", async () => {
    const cases = [
      {
        phase: "wait_llm",
        inflight: { kind: "llm", opId: "llm:fiber-main:1", turn: 1, tools: [] },
        expected: "wait_llm_result",
      },
      {
        phase: "wait_tool",
        inflight: { kind: "tool", opId: "tool:fiber-main:1", funcName: "example", toolCallId: "call-1", args: {} },
        expected: "wait_tool_result",
      },
      {
        phase: "compress",
        inflight: { kind: "compress", opId: "compress:fiber-main:1" },
        expected: "wait_compress_result",
      },
      {
        phase: "wait_questionnaire_parse",
        inflight: {
          kind: "questionnaire_parse",
          opId: "qparse:fiber-main:1",
          questionnaireId: "q-1",
          toolCallId: "call-1",
          rawText: "A",
        },
        expected: "wait_questionnaire_parse",
      },
    ];

    for (const testCase of cases) {
      const actor = createActor({ key: "main" });
      const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
      const state: any = {
        phase: testCase.phase,
        turn: 1,
        tools: [],
        toolCalls: [],
        toolIndex: 0,
        nextOpSeq: 2,
        pendingToolResults: [],
        pendingAiGenerated: [],
        inflight: testCase.inflight,
        messageHistoryAttached: false,
      };

      const outcome = await aiAgentCooperativeStep({
        fiberId: "fiber-main",
        vm,
        actor,
        messages: actor.messages,
        state,
        setState: (next) => {
          Object.assign(state, next);
        },
        resumeFiber: () => {},
      });

      expect(outcome).toMatchObject({ kind: "suspend", reason: testCase.expected });
    }
  });

  it("keeps stale async completions from satisfying a newer wait op", async () => {
    const actor = createActor({
      key: "main",
      mailboxes: {
        asyncCompletion: [
          {
            kind: "llm_done",
            opId: "llm:fiber-main:old",
            msg: { role: "assistant", content: "stale" },
          },
        ],
      },
    });
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } });
    const state: any = {
      phase: "wait_llm",
      turn: 1,
      tools: [],
      toolCalls: [],
      toolIndex: 0,
      nextOpSeq: 2,
      pendingToolResults: [],
      pendingAiGenerated: [],
      inflight: { kind: "llm", opId: "llm:fiber-main:new", turn: 1, tools: [] },
      messageHistoryAttached: false,
    };

    const outcome = await aiAgentCooperativeStep({
      fiberId: "fiber-main",
      vm,
      actor,
      messages: actor.messages,
      state,
      setState: (next) => {
        Object.assign(state, next);
      },
      resumeFiber: () => {},
    });

    expect(outcome).toMatchObject({ kind: "suspend", reason: "wait_llm_result" });
    expect(actor.messages).toEqual([]);
  });
});
