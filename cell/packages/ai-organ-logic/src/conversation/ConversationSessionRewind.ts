import type {
  ActorCommittedMessageRef,
  ActorHistoryGenerationData,
  ActorPromptGenerationData,
  ConversationForkAuthoritySnapshot,
  ConversationProviderContextTransitionGeneration,
  ConversationSessionRewindCommand,
  ConversationSessionRewindPlanResult,
  ConversationSessionRewindRejection,
  LocalConversationContextAssetData,
} from "@cell/ai-organ-contract";
import {
  createProviderEpochReceiptV2,
  digestProviderContextClosedValue,
  digestProviderContextHistoryFrontier,
} from "./ProviderContextEpochV2";
import {
  resolveConversationForkPoint,
  type ConversationForkSourceSnapshot,
} from "./ConversationSessionFork";

function persisted<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function reject(
  code: ConversationSessionRewindRejection["code"],
  message: string,
  facts?: Readonly<Record<string, unknown>>,
): ConversationSessionRewindPlanResult {
  return { status: "rejected", rejection: { code, message, ...(facts ? { facts } : {}) } };
}

function rewriteIdentifiers(value: unknown, identifiers: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return identifiers.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => rewriteIdentifiers(entry, identifiers));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
    entry === undefined ? [] : [[key, rewriteIdentifiers(entry, identifiers)]]
  )));
}

function actorOwnedTransientAsset(asset: LocalConversationContextAssetData, actorKey: string): boolean {
  return asset.providerContextFact?.actorKey === actorKey
    || asset.providerContextFactCandidate?.actorKey === actorKey
    || asset.projectionFact?.actorKey === actorKey
    || asset.toolResultDeliveryFact?.actorKey === actorKey
    || asset.messageDeliveryFact?.actorKey === actorKey
    || Boolean(asset.replayCheckpoint && asset.source.kind === "note" && asset.source.ownerId === actorKey);
}

function normalizeRejection(
  rejection: Readonly<{ code: string; message: string; facts?: Readonly<Record<string, unknown>> }>,
): ConversationSessionRewindPlanResult {
  const code = rejection.code === "SOURCE_ACTOR_NOT_FOUND"
    ? "ACTOR_NOT_FOUND"
    : rejection.code === "SOURCE_SESSION_NOT_FOUND"
      ? "SESSION_NOT_FOUND"
      : rejection.code;
  return reject(code as ConversationSessionRewindRejection["code"], rejection.message, rejection.facts);
}

/**
 * Pure same-session rewind Processor. It shares fork-point proof semantics but
 * creates a rollback successor rather than a cross-session child authority.
 */
