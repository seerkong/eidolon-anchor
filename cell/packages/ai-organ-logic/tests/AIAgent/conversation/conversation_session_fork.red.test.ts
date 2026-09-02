import { describe, expect, it } from "bun:test";

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorHistoryGenerationData,
  type ActorPromptGenerationData,
  type ConversationSessionForkCommand,
} from "@cell/ai-organ-contract";
import {
  createProviderEpochReceiptV2,
  digestProviderContextClosedValue,
  digestProviderContextHistoryFrontier,
  planConversationSessionFork,
  resolveConversationForkPoint,
  type ConversationForkSourceSnapshot,
} from "@cell/ai-organ-logic";

const occurredAt = "2026-09-01T00:00:00.000Z";

function message(recordId: string, messageId: string, role: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    recordId,
    actorKey: "main",
    actorId: "actor-parent",
    committedAt: 1,
    message: { messageId, role, content, ...extra },
  };
}

function sourceSnapshot(input?: {
  activeMessages?: ActorHistoryGenerationData["messages"];
  predecessorMessages?: ActorHistoryGenerationData["messages"];
}): ConversationForkSourceSnapshot {
  const predecessorMessages = input?.predecessorMessages ?? [];
  const activeMessages = input?.activeMessages ?? [
    message("active::0", "m-user", "user", "question"),
    message("active::1", "m-assistant", "assistant", "answer"),
  ];
  const hasCompaction = predecessorMessages.length > 0;
  const activeId = hasCompaction ? "compact-active" : "active";
  const generations: ActorHistoryGenerationData[] = [
    ...(hasCompaction ? [{
      version: 1,
      generationId: "predecessor",
      sessionId: "parent",
      actorKey: "main",
      actorId: "actor-parent",
      parentGenerationId: null,
      predecessorGenerationIds: [],
      createdReason: "append" as const,
      sealed: true,
      messageCount: predecessorMessages.length,
      messages: predecessorMessages,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }] : []),
    {
      version: 1,
      generationId: activeId,
      sessionId: "parent",
      actorKey: "main",
      actorId: "actor-parent",
      parentGenerationId: hasCompaction ? "predecessor" : null,
      predecessorGenerationIds: hasCompaction ? ["predecessor"] : [],
      createdReason: hasCompaction ? "compaction" : "append",
      sealed: false,
      messageCount: activeMessages.length,
      messages: activeMessages,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
  ];
  const prompt: ActorPromptGenerationData = {
    version: 1,
    promptGenerationId: "prompt",
    sessionId: "parent",
    actorKey: "main",
    actorId: "actor-parent",
    basedOnPromptGenerationId: null,
    basis: {
      version: 1,
      basisHistoryGenerationIds: hasCompaction ? ["predecessor", activeId] : [activeId],
      basisMessageRecordIds: [],
      basisRefs: [
        ...(hasCompaction ? [{ refKind: "history_generation" as const, refId: "predecessor" }] : []),
        { refKind: "history_generation", refId: activeId },
      ],
    },
    transforms: hasCompaction ? [{
      transformId: "prompt::summary",
      kind: "history_compaction_summary",
      payload: {
        summary: "sealed predecessor summary",
        sourceHistoryGenerationId: "predecessor",
        targetHistoryGenerationId: activeId,
      },
      appliedAt: occurredAt,
    }] : [],
    createdReason: "request_build",
    materializedContext: hasCompaction ? "sealed predecessor summary" : null,
    sealed: false,
    createdAt: occurredAt,
    sealedAt: null,
    updatedAt: occurredAt,
    metadata: { systemPrompts: ["stable system"] },
  };
  const emptyDigest = digestProviderContextClosedValue([]);
  const receipt = createProviderEpochReceiptV2({
    sessionId: "parent",
    actorKey: "main",
    actorId: "actor-parent",
    epoch: 3,
    previousReceiptDigest: emptyDigest,
    targetProviderId: "deepseek-iqingwa",
    targetModelId: "deepseek-v4-pro",
    targetProfileId: "deepseek-chat@1",
    baselineHeads: { historyHeadGenerationId: activeId, promptHeadGenerationId: "prompt", factHeadDigest: null },
    sourceHistoryMessageCount: activeMessages.length,
    sourceFrontierDigest: digestProviderContextHistoryFrontier(activeMessages),
    pendingDeliveryDigest: emptyDigest,
    handoffDigest: emptyDigest,
    frozenResourceDigest: emptyDigest,
    providerSurfaceDigest: emptyDigest,
    retentionPolicy: { maxRevisionsPerNamespace: 8, maxCanonicalFactBytesPerEpoch: 262_144 },
    reason: hasCompaction ? "history_compaction" : "initial_projection",
    compactionProofDigest: hasCompaction ? emptyDigest : null,
    createdAt: occurredAt,
  });
  return {
    historyIndex: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "parent",
      heads: { main: { version: 1, sessionId: "parent", actorKey: "main", actorId: "actor-parent", activeGenerationId: activeId, visibleGenerationIds: generations.map((generation) => generation.generationId), updatedAt: occurredAt } },
      lineages: Object.fromEntries(generations.map((generation) => [generation.generationId, {
        version: 1,
        sessionId: "parent",
        actorKey: "main",
        actorId: "actor-parent",
        generationId: generation.generationId,
        parentGenerationId: generation.parentGenerationId,
        rolledBackFromGenerationId: null,
        predecessorGenerationIds: generation.predecessorGenerationIds,
        successorGenerationIds: [],
        forkGenerationIds: [],
        branchLabel: null,
        updatedAt: occurredAt,
      }])),
      generations: Object.fromEntries(generations.map((generation) => [generation.generationId, { generationId: generation.generationId, actorKey: "main", actorId: "actor-parent", sealed: generation.sealed, createdAt: occurredAt, updatedAt: occurredAt }])),
      updatedAt: occurredAt,
    },
    promptIndex: {
      version: 1,
      sessionId: "parent",
      heads: { main: { version: 1, sessionId: "parent", actorKey: "main", actorId: "actor-parent", activePromptGenerationId: "prompt", updatedAt: occurredAt } },
      generations: { prompt: { promptGenerationId: "prompt", actorKey: "main", actorId: "actor-parent", sealed: false, createdAt: occurredAt, updatedAt: occurredAt } },
      updatedAt: occurredAt,
    },
    sessionIndex: {
      version: 1,
      sessionId: "parent",
      session: {
        version: 1,
        sessionId: "parent",
        activeActorKey: "main",
        actorBindings: { main: { actorKey: "main", actorId: "actor-parent", historyHeadGenerationId: activeId, promptHeadGenerationId: "prompt", providerEpochReceiptV2: receipt } },
        contextAssetRegistry: null,
        contextAssets: [],
        activeSelection: { sessionId: "parent", activeActorKey: "main", historyHeadGenerationId: activeId, promptHeadGenerationId: "prompt", selectedAt: occurredAt },
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
      lineage: null,
      updatedAt: occurredAt,
    },
    artifactRefs: { version: 1, sessionId: "parent", refs: [], updatedAt: occurredAt },
    historyGenerations: generations,
    promptGenerations: [prompt],
  };
}

function command(messageId: string): ConversationSessionForkCommand {
  return {
    schemaVersion: "conversation.session-fork-command/v1",
    sourceSessionId: "parent",
    targetSessionId: "child",
    actorKey: "main",
    selector: { kind: "through_committed_message", messageId },
    expectedSourceAuthorityDigest: null,
    occurredAt,
  };
}

describe("Conversation message-level fork proof RED", () => {
  it("plans an active-tail cutoff only through the selected canonical record", () => {
    const result = planConversationSessionFork({
      command: command("m-assistant"),
      source: sourceSnapshot(),
      childActorId: "actor-child",
    });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.generation.historyGenerations.at(-1)?.messages.map((entry) => entry.message.messageId))
      .toEqual(["m-user", "m-assistant"]);
  });

  it("rejects a cutoff between assistant tool call and its tool result", () => {
    const source = sourceSnapshot({ activeMessages: [
      message("active::0", "m-user", "user", "run tool"),
      message("active::1", "m-call", "assistant", "", { toolCalls: [{ id: "call-1", name: "Read", input: {} }] }),
      message("active::2", "m-result", "tool", "result", { toolCallId: "call-1" }),
    ] });
    const result = planConversationSessionFork({ command: command("m-call"), source, childActorId: "actor-child" });
    expect(result).toMatchObject({ status: "rejected", rejection: { code: "TOOL_PAIR_BOUNDARY_OPEN" } });
  });

  it("accepts the same tool pair after its canonical result", () => {
    const source = sourceSnapshot({ activeMessages: [
      message("active::0", "m-user", "user", "run tool"),
      message("active::1", "m-call", "assistant", "", { toolCalls: [{ id: "call-1", name: "Read", input: {} }] }),
      message("active::2", "m-result", "tool", "result", { toolCallId: "call-1" }),
      message("active::3", "m-later", "user", "later"),
    ] });
    expect(planConversationSessionFork({ command: command("m-result"), source, childActorId: "actor-child" }).status)
      .toBe("planned");
  });

  it("treats a later committed user turn as an explicit interruption boundary for an abandoned tool dispatch", () => {
    const source = sourceSnapshot({ activeMessages: [
      message("active::0", "m-user", "user", "run tool"),
      message("active::1", "m-call", "assistant", "starting", { toolCalls: [{ id: "call-abandoned", name: "TaskTreeWrite", input: {} }] }),
      message("active::2", "m-interrupt", "user", "stop that and continue differently"),
      message("active::3", "m-answer", "assistant", "continued safely"),
    ] });
    expect(planConversationSessionFork({ command: command("m-answer"), source, childActorId: "actor-child" }).status)
      .toBe("planned");
  });

  it("rejects missing canonical ids instead of falling back to current head", () => {
    const result = planConversationSessionFork({ command: command("display-only-id"), source: sourceSnapshot(), childActorId: "actor-child" });
    expect(result).toMatchObject({ status: "rejected", rejection: { code: "MESSAGE_NOT_FOUND" } });
  });

  it("fails closed before a compaction boundary when exact historical Prompt state is unavailable", () => {
    const source = sourceSnapshot({
      predecessorMessages: [
        message("predecessor::0", "old-user", "user", "old question"),
        message("predecessor::1", "old-assistant", "assistant", "old answer"),
      ],
      activeMessages: [message("compact-active::0", "new-user", "user", "new question")],
    });
    const result = planConversationSessionFork({ command: command("old-user"), source, childActorId: "actor-child" });
    expect(result).toMatchObject({ status: "rejected", rejection: { code: "PROMPT_STATE_UNPROVABLE" } });
  });

  it("rebinds every loader identity to the child while keeping provider-visible messages stable", () => {
    const source = sourceSnapshot();
    const result = planConversationSessionFork({
      command: command("m-assistant"),
      source,
      childActorId: "actor-child",
    });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    const generation = result.generation.historyGenerations.at(-1)!;
    const prompt = result.generation.promptGenerations[0]!;
    expect(generation).toMatchObject({
      sessionId: "child",
      actorKey: "main",
      actorId: "actor-child",
      createdReason: "fork",
      parentGenerationId: null,
      predecessorGenerationIds: [],
    });
    expect(generation.generationId).not.toBe("active");
    expect(generation.messages.map((entry) => entry.recordId)).not.toEqual(["active::0", "active::1"]);
    expect(generation.messages.map((entry) => entry.message.messageId)).toEqual(["m-user", "m-assistant"]);
    expect(prompt).toMatchObject({
      sessionId: "child",
      actorKey: "main",
      actorId: "actor-child",
      basedOnPromptGenerationId: null,
    });
    expect(prompt.basis.basisHistoryGenerationIds).toEqual([generation.generationId]);
    expect(result.generation.sessionIndex.session.actorBindings.main).toMatchObject({
      actorId: "actor-child",
      historyHeadGenerationId: generation.generationId,
      promptHeadGenerationId: prompt.promptGenerationId,
      providerRequestAdmissions: [],
      providerContextFactHead: null,
    });
    expect(result.generation.sessionIndex.lineage).toMatchObject({
      parentSessionId: "parent",
      forkedFromGenerationId: "active",
    });
  });

  it("copies only Prompt-referenced stable asset state and clears provider/runtime optimization fields", () => {
    const source = sourceSnapshot();
    source.promptGenerations[0]!.basis.basisRefs = [
      ...(source.promptGenerations[0]!.basis.basisRefs ?? []),
      { refKind: "session_asset", refId: "asset-parent" },
    ];
    source.sessionIndex.session.contextAssetRegistry = {
      version: 1,
      assetIds: ["asset-parent", "asset-unreferenced"],
      updatedAt: occurredAt,
    };
    source.sessionIndex.session.contextAssets = [{
      assetId: "asset-parent",
      kind: "workspace_file",
      source: { kind: "workspace_file", path: "/workspace/AGENTS.md" },
      boundPromptGenerationId: "prompt",
      resourceFact: {
        canonicalResourceId: "workspace:AGENTS.md",
        revision: { algorithm: "sha256", digest: "a".repeat(64) },
        fragments: [],
        deliveries: [{ toolCallId: "old-call", revisionDigest: "old", fragmentId: "old", deliveredAt: occurredAt }],
        observedAt: occurredAt,
      },
      projectionFact: {} as never,
      providerContextFactCandidate: {} as never,
      providerContextFact: {} as never,
      toolResultDeliveryFact: {} as never,
      messageDeliveryFact: {} as never,
      replayCheckpoint: {} as never,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }, {
      assetId: "asset-unreferenced",
      kind: "note",
      source: { kind: "note", ownerId: "main" },
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }];
    const sourceBefore = structuredClone(source);
    const result = planConversationSessionFork({ command: command("m-assistant"), source, childActorId: "actor-child" });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    const assets = result.generation.sessionIndex.session.contextAssets ?? [];
    expect(assets).toHaveLength(1);
    expect(assets[0]?.assetId).not.toBe("asset-parent");
    expect(assets[0]?.boundPromptGenerationId).toBe(result.generation.promptGenerations[0]?.promptGenerationId);
    expect(assets[0]?.resourceFact?.deliveries).toEqual([]);
    expect(assets[0]?.projectionFact).toBeUndefined();
    expect(assets[0]?.providerContextFactCandidate).toBeUndefined();
    expect(assets[0]?.providerContextFact).toBeUndefined();
    expect(assets[0]?.toolResultDeliveryFact).toBeUndefined();
    expect(assets[0]?.messageDeliveryFact).toBeUndefined();
    expect(assets[0]?.replayCheckpoint).toBeUndefined();
    expect(source).toEqual(sourceBefore);
  });
});

