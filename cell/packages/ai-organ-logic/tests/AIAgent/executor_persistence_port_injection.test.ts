import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import type { PersistenceWritePort } from "@cell/ai-core-contract/runtime/PersistencePorts";
import { aiAgentLoopStreaming } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { createMockProcessStream } from "./__test_support__/mockProcessStream";

/**
 * P3 (refactor-persistent-session-backplane):
 *  - the executor live path SHALL NOT read the persistence repository factory
 *    from the untyped `vm.outerCtx.metadata` channel (delta requirement
 *    `one-way-persistence-ports` / `explicit-injection`);
 *  - the executor live path SHALL NOT inline-await `recordAiRuntimeEffectLifecycleEvent`
 *    on the hot path — the effect-evidence WAL append goes through the injected
 *    write-behind port (`write-behind-non-blocking` / `executor-no-inline-io`);
 *  - a memory-only turn completes, and a write port whose backing throws does
 *    NOT abort the turn (`memory-only-completes`, failure non-fatal).
 */

function readExecutorSource(): string {
  // import.meta.dir = cell/packages/ai-organ-logic/tests/AIAgent
  const repoRoot = path.resolve(import.meta.dir, "../../../../..");
  const filePath = path.join(
    repoRoot,
    "cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts",
  );
  return fs.readFileSync(filePath, "utf-8");
}

describe("executor persistence port injection (source-level)", () => {
  it("does not read conversationPersistenceRepositoryFactory from outerCtx.metadata", () => {
    const source = readExecutorSource();
    // The implicit untyped channel `metadata.conversationPersistenceRepositoryFactory`
    // is killed: persistence arrives via an explicitly-injected typed field.
    expect(source.includes("metadata.conversationPersistenceRepositoryFactory")).toBe(false);
    expect(source.includes("conversationPersistenceRepositoryFactory as")).toBe(false);
  });

  it("does not inline-await recordAiRuntimeEffectLifecycleEvent on the hot path", () => {
    const source = readExecutorSource();
    // The effect-evidence WAL writer is no longer called directly from the
    // executor; it is enqueued through the injected write-behind port.
    expect(source.includes("recordAiRuntimeEffectLifecycleEvent")).toBe(false);
  });

  it("threads persistence via the explicitly-injected typed outerCtx port", () => {
    const source = readExecutorSource();
    // The capability is read from the typed outerCtx field, not the metadata bag.
    expect(source.includes("outerCtx?.persistenceWritePort")).toBe(true);
  });
});

const mockAdapter = {
  type: "openai" as const,
  async createStream() {
    async function* stream() {
      yield { ok: true };
    }
    return { stream: stream() };
  },
};

function createMemoryOnlyVm(params: {
  port?: PersistenceWritePort;
  processStream: () => Promise<any>;
}) {
  const actor = createActor({
    key: "main",
    llmClient: mockAdapter,
    modelConfig: { model: "mock-model" },
    callbacks: {
      buildToolset: () => [],
      processStream: createMockProcessStream(async () => params.processStream()),
    },
  });
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    registries: { toolRegistry: new ToolFuncRegistry() },
    eventBus: new AgentEventGraph(),
    // storage files + logs OFF → memory-only profile.
    options: { storage: { logs: false, files: false } },
    outerCtx: {
      metadata: { sessionId: "mem-only", sessionDir: "mem-only" },
      ...(params.port ? { persistenceWritePort: params.port } : {}),
    } as any,
    effects: {},
  });
  return { vm, actor };
}

