import { describe, expect, it } from "bun:test";

import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM, ensureVmRxData } from "@cell/ai-core-logic/runtime/runtime";
import { createSemanticProtocolBinding } from "@cell/ai-organ-logic/stream/SemanticProtocolBinding";
import {
  bindObservabilitySinks,
  createLogObservabilitySink,
  createObservabilityRxData,
  createProviderSceneCaptureHook,
  createSessionTraceArtifactSink,
  emitExtensionObservabilityFact,
  emitObservabilityRecord,
  emitSemanticObservabilityRecord,
} from "@cell/ai-organ-logic/observability/ObservabilityRx";
import type { ObservabilityRecord, ObservabilitySink } from "@cell/ai-organ-contract/observability/Observability";

function createRuntime() {
  const actor = createActor({ key: "main" });
  const eventBus = new AgentEventGraph();
  const vm = createVM({
    controlActorKey: "main",
    actors: { main: actor },
    eventBus,
  });
  return { actor, eventBus, vm };
}

describe("Observability RxData", () => {
  it("exposes private writable and public readonly observability streams", () => {
    const { vm } = createRuntime();
    const { privateRxData, publicRxData } = ensureVmRxData(vm);
    const records: ObservabilityRecord[] = [];
    const errors: ObservabilityRecord[] = [];

    publicRxData.observabilityRecords.subscribe((record) => records.push(record));
    publicRxData.observabilityErrors.subscribe((record) => errors.push(record));

    expect(typeof privateRxData.observabilityRecords.append).toBe("function");
    expect("append" in (publicRxData.observabilityRecords as any)).toBe(false);
    expect("append" in (publicRxData.observabilityErrors as any)).toBe(false);

    emitObservabilityRecord(vm, {
      eventName: "runtime.start",
      source: "runtime",
      stage: "start",
      sessionId: "s1",
      requestId: "r1",
      payload: { ok: true },
      emittedAt: 1,
    });
    emitObservabilityRecord(vm, {
      eventName: "runtime.error",
      source: "runtime",
      stage: "error",
      error: { message: "boom" },
      emittedAt: 2,
    });

    expect(records.map((record) => record.eventName)).toEqual(["runtime.start", "runtime.error"]);
    expect(errors.map((record) => record.eventName)).toEqual(["runtime.error"]);
    expect(records[0].payload).toEqual({ ok: true });
  });

  it("standardizes semantic, extension, provider, and runtime records", () => {
    const { actor, eventBus, vm } = createRuntime();
    const rxData = createObservabilityRxData(vm);
    const records: ObservabilityRecord[] = [];

    rxData.records.subscribe((record) => records.push(record));

    eventBus.addConsumer((event) => emitSemanticObservabilityRecord(vm, event));
    eventBus.emitContentDelta({ key: "main", id: actor.id }, "hello");
    emitExtensionObservabilityFact(vm, {
      source: "tool:test",
      factName: "api_call",
      phase: "start",
      payload: { url: "https://example.test" },
      emittedAt: 10,
    });
    createProviderSceneCaptureHook(vm)({
      providerId: "openai",
      model: "gpt-test",
      phase: "response",
      requestId: "req-1",
      payload: { status: 200 },
      emittedAt: 11,
    });
    emitObservabilityRecord(vm, {
      eventName: "runtime.lifecycle",
      source: "runtime",
      stage: "info",
      emittedAt: 12,
    });

    expect(records.map((record) => record.source)).toEqual(["semantic", "tool:test", "provider", "runtime"]);
    expect(records[0]).toMatchObject({
      eventName: "semantic_content_delta",
      stage: "delta",
      payload: { event: { event_type: "semantic_content_delta" } },
    });
    expect(records[1]).toMatchObject({
      eventName: "api_call.start",
      visibility: "internal",
      payload: { factName: "api_call", url: "https://example.test" },
    });
    expect(records[2]).toMatchObject({
      eventName: "provider.response",
      requestId: "req-1",
      payload: { providerId: "openai", model: "gpt-test", status: 200 },
    });
  });

  it("does not pollute semantic protocol frames with observability-only extension facts", () => {
    const { vm } = createRuntime();
    const semanticBinding = createSemanticProtocolBinding(vm);
    const observability = createObservabilityRxData(vm);
    const protocolFrames: unknown[] = [];
    const observabilityRecords: ObservabilityRecord[] = [];

    semanticBinding.protocolFrames.subscribe((frame) => protocolFrames.push(frame));
    observability.records.subscribe((record) => observabilityRecords.push(record));

    emitExtensionObservabilityFact(vm, {
      source: "tool:test",
      factName: "custom_api",
      phase: "end",
      payload: { status: "ok" },
      emittedAt: 20,
    });

    expect(protocolFrames).toHaveLength(0);
    expect(observabilityRecords).toHaveLength(1);
    expect(observabilityRecords[0]).toMatchObject({
      eventName: "custom_api.end",
      source: "tool:test",
      stage: "end",
    });

    semanticBinding.dispose();
  });

  it("isolates sink bind and consume failures from sibling sinks and protocol binding", () => {
    const { actor, eventBus, vm } = createRuntime();
    const observability = createObservabilityRxData(vm);
    const protocolBinding = createSemanticProtocolBinding(vm);
    const protocolFrames: unknown[] = [];
    const goodRecords: string[] = [];
    const otherGoodRecords: string[] = [];
    const badBindSink: ObservabilitySink = {
      bind: () => {
        throw new Error("bind failed");
      },
    };
    const badConsumeSink: ObservabilitySink = {
      bind: (rxData) => {
        const subscription = rxData.records.subscribe(() => {
          throw new Error("consume failed");
        });
        return { dispose: () => subscription.unsubscribe() };
      },
    };
    const goodSink: ObservabilitySink = {
      bind: (rxData) => {
        const subscription = rxData.records.subscribe((record) => goodRecords.push(record.eventName));
        return { dispose: () => subscription.unsubscribe() };
      },
    };
    const otherGoodSink: ObservabilitySink = {
      bind: (rxData) => {
        const subscription = rxData.records.subscribe((record) => otherGoodRecords.push(record.eventName));
        return { dispose: () => subscription.unsubscribe() };
      },
    };

    protocolBinding.protocolFrames.subscribe((frame) => protocolFrames.push(frame));
    const sinkBinding = bindObservabilitySinks(observability, [
      badBindSink,
      badConsumeSink,
      goodSink,
      otherGoodSink,
    ]);

    emitObservabilityRecord(vm, {
      eventName: "runtime.tick",
      source: "runtime",
      stage: "info",
      emittedAt: 30,
    });
    eventBus.emitContentDelta({ key: "main", id: actor.id }, "still visible");

    expect(goodRecords).toEqual(["runtime.tick"]);
    expect(otherGoodRecords).toEqual(["runtime.tick"]);
    expect(protocolFrames).toHaveLength(1);
    expect(() => sinkBinding.dispose()).not.toThrow();
    expect(() => sinkBinding.dispose()).not.toThrow();
    protocolBinding.dispose();
  });

  it("writes structured logs and session trace artifacts from public observability data", () => {
    const { vm } = createRuntime();
    const observability = createObservabilityRxData(vm);
    const logs: unknown[] = [];
    const artifacts: unknown[] = [];
    const binding = bindObservabilitySinks(observability, [
      createLogObservabilitySink({
        channel: "runtime-observability",
        write: (entry) => logs.push(entry),
      }),
      createSessionTraceArtifactSink({
        defaultSessionId: "default-session",
        defaultRequestId: "default-request",
        write: (entry) => artifacts.push(entry),
      }),
      createSessionTraceArtifactSink({
        write: () => {
          throw new Error("artifact unavailable");
        },
      }),
    ]);

    emitObservabilityRecord(vm, {
      eventName: "provider.error",
      source: "provider",
      stage: "error",
      requestId: "request-1",
      error: { message: "provider failed" },
      emittedAt: 40,
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "error",
      channel: "runtime-observability",
      message: "provider.error",
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      sessionId: "default-session",
      requestId: "request-1",
      record: { eventName: "provider.error" },
    });

    binding.dispose();
  });
});
