import { describe, expect, it } from "bun:test";
import type {
  ResponsesReplayCheckpoint,
  ResponsesRequestPlan,
} from "@cell/ai-organ-contract/llm/ResponsesReplay";
import {
  createResponsesContextDigest,
  createResponsesMessageFingerprint,
  createResponsesMessageFrontier,
  createResponsesProviderOutputSnapshot,
  createResponsesReplayCheckpoint,
  createResponsesStablePromptCacheKey,
  planResponsesRequest,
} from "@cell/ai-organ-logic/llm";

const providerId = "openai";
const model = "gpt-5.2";
const actorId = "actor-1";
const baselineMessages = [
  { role: "user", content: "first" },
  { role: "assistant", content: "done" },
];
const currentMessages = [
  ...baselineMessages,
  { role: "user", content: "continue" },
];
const nativeRequest = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "first" }],
  },
];
const nativeOutput = [
  {
    type: "reasoning",
    id: "reasoning-1",
    encrypted_content: "ciphertext",
    summary: [],
  },
  {
    type: "message",
    id: "message-1",
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", text: "done" }],
  },
];
const incrementalInput = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "continue" }],
  },
];
const canonicalFullInput = [...nativeRequest, ...nativeOutput, ...incrementalInput];
const contextDigest = createResponsesContextDigest({
  providerId,
  model,
  stableInstructions: "stable system prompt",
  tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
  dynamicContext: { projectionRevision: 3 },
});

function makeCheckpoint(
  overrides: Partial<{
    baselineEpoch: number;
    contextDigest: string;
    messageFrontier: ReturnType<typeof createResponsesMessageFrontier>;
    responseId: string;
    requestKind: "stateful_incremental" | "stateless_replay";
    priorCheckpoint: ResponsesReplayCheckpoint;
  }> = {},
): ResponsesReplayCheckpoint {
  return createResponsesReplayCheckpoint({
    actorId,
    providerId,
    model,
    baselineEpoch: overrides.baselineEpoch ?? 7,
    contextDigest: overrides.contextDigest ?? contextDigest,
    messageFrontier:
      overrides.messageFrontier ?? createResponsesMessageFrontier(baselineMessages),
    requestKind: overrides.requestKind ?? "stateless_replay",
    priorCheckpoint: overrides.priorCheckpoint,
    requestInput: nativeRequest,
    output: createResponsesProviderOutputSnapshot({
      responseId: overrides.responseId ?? "resp-1",
      items: nativeOutput,
    }),
  });
}

function plan(
  overrides: Partial<Parameters<typeof planResponsesRequest>[0]> = {},
): ResponsesRequestPlan {
  return planResponsesRequest({
    actorId,
    providerId,
    model,
    mode: "stateful_chain",
    transportSupportsContinuation: true,
    baseline: {
      previousResponseId: "resp-1",
      baselineEpoch: 7,
      contextDigest,
    },
    checkpoint: makeCheckpoint(),
    currentEpoch: 7,
    currentContextDigest: contextDigest,
    currentMessages,
    fullCanonicalInput: canonicalFullInput,
    incrementalInput,
    stablePrefix: {
      providerId,
      model,
      stableInstructions: "stable system prompt",
      tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
    },
    ...overrides,
  });
}

