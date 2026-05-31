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
  LocalFileActorTranscriptStore,
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support";
import fs from "fs";
import os from "os";
import path from "path";

configureRuntimePersistenceSupport({
  actorTranscriptStore: LocalFileActorTranscriptStore,
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
      mailboxKind: "aiGenerated",
      signalKind: "mailbox_enqueue",
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
    expect(vm.sessionState.controlSignals.events).toHaveLength(1);
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
      payload: "resume from durable event",
      idempotencyKey: "recover-human-input",
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

      expect(recovered?.controlActor.peekMailbox("humanInput")).toEqual(["resume from durable event"]);
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
        aiGenerated: [
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
