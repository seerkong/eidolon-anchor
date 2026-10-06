import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentEventGraph, createActor, createVM, emitDurableControlSignal, serializeActor, serializeVM } from "@cell/ai-core-logic";
import type { ExecutionOrigin } from "@cell/ai-core-contract/runtime/ExecutionOrigin";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import {
  appendLiveHistoryMessageToConversationDomainRuntime, configureRuntimePersistenceSupport,
  createAiAgentOrchestratorDriver, ensureVmToolCallDomain,
  recoverAiAgentRuntime, saveAiAgentRuntimeSnapshot,
} from "@cell/ai-organ-logic";
import { LocalFileConversationPersistenceRepositoryFactory, LocalFileRuntimeDerivedIndexesStore, LocalFileRuntimeSnapshotRepositoryFactory } from "@cell/ai-support";
import { quarantineWebExecutionOnRecovery } from "@cell/ai-organ-logic/persistence/ExecutionOriginRecovery";
import { appendRuntimeControlEffectEvidence } from "../../cell/packages/ai-file-store-logic/src/index";

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
});

describe("Web execution origin owner recovery", () => {
  it("reads Web intent after the checkpoint before reviving an older TUI snapshot", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-origin-wal-"));
    const actor = createActor({ key: "main", id: "main-actor", execution: { originSchemaVersion: 1,
      origin: { source: "tui", sessionId: "wal-session", actorId: "main-actor" }, status: "settled" } });
    const vm = createVM({ controlActorKey: actor.key, actors: { main: actor }, outerCtx: { workDir: sessionDir } });
    const driver = createAiAgentOrchestratorDriver({ fibers: [{ fiberId: "main", vm, actor, messages: [], basePriority: 1 }],
      runStep: async () => ({ kind: "complete" }) });
    driver.suspendFiber("main", Date.now(), "idle_external" as any);
    const origin: ExecutionOrigin = { source: "web", sessionId: "wal-session", actorId: actor.id,
      epoch: "old", commandId: "new-web-command", turnId: "new-web-turn", principalId: "principal" };
    try {
      expect((await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId: "wal-session", vm, driver })).status).toBe("saved");
      await appendRuntimeControlEffectEvidence({ sessionDir, event: { kind: "request", effectKind: "provider_completion",
        effectId: "web-attempt", handlerKey: "llm:test", idempotencyKey: "web-attempt", sourceCommandId: "new-web-command",
        executionOrigin: origin, originSchemaVersion: 1, payload: { actorKey: actor.key, actorId: actor.id } } });
      const recovered = await recoverAiAgentRuntime({ sessionDir, sessionId: "wal-session", eventBus: new AgentEventGraph(), registries: { toolRegistry: new ToolFuncRegistry() } });
      expect(recovered!.controlActor.execution?.status).toBe("interrupted");
      expect(recovered!.controlActor.execution?.origin).toEqual(origin);
    } finally { fs.rmSync(sessionDir, { recursive: true, force: true }); }
  });

  it("preserves explicit TUI continuation and legacy mailboxes after historical Web ownership", () => {
    const actor = createActor({ key: "main", id: "main-actor", execution: { originSchemaVersion: 1,
      origin: { source: "tui", sessionId: "session", actorId: "main-actor" }, status: "active", webOwned: true } });
    actor.send("humanInput", "explicit TUI");
    const legacy = createActor({ key: "legacy" });
    legacy.send("humanInput", "legacy TUI");
    const vm = createVM({ controlActorKey: actor.key, actors: { main: actor, legacy } });
    const material = { vm: serializeVM(vm), actors: { main: serializeActor(actor), legacy: serializeActor(legacy) }, fibers: {} };
    expect(quarantineWebExecutionOnRecovery(material).size).toBe(0);
    expect(material.actors.main.mailboxes.humanInput).toEqual(["explicit TUI"]);
    expect(material.actors.legacy.mailboxes.humanInput).toEqual(["legacy TUI"]);
  });

  it("retains a fully settled Web turn without relabelling it interrupted", () => {
    const origin: ExecutionOrigin = { source: "web", sessionId: "session", actorId: "finished", epoch: "epoch",
      commandId: "finished-command", turnId: "finished-turn", principalId: "principal" };
    const actor = createActor({ key: "finished", id: "finished", type: "interactive",
      execution: { originSchemaVersion: 1, origin, status: "settled", webOwned: true } });
    const vm = createVM({ controlActorKey: actor.key, actors: { finished: actor } });
    const material = { vm: serializeVM(vm), actors: { finished: serializeActor(actor) }, fibers: {
      finished: { version: 4, fiberId: "finished", actorKey: "finished", status: "suspended", waitingReason: "idle_external",
        executionOrigin: origin, originSchemaVersion: 1 as const },
    } };
    expect(quarantineWebExecutionOnRecovery(material).size).toBe(0);
    expect(material.actors.finished.execution?.status).toBe("settled");
  });

  for (const window of ["before_delivery", "after_delivery", "after_human_commit", "after_tool_effect"] as const) {
    it(`quarantines ${window} before any resumed provider or tool work`, async () => {
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-origin-recovery-"));
      const sessionId = path.basename(sessionDir);
      const origin: ExecutionOrigin = { source: "web", sessionId, actorId: "interactive-web", epoch: "old-epoch",
        commandId: "command-1", turnId: "turn-1", principalId: "principal-1" };
      const actor = createActor({ key: "interactive:web", id: origin.actorId, type: "interactive",
        execution: { originSchemaVersion: 1, origin, status: "active", webOwned: true } });
      const eventBus = new AgentEventGraph();
      const registry = new ToolFuncRegistry();
      const vm = createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor }, eventBus,
        registries: { toolRegistry: registry }, outerCtx: { workDir: sessionDir, metadata: { sessionDir, sessionId } } });
      const driver = createAiAgentOrchestratorDriver({
        fibers: [{ fiberId: "web-fiber", vm, actor, messages: actor.messages, basePriority: 1, lane: "interactive" }],
        runStep: async () => ({ kind: "complete" }),
      });
      driver.suspendFiber("web-fiber", Date.now(), "idle_external" as any);
      const signal = emitDurableControlSignal(vm.sessionState.controlSignals, {
        actorKey: actor.key, actorId: actor.id, fiberId: "web-fiber", mailboxKind: "humanInput",
        signalKind: "mailbox_enqueue", payload: "same text", idempotencyKey: origin.commandId,
        executionOrigin: origin, originSchemaVersion: 1,
      }).signal;
      if (window !== "before_delivery") actor.send("humanInput", "same text");
      if (window === "after_human_commit" || window === "after_tool_effect") {
        appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: actor.key, actorId: actor.id,
          message: { role: "user", content: "same text", executionOrigin: origin, originSchemaVersion: 1 } });
      }
      const effectFile = path.join(sessionDir, "effect-count");
      if (window === "after_tool_effect") {
        // A concrete external effect has already happened. Recovery must not
        // synthesize another invocation from its queued completion.
        registry.register({
          schema: { type: "function", function: { name: "external_write", description: "durable test effect", parameters: { type: "object" } } },
          briefPromptXnl: "<tool name=\"external_write\" />", resourceEffect: "workspace_mutation",
          run: async () => {
            const count = fs.existsSync(effectFile) ? Number(fs.readFileSync(effectFile, "utf8")) : 0;
            fs.writeFileSync(effectFile, String(count + 1));
            return "written";
          },
        });
        const tools = ensureVmToolCallDomain(vm);
        tools.planTool({ toolCallId: "effect-1", actorKey: actor.key, turnId: 1, funcName: "external_write", args: {}, at: 1, executionOrigin: origin });
        tools.recordGateDecision({ toolCallId: "effect-1", gateOutcome: "allow", at: 2 });
        tools.markExecuting({ toolCallId: "effect-1", at: 3 });
        const output = await registry.call("external_write", vm, actor, {}, { toolCallId: "effect-1" });
        tools.recordResult({ toolCallId: "effect-1", outputText: String(output), at: 4 });
        actor.send("asyncCompletion", { kind: "tool_done", opId: "effect-1", toolCallId: "effect-1", output: "written" } as any);
      }
      let providerCalls = 0;
      try {
        expect((await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })).status).toBe("saved");
        const recovered = await recoverAiAgentRuntime({ sessionDir, sessionId, eventBus: new AgentEventGraph(), registries: { toolRegistry: registry },
          llmClient: { type: "openai", createStream: async () => { providerCalls++; throw new Error("must not replay"); } } });
        expect(recovered).not.toBeNull();
        const restored = recovered!.controlActor;
        expect(restored.type).toBe("interactive");
        expect(restored.id).toBe(origin.actorId);
        expect(restored.execution?.status).toBe("interrupted");
        expect(restored.execution?.quarantine?.reason).toBe("web_execution_recovery_interrupted");
        expect(restored.peekMailbox("humanInput")).toEqual([]);
        expect(restored.peekMailbox("asyncCompletion")).toEqual([]);
        expect(recovered!.vm.sessionState.controlSignals.consumedEventIds[signal.eventId]).toBe(true);
        // Direct wake/heartbeat cannot bypass owner quarantine.
        expect(recovered!.driver.emitFiberSignal({ fiberId: "web-fiber", signalKind: "resume_requested" })).toBeNull();
        recovered!.driver.resumeFiber("web-fiber", Date.now());
        await recovered!.driver.tickUntilForegroundSettled({ now: Date.now(), maxWallMs: 100 });
        expect(providerCalls).toBe(0);
        if (window === "after_human_commit" || window === "after_tool_effect") {
          const users = restored.messages.filter((message) => message.role === "user");
          expect(users).toHaveLength(1);
          expect(users[0]!.executionOrigin).toEqual(origin);
        }
        if (window === "after_tool_effect") expect(fs.readFileSync(effectFile, "utf8")).toBe("1");
      } finally {
        eventBus.dispose();
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    });
  }

  for (const secondCommitted of [false, true]) it(`keeps identical-text intents distinct across recovery (second committed: ${secondCommitted})`, async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-origin-pair-"));
    const sessionId = path.basename(sessionDir);
    const first: ExecutionOrigin = { source: "web", sessionId, actorId: "pair-actor", epoch: "before-crash",
      commandId: "first-command", turnId: "first-turn", principalId: "owner" };
    const second: ExecutionOrigin = { ...first, commandId: "second-command", turnId: "second-turn" };
    const actor = createActor({ key: "pair", id: first.actorId, type: "interactive",
      execution: { originSchemaVersion: 1, origin: second, status: "active", webOwned: true } });
    const events = new AgentEventGraph();
    const vm = createVM({ controlActorKey: actor.key, actors: { pair: actor }, eventBus: events,
      outerCtx: { workDir: sessionDir, metadata: { sessionDir, sessionId } } });
    const driver = createAiAgentOrchestratorDriver({ fibers: [{ fiberId: "pair", vm, actor, messages: actor.messages, basePriority: 1 }],
      runStep: async () => ({ kind: "complete" }) });
    driver.suspendFiber("pair", Date.now(), "idle_external" as any);
    const signals = [first, second].map(origin => emitDurableControlSignal(vm.sessionState.controlSignals, {
      actorKey: actor.key, actorId: actor.id, fiberId: "pair", mailboxKind: "humanInput", signalKind: "mailbox_enqueue",
      payload: "identical text", idempotencyKey: origin.commandId, executionOrigin: origin, originSchemaVersion: 1,
    }).signal);
    expect(signals[0].eventId).not.toBe(signals[1].eventId);
    for (const origin of secondCommitted ? [first, second] : [first]) {
      appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: actor.key, actorId: actor.id,
        message: { role: "user", content: "identical text", executionOrigin: origin, originSchemaVersion: 1 } });
    }
    if (!secondCommitted) actor.send("humanInput", "identical text");
    let calls = 0;
    try {
      expect((await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })).status).toBe("saved");
      const recovered = await recoverAiAgentRuntime({ sessionDir, sessionId, eventBus: new AgentEventGraph(),
        registries: { toolRegistry: new ToolFuncRegistry() },
        llmClient: { type: "openai", createStream: async () => { calls++; throw new Error("must not replay either intent"); } } });
      const messages = recovered!.controlActor.messages.filter(message => message.role === "user");
      expect(messages.map(message => message.executionOrigin)).toEqual(secondCommitted ? [first, second] : [first]);
      expect(recovered!.controlActor.peekMailbox("humanInput")).toEqual([]);
      expect(recovered!.controlActor.execution?.origin).toEqual(second);
      expect(recovered!.controlActor.execution?.status).toBe("interrupted");
      for (const signal of signals) expect(recovered!.vm.sessionState.controlSignals.consumedEventIds[signal.eventId]).toBe(true);
      recovered!.driver.resumeFiber("pair", Date.now());
      await recovered!.driver.tickUntilForegroundSettled({ now: Date.now(), maxWallMs: 100 });
      expect(calls).toBe(0);
    } finally { events.dispose(); fs.rmSync(sessionDir, { recursive: true, force: true }); }
  });

  it("fails closed for required new-format missing origin and invalidates child continuations and questions", () => {
    const actor = createActor({ key: "root", id: "root-web", type: "interactive" });
    actor.send("humanInput", "unknown origin");
    const child = createActor({ key: "child", id: "child-web", parentKey: actor.key, type: "delegate" });
    child.send("asyncCompletion", { kind: "llm_done", opId: "old" } as any);
    const vm = createVM({ controlActorKey: actor.key, actors: { root: actor, child } });
    const material = {
      vm: { ...serializeVM(vm), executionOrigins: { originSchemaVersion: 1 as const, webActorIds: [actor.id] } },
      actors: { root: serializeActor(actor), child: serializeActor(child) },
      fibers: {
        root: { version: 4, fiberId: "root", actorKey: "root", status: "ready" },
        child: { version: 4, fiberId: "child", actorKey: "child", parentFiberId: "root", status: "ready",
          metadata: { cooperativeExecState: { phase: "tools", toolCalls: [{ id: "old" }] } } },
      },
      questionnaires: [{ questionnaireId: "question-1", ownerActorKey: "child", toolCallId: "old", status: "pending",
        request: { questionnaireId: "question-1", toolCallId: "old", kind: "form", suspendPolicy: "pause_all", questions: [] },
        suspendPolicy: "pause_all" }] as any[],
    };
    expect([...quarantineWebExecutionOnRecovery(material)].sort()).toEqual(["child", "root"]);
    expect(material.actors.root.execution?.quarantine?.reason).toBe("execution_origin_unknown");
    expect(material.actors.child.mailboxes.asyncCompletion).toEqual([]);
    expect(material.fibers.child.metadata.cooperativeExecState).toBeNull();
    expect(material.questionnaires[0].status).toBe("invalidated");
  });
});
