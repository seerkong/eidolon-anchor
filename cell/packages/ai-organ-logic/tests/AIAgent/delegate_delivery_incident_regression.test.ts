import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer";
import { buildRunDelegateActorToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/RunDelegateActor";
import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  ensureVmConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  materializeConversationRuntimeMessagesFromVm,
  synchronizeConversationDomainActorFromPersistence,
} from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime";
import { getDetachedActorRegistry } from "@cell/ai-organ-logic/detached/DetachedActorRegistry";
import {
  __setCompressionDepsForTest,
  aiAgentLoopStreaming,
  seedConversationDomainFromActorSeedMessages,
} from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver";
import { LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support";
import {
  createMockProcessStream,
  createMockProviderCacheCostObservation,
} from "./__test_support__/mockProcessStream";

const CHEAP_COMPACTION_BUDGET_BYTES = 120_000;
const DELEGATE_SUMMARY_PREFIX = "DETACHED_DELEGATE_INCIDENT_SUMMARY:";
const DELEGATE_SUMMARY = DELEGATE_SUMMARY_PREFIX
  + "S".repeat((26 * 1024) - DELEGATE_SUMMARY_PREFIX.length);

function makeOversizedLegacyHistory(): any[] {
  return Array.from({ length: 18 }, (_, index) => {
    const toolCallId = `incident-legacy-call-${index}`;
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
        content: `INCIDENT_LEGACY_${index}_` + "x".repeat(9_000),
      },
    ];
  }).flat();
}

function listFilesRecursively(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFilesRecursively(fullPath) : [fullPath];
  });
}

function requestMessagesText(request: any): string {
  return JSON.stringify(request?.messages ?? []);
}

function parseToolResult(messages: any[], toolCallId: string): any {
  const message = messages.find((candidate) => (
    candidate?.role === "tool"
    && (candidate?.tool_call_id ?? candidate?.toolCallId) === toolCallId
  ));
  return JSON.parse(String(message?.content ?? ""));
}

