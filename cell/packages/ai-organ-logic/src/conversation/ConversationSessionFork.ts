import type {
  ActorCommittedMessageRef,
  ActorHistoryGenerationData,
  ActorPromptGenerationData,
  ConversationArtifactRef,
  ConversationArtifactRefsSnapshot,
  ConversationForkAuthoritySnapshot,
  ConversationForkPointProof,
  ConversationForkInitializationGeneration,
  ConversationHistoryIndexSnapshot,
  ConversationPromptIndexSnapshot,
  ConversationSessionForkCommand,
  ConversationSessionForkRejection,
  ConversationSessionRepairCommand,
  ConversationSessionRepairEvidence,
  ConversationSessionIndexSnapshot,
  LocalConversationContextAssetData,
  ProviderEpochReceiptV2,
} from "@cell/ai-organ-contract";
import {
  createProviderEpochReceiptV2,
  digestProviderContextClosedValue,
  digestProviderContextHistoryFrontier,
} from "./ProviderContextEpochV2";
import { resolveConversationHistoryLineage } from "@cell/ai-persistence-logic/ConversationHistoryLineage";

export type ConversationForkSourceSnapshot = ConversationForkAuthoritySnapshot;

export type ConversationSessionForkPlanInput = Readonly<{
  command: ConversationSessionForkCommand;
  source: ConversationForkSourceSnapshot;
  childActorId: string;
}>;

export type ConversationSessionForkPlanResult =
  | Readonly<{ status: "planned"; generation: ConversationForkInitializationGeneration }>
  | Readonly<{ status: "rejected"; rejection: ConversationSessionForkRejection }>;

export type ConversationSessionRepairPlanInput = Readonly<{
  command: ConversationSessionRepairCommand;
  source: ConversationForkSourceSnapshot;
  target: ConversationForkAuthoritySnapshot;
}>;

export type ConversationSessionRepairPlanResult = ConversationSessionForkPlanResult;

export type ResolvedConversationForkPoint = Readonly<{
  proof: ConversationForkPointProof;
  actorKey: string;
  actorId: string;
  sourceHistoryGenerations: readonly ActorHistoryGenerationData[];
  sourcePromptGeneration: ActorPromptGenerationData;
}>;

export type ConversationForkPointResolutionResult =
  | Readonly<{ status: "resolved"; value: ResolvedConversationForkPoint }>
  | Readonly<{ status: "rejected"; rejection: ConversationSessionForkRejection }>;

function reject(
  code: ConversationSessionForkRejection["code"],
  message: string,
  facts?: Readonly<Record<string, unknown>>,
): ConversationForkPointResolutionResult {
  return { status: "rejected", rejection: { code, message, ...(facts ? { facts } : {}) } };
}

function rejectPlan(
  code: ConversationSessionForkRejection["code"],
  message: string,
  facts?: Readonly<Record<string, unknown>>,
): ConversationSessionForkPlanResult {
  return { status: "rejected", rejection: { code, message, ...(facts ? { facts } : {}) } };
}

function childId(kind: string, targetSessionId: string, proofDigest: string, sourceId: string): string {
  return `${kind}-${digestProviderContextClosedValue({ kind, targetSessionId, proofDigest, sourceId }).slice(7, 31)}`;
}

function rewriteClosedIdentifiers(
  value: unknown,
  identifiers: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") return identifiers.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => rewriteClosedIdentifiers(entry, identifiers));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
    entry === undefined ? [] : [[key, rewriteClosedIdentifiers(entry, identifiers)]]
  )));
}

function collectReferencedAssetIds(
  prompt: ActorPromptGenerationData,
  availableAssetIds: readonly string[],
): Set<string> {
  const available = new Set(availableAssetIds);
  const referenced = new Set<string>();
  for (const ref of prompt.basis.basisRefs ?? []) {
    if (ref.refKind === "session_asset") referenced.add(ref.refId);
  }
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (available.has(value)) referenced.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(prompt.transforms);
  visit(prompt.metadata ?? null);
  return referenced;
}

function rebindStableAsset(input: {
  asset: LocalConversationContextAssetData;
  promptGenerationId: string;
  identifiers: Map<string, string>;
  occurredAt: string;
}): LocalConversationContextAssetData {
  const assetId = input.identifiers.get(input.asset.assetId)!;
  const source = rewriteClosedIdentifiers(input.asset.source, input.identifiers) as LocalConversationContextAssetData["source"];
  const metadata = input.asset.metadata
    ? rewriteClosedIdentifiers(input.asset.metadata, input.identifiers) as Record<string, unknown>
    : undefined;
  const resourceFact = input.asset.resourceFact ? {
    ...rewriteClosedIdentifiers(input.asset.resourceFact, input.identifiers) as NonNullable<LocalConversationContextAssetData["resourceFact"]>,
    // Delivery ownership is request/runtime state. The resource revision and
    // selected fragments are stable; delivery facts always restart in child.
    deliveries: [],
  } : undefined;
  return {
    assetId,
    kind: input.asset.kind,
    ...(input.asset.label !== undefined ? { label: input.asset.label } : {}),
    source,
    boundPromptGenerationId: input.promptGenerationId,
    ...(input.asset.extractedArtifactId
      ? { extractedArtifactId: input.identifiers.get(input.asset.extractedArtifactId) ?? null }
      : {}),
    ...(input.asset.selectedFragmentId !== undefined
      ? { selectedFragmentId: input.asset.selectedFragmentId }
      : {}),
    ...(resourceFact ? { resourceFact } : {}),
    ...(metadata ? { metadata } : {}),
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
    ...(input.asset.archivedAt !== undefined ? { archivedAt: input.asset.archivedAt } : {}),
    // projectionFact/providerContextFactCandidate/providerContextFact,
    // delivery facts and replayCheckpoint are intentionally absent.
  };
}

function rebindArtifactRefs(input: {
  refs: readonly ConversationArtifactRef[];
  targetSessionId: string;
  proofDigest: string;
  identifiers: Map<string, string>;
  occurredAt: string;
}): ConversationArtifactRef[] {
  return input.refs.flatMap((ref) => {
    const ownerId = input.identifiers.get(ref.ownerId);
    if (!ownerId) return [];
    const artifactId = childId("artifact", input.targetSessionId, input.proofDigest, ref.artifactId);
    input.identifiers.set(ref.artifactId, artifactId);
    return [{
      artifactId,
      ownerDomain: ref.ownerDomain,
      ownerId,
      artifactKind: ref.artifactKind,
      // Parent-session file paths are not child authority. Durable content is
      // already represented by Prompt materializedContext / stable assets.
      filePath: null,
      ...(ref.metadata
        ? { metadata: rewriteClosedIdentifiers(ref.metadata, input.identifiers) as Record<string, unknown> }
        : {}),
      createdAt: input.occurredAt,
    }];
  });
}

