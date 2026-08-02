import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolDef } from "@cell/ai-core-contract/types";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import {
  __setCompressionDepsForTest,
  aiAgentCooperativeStep,
  aiAgentLoopStreaming,
  seedConversationDomainFromActorSeedMessages,
} from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  ensureVmConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  synchronizeConversationDomainActorFromPersistence,
} from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime";
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";
import {
  LocalFileConversationPersistenceRepositoryFactory,
  loadConversationSessionRawState,
} from "@cell/ai-support";
import { createMockProcessStream } from "./__test_support__/mockProcessStream";

const LARGE_ARTIFACT_TEXT = "ARTIFACT_SELECTED_CONTENT_".repeat(1_120);

function makeLargeLegacyHistory(): any[] {
  return Array.from({ length: 16 }, (_, index) => {
    const toolCallId = `legacy-call-${index}`;
    return [
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: { name: "LegacyRead", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: toolCallId,
        content: `LEGACY_${index}_` + "x".repeat(9_000),
      },
    ];
  }).flat();
}

function makeArtifactReadTool(): ToolDef<any, string, Record<string, unknown>> {
  return {
    schema: {
      type: "function",
      function: {
        name: "ReadArtifact",
        description: "read a persisted text artifact",
        parameters: { type: "object", properties: {} },
      },
    },
    briefPromptXnl: "<tool name=\"ReadArtifact\" />",
    run: async () => LARGE_ARTIFACT_TEXT,
  };
}

function toolResultDeliveries(vm: any): any[] {
  const raw = getConversationActorRawStateFromVm({ vm, actorKey: "main" });
  return raw?.session.contextAssets
    ?.flatMap((asset: any) => asset.toolResultDeliveryFact?.deliveries ?? [])
    ?? [];
}

function makeRuntime(params: {
  sessionDir: string;
  sessionId: string;
  providerRequests: any[];
  processStream: (
    vm?: any,
    actor?: any,
    stream?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<any> | any;
  compactionThresholdTokens?: number;
  compressionSummary?: string;
}) {
  const tool = makeArtifactReadTool();
  const adapter = {
    type: "openai" as const,
    runtime: {
      adapterName: "openai-responses",
      providerId: "tool-result-delivery-test",
    },
    async createStream(options?: any) {
      params.providerRequests.push(options ?? {});
      async function* stream() {
        if (
          params.compressionSummary
          && Array.isArray(options?.tools)
          && options.tools.length === 0
        ) {
          yield { type: "text-delta", text: params.compressionSummary };
          return;
        }
        yield { ok: true };
      }
      return { stream: stream() };
    },
  };
  const actor = createActor({
    key: "main",
    llmClient: adapter,
    modelConfig: {
      model: "mock",
      inputLimit: 300_000,
      capabilities: params.compactionThresholdTokens
        ? {
            cachePolicy: {
              compactionThresholdTokens: params.compactionThresholdTokens,
            },
          }
        : undefined,
    },
    callbacks: {
      buildToolset: () => [tool.schema],
      processStream: createMockProcessStream(params.processStream),
    },
  });
  const toolRegistry = new ToolFuncRegistry();
  toolRegistry.register(tool);
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    registries: { toolRegistry },
    eventBus: new AgentEventGraph(),
    outerCtx: {
      workDir: process.cwd(),
      conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      metadata: {
        sessionDir: params.sessionDir,
        sessionId: params.sessionId,
      },
    },
  });
  return { actor, tool, vm };
}