describe("OpenAI Responses hybrid request plan", () => {
  it("uses previous response id and only delta items when every stateful condition matches", () => {
    expect(plan()).toEqual(
      expect.objectContaining({
        kind: "stateful_incremental",
        previousResponseId: "resp-1",
        input: incrementalInput,
        contextDigest,
      }),
    );
  });

  it.each([
    ["epoch", { currentEpoch: 8 }],
    ["digest", { currentContextDigest: "sha256:different" }],
    [
      "frontier",
      {
        checkpoint: makeCheckpoint({
          messageFrontier: createResponsesMessageFrontier([
            { role: "user", content: "different" },
          ]),
        }),
      },
    ],
  ] as const)("rebuilds canonical full input on %s mismatch", (_name, overrides) => {
    expect(plan(overrides)).toEqual(
      expect.objectContaining({
        kind: "stateless_replay",
        source: "canonical_rebuild",
        input: canonicalFullInput,
      }),
    );
    expect(plan(overrides)).not.toHaveProperty("previousResponseId");
  });

  it("uses a matching provider-native window when stateful continuation is unavailable", () => {
    const result = plan({ mode: "stateless_replay" });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "stateless_replay",
        source: "native_window",
        input: [...makeCheckpoint().nativeWindow, ...incrementalInput],
      }),
    );
    expect(result).not.toHaveProperty("previousResponseId");
  });

  it("rebuilds from canonical input when no replay checkpoint exists", () => {
    expect(plan({
      mode: "stateless_replay",
      checkpoint: undefined,
      baseline: undefined,
    })).toEqual(
      expect.objectContaining({
        kind: "stateless_replay",
        source: "canonical_rebuild",
        input: canonicalFullInput,
      }),
    );
  });

  it("keeps provider-visible stateless input equivalent when the checkpoint is deleted", () => {
    const optimized = plan({ mode: "stateless_replay" });
    const rebuilt = plan({
      mode: "stateless_replay",
      checkpoint: undefined,
      baseline: undefined,
    });

    expect(optimized).toEqual(expect.objectContaining({ source: "native_window" }));
    expect(rebuilt).toEqual(expect.objectContaining({ source: "canonical_rebuild" }));
    expect(optimized.input).toEqual(rebuilt.input);
  });

  it("classifies replay state as a non-authoritative replaceable snapshot", () => {
    const checkpoint = makeCheckpoint();

    expect(checkpoint).toEqual(
      expect.objectContaining({
        kind: "provider_replay_checkpoint",
        factClass: "checkpoint_snapshot",
        authority: "non_authoritative",
        recoveryRole: "none",
      }),
    );
  });

  it("copies, orders, and deeply freezes provider-native output items", () => {
    const mutableItems = structuredClone(nativeOutput);
    const snapshot = createResponsesProviderOutputSnapshot({
      responseId: "resp-1",
      items: mutableItems,
    });
    (mutableItems[0] as { encrypted_content: string }).encrypted_content = "mutated";

    expect(snapshot.items).toEqual(nativeOutput);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(Object.isFrozen(snapshot.items[0])).toBe(true);
  });

  it.each([
    ["checkpoint schema version", { schemaVersion: 1 }],
    ["checkpoint kind", { kind: "history_fact" }],
    ["checkpoint native window", { nativeWindow: [null] }],
    [
      "checkpoint native window fingerprint",
      {
        nativeWindowFingerprint: {
          ...makeCheckpoint().nativeWindowFingerprint,
          digest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    ],
    ["checkpoint request input", { requestInput: "not-an-array" }],
    [
      "message frontier shape",
      { messageFrontier: { schemaVersion: 1, algorithm: "md5", messageCount: 2, digest: "x" } },
    ],
    ["output schema version", { output: { ...makeCheckpoint().output, schemaVersion: 1 } }],
    ["output completeness proof", { output: { ...makeCheckpoint().output, completenessProof: undefined } }],
    ["checkpoint lineage proof", { lineageProof: undefined }],
    ["output kind", { output: { ...makeCheckpoint().output, kind: "message" } }],
    ["output item shape", { output: { ...makeCheckpoint().output, items: [null] } }],
  ])("fails closed to canonical rebuild for a damaged %s", (_name, damage) => {
    const damaged = {
      ...makeCheckpoint(),
      ...damage,
    } as unknown as ResponsesReplayCheckpoint;

    expect(plan({
      mode: "stateless_replay",
      baseline: undefined,
      checkpoint: damaged,
    })).toEqual(expect.objectContaining({
      kind: "stateless_replay",
      source: "canonical_rebuild",
      input: canonicalFullInput,
    }));
  });

  it("retains a complete ordered native replay window after three stateful checkpoints", () => {
    const makeInput = (turn: number) => [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `user-${turn}` }],
    }];
    const makeOutput = (turn: number) => createResponsesProviderOutputSnapshot({
      responseId: `resp-${turn}`,
      items: [
        { type: "reasoning", id: `reasoning-${turn}`, encrypted_content: `cipher-${turn}` },
        {
          type: "message",
          id: `assistant-${turn}`,
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: `assistant-${turn}` }],
        },
      ],
    });
    const createCheckpoint = (
      turn: number,
      requestKind: "stateful_incremental" | "stateless_replay",
      priorCheckpoint?: ResponsesReplayCheckpoint,
    ) => createResponsesReplayCheckpoint({
      actorId,
      providerId,
      model,
      baselineEpoch: 7,
      contextDigest,
      messageFrontier: createResponsesMessageFrontier(
        Array.from({ length: turn }, (_, index) => ({ turn: index + 1 })),
      ),
      requestKind,
      priorCheckpoint,
      requestInput: makeInput(turn),
      output: makeOutput(turn),
    });

    const initial = createCheckpoint(1, "stateless_replay");
    const second = createCheckpoint(2, "stateful_incremental", initial);
    const third = createCheckpoint(3, "stateful_incremental", second);
    const fourth = createCheckpoint(4, "stateful_incremental", third);
    const fifthInput = makeInput(5);
    const result = planResponsesRequest({
      actorId,
      providerId,
      model,
      mode: "stateless_replay",
      transportSupportsContinuation: true,
      baseline: undefined,
      checkpoint: fourth,
      currentEpoch: 7,
      currentContextDigest: contextDigest,
      currentMessages: [
        { turn: 1 },
        { turn: 2 },
        { turn: 3 },
        { turn: 4 },
        { turn: 5 },
      ],
      fullCanonicalInput: [],
      incrementalInput: fifthInput,
      stablePrefix: { providerId, model },
    });

    expect(fourth.nativeWindow).toEqual([
      ...makeInput(1), ...makeOutput(1).items,
      ...makeInput(2), ...makeOutput(2).items,
      ...makeInput(3), ...makeOutput(3).items,
      ...makeInput(4), ...makeOutput(4).items,
    ]);
    expect(result).toEqual(expect.objectContaining({
      kind: "stateless_replay",
      source: "native_window",
      input: [...fourth.nativeWindow, ...fifthInput],
    }));
  });

  it("deeply copies and freezes the cumulative native window", () => {
    const mutableRequest = structuredClone(nativeRequest);
    const checkpoint = createResponsesReplayCheckpoint({
      actorId,
      providerId,
      model,
      baselineEpoch: 7,
      contextDigest,
      messageFrontier: createResponsesMessageFrontier(baselineMessages),
      requestKind: "stateless_replay",
      requestInput: mutableRequest,
      output: createResponsesProviderOutputSnapshot({ responseId: "resp-1", items: nativeOutput }),
    });
    mutableRequest[0]!.content[0]!.text = "mutated";

    expect(checkpoint.nativeWindow[0]).toEqual(nativeRequest[0]);
    expect(Object.isFrozen(checkpoint)).toBe(true);
    expect(Object.isFrozen(checkpoint.nativeWindow)).toBe(true);
    expect(Object.isFrozen(checkpoint.nativeWindow[0])).toBe(true);
  });
});

