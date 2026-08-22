import { describe, expect, it } from "bun:test";

import {
  createResponsesMessageFrontier,
  createResponsesProviderOutputSnapshot,
  createResponsesReplayCheckpoint,
  decideResponsesCallLineage,
  decideResponsesRequestLineage,
  decideResponsesNativeOutputCompleteness,
  planResponsesRequest,
} from "@cell/ai-organ-logic/llm";

const digest = `sha256:${"a".repeat(43)}`;
const frontier = createResponsesMessageFrontier([{ role: "user", content: "before" }]);

function checkpointWithPendingCall() {
  return createResponsesReplayCheckpoint({
    actorId: "actor-1",
    providerId: "openai",
    model: "gpt-5.5",
    baselineEpoch: 1,
    contextDigest: digest,
    messageFrontier: frontier,
    requestKind: "stateless_replay",
    requestInput: [{ type: "message", role: "user", content: [] }],
    output: createResponsesProviderOutputSnapshot({
      responseId: "resp-1",
      items: [{
        id: "fc-1",
        type: "function_call",
        call_id: "call-1",
        name: "inspect",
        arguments: "{}",
      }],
    }),
  });
}

describe("Responses native output completeness", () => {
  const reconstructedItems = [
    {
      id: "reasoning-1",
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [{ type: "summary_text", text: "checked" }],
    },
    {
      id: "message-1",
      type: "message",
      role: "assistant",
      phase: "analysis",
      content: [{ type: "output_text", text: "working" }],
    },
    {
      id: "function-1",
      type: "function_call",
      call_id: "call-1",
      name: "inspect",
      arguments: "{\"path\":\"README.md\"}",
    },
  ] as const;

  function reconstructedEvidence() {
    return {
      schemaVersion: 1 as const,
      kind: "responses_native_output_evidence" as const,
      responseId: "resp-reconstructed",
      completedOutput: { observed: true, items: [] },
      addedItems: reconstructedItems.map((item, outputIndex) => ({
        outputIndex,
        item: item.type === "function_call"
          ? { ...item, arguments: "" }
          : item,
      })),
      doneItems: reconstructedItems.map((item, outputIndex) => ({ outputIndex, item })),
      functionCallArgumentDeltas: [{
        itemId: "function-1",
        delta: "{\"path\":\"README.md\"}",
      }],
    };
  }

  it("reconstructs an empty terminal output only from complete indexed event evidence", () => {
    const decision = decideResponsesNativeOutputCompleteness(reconstructedEvidence());

    expect(decision.status).toBe("complete");
    if (decision.status !== "complete") throw new Error("expected reconstructed output");
    expect(decision.output.completenessProof.source).toBe("reconstructed_event_items");
    expect(decision.output.items).toEqual(reconstructedItems);
  });

  it("does not treat an empty terminal output without independent events as complete", () => {
    const evidence = reconstructedEvidence();
    const decision = decideResponsesNativeOutputCompleteness({
      ...evidence,
      addedItems: [],
      doneItems: [],
      functionCallArgumentDeltas: [],
    });

    expect(decision).toEqual(expect.objectContaining({ status: "incomplete" }));
  });

  it.each([
    ["missing index", (evidence: ReturnType<typeof reconstructedEvidence>) => ({
      ...evidence,
      addedItems: evidence.addedItems.map((entry, index) => index === 1
        ? { item: entry.item }
        : entry),
    })],
    ["missing terminal done", (evidence: ReturnType<typeof reconstructedEvidence>) => ({
      ...evidence,
      doneItems: evidence.doneItems.slice(0, -1),
    })],
    ["missing stable item identity", (evidence: ReturnType<typeof reconstructedEvidence>) => ({
      ...evidence,
      doneItems: evidence.doneItems.map((entry, index) => index === 1
        ? { ...entry, item: { ...entry.item, id: "" } }
        : entry),
    })],
    ["discontinuous index order", (evidence: ReturnType<typeof reconstructedEvidence>) => ({
      ...evidence,
      doneItems: evidence.doneItems.map((entry, index) => index === 2
        ? { ...entry, outputIndex: 3 }
        : entry),
    })],
    ["changed call identity", (evidence: ReturnType<typeof reconstructedEvidence>) => ({
      ...evidence,
      doneItems: evidence.doneItems.map((entry, index) => index === 2
        ? { ...entry, item: { ...entry.item, call_id: "call-other" } }
        : entry),
    })],
    ["delta does not prove final arguments", (evidence: ReturnType<typeof reconstructedEvidence>) => ({
      ...evidence,
      functionCallArgumentDeltas: [{ itemId: "function-1", delta: "{}" }],
    })],
    ["event lineage is not closed", (evidence: ReturnType<typeof reconstructedEvidence>) => ({
      ...evidence,
      addedItems: [{
        outputIndex: 0,
        item: { id: "output-1", type: "function_call_output", call_id: "orphan", output: "bad" },
      }],
      doneItems: [{
        outputIndex: 0,
        item: { id: "output-1", type: "function_call_output", call_id: "orphan", output: "bad" },
      }],
      functionCallArgumentDeltas: [],
    })],
  ] as const)("keeps empty terminal output incomplete when proof has %s", (_name, mutate) => {
    const decision = decideResponsesNativeOutputCompleteness(mutate(reconstructedEvidence()) as any);

    expect(decision).toEqual(expect.objectContaining({ status: "incomplete" }));
  });

  it("does not let an empty terminal output erase an observed function call", () => {
    const decision = decideResponsesNativeOutputCompleteness({
      schemaVersion: 1,
      kind: "responses_native_output_evidence",
      responseId: "resp-broken",
      completedOutput: { observed: true, items: [] },
      addedItems: [{
        outputIndex: 0,
        item: {
          id: "fc-broken",
          type: "function_call",
          call_id: "call-broken",
          name: "Bash",
          arguments: "",
        },
      }],
      doneItems: [],
      functionCallArgumentDeltas: [{ itemId: "fc-broken", delta: "{\"cmd\":\"pwd\"}" }],
    });

    expect(decision.status).toBe("incomplete");
    expect(decision).toEqual(expect.objectContaining({ reason: "terminal_output_conflict" }));
    expect("output" in decision).toBe(false);
  });

  it("proves matching completed, done, and added/delta evidence once", () => {
    const functionCall = {
      id: "fc-1",
      type: "function_call",
      call_id: "call-1",
      name: "inspect",
      arguments: "{}",
    };
    const decision = decideResponsesNativeOutputCompleteness({
      schemaVersion: 1,
      kind: "responses_native_output_evidence",
      responseId: "resp-complete",
      completedOutput: { observed: true, items: [functionCall] },
      addedItems: [{
        outputIndex: 0,
        item: { ...functionCall, arguments: "" },
      }],
      doneItems: [{ outputIndex: 0, item: functionCall }],
      functionCallArgumentDeltas: [{ itemId: "fc-1", delta: "{}" }],
    });

    expect(decision.status).toBe("complete");
    if (decision.status !== "complete") throw new Error("expected complete output");
    expect(decision.output.items).toEqual([functionCall]);
    expect(decision.output.completenessProof.status).toBe("complete");
  });

  it("does not compare an initial message added item as if it contained final text deltas", () => {
    const decision = decideResponsesNativeOutputCompleteness({
      schemaVersion: 1,
      kind: "responses_native_output_evidence",
      responseId: "resp-text",
      completedOutput: {
        observed: true,
        items: [{
          id: "message-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "final text" }],
        }],
      },
      addedItems: [{
        outputIndex: 0,
        item: { id: "message-1", type: "message", role: "assistant", content: [] },
      }],
      doneItems: [],
      functionCallArgumentDeltas: [],
    });

    expect(decision.status).toBe("complete");
  });
});

