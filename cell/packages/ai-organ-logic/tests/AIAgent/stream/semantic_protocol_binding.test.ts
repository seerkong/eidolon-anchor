import { describe, expect, it } from "bun:test";

import type { AiAgentVmDomainRxEvent, AiAgentVmRxStream } from "@cell/ai-core-contract/runtime/AiAgentVm";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { bindVmDomainRxStreams, createVM, ensureVmRxData } from "@cell/ai-core-logic/runtime/runtime";
import { createSemanticProtocolBinding } from "@cell/ai-organ-logic/stream/SemanticProtocolBinding";

function createDomainRxSource(): {
  stream: AiAgentVmRxStream<AiAgentVmDomainRxEvent>;
  emit: (event: AiAgentVmDomainRxEvent) => void;
} {
  const listeners = new Set<(event: AiAgentVmDomainRxEvent) => void>();
  return {
    stream: {
      subscribe: (listener) => {
        listeners.add(listener);
        return {
          unsubscribe: () => {
            listeners.delete(listener);
          },
        };
      },
    },
    emit: (event) => {
      for (const listener of Array.from(listeners)) {
        listener(event);
      }
    },
  };
}

describe("createSemanticProtocolBinding", () => {
  it("binds before execution and captures the first semantic protocol frame", () => {
    const actor = createActor({ key: "main" });
    const eventBus = new AgentEventGraph();
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      eventBus,
    });
    const binding = createSemanticProtocolBinding(vm);
    const frames: unknown[] = [];

    const subscription = binding.protocolFrames.subscribe((frame) => frames.push(frame));
    eventBus.emitContentDelta({ key: "main", id: actor.id }, "first-token");

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "semantic",
      source: "semantic",
      eventType: "semantic_content_delta",
      event: {
        event_type: "semantic_content_delta",
        text: "first-token",
      },
    });
    expect((frames[0] as any).trace).toBeDefined();
    expect((frames[0] as any).actor.actor_id).toBe(actor.id);
    expect((frames[0] as any).team).toBeDefined();
    expect(binding.traceSummary.get().eventCount).toBe(1);

    subscription.unsubscribe();
    binding.dispose();
    expect(() => binding.dispose()).not.toThrow();
  });

  it("projects domain streams and signals without writing synthetic semantic events", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
    });
    const historySource = createDomainRxSource();
    const promptSource = createDomainRxSource();
    const sessionSource = createDomainRxSource();
    const binding = createSemanticProtocolBinding(vm);
    const frames: any[] = [];
    const subscription = binding.protocolFrames.subscribe((frame) => frames.push(frame));

    const domainBinding = bindVmDomainRxStreams({
      vm,
      history: historySource.stream,
      prompt: promptSource.stream,
      session: sessionSource.stream,
    });
    historySource.emit({ type: "actor_history_generation_created", payload: { id: "h1" }, occurredAt: 1 });
    promptSource.emit({ type: "actor_prompt_generation_created", payload: { id: "p1" }, occurredAt: 2 });
    sessionSource.emit({ type: "conversation_session_selected", payload: { id: "s1" }, occurredAt: 3 });

    expect(frames).toEqual([
      {
        kind: "domain",
        source: "history",
        eventType: "actor_history_generation_created",
        event: { type: "actor_history_generation_created", payload: { id: "h1" }, occurredAt: 1 },
      },
      {
        kind: "domain",
        source: "prompt",
        eventType: "actor_prompt_generation_created",
        event: { type: "actor_prompt_generation_created", payload: { id: "p1" }, occurredAt: 2 },
      },
      {
        kind: "domain",
        source: "session",
        eventType: "conversation_session_selected",
        event: { type: "conversation_session_selected", payload: { id: "s1" }, occurredAt: 3 },
      },
    ]);

    const { privateRxData } = ensureVmRxData(vm);
    privateRxData.usage.set((prev) => ({ ...prev, total_tokens: 12, is_estimated: true }));
    expect(binding.usage.get().total_tokens).toBe(12);
    expect(binding.usage.get().is_estimated).toBe(true);
    expect(frames).toHaveLength(3);

    domainBinding.dispose();
    subscription.unsubscribe();
    binding.dispose();
    historySource.emit({ type: "actor_history_generation_created", payload: { id: "h2" }, occurredAt: 4 });
    expect(frames).toHaveLength(3);
  });

  it("uses the initialized public read side without subscribing to eventBus or exposing writers", () => {
    const actor = createActor({ key: "main" });
    const eventBus = new AgentEventGraph();
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      eventBus,
    });
    ensureVmRxData(vm);

    let directEventBusSubscriptions = 0;
    const originalAddConsumer = eventBus.addConsumer.bind(eventBus);
    eventBus.addConsumer = ((...args: Parameters<AgentEventGraph["addConsumer"]>) => {
      directEventBusSubscriptions += 1;
      return originalAddConsumer(...args);
    }) as AgentEventGraph["addConsumer"];

    const binding = createSemanticProtocolBinding(vm);

    expect(directEventBusSubscriptions).toBe(0);
    expect("append" in (binding.protocolFrames as any)).toBe(false);
    expect("set" in (binding.usage as any)).toBe(false);
    expect("set" in (binding.traceSummary as any)).toBe(false);

    binding.dispose();
  });
});
