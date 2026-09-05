import { describe, expect, it } from "bun:test";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import {
  MessageHistoryGraph,
  createInitialHistoryProjectionState,
  reduceHistoryProjection,
  type CommittedHistoryMessageEvent,
  type MessageHistoryEvent,
} from "@cell/ai-core-logic/stream/MessageHistoryGraph";
import { buildRuntimeSemanticBase } from "@cell/ai-core-logic/stream/runtime/SemanticRuntimeSupport";

function event(actor: string, event_type: string, extra: Record<string, unknown> = {}): SemanticEvent {
  return {
    ...buildRuntimeSemanticBase({ agentKey: actor, agentActorId: `${actor}-id` }),
    event_type,
    ...extra,
  } as SemanticEvent;
}

describe("provider attempt history transaction", () => {
  it("accepts a legacy assembly state without providerAttempts", () => {
    const state = createInitialHistoryProjectionState();
    delete (state as Partial<typeof state>).providerAttempts;
    const next = reduceHistoryProjection(state, { kind: "semantic", event: event("a", "semantic_content_delta", { text: "legacy" }) });
    const completed = reduceHistoryProjection(next, { kind: "complete" });
    expect(completed.lastCommittedBatch[0].message.content).toBe("legacy");
  });
  it("discards failed interleaved output while retaining another actor and earlier committed history", () => {
    const graph = new MessageHistoryGraph();
    const committed: CommittedHistoryMessageEvent[] = [];
    const transcript: MessageHistoryEvent[] = [];
    graph.onCommittedMessage((message) => committed.push(message));
    graph.onHistoryEvent((message) => transcript.push(message));
    const emit = (actor: string, type: string, extra = {}) => graph.consumeSemanticEvent(event(actor, type, extra));
    emit("a", "semantic_content_delta", { text: "previous committed answer" });
    emit("a", "semantic_turn_end", { reason: "done" });
    emit("a", "semantic_provider_attempt_started", { attempt_id: "a1" });
    emit("a", "semantic_think_delta", { text: "FAILED_REASONING" });
    emit("a", "semantic_content_delta", { text: "FAILED_CONTENT" });
    emit("a", "semantic_tool_call_planned", {
      tool_call: { tool_call_id: "failed-tool", tool_name: "Record", arguments_text: '{"FAILED_JSON":', protocol: "json", call_kind: "function", raw_payload_text: "" },
    });
    emit("b", "semantic_provider_attempt_started", { attempt_id: "b1" });
    emit("b", "semantic_content_delta", { text: "other actor successful answer" });
    emit("b", "semantic_provider_attempt_succeeded", { attempt_id: "b1" });
    emit("b", "semantic_turn_end", { reason: "done" });
    expect(committed.map(({ message }) => message.content)).toEqual(["previous committed answer", "other actor successful answer"]);
    emit("a", "semantic_provider_attempt_aborted", { attempt_id: "a1" });
    emit("a", "semantic_provider_attempt_started", { attempt_id: "a2" });
    emit("a", "semantic_content_delta", { text: "recovered answer" });
    emit("a", "semantic_provider_attempt_succeeded", { attempt_id: "a2" });
    emit("a", "semantic_turn_end", { reason: "done" });
    graph.complete();
    expect(committed.map(({ message }) => message.content)).toEqual(["previous committed answer", "other actor successful answer", "recovered answer"]);
    expect(JSON.stringify(committed)).not.toContain("FAILED_");
    expect(JSON.stringify(committed)).not.toContain("failed-tool");
    expect(JSON.stringify(transcript)).not.toContain("FAILED_");
    graph.dispose();
  });

  it("ignores stale terminal boundaries and clears provisional state on completion", () => {
    let state = createInitialHistoryProjectionState();
    const apply = (type: string, extra = {}) => {
      state = reduceHistoryProjection(state, { kind: "semantic", event: event("a", type, extra) });
      return state;
    };
    apply("semantic_provider_attempt_started", { attempt_id: "old" });
    apply("semantic_content_delta", { text: "FAILED_OLD" });
    apply("semantic_provider_attempt_aborted", { attempt_id: "old" });
    apply("semantic_provider_attempt_started", { attempt_id: "current" });
    apply("semantic_content_delta", { text: "current" });
    apply("semantic_provider_attempt_aborted", { attempt_id: "old" });
    apply("semantic_provider_attempt_succeeded", { attempt_id: "old" });
    expect(state.lastCommittedBatch).toEqual([]);
    apply("semantic_provider_attempt_succeeded", { attempt_id: "current" });
    apply("semantic_turn_end", { reason: "done" });
    expect(state.lastCommittedBatch.map(({ message }) => message.content)).toEqual(["current"]);
    apply("semantic_provider_attempt_started", { attempt_id: "unfinished" });
    apply("semantic_content_delta", { text: "FAILED_UNFINISHED" });
    state = reduceHistoryProjection(state, { kind: "complete" });
    expect(state.lastCommittedBatch).toEqual([]);
    expect(JSON.stringify(state)).not.toContain("FAILED_");
  });

  it("coalesces token deltas without losing timestamps or mutating earlier state", () => {
    let state = reduceHistoryProjection(createInitialHistoryProjectionState(), {
      kind: "semantic", event: event("a", "semantic_provider_attempt_started", { attempt_id: "tokens" }),
    });
    const initial = state;
    for (let timestamp = 100; timestamp < 200; timestamp += 1) {
      const delta = event("a", "semantic_content_delta", { text: "x" });
      delta.trace.emitted_at = timestamp;
      state = reduceHistoryProjection(state, { kind: "semantic", event: delta });
    }
    expect(Object.values(initial.providerAttempts)[0].events).toHaveLength(0);
    expect(Object.values(state.providerAttempts)[0].events).toHaveLength(2);
    state = reduceHistoryProjection(state, {
      kind: "semantic", event: event("a", "semantic_provider_attempt_succeeded", { attempt_id: "tokens" }),
    });
    state = reduceHistoryProjection(state, {
      kind: "semantic", event: event("a", "semantic_turn_end", { reason: "done" }),
    });
    expect(state.lastCommittedBatch[0].message).toMatchObject({ content: "x".repeat(100), startAt: 100, endAt: 199 });
    expect(state.lastBatch[0]).toMatchObject({ payload: "x".repeat(100), startAt: 100, endAt: 199 });
    expect(state.providerAttempts).toEqual({});
  });
});