describe("OpenAI Responses stable fingerprints", () => {
  const prefix = {
    providerId,
    model,
    stableInstructions: "stable system prompt",
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
  };

  it("produces the same cache key for structurally equal stable prefixes", () => {
    const reordered = {
      tools: [{ parameters: { type: "object" }, name: "read", type: "function" }],
      stableInstructions: "stable system prompt",
      model,
      providerId,
    };

    expect(createResponsesStablePromptCacheKey(prefix)).toBe(
      createResponsesStablePromptCacheKey(reordered),
    );
  });

  it.each([
    ["model", { ...prefix, model: "gpt-5.3" }],
    ["stable instructions", { ...prefix, stableInstructions: "changed" }],
    ["tools", { ...prefix, tools: [{ type: "function", name: "write" }] }],
  ])("changes the cache key when %s changes", (_name, changedPrefix) => {
    expect(createResponsesStablePromptCacheKey(prefix)).not.toBe(
      createResponsesStablePromptCacheKey(changedPrefix),
    );
  });

  it("keeps message frontier and context digests deterministic but domain-separated", () => {
    expect(createResponsesMessageFingerprint({ content: "x", role: "user" })).toEqual(
      createResponsesMessageFingerprint({ role: "user", content: "x" }),
    );
    expect(createResponsesMessageFingerprint({ role: "user", content: "x" })).not.toEqual(
      createResponsesMessageFingerprint({ role: "user", content: "y" }),
    );
    expect(createResponsesMessageFrontier([{ content: "x", role: "user" }])).toEqual(
      createResponsesMessageFrontier([{ role: "user", content: "x" }]),
    );
    expect(contextDigest).toBe(
      createResponsesContextDigest({
        dynamicContext: { projectionRevision: 3 },
        tools: [{ parameters: { type: "object" }, name: "read", type: "function" }],
        stableInstructions: "stable system prompt",
        model,
        providerId,
      }),
    );
    expect(contextDigest).not.toBe(createResponsesStablePromptCacheKey(prefix));
  });
});