describe("executor persistence write port (behavioral)", () => {
  it("completes a normal turn with storage off (no persistence configured)", async () => {
    const { vm, actor } = createMemoryOnlyVm({
      processStream: async () => ({ role: "assistant", content: "done" }),
    });
    const result = await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "hi" } as any] });
    expect(result).toBeDefined();
    expect(result.messages.some((m: any) => m?.role === "assistant")).toBe(true);
  });

  it("does not abort the turn when the injected write port backing throws", async () => {
    const throwingPort: PersistenceWritePort = {
      writeSnapshot() {
        throw new Error("snapshot write boom");
      },
      appendEffectEvidence() {
        throw new Error("evidence append boom");
      },
      persistCompaction() {
        throw new Error("compaction boom");
      },
    };
    const { vm, actor } = createMemoryOnlyVm({
      port: throwingPort,
      processStream: async () => ({ role: "assistant", content: "still done" }),
    });
    const result = await aiAgentLoopStreaming({ vm, actor, messages: [{ role: "user", content: "hi" } as any] });
    expect(result).toBeDefined();
    expect(result.messages.some((m: any) => m?.role === "assistant")).toBe(true);
  });
});

/**
 * P4 carry-forward (track refactor-persistent-session-backplane, P3 review):
 * the P3 throwing-port test above runs in memory-only mode (storage files OFF),
 * where `appendRuntimeControlLifecycleEvidenceFromVm` EARLY-RETURNS on
 * `!isRuntimeStorageFilesEnabled(vm)` BEFORE ever touching the port — so the
 * evidence-append throwing path is partially vacuous there. This test runs with
 * storage files ON and a real sessionDir, so the executor actually enqueues the
 * effect-evidence append through the injected port; we assert that a throwing
 * `appendEffectEvidence` STILL does not abort the turn (the production
 * write-behind non-fatal guarantee, behavior-delta `one-way-persistence-ports` /
 * `write-behind-non-blocking`).
 */
function createStorageOnVm(params: {
  sessionDir: string;
  port?: PersistenceWritePort;
  processStream: () => Promise<any>;
}) {
  const actor = createActor({
    key: "main",
    llmClient: mockAdapter,
    modelConfig: { model: "mock-model" },
    callbacks: {
      buildToolset: () => [],
      processStream: createMockProcessStream(async () => params.processStream()),
    },
  });
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    registries: { toolRegistry: new ToolFuncRegistry() },
    eventBus: new AgentEventGraph(),
    // storage files ON → `isRuntimeStorageFilesEnabled(vm)` is true, so the
    // executor reaches the effect-evidence enqueue (no early return). logs OFF
    // keeps the test from writing diagnostics files.
    options: { storage: { logs: false, files: true } },
    outerCtx: {
      // A real sessionDir so `getRuntimeControlSessionDir(vm)` is non-empty and
      // the evidence enqueue actually fires through the injected port.
      metadata: { sessionId: "storage-on", sessionDir: params.sessionDir },
      ...(params.port ? { persistenceWritePort: params.port } : {}),
    } as any,
    effects: {},
  });
  return { vm, actor };
}

describe("executor persistence write port (storage-on, behavioral)", () => {
  it("does not abort the turn when appendEffectEvidence throws with storage files ON", async () => {
    const sessionDir = path.join(
      os.tmpdir(),
      `eidolon-storage-on-throwing-port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    let appendCalls = 0;
    const throwingPort: PersistenceWritePort = {
      writeSnapshot() {
        throw new Error("snapshot write boom");
      },
      appendEffectEvidence() {
        // With storage ON the executor reaches HERE (it early-returned in the
        // memory-only test). A throw must remain non-fatal.
        appendCalls += 1;
        throw new Error("evidence append boom (storage on)");
      },
      persistCompaction() {
        throw new Error("compaction boom");
      },
    };
    try {
      const { vm, actor } = createStorageOnVm({
        sessionDir,
        port: throwingPort,
        processStream: async () => ({ role: "assistant", content: "still done with storage on" }),
      });
      const result = await aiAgentLoopStreaming({
        vm,
        actor,
        messages: [{ role: "user", content: "hi" } as any],
      });
      // The turn completed despite the throwing evidence append.
      expect(result).toBeDefined();
      expect(result.messages.some((m: any) => m?.role === "assistant")).toBe(true);
      // The throwing evidence path was actually exercised (NOT vacuous): the
      // executor reached the injected port at least once with storage ON.
      expect(appendCalls).toBeGreaterThan(0);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