describe("Conversation fork point resolver", () => {
  it("binds a deterministic active-tail proof to exact source heads and frontier", () => {
    const source = sourceSnapshot();
    const first = resolveConversationForkPoint({ command: command("m-assistant"), source });
    const second = resolveConversationForkPoint({ command: command("m-assistant"), source });
    expect(first.status).toBe("resolved");
    expect(second).toEqual(first);
    if (first.status !== "resolved") return;
    expect(first.value.proof).toMatchObject({
      sourceSessionId: "parent",
      sourceActorKey: "main",
      cutoffHistoryGenerationId: "active",
      cutoffMessageRecordId: "active::1",
      cutoffMessageCount: 2,
      compactionBoundary: "active_tail",
      toolPairBoundaryClosed: true,
    });
    expect(first.value.proof.proofDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects a stale expected source authority digest", () => {
    const stale = {
      ...command("m-assistant"),
      expectedSourceAuthorityDigest: `sha256:${"0".repeat(64)}` as const,
    };
    expect(resolveConversationForkPoint({ command: stale, source: sourceSnapshot() }))
      .toMatchObject({ status: "rejected", rejection: { code: "SOURCE_AUTHORITY_CHANGED" } });
  });

  it("rejects historical-generation selection when the current summary cannot prove that Prompt", () => {
    const source = sourceSnapshot({
      predecessorMessages: [message("predecessor::0", "old-user", "user", "old question")],
      activeMessages: [message("compact-active::0", "new-user", "user", "new question")],
    });
    expect(resolveConversationForkPoint({ command: command("old-user"), source }))
      .toMatchObject({ status: "rejected", rejection: { code: "PROMPT_STATE_UNPROVABLE" } });
  });
});

describe("Conversation fork child provider epoch", () => {
  it("initializes an independent child receipt and keeps the parent receipt as provenance only", () => {
    const source = sourceSnapshot();
    const parentReceipt = source.sessionIndex.session.actorBindings.main!.providerEpochReceiptV2!;
    const result = planConversationSessionFork({
      command: command("m-assistant"),
      source,
      childActorId: "actor-child",
    });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    const receipt = result.generation.childProviderEpochReceipt;
    const binding = result.generation.sessionIndex.session.actorBindings.main!;
    expect(receipt).toMatchObject({
      schemaVersion: "provider.epoch-receipt/v2",
      sessionId: "child",
      actorKey: "main",
      actorId: "actor-child",
      epoch: 0,
      previousReceiptDigest: null,
      reason: "history_rewind_or_fork",
      compactionProofDigest: null,
      baselineHeads: {
        historyHeadGenerationId: binding.historyHeadGenerationId,
        promptHeadGenerationId: binding.promptHeadGenerationId,
        factHeadDigest: null,
      },
    });
    expect(receipt.receiptDigest).not.toBe(parentReceipt.receiptDigest);
    expect(result.generation.providerEpoch).toMatchObject({
      childSessionId: "child",
      childActorId: "actor-child",
      parentReceiptDigest: parentReceipt.receiptDigest,
      childReceiptDigest: receipt.receiptDigest,
      reason: "history_rewind_or_fork",
    });
    expect(binding.providerEpochReceiptV2).toEqual(receipt);
    expect(binding.providerEpochReceipt).toBeUndefined();
    expect(binding.providerRequestAdmissions).toEqual([]);
    expect(binding.providerContextFactHead).toBeNull();
  });

  it("binds its frontier to child canonical authority without changing provider-visible message payloads", () => {
    const source = sourceSnapshot();
    const first = planConversationSessionFork({ command: command("m-assistant"), source, childActorId: "actor-child" });
    const second = planConversationSessionFork({ command: command("m-assistant"), source, childActorId: "actor-child" });
    expect(first).toEqual(second);
    expect(first.status).toBe("planned");
    if (first.status !== "planned") return;
    const active = first.generation.historyGenerations.at(-1)!;
    const receipt = first.generation.childProviderEpochReceipt;
    expect(receipt.sourceHistoryMessageCount).toBe(active.messages.length);
    expect(receipt.sourceFrontierDigest).toBe(digestProviderContextHistoryFrontier(active.messages));
    expect(active.messages.map((entry) => entry.message)).toEqual(
      source.historyGenerations.at(-1)!.messages.map((entry) => entry.message),
    );
  });
});