function createChildProviderEpoch(input: {
  parent: ProviderEpochReceiptV2;
  targetSessionId: string;
  actorKey: string;
  actorId: string;
  historyHeadGenerationId: string;
  promptHeadGenerationId: string;
  activeMessages: readonly ActorCommittedMessageRef[];
  proof: ConversationForkPointProof;
  occurredAt: string;
}): ProviderEpochReceiptV2 {
  const emptyDigest = digestProviderContextClosedValue([]);
  const sourceFrontierDigest = digestProviderContextHistoryFrontier(input.activeMessages);
  return createProviderEpochReceiptV2({
    sessionId: input.targetSessionId,
    actorKey: input.actorKey,
    actorId: input.actorId,
    epoch: 0,
    previousReceiptDigest: null,
    targetProviderId: input.parent.targetProviderId,
    targetModelId: input.parent.targetModelId,
    targetProfileId: input.parent.targetProfileId,
    baselineHeads: {
      historyHeadGenerationId: input.historyHeadGenerationId,
      promptHeadGenerationId: input.promptHeadGenerationId,
      factHeadDigest: null,
    },
    sourceHistoryMessageCount: input.activeMessages.length,
    sourceFrontierDigest,
    pendingDeliveryDigest: emptyDigest,
    handoffDigest: digestProviderContextClosedValue({
      kind: "conversation-fork-handoff/v1",
      targetSessionId: input.targetSessionId,
      actorKey: input.actorKey,
      actorId: input.actorId,
      proofDigest: input.proof.proofDigest,
      historyHeadGenerationId: input.historyHeadGenerationId,
      promptHeadGenerationId: input.promptHeadGenerationId,
      sourceFrontierDigest,
    }),
    frozenResourceDigest: input.parent.frozenResourceDigest,
    providerSurfaceDigest: input.parent.providerSurfaceDigest,
    retentionPolicy: input.parent.retentionPolicy,
    reason: "history_rewind_or_fork",
    compactionProofDigest: null,
    createdAt: input.occurredAt,
  });
}

