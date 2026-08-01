import { describe, expect, it } from "bun:test";

import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  ensureVmConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  registerPendingMessageDeliveryToConversationDomainRuntime,
} from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime";
import { aiAgentLoopStreaming } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { createMockProcessStream } from "./__test_support__/mockProcessStream";

function messageDeliveries(vm: any): any[] {
  const raw = getConversationActorRawStateFromVm({ vm, actorKey: "main" });
  return raw?.session.contextAssets
    ?.flatMap((asset: any) => asset.messageDeliveryFact?.deliveries ?? [])
    ?? [];
}

describe("asynchronous conversation message first provider delivery", () => {
  it("keeps an aborted message pending and confirms it only after a successful retry", async () => {
    const providerRequests: any[] = [];
    let providerAttempt = 0;
    let firstProviderStarted!: () => void;
    const firstProviderStart = new Promise<void>((resolve) => {
      firstProviderStarted = resolve;
    });
    const adapter = {
      type: "openai" as const,
      runtime: {
        adapterName: "openai-responses",
        providerId: "message-delivery-lifecycle",
      },
      async createStream(options?: any) {
        providerRequests.push(options ?? {});
        async function* stream() {
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
        inputLimit: 100_000,
        capabilities: {
          cachePolicy: {
            stablePrefix: true,
          },
        },
      },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async (_vm, _actor, _stream, options) => {
          providerAttempt += 1;
          if (providerAttempt === 1) {
            firstProviderStarted();
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(new Error("message provider aborted")),
                { once: true },
              );
            });
          }
          return { role: "assistant", content: "message consumed" };
        }),
      },
    });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry: new ToolFuncRegistry(),
      },
      outerCtx: {
        metadata: {
          sessionId: "message-delivery-lifecycle",
        },
      },
    });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "user", content: "consume the async completion" },
    });
    const messageId = appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: {
        role: "assistant",
        content: "ASYNC_COMPLETION_PENDING_UNTIL_SUCCESS",
      },
    });
    registerPendingMessageDeliveryToConversationDomainRuntime({
      runtime: ensureVmConversationDomainRuntime(vm),
      sessionId: "message-delivery-lifecycle",
      actorKey: actor.key,
      messageId,
    });

    const firstLoop = aiAgentLoopStreaming({ vm, actor, messages: [] });
    await firstProviderStart;
    actor.llmAbortController?.abort();
    await expect(firstLoop).rejects.toThrow("message provider aborted");

    expect(messageDeliveries(vm)).toEqual([
      expect.objectContaining({
        messageId,
        deliveryState: "pending",
      }),
    ]);
    expect(JSON.stringify(providerRequests[0]?.messages ?? []))
      .toContain("ASYNC_COMPLETION_PENDING_UNTIL_SUCCESS");

    await aiAgentLoopStreaming({ vm, actor, messages: [] });

    expect(JSON.stringify(providerRequests[1]?.messages ?? []))
      .toContain("ASYNC_COMPLETION_PENDING_UNTIL_SUCCESS");
    expect(messageDeliveries(vm)).toEqual([
      expect.objectContaining({
        messageId,
        deliveryState: "delivered",
      }),
    ]);
    const requestShape = JSON.stringify(providerRequests[1]);
    expect(requestShape).not.toContain("messageDeliveryFact");
    expect(requestShape).not.toContain("\"messageId\"");
    expect(requestShape).not.toContain("\"deliveryState\"");
  });
});