describe("Responses request lineage", () => {
  it("accepts a stateful function output whose call exists in previous lineage", () => {
    const checkpoint = checkpointWithPendingCall();
    const plan = planResponsesRequest({
      actorId: "actor-1",
      providerId: "openai",
      model: "gpt-5.5",
      mode: "stateful_chain",
      transportSupportsContinuation: true,
      baseline: { previousResponseId: "resp-1", baselineEpoch: 1, contextDigest: digest },
      checkpoint,
      currentEpoch: 1,
      currentContextDigest: digest,
      currentMessages: [{ role: "user", content: "before" }, { role: "tool", content: "ok" }],
      fullCanonicalInput: [
        { type: "function_call", call_id: "call-1", name: "inspect", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "ok" },
      ],
      incrementalInput: [{ type: "function_call_output", call_id: "call-1", output: "ok" }],
      stablePrefix: { providerId: "openai", model: "gpt-5.5" },
    });

    expect(plan.kind).toBe("stateful_incremental");
    expect(plan.lineageProof.status).toBe("valid");
  });

  it("rejects a request that leaves a previous function call unresolved", () => {
    expect(decideResponsesRequestLineage([
      { type: "function_call", call_id: "call-pending", name: "inspect", arguments: "{}" },
    ])).toEqual(expect.objectContaining({
      status: "invalid",
      reason: "unresolved_function_call",
      callId: "call-pending",
    }));
  });

  it("keeps provider output lineage permissive until the request is assembled", () => {
    const output = [{
      type: "function_call",
      call_id: "call-pending",
      name: "inspect",
      arguments: "{}",
    }];

    expect(decideResponsesCallLineage(output).status).toBe("valid");
    expect(decideResponsesRequestLineage(output).status).toBe("invalid");
  });

  it("falls back to canonical input when the native window is not request-closed", () => {
    const checkpoint = checkpointWithPendingCall();
    const plan = planResponsesRequest({
      actorId: "actor-1",
      providerId: "openai",
      model: "gpt-5.5",
      mode: "stateless_replay",
      transportSupportsContinuation: false,
      baseline: undefined,
      checkpoint,
      currentEpoch: 1,
      currentContextDigest: digest,
      currentMessages: [{ role: "user", content: "before" }],
      fullCanonicalInput: [
        { type: "function_call", call_id: "call-1", name: "inspect", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "ok" },
      ],
      incrementalInput: [],
      stablePrefix: { providerId: "openai", model: "gpt-5.5" },
    });

    expect(plan).toEqual(expect.objectContaining({
      kind: "stateless_replay",
      source: "canonical_rebuild",
    }));
  });

  it.each([
    ["orphan_function_call_output", [{ type: "function_call_output", call_id: "missing", output: "x" }]],
    ["duplicate_function_call", [
      { type: "function_call", call_id: "duplicate", name: "a", arguments: "{}" },
      { type: "function_call", call_id: "duplicate", name: "a", arguments: "{}" },
    ]],
    ["out_of_order_function_call_output", [
      { type: "function_call_output", call_id: "late", output: "x" },
      { type: "function_call", call_id: "late", name: "a", arguments: "{}" },
    ]],
    ["empty_call_id", [{ type: "function_call_output", call_id: "", output: "x" }]],
  ] as const)("reports %s", (reason, items) => {
    expect(decideResponsesCallLineage(items)).toEqual(expect.objectContaining({
      status: "invalid",
      reason,
    }));
  });

  it("falls back from invalid native lineage to a valid canonical rebuild", () => {
    const checkpoint = checkpointWithPendingCall();
    const corrupted = {
      ...checkpoint,
      nativeWindow: [
        ...checkpoint.nativeWindow,
        { type: "function_call_output", call_id: "orphan", output: "bad" },
      ],
    };
    const plan = planResponsesRequest({
      actorId: "actor-1",
      providerId: "openai",
      model: "gpt-5.5",
      mode: "stateless_replay",
      transportSupportsContinuation: false,
      checkpoint: corrupted,
      currentEpoch: 1,
      currentContextDigest: digest,
      currentMessages: [{ role: "user", content: "before" }, { role: "user", content: "now" }],
      fullCanonicalInput: [{ type: "message", role: "user", content: [] }],
      incrementalInput: [{ type: "message", role: "user", content: [] }],
      stablePrefix: { providerId: "openai", model: "gpt-5.5" },
    });

    expect(plan).toEqual(expect.objectContaining({
      kind: "stateless_replay",
      source: "canonical_rebuild",
    }));
  });

  it("rejects an orphan current delta even when a previous stateful lineage exists", () => {
    const checkpoint = checkpointWithPendingCall();
    const plan = planResponsesRequest({
      actorId: "actor-1",
      providerId: "openai",
      model: "gpt-5.5",
      mode: "stateful_chain",
      transportSupportsContinuation: true,
      baseline: { previousResponseId: "resp-1", baselineEpoch: 1, contextDigest: digest },
      checkpoint,
      currentEpoch: 1,
      currentContextDigest: digest,
      currentMessages: [{ role: "user", content: "before" }, { role: "tool", content: "bad" }],
      fullCanonicalInput: [
        { type: "function_call", call_id: "orphan-current", name: "repair", arguments: "{}" },
        { type: "function_call_output", call_id: "orphan-current", output: "bad" },
      ],
      incrementalInput: [{ type: "function_call_output", call_id: "orphan-current", output: "bad" }],
      stablePrefix: { providerId: "openai", model: "gpt-5.5" },
    });

    expect(plan).toEqual(expect.objectContaining({
      kind: "stateless_replay",
      source: "canonical_rebuild",
    }));
  });

  it("fails closed when canonical rebuild is still invalid", () => {
    expect(() => planResponsesRequest({
      actorId: "actor-1",
      providerId: "openai",
      model: "gpt-5.5",
      mode: "stateless_replay",
      transportSupportsContinuation: false,
      currentEpoch: 1,
      currentContextDigest: digest,
      currentMessages: [],
      fullCanonicalInput: [{ type: "function_call_output", call_id: "orphan", output: "bad" }],
      incrementalInput: [],
      stablePrefix: { providerId: "openai", model: "gpt-5.5" },
    })).toThrow("orphan_function_call_output");
  });

  it("invalidates an old checkpoint without completeness/lineage proof", () => {
    const checkpoint = checkpointWithPendingCall() as any;
    const oldCheckpoint = { ...checkpoint, schemaVersion: 1 };
    const plan = planResponsesRequest({
      actorId: "actor-1",
      providerId: "openai",
      model: "gpt-5.5",
      mode: "stateful_chain",
      transportSupportsContinuation: true,
      baseline: { previousResponseId: "resp-1", baselineEpoch: 1, contextDigest: digest },
      checkpoint: oldCheckpoint,
      currentEpoch: 1,
      currentContextDigest: digest,
      currentMessages: [{ role: "user", content: "before" }],
      fullCanonicalInput: [{ type: "message", role: "user", content: [] }],
      incrementalInput: [],
      stablePrefix: { providerId: "openai", model: "gpt-5.5" },
    });

    expect(plan).toEqual(expect.objectContaining({
      kind: "stateless_replay",
      source: "canonical_rebuild",
    }));
  });
});