function messageDeliveries(vm: any): any[] {
  const raw = getConversationActorRawStateFromVm({ vm, actorKey: "main" });
  return raw?.session.contextAssets
    ?.flatMap((asset: any) => asset.messageDeliveryFact?.deliveries ?? [])
    ?? [];
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

describe("delegate result first-delivery incident regression", () => {
  it("keeps a failed 26KB detached childDone delivery pending through recovery and summary compaction", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-delivery-incident-"));
    const providerRequests: any[] = [];
    const parentTurns = new Map<string, number>();
    const runDelegateActor = buildRunDelegateActorToolDef();
    const legacyHistory = makeOversizedLegacyHistory();
    const legacyToolResultBytes = legacyHistory
      .filter((message) => message.role === "tool")
      .reduce((total, message) => total + Buffer.byteLength(String(message.content)), 0);

    const adapter = {
      type: "openai" as const,
      runtime: {
        adapterName: "openai-responses",
        providerId: "delegate-delivery-incident",
      },
      async createStream(options?: any) {
        providerRequests.push(options ?? {});
        async function* stream() {
          yield { ok: true };
        }
        return {
          stream: stream(),
          providerOutput: Promise.resolve({
            provider_cache_cost_observation: createMockProviderCacheCostObservation(options ?? {}),
          }),
        };
      },
    };

    const main = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: {
        model: "mock",
        inputLimit: 300_000,
        capabilities: {
          cachePolicy: {
            stablePrefix: true,
          },
        },
      },
      callbacks: {
        buildToolset: () => [runDelegateActor.schema],
        processStream: createMockProcessStream(async (_vm, actor) => {
          if (actor.type === "detached") {
            const prompt = actor.messages
              .filter((message: any) => message?.role === "user")
              .map((message: any) => String(message.content ?? ""))
              .join("\n");
            return {
              role: "assistant",
              content: prompt.includes("primary incident summary")
                ? DELEGATE_SUMMARY
                : `parallel child complete: ${prompt}`,
            };
          }

          const turn = (parentTurns.get(actor.key) ?? 0) + 1;
          parentTurns.set(actor.key, turn);
          if (turn === 1) {
            const delegateCall = (
              id: string,
              prompt: string,
              taskKey?: string,
            ) => ({
              id,
              function: {
                name: "RunDelegateActor",
                arguments: JSON.stringify({
                  description: prompt,
                  prompt,
                  agent_type: "code",
                  mode: "detached",
                  ...(taskKey ? { task_key: taskKey } : {}),
                }),
              },
            });
            return {
              role: "assistant",
              tool_calls: [
                delegateCall("tc-default-1", "primary incident summary"),
                delegateCall("tc-default-2", "rewritten duplicate request"),
                delegateCall("tc-key-a", "parallel incident branch A", "branch-a"),
                delegateCall("tc-key-b", "parallel incident branch B", "branch-b"),
              ],
            };
          }
          if (turn === 3) {
            throw new Error("parent provider unavailable after detached completion");
          }
          return {
            role: "assistant",
            content: "parent waiting for detached results",
          };
        }),
      },
    });

    const toolRegistry = composeToolRegistry();
    const vm = createVM({
      controlActorKey: main.key,
      actors: { [main.key]: main },
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: {
            name: "code",
            description: "incident regression delegate",
            tools: "*",
            prompt: ["You are the incident regression delegate."],
          },
        } as any),
      },
      outerCtx: {
        workDir: process.cwd(),
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
        metadata: {
          sessionDir,
          sessionId: path.basename(sessionDir),
        },
      },
    });
    seedConversationDomainFromActorSeedMessages({
      vm,
      actor: main,
      seedMessages: legacyHistory,
    });
    main.send("humanInput", "start the incident-shaped delegate turn");

    const mainFiberId = `${main.key}:${main.id}`;
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: main, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    });

    try {
      expect(legacyToolResultBytes).toBeGreaterThan(CHEAP_COMPACTION_BUDGET_BYTES);

      driver.resumeFiber(mainFiberId, Date.now());
      await driver.tickUntilForegroundSettled({
        now: Date.now(),
        maxTicks: 100,
        maxWallMs: 5_000,
      });

      const conversationAfterSpawn = materializeConversationRuntimeMessagesFromVm({
        vm,
        actorKey: main.key,
      });
      const firstDefault = parseToolResult(conversationAfterSpawn, "tc-default-1");
      const repeatedDefault = parseToolResult(conversationAfterSpawn, "tc-default-2");
      const keyedA = parseToolResult(conversationAfterSpawn, "tc-key-a");
      const keyedB = parseToolResult(conversationAfterSpawn, "tc-key-b");
      expect(repeatedDefault).toEqual({
        task_id: firstDefault.task_id,
        status: "pending",
        reused: true,
      });
      expect(firstDefault.reused).toBe(false);
      expect(new Set([firstDefault.task_id, keyedA.task_id, keyedB.task_id]).size).toBe(3);
      expect(Object.values(vm.actors).filter((actor) => actor.type === "detached")).toHaveLength(3);
      expect(getDetachedActorRegistry(vm).list()).toHaveLength(3);
      expect(
        Object.values(driver.getState().fibers).filter((fiber) => fiber.parentId === mainFiberId),
      ).toHaveLength(3);

      const artifactRoot = path.join(sessionDir, "artifacts");
      const artifactsAfterCheapCompaction = listFilesRecursively(artifactRoot);
      expect(artifactsAfterCheapCompaction.length).toBeGreaterThan(0);
      expect(
        artifactsAfterCheapCompaction.some((file) => (
          fs.readFileSync(file, "utf8").includes(DELEGATE_SUMMARY_PREFIX)
        )),
      ).toBe(false);

      await driver.tickUntilBackgroundSettled({
        now: Date.now(),
        maxTicks: 100,
        maxWallMs: 5_000,
      });
      expect(main.hasPending("childDone")).toBe(true);
      expect(providerRequests.some((request) => requestMessagesText(request).includes(DELEGATE_SUMMARY))).toBe(false);
      expect(
        listFilesRecursively(artifactRoot).some((file) => (
          fs.readFileSync(file, "utf8").includes(DELEGATE_SUMMARY_PREFIX)
        )),
      ).toBe(false);

      main.send("humanInput", "consume the completed delegate result");
      driver.resumeFiber(mainFiberId, Date.now());
      await driver.tickUntilForegroundSettled({
        now: Date.now(),
        maxTicks: 100,
        maxWallMs: 5_000,
      });

      const failedDeliveryRequest = providerRequests.find((request) => (
        requestMessagesText(request).includes(DELEGATE_SUMMARY)
      ));
      expect(failedDeliveryRequest).toBeDefined();
      expect(requestMessagesText(failedDeliveryRequest)).toContain(DELEGATE_SUMMARY);
      expect(messageDeliveries(vm)).toEqual([
        expect.objectContaining({
          deliveryState: "pending",
        }),
        expect.objectContaining({
          deliveryState: "pending",
        }),
        expect.objectContaining({
          deliveryState: "pending",
        }),
      ]);

      const postSpawnRequest = providerRequests.find((request) => {
        const text = requestMessagesText(request);
        return text.includes("tc-default-1") && !text.includes(DELEGATE_SUMMARY_PREFIX);
      });
      expect(postSpawnRequest).toBeDefined();
      expect(failedDeliveryRequest.providerRequestContext.instructions)
        .toBe(postSpawnRequest.providerRequestContext.instructions);
      expect(failedDeliveryRequest.providerRequestContext.primary.promptCacheKey)
        .toBe(postSpawnRequest.providerRequestContext.primary.promptCacheKey);

      const stableRequestShape = JSON.stringify({
        instructions: failedDeliveryRequest.providerRequestContext.instructions,
        promptCacheKey: failedDeliveryRequest.providerRequestContext.primary.promptCacheKey,
      });
      expect(stableRequestShape).not.toContain("toolResultDeliveryFact");
      expect(stableRequestShape).not.toContain("messageDeliveryFact");
      expect(stableRequestShape).not.toContain("deliveryState");
      expect(stableRequestShape).not.toContain("singleFlightScope");
      expect(stableRequestShape).not.toContain("parentActorId");

      const raw = getConversationActorRawStateFromVm({ vm, actorKey: main.key });
      const repository = await persistConversationActorState({ sessionDir, raw: raw! });
      const recoveredProviderRequests: any[] = [];
      const recoveredAdapter = {
        type: "openai" as const,
        runtime: {
          adapterName: "openai-responses",
          providerId: "delegate-delivery-incident-recovered",
        },
        async createStream(options?: any) {
          recoveredProviderRequests.push(options ?? {});
          async function* stream() {
            if (Array.isArray(options?.tools) && options.tools.length === 0) {
              yield {
                type: "text-delta",
                text: "<state_snapshot><overall_goal>recover detached completion</overall_goal></state_snapshot>",
              };
              return;
            }
            yield { ok: true };
          }
          return {
            stream: stream(),
            providerOutput: Promise.resolve({
              provider_cache_cost_observation: createMockProviderCacheCostObservation(options ?? {}),
            }),
          };
        },
      };
      const recoveredMain = createActor({
        key: "main",
        id: main.id,
        llmClient: recoveredAdapter,
        modelConfig: {
          model: "mock",
          inputLimit: 300_000,
          capabilities: {
            cachePolicy: {
              stablePrefix: true,
              compactionThresholdTokens: 80_000,
            },
          },
        },
        callbacks: {
          buildToolset: () => [runDelegateActor.schema],
          processStream: createMockProcessStream(async () => ({
            role: "assistant",
            content: "parent consumed recovered detached result",
          })),
        },
      });
      const recoveredVm = createVM({
        controlActorKey: recoveredMain.key,
        actors: { [recoveredMain.key]: recoveredMain },
        eventBus: new AgentEventGraph(),
        registries: {
          toolRegistry: composeToolRegistry(),
        },
        outerCtx: {
          workDir: process.cwd(),
          conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
          metadata: {
            sessionDir,
            sessionId: path.basename(sessionDir),
          },
        },
      });
      await synchronizeConversationDomainActorFromPersistence({
        runtime: ensureVmConversationDomainRuntime(recoveredVm),
        sessionDir,
        actorKey: recoveredMain.key,
        repository,
      });
      expect(messageDeliveries(recoveredVm)).toEqual([
        expect.objectContaining({
          deliveryState: "pending",
        }),
        expect.objectContaining({
          deliveryState: "pending",
        }),
        expect.objectContaining({
          deliveryState: "pending",
        }),
      ]);
      const pendingMessageIds = new Set(
        messageDeliveries(recoveredVm).map((delivery) => delivery.messageId),
      );
      const recoveredCompletionMessages = materializeConversationRuntimeMessagesFromVm({
        vm: recoveredVm,
        actorKey: recoveredMain.key,
      }).filter((message: any) => (
        String(message?.content ?? "").startsWith("Delegate actor ")
      ));
      expect(recoveredCompletionMessages).toHaveLength(3);
      expect(recoveredCompletionMessages.every((message: any) => (
        typeof message.messageId === "string"
        && pendingMessageIds.has(message.messageId)
      ))).toBe(true);
      for (let index = 0; index < 4; index += 1) {
        appendLiveHistoryMessageToConversationDomainRuntime({
          vm: recoveredVm,
          actorKey: recoveredMain.key,
          actorId: recoveredMain.id,
          message: {
            role: "user",
            content: index === 0
              ? `DETACHED_RECOVERY_INPUT_${index}_` + "z".repeat(180_000)
              : `DETACHED_RECOVERY_INPUT_${index}`,
          },
        });
      }

      __setCompressionDepsForTest({ estimateUsageRatio: () => 0.9 });
      await aiAgentLoopStreaming({
        vm: recoveredVm,
        actor: recoveredMain,
        messages: [],
      });

      const summaryRequest = recoveredProviderRequests.find((request) => (
        Array.isArray(request?.tools) && request.tools.length === 0
      ));
      expect(summaryRequest).toBeDefined();
      expect(requestMessagesText(summaryRequest)).not.toContain(DELEGATE_SUMMARY_PREFIX);
      expect(requestMessagesText(summaryRequest)).not.toContain("\"messageId\"");
      const successfulDeliveryRequest = recoveredProviderRequests.find((request) => (
        Array.isArray(request?.tools)
        && request.tools.length > 0
        && requestMessagesText(request).includes(DELEGATE_SUMMARY)
      ));
      expect(successfulDeliveryRequest).toBeDefined();
      expect(requestMessagesText(successfulDeliveryRequest)).toContain(DELEGATE_SUMMARY);
      const compactedCompletionMessages = materializeConversationRuntimeMessagesFromVm({
        vm: recoveredVm,
        actorKey: recoveredMain.key,
      }).filter((message: any) => (
        String(message?.content ?? "").startsWith("Delegate actor ")
      ));
      expect(compactedCompletionMessages).toHaveLength(3);
      expect(compactedCompletionMessages.map((message: any) => message.messageId))
        .toEqual([...pendingMessageIds]);
      expect(messageDeliveries(recoveredVm)).toEqual([
        expect.objectContaining({
          deliveryState: "delivered",
        }),
        expect.objectContaining({
          deliveryState: "delivered",
        }),
        expect.objectContaining({
          deliveryState: "delivered",
        }),
      ]);
      const recoveredStableShape = JSON.stringify({
        instructions: successfulDeliveryRequest.providerRequestContext.instructions,
        promptCacheKey: successfulDeliveryRequest.providerRequestContext.primary.promptCacheKey,
      });
      expect(recoveredStableShape).not.toContain("messageDeliveryFact");
      expect(recoveredStableShape).not.toContain("deliveryState");

      const conversationAfterDelivery = materializeConversationRuntimeMessagesFromVm({
        vm: recoveredVm,
        actorKey: recoveredMain.key,
      });
      expect(JSON.stringify(conversationAfterDelivery)).toContain(DELEGATE_SUMMARY);
      const artifactsAfterDelivery = listFilesRecursively(artifactRoot);
      expect(artifactsAfterDelivery).toEqual(artifactsAfterCheapCompaction);
      expect(
        artifactsAfterDelivery.some((file) => (
          fs.readFileSync(file, "utf8").includes(DELEGATE_SUMMARY_PREFIX)
        )),
      ).toBe(false);
    } finally {
      __setCompressionDepsForTest(null);
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 15_000);
});