function normalizedMessageId(entry: ActorCommittedMessageRef): string | null {
  const value = entry.message.messageId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toolResultId(entry: ActorCommittedMessageRef): string | null {
  const value = entry.message.toolCallId ?? entry.message.tool_call_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertClosedToolBoundary(
  messages: readonly ActorCommittedMessageRef[],
): Readonly<{ closed: true }> | Readonly<{ closed: false; callId: string; reason: "missing_call" | "missing_result" }> {
  const seenCalls = new Set<string>();
  const pendingCalls = new Set<string>();
  for (const entry of messages) {
    // A later committed user turn is the canonical interruption boundary for
    // an abandoned tool dispatch. Old Eidolon sessions legitimately contain
    // this shape when the user interrupts before the tool result is emitted;
    // it is not the same as cutting immediately after a still-pending call.
    if (entry.message.role === "user" && pendingCalls.size > 0) {
      pendingCalls.clear();
    }
    for (const call of entry.message.toolCalls ?? []) {
      if (call.id) {
        seenCalls.add(call.id);
        pendingCalls.add(call.id);
      }
    }
    if (entry.message.role === "tool") {
      const id = toolResultId(entry);
      if (id) {
        if (!seenCalls.has(id)) return { closed: false, callId: id, reason: "missing_call" };
        pendingCalls.delete(id);
      }
    }
  }
  const pending = pendingCalls.values().next().value as string | undefined;
  if (pending) return { closed: false, callId: pending, reason: "missing_result" };
  return { closed: true };
}

function promptBasisIsProven(params: {
  prompt: ActorPromptGenerationData;
  selectedGenerations: readonly ActorHistoryGenerationData[];
  activeGenerationId: string;
}): boolean {
  const selectedGenerationIds = new Set(params.selectedGenerations.map((generation) => generation.generationId));
  const selectedRecordIds = new Set(params.selectedGenerations.flatMap((generation) => generation.messages.map((entry) => entry.recordId)));
  if (params.prompt.basis.basisHistoryGenerationIds.some((id) => !selectedGenerationIds.has(id))) return false;
  if (params.prompt.basis.basisMessageRecordIds.some((id) => !selectedRecordIds.has(id))) return false;
  for (const ref of params.prompt.basis.basisRefs ?? []) {
    if (ref.refKind === "history_generation" && !selectedGenerationIds.has(ref.refId)) return false;
    if (ref.refKind === "message" && !selectedRecordIds.has(ref.refId)) return false;
  }
  const metadataTarget = params.prompt.metadata?.targetHistoryGenerationId;
  if (typeof metadataTarget === "string" && metadataTarget && metadataTarget !== params.activeGenerationId) return false;
  for (const transform of params.prompt.transforms) {
    if (transform.kind !== "history_compaction_summary" && transform.kind !== "micro_compact") continue;
    const sourceId = transform.payload?.sourceHistoryGenerationId;
    const targetId = transform.payload?.targetHistoryGenerationId;
    if (typeof sourceId === "string" && sourceId && !selectedGenerationIds.has(sourceId)) return false;
    if (typeof targetId === "string" && targetId && targetId !== params.activeGenerationId) return false;
  }
  return true;
}

export function digestConversationForkSourceAuthority(source: ConversationForkSourceSnapshot): `sha256:${string}` {
  // Repository codecs may materialize optional fields as own `undefined`
  // properties. Fork authority is the persisted JSON value, so normalize it
  // exactly as the durable codec does before applying the closed-value digest.
  return digestProviderContextClosedValue(JSON.parse(JSON.stringify({
    historyIndex: source.historyIndex,
    promptIndex: source.promptIndex,
    sessionIndex: source.sessionIndex,
    artifactRefs: source.artifactRefs,
    historyGenerations: source.historyGenerations,
    promptGenerations: source.promptGenerations,
  })));
}

export function resolveConversationForkPoint(
  input: Pick<ConversationSessionForkPlanInput, "command" | "source">,
  options: Readonly<{ allowActiveTailPromptRebase?: boolean }> = {},
): ConversationForkPointResolutionResult {
  const { command, source } = input;
  if (source.sessionIndex.sessionId !== command.sourceSessionId
    || source.historyIndex.sessionId !== command.sourceSessionId
    || source.promptIndex.sessionId !== command.sourceSessionId) {
    return reject("SOURCE_AUTHORITY_CHANGED", "source snapshots do not belong to the requested session");
  }
  const actorKey = command.actorKey
    ?? source.sessionIndex.session.activeActorKey
    ?? Object.keys(source.sessionIndex.session.actorBindings)[0]
    ?? null;
  if (!actorKey) return reject("SOURCE_ACTOR_NOT_FOUND", "source session has no active actor");
  const binding = source.sessionIndex.session.actorBindings[actorKey];
  if (!binding) return reject("SOURCE_ACTOR_NOT_FOUND", `source actor is not bound: ${actorKey}`);
  const historyHeadGenerationId = binding.historyHeadGenerationId
    ?? source.historyIndex.heads[actorKey]?.activeGenerationId
    ?? null;
  if (!historyHeadGenerationId) return reject("SOURCE_HISTORY_HEAD_MISSING", "source actor has no History head");
  const promptHeadGenerationId = binding.promptHeadGenerationId
    ?? source.promptIndex.heads[actorKey]?.activePromptGenerationId
    ?? null;
  if (!promptHeadGenerationId) return reject("SOURCE_PROMPT_HEAD_MISSING", "source actor has no Prompt head");
  const providerReceipt = binding.providerEpochReceiptV2;
  if (!providerReceipt) return reject("SOURCE_PROVIDER_EPOCH_MISSING", "source actor has no v2 provider epoch receipt");
  const providerAdmissions = binding.providerRequestAdmissions ?? [];
  const latestAdmission = [...providerAdmissions]
    .reverse()
    .find((entry) => entry.epochReceiptDigest === providerReceipt.receiptDigest);
  const admittedHeads = latestAdmission?.currentHeads ?? providerReceipt.baselineHeads;
  if (providerReceipt.sessionId !== command.sourceSessionId
    || providerReceipt.actorKey !== actorKey
    || providerReceipt.actorId !== binding.actorId
    || admittedHeads.historyHeadGenerationId !== historyHeadGenerationId
    || admittedHeads.promptHeadGenerationId !== promptHeadGenerationId) {
    return reject("SOURCE_AUTHORITY_CHANGED", "source provider receipt does not bind the selected Conversation heads");
  }

  const sourceAuthorityDigest = digestConversationForkSourceAuthority(source);
  if (command.expectedSourceAuthorityDigest && command.expectedSourceAuthorityDigest !== sourceAuthorityDigest) {
    return reject("SOURCE_AUTHORITY_CHANGED", "source authority digest changed before fork planning", {
      expected: command.expectedSourceAuthorityDigest,
      actual: sourceAuthorityDigest,
    });
  }

  const generationById = new Map(source.historyGenerations.map((generation) => [generation.generationId, generation]));
  const lineage = resolveConversationHistoryLineage({
    historyIndex: source.historyIndex, actorKey,
    activeGenerationId: historyHeadGenerationId,
    historyGenerations: source.historyGenerations,
  });
  if (lineage.status === "rejected") {
    return reject("SOURCE_AUTHORITY_CHANGED", "History lineage cannot prove the selected generation order", {
      reason: lineage.reason, generationId: lineage.generationId,
    });
  }
  const visibleIds = lineage.generationIds;
  const visibleGenerations: ActorHistoryGenerationData[] = [];
  for (const generationId of visibleIds) {
    const generation = generationById.get(generationId);
    if (!generation
      || generation.sessionId !== command.sourceSessionId
      || generation.actorKey !== actorKey
      || generation.actorId !== binding.actorId
      || generation.messageCount !== generation.messages.length) {
      return reject("SOURCE_AUTHORITY_CHANGED", `History generation is missing or inconsistent: ${generationId}`);
    }
    visibleGenerations.push(generation);
  }
  const activeGenerationIndex = visibleGenerations.findIndex((generation) => generation.generationId === historyHeadGenerationId);
  if (activeGenerationIndex < 0) return reject("SOURCE_HISTORY_HEAD_MISSING", "active History generation is not reachable");
  if (activeGenerationIndex !== visibleGenerations.length - 1) {
    return reject("SOURCE_AUTHORITY_CHANGED", "visible History contains generations outside the proven head ancestry");
  }
  const activeGeneration = visibleGenerations[activeGenerationIndex]!;
  const prompt = source.promptGenerations.find((generation) => generation.promptGenerationId === promptHeadGenerationId);
  if (!prompt
    || prompt.sessionId !== command.sourceSessionId
    || prompt.actorKey !== actorKey
    || prompt.actorId !== binding.actorId) {
    return reject("SOURCE_PROMPT_HEAD_MISSING", "active Prompt generation is missing or inconsistent");
  }

  let cutoffGenerationIndex = activeGenerationIndex;
  let cutoffMessageIndex = activeGeneration.messages.length - 1;
  const currentLastMessage = activeGeneration.messages[activeGeneration.messages.length - 1];
  let cutoffMessageRecordId: string | null = currentLastMessage?.recordId ?? null;
  let cutoffMessageId: string | null = currentLastMessage
    ? normalizedMessageId(currentLastMessage) ?? currentLastMessage.recordId
    : null;
  let compactionBoundary: ConversationForkPointProof["compactionBoundary"] = "current_head";
  if (command.selector.kind === "through_committed_message") {
    const selectedMessageId = command.selector.messageId;
    const matches = visibleGenerations.flatMap((generation, generationIndex) => generation.messages.flatMap((entry, messageIndex) => (
      entry.recordId === selectedMessageId || normalizedMessageId(entry) === selectedMessageId
        ? [{ generation, generationIndex, entry, messageIndex }]
        : []
    )));
    if (matches.length === 0) return reject("MESSAGE_NOT_FOUND", `canonical message was not found: ${command.selector.messageId}`);
    if (matches.length > 1) return reject("MESSAGE_ID_AMBIGUOUS", `canonical message id is ambiguous: ${command.selector.messageId}`);
    const match = matches[0]!;
    cutoffGenerationIndex = match.generationIndex;
    cutoffMessageIndex = match.messageIndex;
    cutoffMessageRecordId = match.entry.recordId;
    cutoffMessageId = normalizedMessageId(match.entry) ?? match.entry.recordId;
    compactionBoundary = match.generation.generationId === historyHeadGenerationId
      ? "active_tail"
      : "historical_generation";
    if (compactionBoundary === "historical_generation") {
      return reject("PROMPT_STATE_UNPROVABLE", "historical Prompt state is not proven across the compaction boundary", {
        targetGenerationId: match.generation.generationId,
        activeGenerationId: historyHeadGenerationId,
      });
    }
  }

  const selectedGenerations = visibleGenerations.slice(0, cutoffGenerationIndex + 1).map((generation, index) => (
    index === cutoffGenerationIndex
      ? { ...generation, messages: generation.messages.slice(0, cutoffMessageIndex + 1), messageCount: cutoffMessageIndex + 1 }
      : generation
  ));
  const exactPromptBasis = promptBasisIsProven({
    prompt,
    selectedGenerations,
    activeGenerationId: historyHeadGenerationId,
  });
  const activeTailRebasePrompt = exactPromptBasis ? null : {
    ...prompt,
    basis: {
      ...prompt.basis,
      basisMessageRecordIds: prompt.basis.basisMessageRecordIds.filter((id) => (
        selectedGenerations.some((generation) => generation.messages.some((entry) => entry.recordId === id))
      )),
      basisRefs: (prompt.basis.basisRefs ?? []).filter((ref) => (
        ref.refKind !== "message"
        || selectedGenerations.some((generation) => generation.messages.some((entry) => entry.recordId === ref.refId))
      )),
    },
  };
  const activeTailRebaseProven = Boolean(
    options.allowActiveTailPromptRebase
    && compactionBoundary === "active_tail"
    && activeTailRebasePrompt
    && promptBasisIsProven({
      prompt: activeTailRebasePrompt,
      selectedGenerations,
      activeGenerationId: historyHeadGenerationId,
    }),
  );
  if (!exactPromptBasis && !activeTailRebaseProven) {
    return reject("PROMPT_STATE_UNPROVABLE", "Prompt basis contains facts beyond the requested History frontier");
  }
  const toolBoundary = assertClosedToolBoundary(selectedGenerations.flatMap((generation) => generation.messages));
  if (!toolBoundary.closed) {
    return reject("TOOL_PAIR_BOUNDARY_OPEN", `tool boundary is open: ${toolBoundary.callId}`, toolBoundary);
  }

  const cutoffGeneration = selectedGenerations[selectedGenerations.length - 1]!;
  const proofFacts = {
    schemaVersion: "conversation.fork-point-proof/v1" as const,
    sourceSessionId: command.sourceSessionId,
    sourceActorKey: actorKey,
    sourceActorId: binding.actorId,
    selector: command.selector,
    sourceHeads: {
      historyHeadGenerationId,
      promptHeadGenerationId,
      providerEpochReceiptDigest: providerReceipt.receiptDigest,
    },
    sourceAuthorityDigest,
    cutoffHistoryGenerationId: cutoffGeneration.generationId,
    cutoffMessageRecordId,
    cutoffMessageId,
    cutoffMessageCount: cutoffGeneration.messages.length,
    cutoffFrontierDigest: digestProviderContextHistoryFrontier(cutoffGeneration.messages),
    promptGenerationId: prompt.promptGenerationId,
    promptBasisDigest: digestProviderContextClosedValue(JSON.parse(JSON.stringify({
      basis: prompt.basis,
      transforms: prompt.transforms,
      materializedContext: prompt.materializedContext ?? null,
      metadata: prompt.metadata ?? null,
    }))),
    promptProofMode: exactPromptBasis ? "exact" as const : "active_tail_rebase" as const,
    compactionBoundary,
    toolPairBoundaryClosed: true as const,
  };
  const proof: ConversationForkPointProof = {
    ...proofFacts,
    proofDigest: digestProviderContextClosedValue(proofFacts),
  };
  return {
    status: "resolved",
    value: {
      proof,
      actorKey,
      actorId: binding.actorId,
      sourceHistoryGenerations: selectedGenerations,
      sourcePromptGeneration: prompt,
    },
  };
}

/**
 * Pure child-authority Processor. All identities in the planned History,
 * Prompt, Session and asset projections are child-local. The source remains
 * read-only provenance in proof/session lineage and is never a loader edge.
 */
export function planConversationSessionFork(
  input: ConversationSessionForkPlanInput,
): ConversationSessionForkPlanResult {
  const resolved = resolveConversationForkPoint(input);
  if (resolved.status === "rejected") return resolved;
  const { command, source, childActorId } = input;
  const { proof, actorKey, sourceHistoryGenerations, sourcePromptGeneration } = resolved.value;
  const sourceBinding = source.sessionIndex.session.actorBindings[actorKey]!;
  const parentReceipt = sourceBinding.providerEpochReceiptV2!;
  const identifiers = new Map<string, string>();

  for (const generation of sourceHistoryGenerations) {
    identifiers.set(
      generation.generationId,
      childId("history", command.targetSessionId, proof.proofDigest, generation.generationId),
    );
    for (const entry of generation.messages) {
      identifiers.set(entry.recordId, childId("record", command.targetSessionId, proof.proofDigest, entry.recordId));
    }
  }
  const promptGenerationId = childId(
    "prompt",
    command.targetSessionId,
    proof.proofDigest,
    sourcePromptGeneration.promptGenerationId,
  );
  identifiers.set(sourcePromptGeneration.promptGenerationId, promptGenerationId);

  const referencedAssetIds = collectReferencedAssetIds(
    sourcePromptGeneration,
    source.sessionIndex.session.contextAssetRegistry?.assetIds ?? [],
  );
  const sourceAssets = source.sessionIndex.session.contextAssets ?? [];
  const sourceAssetsById = new Map(sourceAssets.map((asset) => [asset.assetId, asset]));
  for (const assetId of referencedAssetIds) {
    if (!sourceAssetsById.has(assetId)) {
      return rejectPlan("CONTEXT_ASSET_UNSAFE", `Prompt references unavailable context asset: ${assetId}`);
    }
    identifiers.set(assetId, childId("asset", command.targetSessionId, proof.proofDigest, assetId));
  }

  const historyGenerations: ActorHistoryGenerationData[] = sourceHistoryGenerations.map((generation) => {
    const generationId = identifiers.get(generation.generationId)!;
    const parentGenerationId = generation.parentGenerationId
      ? identifiers.get(generation.parentGenerationId) ?? null
      : null;
    const predecessorGenerationIds = generation.predecessorGenerationIds
      .flatMap((id) => identifiers.get(id) ?? []);
    const messages = generation.messages.map((entry): ActorCommittedMessageRef => {
      const { sourceRecords, ...entryFacts } = entry;
      return {
        ...entryFacts,
        recordId: identifiers.get(entry.recordId)!,
        actorKey,
        actorId: childActorId,
        message: rewriteClosedIdentifiers(entry.message, identifiers) as ActorCommittedMessageRef["message"],
        ...(sourceRecords
          ? { sourceRecords: rewriteClosedIdentifiers(sourceRecords, identifiers) as NonNullable<ActorCommittedMessageRef["sourceRecords"]> }
          : {}),
      };
    });
    return {
      ...generation,
      generationId,
      sessionId: command.targetSessionId,
      actorKey,
      actorId: childActorId,
      parentGenerationId,
      predecessorGenerationIds,
      createdReason: "fork",
      sealed: generation.generationId === sourceHistoryGenerations[sourceHistoryGenerations.length - 1]?.generationId ? false : generation.sealed,
      messageCount: messages.length,
      messages,
      createdAt: command.occurredAt,
      updatedAt: command.occurredAt,
    };
  });
  const historyHeadGenerationId = historyGenerations[historyGenerations.length - 1]?.generationId;
  if (!historyHeadGenerationId) {
    return rejectPlan("SOURCE_HISTORY_HEAD_MISSING", "resolved fork point contains no child History generation");
  }

  const artifactRefs = rebindArtifactRefs({
    refs: source.artifactRefs.refs,
    targetSessionId: command.targetSessionId,
    proofDigest: proof.proofDigest,
    identifiers,
    occurredAt: command.occurredAt,
  });
  const promptGeneration: ActorPromptGenerationData = {
    ...sourcePromptGeneration,
    promptGenerationId,
    sessionId: command.targetSessionId,
    actorKey,
    actorId: childActorId,
    basedOnPromptGenerationId: null,
    basis: rewriteClosedIdentifiers(sourcePromptGeneration.basis, identifiers) as ActorPromptGenerationData["basis"],
    transforms: rewriteClosedIdentifiers(sourcePromptGeneration.transforms, identifiers) as ActorPromptGenerationData["transforms"],
    createdReason: "restore",
    sealed: false,
    createdAt: command.occurredAt,
    sealedAt: null,
    updatedAt: command.occurredAt,
    ...(sourcePromptGeneration.metadata
      ? { metadata: rewriteClosedIdentifiers(sourcePromptGeneration.metadata, identifiers) as Record<string, unknown> }
      : {}),
  };

  const contextAssets = [...referencedAssetIds].map((assetId) => rebindStableAsset({
    asset: sourceAssetsById.get(assetId)!,
    promptGenerationId,
    identifiers,
    occurredAt: command.occurredAt,
  }));
  const childProviderEpochReceipt = createChildProviderEpoch({
    parent: parentReceipt,
    targetSessionId: command.targetSessionId,
    actorKey,
    actorId: childActorId,
    historyHeadGenerationId,
    promptHeadGenerationId: promptGenerationId,
    activeMessages: historyGenerations[historyGenerations.length - 1]!.messages,
    proof,
    occurredAt: command.occurredAt,
  });

  const historyIndex: ConversationHistoryIndexSnapshot = {
    version: source.historyIndex.version,
    sessionId: command.targetSessionId,
    heads: {
      [actorKey]: {
        version: source.historyIndex.version,
        sessionId: command.targetSessionId,
        actorKey,
        actorId: childActorId,
        activeGenerationId: historyHeadGenerationId,
        visibleGenerationIds: historyGenerations.map((generation) => generation.generationId),
        updatedAt: command.occurredAt,
      },
    },
    lineages: Object.fromEntries(historyGenerations.map((generation, index) => [generation.generationId, {
      version: source.historyIndex.version,
      sessionId: command.targetSessionId,
      actorKey,
      actorId: childActorId,
      generationId: generation.generationId,
      parentGenerationId: generation.parentGenerationId ?? null,
      rolledBackFromGenerationId: null,
      predecessorGenerationIds: generation.predecessorGenerationIds,
      successorGenerationIds: historyGenerations[index + 1]
        ? [historyGenerations[index + 1]!.generationId]
        : [],
      forkGenerationIds: [],
      branchLabel: null,
      updatedAt: command.occurredAt,
    }])),
    generations: Object.fromEntries(historyGenerations.map((generation) => [generation.generationId, {
      generationId: generation.generationId,
      actorKey,
      actorId: childActorId,
      sealed: generation.sealed,
      createdAt: generation.createdAt,
      updatedAt: generation.updatedAt,
    }])),
    updatedAt: command.occurredAt,
  };
  const promptIndex: ConversationPromptIndexSnapshot = {
    version: source.promptIndex.version,
    sessionId: command.targetSessionId,
    heads: {
      [actorKey]: {
        version: source.promptIndex.version,
        sessionId: command.targetSessionId,
        actorKey,
        actorId: childActorId,
        activePromptGenerationId: promptGenerationId,
        updatedAt: command.occurredAt,
      },
    },
    generations: {
      [promptGenerationId]: {
        promptGenerationId,
        actorKey,
        actorId: childActorId,
        sealed: false,
        createdAt: command.occurredAt,
        updatedAt: command.occurredAt,
      },
    },
    updatedAt: command.occurredAt,
  };
  const sessionIndex: ConversationSessionIndexSnapshot = {
    version: source.sessionIndex.version,
    sessionId: command.targetSessionId,
    session: {
      version: source.sessionIndex.session.version,
      sessionId: command.targetSessionId,
      activeActorKey: actorKey,
      actorBindings: {
        [actorKey]: {
          actorKey,
          actorId: childActorId,
          ...(sourceBinding.actorName !== undefined ? { actorName: sourceBinding.actorName } : {}),
          ...(sourceBinding.actorKind !== undefined ? { actorKind: sourceBinding.actorKind } : {}),
          boundAt: command.occurredAt,
          historyHeadGenerationId,
          promptHeadGenerationId: promptGenerationId,
          contextEpoch: 0,
          providerEpochReceiptV2: childProviderEpochReceipt,
          providerRequestAdmissions: [],
          providerContextFactHead: null,
        },
      },
      contextAssetRegistry: contextAssets.length > 0 ? {
        version: source.sessionIndex.version,
        assetIds: contextAssets.map((asset) => asset.assetId),
        updatedAt: command.occurredAt,
      } : null,
      contextAssets,
      activeSelection: {
        sessionId: command.targetSessionId,
        activeActorKey: actorKey,
        historyHeadGenerationId,
        promptHeadGenerationId: promptGenerationId,
        selectedAt: command.occurredAt,
      },
      createdAt: command.occurredAt,
      updatedAt: command.occurredAt,
    },
    lineage: {
      version: source.sessionIndex.version,
      sessionId: command.targetSessionId,
      parentSessionId: command.sourceSessionId,
      forkedFromGenerationId: proof.cutoffHistoryGenerationId,
      rolledBackFromSessionId: null,
      predecessorSessionIds: [command.sourceSessionId],
      forkSessionIds: [],
      updatedAt: command.occurredAt,
    },
    updatedAt: command.occurredAt,
  };
  const artifactRefsSnapshot: ConversationArtifactRefsSnapshot = {
    version: source.artifactRefs.version,
    sessionId: command.targetSessionId,
    refs: artifactRefs,
    updatedAt: command.occurredAt,
  };
  const providerEpoch = {
    schemaVersion: "conversation.fork-provider-epoch-initialization/v1" as const,
    childSessionId: command.targetSessionId,
    childActorKey: actorKey,
    childActorId,
    parentReceiptDigest: parentReceipt.receiptDigest,
    childReceiptDigest: childProviderEpochReceipt.receiptDigest,
    reason: "history_rewind_or_fork" as const,
  };
  const targetAuthorityDigest = digestProviderContextClosedValue({
    historyIndex,
    promptIndex,
    sessionIndex,
    artifactRefs: artifactRefsSnapshot,
    historyGenerations,
    promptGenerations: [promptGeneration],
    childProviderEpochReceipt,
  });
  const generationFacts = {
    schemaVersion: "conversation.fork-initialization-generation/v1" as const,
    mode: "create" as const,
    proof,
    providerEpoch,
    childProviderEpochReceipt,
    expectedTargetAuthorityDigest: null,
    expectedTargetAuthority: null,
    targetAuthorityDigest,
    historyIndex,
    promptIndex,
    sessionIndex,
    artifactRefs: artifactRefsSnapshot,
    historyGenerations,
    promptGenerations: [promptGeneration],
    preservedTargetTailMessageCount: 0,
    createdAt: command.occurredAt,
  };
  return {
    status: "planned",
    generation: {
      ...generationFacts,
      transactionId: digestProviderContextClosedValue(generationFacts),
    },
  };
}

function createRepairProviderEpoch(input: {
  previous: ProviderEpochReceiptV2;
  targetSessionId: string;
  actorKey: string;
  actorId: string;
  historyHeadGenerationId: string;
  promptHeadGenerationId: string;
  activeMessages: readonly ActorCommittedMessageRef[];
  proof: ConversationForkPointProof;
  expectedTargetAuthorityDigest: `sha256:${string}`;
  occurredAt: string;
}): ProviderEpochReceiptV2 {
  const emptyDigest = digestProviderContextClosedValue([]);
  const sourceFrontierDigest = digestProviderContextHistoryFrontier(input.activeMessages);
  return createProviderEpochReceiptV2({
    sessionId: input.targetSessionId,
    actorKey: input.actorKey,
    actorId: input.actorId,
    epoch: input.previous.epoch + 1,
    previousReceiptDigest: input.previous.receiptDigest,
    targetProviderId: input.previous.targetProviderId,
    targetModelId: input.previous.targetModelId,
    targetProfileId: input.previous.targetProfileId,
    baselineHeads: {
      historyHeadGenerationId: input.historyHeadGenerationId,
      promptHeadGenerationId: input.promptHeadGenerationId,
      factHeadDigest: null,
    },
    sourceHistoryMessageCount: input.activeMessages.length,
    sourceFrontierDigest,
    pendingDeliveryDigest: emptyDigest,
    handoffDigest: digestProviderContextClosedValue({
      kind: "conversation-repair-graft-handoff/v1",
      targetSessionId: input.targetSessionId,
      actorKey: input.actorKey,
      actorId: input.actorId,
      proofDigest: input.proof.proofDigest,
      expectedTargetAuthorityDigest: input.expectedTargetAuthorityDigest,
      historyHeadGenerationId: input.historyHeadGenerationId,
      promptHeadGenerationId: input.promptHeadGenerationId,
      sourceFrontierDigest,
    }),
    frozenResourceDigest: input.previous.frozenResourceDigest,
    providerSurfaceDigest: input.previous.providerSurfaceDigest,
    retentionPolicy: input.previous.retentionPolicy,
    reason: "history_rewind_or_fork",
    compactionProofDigest: null,
    createdAt: input.occurredAt,
  });
}

function targetActorAuthority(input: ConversationSessionRepairPlanInput):
  | Readonly<{
    actorKey: string;
    actorId: string;
    binding: NonNullable<ConversationSessionIndexSnapshot["session"]["actorBindings"][string]>;
    receipt: ProviderEpochReceiptV2;
    historyHeadGenerationId: string;
    promptHeadGenerationId: string;
    historyGenerations: readonly ActorHistoryGenerationData[];
    promptGeneration: ActorPromptGenerationData;
  }>
  | Readonly<{ rejection: ConversationSessionForkRejection }> {
  const { command, target } = input;
  if (target.sessionIndex.sessionId !== command.targetSessionId
    || target.historyIndex.sessionId !== command.targetSessionId
    || target.promptIndex.sessionId !== command.targetSessionId
    || (target.artifactRefs.refs.length > 0 && target.artifactRefs.sessionId !== command.targetSessionId)) {
    return { rejection: { code: "TARGET_AUTHORITY_CHANGED", message: "target snapshots do not belong to the requested child session" } };
  }
  const actualDigest = digestConversationForkSourceAuthority(target);
  if (actualDigest !== command.expectedTargetAuthorityDigest) {
    return {
      rejection: {
        code: "TARGET_AUTHORITY_CHANGED",
        message: "target authority digest changed before repair planning",
        facts: { expected: command.expectedTargetAuthorityDigest, actual: actualDigest },
      },
    };
  }
  const actorKey = command.actorKey
    ?? target.sessionIndex.session.activeActorKey
    ?? Object.keys(target.sessionIndex.session.actorBindings)[0]
    ?? null;
  const binding = actorKey ? target.sessionIndex.session.actorBindings[actorKey] : null;
  if (!actorKey || !binding) {
    return { rejection: { code: "SOURCE_ACTOR_NOT_FOUND", message: "repair target actor is unavailable" } };
  }
  const historyHeadGenerationId = binding.historyHeadGenerationId
    ?? target.historyIndex.heads[actorKey]?.activeGenerationId
    ?? null;
  const promptHeadGenerationId = binding.promptHeadGenerationId
    ?? target.promptIndex.heads[actorKey]?.activePromptGenerationId
    ?? null;
  const receipt = binding.providerEpochReceiptV2;
  if (!historyHeadGenerationId || !promptHeadGenerationId || !receipt) {
    return { rejection: { code: "REPAIR_TAIL_UNPROVABLE", message: "repair target lacks a bound History, Prompt or provider epoch" } };
  }
  const latestAdmission = [...(binding.providerRequestAdmissions ?? [])]
    .reverse()
    .find((entry) => entry.epochReceiptDigest === receipt.receiptDigest);
  const admittedHeads = latestAdmission?.currentHeads ?? receipt.baselineHeads;
  if (receipt.sessionId !== command.targetSessionId
    || receipt.actorKey !== actorKey
    || receipt.actorId !== binding.actorId
    || admittedHeads.historyHeadGenerationId !== historyHeadGenerationId
    || admittedHeads.promptHeadGenerationId !== promptHeadGenerationId) {
    return { rejection: { code: "REPAIR_TAIL_UNPROVABLE", message: "repair target provider evidence does not bind its current heads" } };
  }
  const generationById = new Map(target.historyGenerations.map((entry) => [entry.generationId, entry]));
  const visibleIds = [...new Set([
    ...(target.historyIndex.heads[actorKey]?.visibleGenerationIds ?? []),
    historyHeadGenerationId,
  ])];
  const historyGenerations: ActorHistoryGenerationData[] = [];
  for (const generationId of visibleIds) {
    const generation = generationById.get(generationId);
    if (!generation
      || generation.sessionId !== command.targetSessionId
      || generation.actorKey !== actorKey
      || generation.actorId !== binding.actorId
      || generation.messageCount !== generation.messages.length) {
      return { rejection: { code: "REPAIR_TAIL_UNPROVABLE", message: `repair target History is missing or inconsistent: ${generationId}` } };
    }
    historyGenerations.push(generation);
  }
  const promptGeneration = target.promptGenerations.find((entry) => entry.promptGenerationId === promptHeadGenerationId);
  if (!promptGeneration
    || promptGeneration.sessionId !== command.targetSessionId
    || promptGeneration.actorKey !== actorKey
    || promptGeneration.actorId !== binding.actorId
    || !promptBasisIsProven({ prompt: promptGeneration, selectedGenerations: historyGenerations, activeGenerationId: historyHeadGenerationId })) {
    return { rejection: { code: "REPAIR_TAIL_UNPROVABLE", message: "repair target Prompt basis cannot prove its committed tail" } };
  }
  if (target.sessionIndex.lineage?.parentSessionId
    && target.sessionIndex.lineage.parentSessionId !== command.sourceSessionId) {
    return { rejection: { code: "REPAIR_TAIL_UNPROVABLE", message: "repair target already belongs to a different parent lineage" } };
  }
  const activeGeneration = historyGenerations.find((entry) => entry.generationId === historyHeadGenerationId);
  if (!activeGeneration || activeGeneration.messages.length === 0) {
    return { rejection: { code: "REPAIR_TAIL_UNPROVABLE", message: "repair target has no committed child tail" } };
  }
  const boundary = assertClosedToolBoundary(activeGeneration.messages);
  if (!boundary.closed) {
    return { rejection: { code: "REPAIR_TAIL_UNPROVABLE", message: `repair target tail has an open tool boundary: ${boundary.callId}`, facts: boundary } };
  }
  return {
    actorKey,
    actorId: binding.actorId,
    binding,
    receipt,
    historyHeadGenerationId,
    promptHeadGenerationId,
    historyGenerations,
    promptGeneration,
  };
}

function uniqueText(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Pure repair/graft Processor. It first plans a normal child base from the
 * explicit parent proof, then folds the already committed child active tail
 * into one new active generation. The complete old child authority is carried
 * as the transaction CAS input, so dry-run and commit share identical facts.
 */
export function planConversationSessionRepair(
  input: ConversationSessionRepairPlanInput,
): ConversationSessionRepairPlanResult {
  if (input.command.sourceSessionId === input.command.targetSessionId) {
    return rejectPlan("FORK_TRANSACTION_CONFLICT", "repair parent and child session must differ");
  }
  const targetAuthority = targetActorAuthority(input);
  if ("rejection" in targetAuthority) return { status: "rejected", rejection: targetAuthority.rejection };
  const forkCommand: ConversationSessionForkCommand = {
    schemaVersion: "conversation.session-fork-command/v1",
    sourceSessionId: input.command.sourceSessionId,
    targetSessionId: input.command.targetSessionId,
    actorKey: input.command.actorKey ?? targetAuthority.actorKey,
    selector: input.command.selector,
    expectedSourceAuthorityDigest: input.command.expectedSourceAuthorityDigest ?? null,
    occurredAt: input.command.occurredAt,
  };
  const basePlan = planConversationSessionFork({
    command: forkCommand,
    source: input.source,
    childActorId: targetAuthority.actorId,
  });
  if (basePlan.status === "rejected") return basePlan;
  const base = basePlan.generation;
  if (base.providerEpoch.childActorKey !== targetAuthority.actorKey) {
    return rejectPlan("REPAIR_TAIL_UNPROVABLE", "parent and child actor keys do not identify the same repair subject");
  }
  const targetDigest = digestConversationForkSourceAuthority(input.target);
  const persistedTargetAuthority = JSON.parse(JSON.stringify(input.target)) as ConversationForkAuthoritySnapshot;
  const baseActive = base.historyGenerations[base.historyGenerations.length - 1];
  const targetActive = targetAuthority.historyGenerations.find(
    (entry) => entry.generationId === targetAuthority.historyHeadGenerationId,
  );
  if (!baseActive || !targetActive) {
    return rejectPlan("REPAIR_TAIL_UNPROVABLE", "repair base or target active History is unavailable");
  }

  const baseMessageIds = new Set(baseActive.messages.flatMap((entry) => {
    const id = normalizedMessageId(entry);
    return id ? [id] : [];
  }));
  for (const entry of targetActive.messages) {
    const messageId = normalizedMessageId(entry);
    if (messageId && baseMessageIds.has(messageId)) {
      return rejectPlan("REPAIR_TAIL_UNPROVABLE", `repair target tail overlaps the parent base: ${messageId}`);
    }
  }

  const graftGenerationId = childId(
    "history-repair",
    input.command.targetSessionId,
    base.proof.proofDigest,
    targetDigest,
  );
  const promptGenerationId = childId(
    "prompt-repair",
    input.command.targetSessionId,
    base.proof.proofDigest,
    targetDigest,
  );
  const targetIdentifiers = new Map<string, string>([
    [targetAuthority.actorId, targetAuthority.actorId],
    [targetAuthority.promptHeadGenerationId, promptGenerationId],
  ]);
  for (const generation of targetAuthority.historyGenerations) {
    targetIdentifiers.set(generation.generationId, graftGenerationId);
  }
  const tailMapping = targetActive.messages.map((entry) => {
    const plannedRecordId = childId(
      "record-repair",
      input.command.targetSessionId,
      base.proof.proofDigest,
      `${targetDigest}:${entry.recordId}`,
    );
    targetIdentifiers.set(entry.recordId, plannedRecordId);
    return {
      sourceGenerationId: targetActive.generationId,
      sourceRecordId: entry.recordId,
      sourceMessageId: normalizedMessageId(entry),
      plannedGenerationId: graftGenerationId,
      plannedRecordId,
    };
  });

  const targetReferencedAssetIds = collectReferencedAssetIds(
    targetAuthority.promptGeneration,
    input.target.sessionIndex.session.contextAssetRegistry?.assetIds ?? [],
  );
  const targetAssetsById = new Map((input.target.sessionIndex.session.contextAssets ?? []).map((asset) => [asset.assetId, asset]));
  for (const assetId of targetReferencedAssetIds) {
    if (!targetAssetsById.has(assetId)) {
      return rejectPlan("CONTEXT_ASSET_UNSAFE", `target Prompt references unavailable context asset: ${assetId}`);
    }
    targetIdentifiers.set(
      assetId,
      childId("asset-repair", input.command.targetSessionId, base.proof.proofDigest, `${targetDigest}:${assetId}`),
    );
  }
  for (const transform of targetAuthority.promptGeneration.transforms) {
    targetIdentifiers.set(
      transform.transformId,
      childId("transform-repair", input.command.targetSessionId, base.proof.proofDigest, `${targetDigest}:${transform.transformId}`),
    );
  }

  const tailMessages = targetActive.messages.map((entry): ActorCommittedMessageRef => {
    const { sourceRecords, ...entryFacts } = entry;
    return {
      ...entryFacts,
      recordId: targetIdentifiers.get(entry.recordId)!,
      actorKey: targetAuthority.actorKey,
      actorId: targetAuthority.actorId,
      message: rewriteClosedIdentifiers(entry.message, targetIdentifiers) as ActorCommittedMessageRef["message"],
      ...(sourceRecords
        ? { sourceRecords: rewriteClosedIdentifiers(sourceRecords, targetIdentifiers) as NonNullable<ActorCommittedMessageRef["sourceRecords"]> }
        : {}),
    };
  });
  const graftMessages = [...baseActive.messages, ...tailMessages];
  const graftBoundary = assertClosedToolBoundary(graftMessages);
  if (!graftBoundary.closed) {
    return rejectPlan("REPAIR_TAIL_UNPROVABLE", `grafted History has an open tool boundary: ${graftBoundary.callId}`, graftBoundary);
  }

  const baseHistory = base.historyGenerations.map((generation) => ({ ...generation, sealed: true }));
  const graftGeneration: ActorHistoryGenerationData = {
    version: baseActive.version,
    generationId: graftGenerationId,
    sessionId: input.command.targetSessionId,
    actorKey: targetAuthority.actorKey,
    actorId: targetAuthority.actorId,
    parentGenerationId: baseActive.generationId,
    predecessorGenerationIds: uniqueText(baseHistory.map((entry) => entry.generationId)),
    createdReason: "migration",
    sealed: false,
    messageCount: graftMessages.length,
    messages: graftMessages,
    createdAt: input.command.occurredAt,
    updatedAt: input.command.occurredAt,
  };
  const historyGenerations = [...baseHistory, graftGeneration];

  const basePrompt = base.promptGenerations[0]!;
  const basePromptIdentifiers = new Map<string, string>([[basePrompt.promptGenerationId, promptGenerationId]]);
  const targetPrompt = targetAuthority.promptGeneration;
  const rewrittenTargetTransforms = rewriteClosedIdentifiers(targetPrompt.transforms, targetIdentifiers) as ActorPromptGenerationData["transforms"];
  const rewrittenTargetMetadata = rewriteClosedIdentifiers(targetPrompt.metadata ?? {}, targetIdentifiers) as Record<string, unknown>;
  const baseMaterialized = String(basePrompt.materializedContext ?? "").trim();
  const targetMaterialized = String(targetPrompt.materializedContext ?? "").trim();
  const materializedContext = uniqueText([baseMaterialized, targetMaterialized]).join("\n\n") || null;
  const promptGeneration: ActorPromptGenerationData = {
    ...basePrompt,
    promptGenerationId,
    sessionId: input.command.targetSessionId,
    actorKey: targetAuthority.actorKey,
    actorId: targetAuthority.actorId,
    basedOnPromptGenerationId: null,
    basis: {
      version: basePrompt.basis.version,
      basisHistoryGenerationIds: historyGenerations.map((entry) => entry.generationId),
      basisMessageRecordIds: graftMessages.map((entry) => entry.recordId),
      basisRefs: [
        ...(basePrompt.basis.basisRefs ?? []).map((ref) => (
          rewriteClosedIdentifiers(ref, basePromptIdentifiers) as NonNullable<ActorPromptGenerationData["basis"]["basisRefs"]>[number]
        )),
        ...(targetPrompt.basis.basisRefs ?? []).map((ref) => (
          rewriteClosedIdentifiers(ref, targetIdentifiers) as NonNullable<ActorPromptGenerationData["basis"]["basisRefs"]>[number]
        )),
      ],
    },
    transforms: [
      ...basePrompt.transforms.map((transform) => (
        rewriteClosedIdentifiers(transform, basePromptIdentifiers) as ActorPromptGenerationData["transforms"][number]
      )),
      ...rewrittenTargetTransforms,
    ],
    createdReason: "restore",
    materializedContext,
    sealed: false,
    createdAt: input.command.occurredAt,
    sealedAt: null,
    updatedAt: input.command.occurredAt,
    metadata: {
      ...(rewriteClosedIdentifiers(basePrompt.metadata ?? {}, basePromptIdentifiers) as Record<string, unknown>),
      ...rewrittenTargetMetadata,
      repair: {
        sourceProofDigest: base.proof.proofDigest,
        expectedTargetAuthorityDigest: targetDigest,
        preservedTargetTailMessageCount: tailMessages.length,
      },
    },
  };

  const baseAssets = (base.sessionIndex.session.contextAssets ?? []).map((asset) => ({
    ...rewriteClosedIdentifiers(asset, basePromptIdentifiers) as LocalConversationContextAssetData,
    boundPromptGenerationId: promptGenerationId,
    updatedAt: input.command.occurredAt,
  }));
  const targetAssets = [...targetReferencedAssetIds].map((assetId) => rebindStableAsset({
    asset: targetAssetsById.get(assetId)!,
    promptGenerationId,
    identifiers: targetIdentifiers,
    occurredAt: input.command.occurredAt,
  }));
  const contextAssets = [...baseAssets, ...targetAssets];

  const childProviderEpochReceipt = createRepairProviderEpoch({
    previous: targetAuthority.receipt,
    targetSessionId: input.command.targetSessionId,
    actorKey: targetAuthority.actorKey,
    actorId: targetAuthority.actorId,
    historyHeadGenerationId: graftGenerationId,
    promptHeadGenerationId: promptGenerationId,
    activeMessages: graftMessages,
    proof: base.proof,
    expectedTargetAuthorityDigest: targetDigest,
    occurredAt: input.command.occurredAt,
  });

  const historyIndex: ConversationHistoryIndexSnapshot = {
    version: base.historyIndex.version,
    sessionId: input.command.targetSessionId,
    heads: {
      [targetAuthority.actorKey]: {
        version: base.historyIndex.version,
        sessionId: input.command.targetSessionId,
        actorKey: targetAuthority.actorKey,
        actorId: targetAuthority.actorId,
        activeGenerationId: graftGenerationId,
        visibleGenerationIds: historyGenerations.map((entry) => entry.generationId),
        updatedAt: input.command.occurredAt,
      },
    },
    lineages: Object.fromEntries(historyGenerations.map((generation, index) => [generation.generationId, {
      version: base.historyIndex.version,
      sessionId: input.command.targetSessionId,
      actorKey: targetAuthority.actorKey,
      actorId: targetAuthority.actorId,
      generationId: generation.generationId,
      parentGenerationId: generation.parentGenerationId ?? null,
      rolledBackFromGenerationId: null,
      predecessorGenerationIds: generation.predecessorGenerationIds,
      successorGenerationIds: historyGenerations[index + 1] ? [historyGenerations[index + 1]!.generationId] : [],
      forkGenerationIds: [],
      branchLabel: index === historyGenerations.length - 1 ? "repair-graft" : null,
      updatedAt: input.command.occurredAt,
    }])),
    generations: Object.fromEntries(historyGenerations.map((generation) => [generation.generationId, {
      generationId: generation.generationId,
      actorKey: targetAuthority.actorKey,
      actorId: targetAuthority.actorId,
      sealed: generation.sealed,
      createdAt: generation.createdAt,
      updatedAt: generation.updatedAt,
    }])),
    updatedAt: input.command.occurredAt,
  };
  const promptIndex: ConversationPromptIndexSnapshot = {
    version: base.promptIndex.version,
    sessionId: input.command.targetSessionId,
    heads: {
      [targetAuthority.actorKey]: {
        version: base.promptIndex.version,
        sessionId: input.command.targetSessionId,
        actorKey: targetAuthority.actorKey,
        actorId: targetAuthority.actorId,
        activePromptGenerationId: promptGenerationId,
        updatedAt: input.command.occurredAt,
      },
    },
    generations: {
      [promptGenerationId]: {
        promptGenerationId,
        actorKey: targetAuthority.actorKey,
        actorId: targetAuthority.actorId,
        sealed: false,
        createdAt: input.command.occurredAt,
        updatedAt: input.command.occurredAt,
      },
    },
    updatedAt: input.command.occurredAt,
  };
  const targetBinding = targetAuthority.binding;
  const sessionIndex: ConversationSessionIndexSnapshot = {
    version: base.sessionIndex.version,
    sessionId: input.command.targetSessionId,
    session: {
      version: base.sessionIndex.session.version,
      sessionId: input.command.targetSessionId,
      activeActorKey: targetAuthority.actorKey,
      actorBindings: {
        [targetAuthority.actorKey]: {
          actorKey: targetAuthority.actorKey,
          actorId: targetAuthority.actorId,
          ...(targetBinding.actorName !== undefined ? { actorName: targetBinding.actorName } : {}),
          ...(targetBinding.actorKind !== undefined ? { actorKind: targetBinding.actorKind } : {}),
          ...(targetBinding.metadata ? { metadata: targetBinding.metadata } : {}),
          boundAt: targetBinding.boundAt ?? input.command.occurredAt,
          historyHeadGenerationId: graftGenerationId,
          promptHeadGenerationId: promptGenerationId,
          contextEpoch: (targetBinding.contextEpoch ?? targetAuthority.receipt.epoch) + 1,
          providerEpochReceiptV2: childProviderEpochReceipt,
          providerRequestAdmissions: [],
          providerContextFactHead: null,
        },
      },
      contextAssetRegistry: contextAssets.length ? {
        version: base.sessionIndex.version,
        assetIds: contextAssets.map((asset) => asset.assetId),
        updatedAt: input.command.occurredAt,
      } : null,
      contextAssets,
      activeSelection: {
        sessionId: input.command.targetSessionId,
        activeActorKey: targetAuthority.actorKey,
        historyHeadGenerationId: graftGenerationId,
        promptHeadGenerationId: promptGenerationId,
        selectedAt: input.command.occurredAt,
      },
      createdAt: input.target.sessionIndex.session.createdAt,
      updatedAt: input.command.occurredAt,
    },
    lineage: {
      version: base.sessionIndex.version,
      sessionId: input.command.targetSessionId,
      parentSessionId: input.command.sourceSessionId,
      forkedFromGenerationId: base.proof.cutoffHistoryGenerationId,
      rolledBackFromSessionId: null,
      predecessorSessionIds: [input.command.sourceSessionId],
      forkSessionIds: [],
      updatedAt: input.command.occurredAt,
    },
    updatedAt: input.command.occurredAt,
  };

  const baseArtifactRefs = base.artifactRefs.refs.map((ref) => ({
    ...ref,
    ownerId: basePromptIdentifiers.get(ref.ownerId) ?? ref.ownerId,
    ...(ref.metadata
      ? { metadata: rewriteClosedIdentifiers(ref.metadata, basePromptIdentifiers) as Record<string, unknown> }
      : {}),
  }));
  const targetArtifactRefs = input.target.artifactRefs.refs.flatMap((ref) => {
    const ownerId = targetIdentifiers.get(ref.ownerId);
    if (!ownerId) return [];
    return [{
      ...ref,
      artifactId: childId("artifact-repair", input.command.targetSessionId, base.proof.proofDigest, `${targetDigest}:${ref.artifactId}`),
      ownerId,
      ...(ref.metadata
        ? { metadata: rewriteClosedIdentifiers(ref.metadata, targetIdentifiers) as Record<string, unknown> }
        : {}),
    }];
  });
  const artifactRefs: ConversationArtifactRefsSnapshot = {
    version: base.artifactRefs.version,
    sessionId: input.command.targetSessionId,
    refs: [...baseArtifactRefs, ...targetArtifactRefs],
    updatedAt: input.command.occurredAt,
  };
  const providerEpoch = {
    schemaVersion: "conversation.fork-provider-epoch-initialization/v1" as const,
    childSessionId: input.command.targetSessionId,
    childActorKey: targetAuthority.actorKey,
    childActorId: targetAuthority.actorId,
    parentReceiptDigest: base.providerEpoch.parentReceiptDigest,
    childReceiptDigest: childProviderEpochReceipt.receiptDigest,
    reason: "history_rewind_or_fork" as const,
  };
  const targetAuthorityDigest = digestProviderContextClosedValue({
    historyIndex,
    promptIndex,
    sessionIndex,
    artifactRefs,
    historyGenerations,
    promptGenerations: [promptGeneration],
    childProviderEpochReceipt,
  });
  const evidenceFacts = {
    schemaVersion: "conversation.session-repair-evidence/v1" as const,
    sourceProofDigest: base.proof.proofDigest,
    expectedTargetAuthorityDigest: targetDigest,
    targetHeads: {
      historyHeadGenerationId: targetAuthority.historyHeadGenerationId,
      promptHeadGenerationId: targetAuthority.promptHeadGenerationId,
      providerEpochReceiptDigest: targetAuthority.receipt.receiptDigest,
    },
    plannedHeads: {
      historyHeadGenerationId: graftGenerationId,
      promptHeadGenerationId: promptGenerationId,
      providerEpochReceiptDigest: childProviderEpochReceipt.receiptDigest,
    },
    tailMapping,
  };
  const repairEvidence: ConversationSessionRepairEvidence = {
    ...evidenceFacts,
    evidenceDigest: digestProviderContextClosedValue(evidenceFacts),
  };
  const generationFacts = {
    schemaVersion: "conversation.fork-initialization-generation/v1" as const,
    mode: "repair" as const,
    proof: base.proof,
    providerEpoch,
    childProviderEpochReceipt,
    expectedTargetAuthorityDigest: targetDigest,
    expectedTargetAuthority: persistedTargetAuthority,
    targetAuthorityDigest,
    historyIndex,
    promptIndex,
    sessionIndex,
    artifactRefs,
    historyGenerations,
    promptGenerations: [promptGeneration],
    preservedTargetTailMessageCount: tailMessages.length,
    repairEvidence,
    createdAt: input.command.occurredAt,
  };
  return {
    status: "planned",
    generation: {
      ...generationFacts,
      transactionId: digestProviderContextClosedValue(generationFacts),
    },
  };
}