export function planConversationSessionRewind(input: Readonly<{
  command: ConversationSessionRewindCommand;
  source: ConversationForkAuthoritySnapshot;
}>): ConversationSessionRewindPlanResult {
  const { command, source } = input;
  if (source.sessionIndex.sessionId !== command.sessionId) {
    return reject("SESSION_NOT_FOUND", `Conversation authority is unavailable: ${command.sessionId}`);
  }
  const resolved = resolveConversationForkPoint({
    command: {
      schemaVersion: "conversation.session-fork-command/v1",
      sourceSessionId: command.sessionId,
      targetSessionId: `${command.sessionId}#rewind-proof`,
      actorKey: command.actorKey,
      selector: command.selector,
      expectedSourceAuthorityDigest: command.expectedSourceAuthorityDigest,
      occurredAt: command.occurredAt,
    },
    source: source as ConversationForkSourceSnapshot,
  }, { allowActiveTailPromptRebase: true });
  if (resolved.status === "rejected") return normalizeRejection(resolved.rejection);

  const { proof, actorKey, actorId, sourceHistoryGenerations, sourcePromptGeneration } = resolved.value;
  const binding = source.sessionIndex.session.actorBindings[actorKey];
  const previousReceipt = binding?.providerEpochReceiptV2;
  if (!binding) return reject("ACTOR_NOT_FOUND", `Conversation actor is unavailable: ${actorKey}`);
  if (!previousReceipt) return reject("SOURCE_PROVIDER_EPOCH_MISSING", "active actor has no provider epoch receipt");

  const previousHistoryHead = proof.sourceHeads.historyHeadGenerationId;
  const previousPromptHead = proof.sourceHeads.promptHeadGenerationId;
  const sourceActive = source.historyGenerations.find((entry) => entry.generationId === previousHistoryHead);
  const selectedActive = sourceHistoryGenerations.find((entry) => entry.generationId === previousHistoryHead);
  if (!sourceActive || !selectedActive) {
    return reject("SOURCE_HISTORY_HEAD_MISSING", "active History generation is unavailable");
  }
  if (selectedActive.messages.length >= sourceActive.messages.length) {
    return reject("REWIND_NO_CHANGE", "selected message is already the active History frontier");
  }

  const idSeed = digestProviderContextClosedValue({
    kind: "conversation-session-rewind/v1",
    sessionId: command.sessionId,
    actorKey,
    sourceAuthorityDigest: proof.sourceAuthorityDigest,
    proofDigest: proof.proofDigest,
    occurredAt: command.occurredAt,
  });
  const suffix = idSeed.slice("sha256:".length, "sha256:".length + 24);
  const historyGenerationId = `history-rewind-${suffix}`;
  const promptGenerationId = `prompt-rewind-${suffix}`;
  const retainedMessages = persisted(selectedActive.messages) as ActorCommittedMessageRef[];

  const historyGeneration: ActorHistoryGenerationData = {
    version: sourceActive.version,
    generationId: historyGenerationId,
    sessionId: command.sessionId,
    actorKey,
    actorId,
    parentGenerationId: previousHistoryHead,
    // The abandoned predecessor is provenance, not active visible history.
    predecessorGenerationIds: [],
    createdReason: "rollback",
    sealed: false,
    messageCount: retainedMessages.length,
    messages: retainedMessages,
    createdAt: command.occurredAt,
    updatedAt: command.occurredAt,
  };

  const identifiers = new Map<string, string>();
  for (const generation of sourceHistoryGenerations) identifiers.set(generation.generationId, historyGenerationId);
  identifiers.set(previousHistoryHead, historyGenerationId);
  identifiers.set(sourcePromptGeneration.promptGenerationId, promptGenerationId);
  const retainedRecordIds = new Set(retainedMessages.map((entry) => entry.recordId));
  const basisRefs = (sourcePromptGeneration.basis.basisRefs ?? []).flatMap((ref) => {
    if (ref.refKind === "message" && !retainedRecordIds.has(ref.refId)) return [];
    return [rewriteIdentifiers(ref, identifiers) as NonNullable<ActorPromptGenerationData["basis"]["basisRefs"]>[number]];
  });
  const rewrittenMetadata = rewriteIdentifiers(sourcePromptGeneration.metadata ?? {}, identifiers) as Record<string, unknown>;
  const promptGeneration: ActorPromptGenerationData = {
    ...persisted(sourcePromptGeneration),
    promptGenerationId,
    basedOnPromptGenerationId: previousPromptHead,
    basis: {
      version: sourcePromptGeneration.basis.version,
      basisHistoryGenerationIds: [historyGenerationId],
      basisMessageRecordIds: sourcePromptGeneration.basis.basisMessageRecordIds.filter((id) => retainedRecordIds.has(id)),
      basisRefs,
    },
    transforms: rewriteIdentifiers(sourcePromptGeneration.transforms, identifiers) as ActorPromptGenerationData["transforms"],
    createdReason: "restore",
    sealed: false,
    createdAt: command.occurredAt,
    sealedAt: null,
    updatedAt: command.occurredAt,
    metadata: {
      ...rewrittenMetadata,
      targetHistoryGenerationId: historyGenerationId,
      rewind: {
        proofDigest: proof.proofDigest,
        rolledBackFromGenerationId: previousHistoryHead,
        cutoffMessageRecordId: proof.cutoffMessageRecordId,
      },
    },
  };

  const historyIndex = persisted(source.historyIndex);
  historyIndex.updatedAt = command.occurredAt;
  historyIndex.heads[actorKey] = {
    version: historyIndex.version,
    sessionId: command.sessionId,
    actorKey,
    actorId,
    activeGenerationId: historyGenerationId,
    visibleGenerationIds: [historyGenerationId],
    updatedAt: command.occurredAt,
  };
  const oldLineage = historyIndex.lineages[previousHistoryHead];
  if (oldLineage) {
    historyIndex.lineages[previousHistoryHead] = {
      ...oldLineage,
      successorGenerationIds: [...new Set([...oldLineage.successorGenerationIds, historyGenerationId])],
      updatedAt: command.occurredAt,
    };
  }
  historyIndex.lineages[historyGenerationId] = {
    version: historyIndex.version,
    sessionId: command.sessionId,
    actorKey,
    actorId,
    generationId: historyGenerationId,
    parentGenerationId: previousHistoryHead,
    rolledBackFromGenerationId: previousHistoryHead,
    predecessorGenerationIds: [],
    successorGenerationIds: [],
    forkGenerationIds: [],
    branchLabel: "rewind",
    updatedAt: command.occurredAt,
  };
  historyIndex.generations[historyGenerationId] = {
    generationId: historyGenerationId,
    actorKey,
    actorId,
    sealed: false,
    createdAt: command.occurredAt,
    updatedAt: command.occurredAt,
  };

  const promptIndex = persisted(source.promptIndex);
  promptIndex.updatedAt = command.occurredAt;
  promptIndex.heads[actorKey] = {
    version: promptIndex.version,
    sessionId: command.sessionId,
    actorKey,
    actorId,
    activePromptGenerationId: promptGenerationId,
    updatedAt: command.occurredAt,
  };
  promptIndex.generations[promptGenerationId] = {
    promptGenerationId,
    actorKey,
    actorId,
    sealed: false,
    createdAt: command.occurredAt,
    updatedAt: command.occurredAt,
  };

  const nextHeadsWithoutReceipt = {
    historyHeadGenerationId: historyGenerationId,
    promptHeadGenerationId: promptGenerationId,
    factHeadDigest: null,
  };
  const emptyDigest = digestProviderContextClosedValue([]);
  const nextReceipt = createProviderEpochReceiptV2({
    ...previousReceipt,
    epoch: previousReceipt.epoch + 1,
    previousReceiptDigest: previousReceipt.receiptDigest,
    baselineHeads: nextHeadsWithoutReceipt,
    sourceHistoryMessageCount: retainedMessages.length,
    sourceFrontierDigest: digestProviderContextHistoryFrontier(retainedMessages),
    pendingDeliveryDigest: emptyDigest,
    handoffDigest: digestProviderContextClosedValue({
      kind: "conversation-session-rewind/v1",
      proofDigest: proof.proofDigest,
      previousHistoryHead,
      historyGenerationId,
      promptGenerationId,
    }),
    reason: "history_rewind_or_fork",
    compactionProofDigest: null,
    createdAt: command.occurredAt,
  });

  const sessionIndex = persisted(source.sessionIndex);
  const contextAssets = (sessionIndex.session.contextAssets ?? []).filter((asset) => (
    !actorOwnedTransientAsset(asset, actorKey)
  ));
  sessionIndex.updatedAt = command.occurredAt;
  sessionIndex.session = {
    ...sessionIndex.session,
    actorBindings: {
      ...sessionIndex.session.actorBindings,
      [actorKey]: {
        ...binding,
        historyHeadGenerationId: historyGenerationId,
        promptHeadGenerationId: promptGenerationId,
        contextEpoch: nextReceipt.epoch,
        providerEpochReceiptV2: nextReceipt,
        providerRequestAdmissions: [],
        providerContextFactHead: null,
      },
    },
    contextAssets,
    contextAssetRegistry: {
      version: sessionIndex.version,
      assetIds: contextAssets.map((asset) => asset.assetId),
      updatedAt: command.occurredAt,
    },
    activeSelection: {
      sessionId: command.sessionId,
      activeActorKey: actorKey,
      historyHeadGenerationId: historyGenerationId,
      promptHeadGenerationId: promptGenerationId,
      selectedAt: command.occurredAt,
    },
    updatedAt: command.occurredAt,
  };

  const generationFacts = persisted({
    schemaVersion: "conversation.provider-context-transition-generation/v1" as const,
    expectedEpochReceiptDigest: previousReceipt.receiptDigest,
    nextEpochReceiptDigest: nextReceipt.receiptDigest,
    historyIndex,
    promptIndex,
    sessionIndex,
    artifactRefs: source.artifactRefs,
    historyGenerations: [historyGeneration],
    promptGenerations: [promptGeneration],
    createdAt: command.occurredAt,
  });
  const transactionId = digestProviderContextClosedValue(generationFacts);
  const transition: ConversationProviderContextTransitionGeneration = {
    ...generationFacts,
    transitionId: transactionId,
  };
  const nextHeads = {
    historyHeadGenerationId: historyGenerationId,
    promptHeadGenerationId: promptGenerationId,
    providerEpochReceiptDigest: nextReceipt.receiptDigest,
  };
  return {
    status: "planned",
    transition,
    receipt: {
      schemaVersion: "conversation.session-rewind-receipt/v1",
      sessionId: command.sessionId,
      actorKey,
      actorId,
      proof,
      previousHeads: proof.sourceHeads,
      nextHeads,
      previousProviderEpochReceiptDigest: previousReceipt.receiptDigest,
      nextProviderEpochReceiptDigest: nextReceipt.receiptDigest,
      retainedMessageCount: retainedMessages.length,
      removedMessageCount: sourceActive.messages.length - retainedMessages.length,
      transactionId,
      committedAt: command.occurredAt,
    },
  };
}