function artifactFilesFor(sessionDir: string, toolCallId: string): string[] {
  const artifactDir = path.join(sessionDir, "artifacts", "tool-results", "main");
  if (!fs.existsSync(artifactDir)) return [];
  return fs.readdirSync(artifactDir).filter((name) => name.startsWith(`${toolCallId}-`));
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function persistConversationActorState(params: {
  sessionDir: string;
  raw: NonNullable<ReturnType<typeof getConversationActorRawStateFromVm>>;
}): Promise<ReturnType<typeof LocalFileConversationPersistenceRepositoryFactory.createRepository>> {
  const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(params.sessionDir);
  const generations = new Map(
    [
      ...params.raw.visibleHistoryGenerations,
      params.raw.activeHistoryGeneration,
    ]
      .filter((generation): generation is NonNullable<typeof generation> => Boolean(generation))
      .map((generation) => [generation.generationId, generation]),
  );
  for (const generation of generations.values()) {
    await repository.writeHistoryGeneration(generation);
  }
  if (params.raw.promptGeneration) {
    await repository.writePromptGeneration(params.raw.promptGeneration);
  }
  await repository.writeHistoryIndex(params.raw.session.historyIndex);
  await repository.writePromptIndex(params.raw.session.promptIndex);
  await repository.writeSessionIndex(params.raw.session.sessionIndex);
  return repository;
}

describe("tool result first provider delivery", () => {
  it("keeps a live artifact read complete until its first successful streaming provider delivery", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-result-delivery-streaming-"));
    const providerRequests: any[] = [];
    let providerTurn = 0;
    const { actor, vm } = makeRuntime({
      sessionDir,
      sessionId: "tool-result-delivery-streaming",
      providerRequests,
      processStream: () => {
        providerTurn += 1;
        return providerTurn === 1
          ? {
              role: "assistant",
              tool_calls: [{
                id: "artifact-read-live",
                function: { name: "ReadArtifact", arguments: "{}" },
              }],
            }
          : { role: "assistant", content: "consumed artifact" };
      },
    });

    try {
      await aiAgentLoopStreaming({
        vm,
        actor,
        messages: [
          ...makeLargeLegacyHistory(),
          { role: "user", content: "read the persisted artifact" },
        ],
      });

      expect(providerRequests).toHaveLength(2);
      const firstDeliveryRequest = JSON.stringify(providerRequests[1]?.messages ?? []);
      expect(firstDeliveryRequest).toContain(LARGE_ARTIFACT_TEXT);
      expect(firstDeliveryRequest).not.toContain("artifact-read-live-");
      expect(artifactFilesFor(sessionDir, "artifact-read-live")).toEqual([]);
      expect(toolResultDeliveries(vm)).toEqual([
        expect.objectContaining({
          toolCallId: "artifact-read-live",
          deliveryState: "delivered",
        }),
      ]);
      const providerShape = JSON.stringify(providerRequests[1]);
      expect(providerRequests[1]?.providerRequestContext).toBeDefined();
      expect(providerShape).not.toContain("toolResultDeliveryFact");
      expect(providerShape).not.toContain("\"deliveryState\"");
      expect(providerShape).not.toContain("artifact-read-live\":\"pending");
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("spills an oversized pending first delivery to an artifact instead of failing prompt preflight", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-result-delivery-oversized-"));
    const providerRequests: any[] = [];
    let providerTurn = 0;
    const { actor, vm } = makeRuntime({
      sessionDir,
      sessionId: "tool-result-delivery-oversized",
      providerRequests,
      processStream: () => {
        providerTurn += 1;
        return providerTurn === 1
          ? {
              role: "assistant",
              tool_calls: [{
                id: "artifact-read-oversized",
                function: { name: "ReadArtifact", arguments: "{}" },
              }],
            }
          : { role: "assistant", content: "consumed oversized artifact reference" };
      },
    });
    actor.modelConfig.inputLimit = 5_000;
    __setCompressionDepsForTest({
      estimateUsageRatio: () => 2,
      compressHistory: async () => null,
    });

    try {
      await aiAgentLoopStreaming({
        vm,
        actor,
        messages: [{ role: "user", content: "read the oversized artifact" }],
      });

      expect(providerRequests).toHaveLength(2);
      const firstDeliveryRequest = JSON.stringify(providerRequests[1]?.messages ?? []);
      expect(firstDeliveryRequest).not.toContain(LARGE_ARTIFACT_TEXT);
      expect(firstDeliveryRequest).toContain("pending_first_delivery_compacted");
      expect(firstDeliveryRequest).toContain("Full output persisted at:");
      expect(firstDeliveryRequest).toContain("artifact-read-oversized");

      const artifactFiles = artifactFilesFor(sessionDir, "artifact-read-oversized");
      expect(artifactFiles).toHaveLength(1);
      expect(fs.readFileSync(
        path.join(sessionDir, "artifacts", "tool-results", "main", artifactFiles[0]!),
        "utf8",
      )).toBe(LARGE_ARTIFACT_TEXT);
      expect(toolResultDeliveries(vm)).toEqual([
        expect.objectContaining({
          toolCallId: "artifact-read-oversized",
          deliveryState: "delivered",
        }),
      ]);
    } finally {
      __setCompressionDepsForTest(null);
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("keeps a failed provider delivery pending across conversation persistence and recovery", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-result-delivery-recovery-"));
    const providerRequests: any[] = [];
    let providerTurn = 0;
    const { actor, vm } = makeRuntime({
      sessionDir,
      sessionId: "tool-result-delivery-recovery",
      providerRequests,
      processStream: () => {
        providerTurn += 1;
        if (providerTurn === 1) {
          return {
            role: "assistant",
            tool_calls: [{
              id: "artifact-read-retry",
              function: { name: "ReadArtifact", arguments: "{}" },
            }],
          };
        }
        throw new Error("provider unavailable");
      },
    });

    try {
      await expect(aiAgentLoopStreaming({
        vm,
        actor,
        messages: [
          ...makeLargeLegacyHistory(),
          { role: "user", content: "read and recover" },
        ],
      })).rejects.toThrow("provider unavailable");

      expect(JSON.stringify(providerRequests[1]?.messages ?? [])).toContain(LARGE_ARTIFACT_TEXT);
      expect(toolResultDeliveries(vm)).toEqual([
        expect.objectContaining({
          toolCallId: "artifact-read-retry",
          deliveryState: "pending",
        }),
      ]);

      const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key });
      const repository = await persistConversationActorState({ sessionDir, raw: raw! });
      const recovered = await loadConversationSessionRawState({ sessionDir, repository });
      const recoveredDeliveries = recovered.contextAssets
        ?.flatMap((asset: any) => asset.toolResultDeliveryFact?.deliveries ?? [])
        ?? [];
      expect(recoveredDeliveries).toEqual([
        expect.objectContaining({
          toolCallId: "artifact-read-retry",
          deliveryState: "pending",
        }),
      ]);
      expect(artifactFilesFor(sessionDir, "artifact-read-retry")).toEqual([]);

      const recoveredProviderRequests: any[] = [];
      const recoveredRuntime = makeRuntime({
        sessionDir,
        sessionId: path.basename(sessionDir),
        providerRequests: recoveredProviderRequests,
        compactionThresholdTokens: 80_000,
        compressionSummary: "<state_snapshot><overall_goal>recovered delivery retry</overall_goal></state_snapshot>",
        processStream: () => ({ role: "assistant", content: "recovered delivery consumed" }),
      });
      await synchronizeConversationDomainActorFromPersistence({
        runtime: ensureVmConversationDomainRuntime(recoveredRuntime.vm),
        sessionDir,
        actorKey: recoveredRuntime.actor.key,
        repository,
      });
      for (let index = 0; index < 4; index += 1) {
        appendLiveHistoryMessageToConversationDomainRuntime({
          vm: recoveredRuntime.vm,
          actorKey: recoveredRuntime.actor.key,
          actorId: recoveredRuntime.actor.id,
          message: {
            role: "user",
            content: index === 0
              ? `RECOVERY_INPUT_${index}_` + "z".repeat(72_000)
              : `RECOVERY_INPUT_${index}`,
          } as any,
        });
      }

      __setCompressionDepsForTest({ estimateUsageRatio: () => 0.9 });
      await aiAgentLoopStreaming({
        vm: recoveredRuntime.vm,
        actor: recoveredRuntime.actor,
        messages: [],
      });

      const nextProviderRequest = recoveredProviderRequests.find((request) => (
        Array.isArray(request?.tools) && request.tools.length > 0
      ));
      const nextProviderMessages = JSON.stringify(nextProviderRequest?.messages ?? []);
      expect(nextProviderMessages).toContain("\"id\":\"artifact-read-retry\"");
      expect(nextProviderMessages).toContain(LARGE_ARTIFACT_TEXT);
      expect(toolResultDeliveries(recoveredRuntime.vm)).toEqual([
        expect.objectContaining({
          toolCallId: "artifact-read-retry",
          deliveryState: "delivered",
        }),
      ]);
    } finally {
      __setCompressionDepsForTest(null);
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("keeps an aborted provider delivery pending", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-result-delivery-abort-"));
    const providerRequests: any[] = [];
    let providerTurn = 0;
    let runtimeActor: any;
    let secondProviderStarted!: () => void;
    const secondProviderStart = new Promise<void>((resolve) => {
      secondProviderStarted = resolve;
    });
    const runtime = makeRuntime({
      sessionDir,
      sessionId: "tool-result-delivery-abort",
      providerRequests,
      processStream: async (_vm, _actor, _stream, options) => {
        providerTurn += 1;
        if (providerTurn === 1) {
          return {
            role: "assistant",
            tool_calls: [{
              id: "artifact-read-aborted",
              function: { name: "ReadArtifact", arguments: "{}" },
            }],
          };
        }
        secondProviderStarted();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("provider aborted")),
            { once: true },
          );
        });
        return { role: "assistant", content: "unreachable" };
      },
    });
    runtimeActor = runtime.actor;

    try {
      const loop = aiAgentLoopStreaming({
        vm: runtime.vm,
        actor: runtimeActor,
        messages: [
          ...makeLargeLegacyHistory(),
          { role: "user", content: "read then abort" },
        ],
      });
      await secondProviderStart;
      runtimeActor.llmAbortController?.abort();
      await expect(loop).rejects.toThrow("provider aborted");

      expect(JSON.stringify(providerRequests[1]?.messages ?? [])).toContain(LARGE_ARTIFACT_TEXT);
      expect(toolResultDeliveries(runtime.vm)).toEqual([
        expect.objectContaining({
          toolCallId: "artifact-read-aborted",
          deliveryState: "pending",
        }),
      ]);
      expect(artifactFilesFor(sessionDir, "artifact-read-aborted")).toEqual([]);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("uses the same first-delivery protection and confirmation in cooperative execution", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-result-delivery-cooperative-"));
    const providerRequests: any[] = [];
    let providerTurn = 0;
    const { actor, vm } = makeRuntime({
      sessionDir,
      sessionId: "tool-result-delivery-cooperative",
      providerRequests,
      processStream: () => {
        providerTurn += 1;
        return providerTurn === 1
          ? {
              role: "assistant",
              tool_calls: [{
                id: "artifact-read-cooperative",
                function: { name: "ReadArtifact", arguments: "{}" },
              }],
            }
          : { role: "assistant", content: "cooperative consumed artifact" };
      },
    });
    seedConversationDomainFromActorSeedMessages({
      vm,
      actor,
      seedMessages: makeLargeLegacyHistory(),
    });
    const fiberId = `${actor.key}:${actor.id}`;
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }],
      runStep: async (context, helpers) => aiAgentCooperativeStep({
        fiberId: context.fiberId,
        vm: context.vm,
        actor: context.actor,
        messages: context.messages,
        state: context.execState,
        setState: (state) => {
          context.execState = state;
        },
        resumeFiber: helpers.resume,
      }),
    });
    actor.send("humanInput", "read the artifact cooperatively");

    try {
      for (let step = 0; step < 100; step += 1) {
        driver.tick(Date.now());
        await flushAsyncWork();
        if (toolResultDeliveries(vm).some((fact) => fact.deliveryState === "delivered")) break;
      }

      expect(providerRequests).toHaveLength(2);
      expect(JSON.stringify(providerRequests[1]?.messages ?? [])).toContain(LARGE_ARTIFACT_TEXT);
      expect(toolResultDeliveries(vm)).toEqual([
        expect.objectContaining({
          toolCallId: "artifact-read-cooperative",
          deliveryState: "delivered",
        }),
      ]);
      expect(artifactFilesFor(sessionDir, "artifact-read-cooperative")).toEqual([]);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("keeps cooperative execution alive when a pending first delivery exceeds the context limit", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-result-delivery-cooperative-oversized-"));
    const providerRequests: any[] = [];
    let providerTurn = 0;
    const { actor, vm } = makeRuntime({
      sessionDir,
      sessionId: "tool-result-delivery-cooperative-oversized",
      providerRequests,
      processStream: () => {
        providerTurn += 1;
        return providerTurn === 1
          ? {
              role: "assistant",
              tool_calls: [{
                id: "artifact-read-cooperative-oversized",
                function: { name: "ReadArtifact", arguments: "{}" },
              }],
            }
          : { role: "assistant", content: "cooperative oversized result consumed" };
      },
    });
    actor.modelConfig.inputLimit = 5_000;
    __setCompressionDepsForTest({
      estimateUsageRatio: () => 2,
      compressHistory: async () => null,
    });
    const fiberId = `${actor.key}:${actor.id}`;
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }],
      runStep: async (context, helpers) => aiAgentCooperativeStep({
        fiberId: context.fiberId,
        vm: context.vm,
        actor: context.actor,
        messages: context.messages,
        state: context.execState,
        setState: (state) => {
          context.execState = state;
        },
        resumeFiber: helpers.resume,
      }),
    });
    actor.send("humanInput", "read the oversized artifact cooperatively");

    try {
      for (let step = 0; step < 100; step += 1) {
        driver.tick(Date.now());
        await flushAsyncWork();
        if (toolResultDeliveries(vm).some((fact) => fact.deliveryState === "delivered")) break;
      }

      expect(providerRequests).toHaveLength(2);
      expect(JSON.stringify(providerRequests[1]?.messages ?? [])).toContain("pending_first_delivery_compacted");
      expect(driver.getState().fibers[fiberId]?.status).not.toBe("failed");
      expect(toolResultDeliveries(vm)).toEqual([
        expect.objectContaining({
          toolCallId: "artifact-read-cooperative-oversized",
          deliveryState: "delivered",
        }),
      ]);
      expect(artifactFilesFor(sessionDir, "artifact-read-cooperative-oversized")).toHaveLength(1);
    } finally {
      __setCompressionDepsForTest(null);
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
