import path from "node:path";
import type { ChatMessage } from "@shared/composer";
import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorHistoryGenerationData,
  type ActorPromptGenerationData,
  type ConversationArtifactRef,
  type ConversationPersistenceRepository,
} from "@cell/ai-organ-contract";
import {
  chatMessagesToCommittedHistoryRefs,
  materializeConversationRuntimePrompt,
  materializeConversationVisibleHistory,
} from "@cell/ai-persistence-logic/ConversationProjection";
import { loadConversationActorRawState } from "@cell/ai-persistence-logic/ConversationRecovery";
import { getLocalHistoryGenerationPath } from "./LocalConversationPaths";

// Compatibility exports share the lower-level implementation used by the domain.
export * from "@cell/ai-persistence-logic/ConversationProjection";
export * from "@cell/ai-persistence-logic/ConversationRecovery";

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

function makeGenerationId(actorKey: string, kind: "active" | "compact" | "prompt"): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${actorKey}__${kind}__${suffix}`;
}

function extractActiveTailMessages(params: {
  compressedMessages: ChatMessage[];
  summary: string;
  acknowledgedSummary?: string | null;
}): ChatMessage[] {
  const messages = [...params.compressedMessages];
  if (messages[0]?.role === "user" && String(messages[0]?.content ?? "").trim() === params.summary.trim()) {
    messages.shift();
  }
  const ack = String(params.acknowledgedSummary ?? "").trim();
  if (
    ack
    && messages[0]?.role === "assistant"
    && String(messages[0]?.content ?? "").trim() === ack
  ) {
    messages.shift();
  }
  return messages;
}

export type LoadedConversationMessages = {
  messages: ChatMessage[];
  source: "conversation" | "empty";
  historyGenerationId?: string | null;
  promptGenerationId?: string | null;
  path?: string;
};

export async function loadConversationHistoryMessages(params: {
  sessionDir: string;
  actorKey: string;
  repository: ConversationPersistenceRepository;
}): Promise<LoadedConversationMessages> {
  const rawState = await loadConversationActorRawState(params);
  if (!rawState?.historyHeadGenerationId) {
    return {
      messages: [],
      source: "empty",
    };
  }
  const messages = materializeConversationVisibleHistory(rawState);
  if (messages.length === 0) {
    return {
      messages: [],
      source: "empty",
      historyGenerationId: rawState.historyHeadGenerationId,
    };
  }
  return {
    messages,
    source: "conversation",
    historyGenerationId: rawState.historyHeadGenerationId,
    promptGenerationId: rawState.promptHeadGenerationId ?? null,
    path: getLocalHistoryGenerationPath(params.sessionDir, rawState.historyHeadGenerationId),
  };
}

export async function loadConversationRuntimeMessages(params: {
  sessionDir: string;
  actorKey: string;
  repository: ConversationPersistenceRepository;
}): Promise<LoadedConversationMessages> {
  const rawState = await loadConversationActorRawState(params);
  if (!rawState?.historyHeadGenerationId) {
    return {
      messages: [],
      source: "empty",
      historyGenerationId: null,
      promptGenerationId: rawState?.promptHeadGenerationId ?? null,
    };
  }
  if (!rawState.activeHistoryGeneration) {
    return {
      messages: [],
      source: "empty",
      historyGenerationId: rawState.historyHeadGenerationId,
      promptGenerationId: rawState.promptHeadGenerationId ?? null,
    };
  }
  const runtimeMessages = materializeConversationRuntimePrompt(rawState);
  return {
    messages: runtimeMessages,
    source: runtimeMessages.length > 0 ? "conversation" : "empty",
    historyGenerationId: rawState.historyHeadGenerationId,
    promptGenerationId: rawState.promptHeadGenerationId ?? null,
    path: getLocalHistoryGenerationPath(params.sessionDir, rawState.historyHeadGenerationId),
  };
}

export async function applyConversationCompaction(params: {
  sessionDir: string;
  actorKey: string;
  actorId: string;
  compressedMessages: ChatMessage[];
  summary: string;
  acknowledgedSummary?: string | null;
  occurredAt?: string;
  metadata?: {
    workContext?: Record<string, unknown>;
    policyContext?: Record<string, unknown>;
    policyDecision?: Record<string, unknown>;
    continuationBaselineBefore?: Record<string, unknown>;
    continuationBaselineAfter?: Record<string, unknown>;
    promptPlan?: Record<string, unknown>;
  };
  repository: ConversationPersistenceRepository;
  deferCommit?: boolean;
}): Promise<{
  historyGenerationId: string;
  promptGenerationId: string;
  historyIndex: import("@cell/ai-organ-contract").ConversationHistoryIndexSnapshot;
  promptIndex: import("@cell/ai-organ-contract").ConversationPromptIndexSnapshot;
  sessionIndex: import("@cell/ai-organ-contract").ConversationSessionIndexSnapshot;
  artifactRefs: import("@cell/ai-organ-contract").ConversationArtifactRefsSnapshot;
  historyGenerations: readonly ActorHistoryGenerationData[];
  promptGenerations: readonly ActorPromptGenerationData[];
}> {
  const nowIso = params.occurredAt ?? new Date().toISOString();
  const sessionId = path.basename(params.sessionDir);
  const historyIndex = await params.repository.loadHistoryIndex();
  const promptIndex = await params.repository.loadPromptIndex();
  const sessionIndex = await params.repository.loadSessionIndex();
  const artifactRefs = await params.repository.loadArtifactRefs();
  const actorBinding = sessionIndex.session.actorBindings[params.actorKey];
  const previousHistoryGenerationId =
    actorBinding?.historyHeadGenerationId
    ?? historyIndex.heads[params.actorKey]?.activeGenerationId
    ?? null;
  const previousPromptGenerationId =
    actorBinding?.promptHeadGenerationId
    ?? promptIndex.heads[params.actorKey]?.activePromptGenerationId
    ?? null;
  const previousHistoryGeneration = previousHistoryGenerationId
    ? await params.repository.loadHistoryGeneration(previousHistoryGenerationId)
    : null;

  const sealedPreviousHistoryGeneration = previousHistoryGeneration && !previousHistoryGeneration.sealed
    ? {
        ...previousHistoryGeneration,
        sealed: true,
        updatedAt: nowIso,
      }
    : null;
  if (sealedPreviousHistoryGeneration && !params.deferCommit) {
    await params.repository.writeHistoryGeneration({
      ...sealedPreviousHistoryGeneration,
    });
  }

  const historyGenerationId = makeGenerationId(params.actorKey, "compact");
  const promptGenerationId = makeGenerationId(params.actorKey, "prompt");
  const activeTailMessages = extractActiveTailMessages({
    compressedMessages: params.compressedMessages,
    summary: params.summary,
    acknowledgedSummary: params.acknowledgedSummary,
  });

  const historyGeneration: ActorHistoryGenerationData = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    generationId: historyGenerationId,
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    parentGenerationId: previousHistoryGenerationId,
    predecessorGenerationIds: uniqueStrings([previousHistoryGenerationId]),
    createdReason: "compaction",
    sealed: false,
    messageCount: activeTailMessages.length,
    messages: chatMessagesToCommittedHistoryRefs({
      messages: activeTailMessages,
      actorKey: params.actorKey,
      actorId: params.actorId,
      recordIdPrefix: historyGenerationId,
    }),
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const promptGeneration: ActorPromptGenerationData = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    promptGenerationId,
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    basedOnPromptGenerationId: previousPromptGenerationId,
    basis: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      basisHistoryGenerationIds: uniqueStrings([previousHistoryGenerationId, historyGenerationId]),
      basisMessageRecordIds: historyGeneration.messages.map((message) => message.recordId),
      basisRefs: uniqueStrings([previousHistoryGenerationId, historyGenerationId]).map((generationId) => ({
        refKind: "history_generation",
        refId: generationId,
      })),
    },
    transforms: [
      {
        transformId: `${promptGenerationId}::summary`,
        kind: "history_compaction_summary",
        payload: {
          summary: params.summary,
          acknowledgedSummary: params.acknowledgedSummary ?? null,
          sourceHistoryGenerationId: previousHistoryGenerationId,
          targetHistoryGenerationId: historyGenerationId,
          ...(params.metadata?.workContext ? { workContext: params.metadata.workContext } : {}),
          ...(params.metadata?.policyContext ? { policyContext: params.metadata.policyContext } : {}),
          ...(params.metadata?.policyDecision ? { policyDecision: params.metadata.policyDecision } : {}),
          ...(params.metadata?.continuationBaselineAfter
            ? { continuationBaselineAfter: params.metadata.continuationBaselineAfter }
            : {}),
        },
        appliedAt: nowIso,
      },
    ],
    createdReason: "request_build",
    materializedContext: params.summary,
    sealed: false,
    createdAt: nowIso,
    sealedAt: null,
    updatedAt: nowIso,
    metadata: {
      sourceHistoryGenerationId: previousHistoryGenerationId,
      targetHistoryGenerationId: historyGenerationId,
      ...(params.metadata?.workContext ? { workContext: params.metadata.workContext } : {}),
      ...(params.metadata?.policyContext ? { policyContext: params.metadata.policyContext } : {}),
      ...(params.metadata?.policyDecision ? { policyDecision: params.metadata.policyDecision } : {}),
      ...(params.metadata?.continuationBaselineBefore
        ? { continuationBaselineBefore: params.metadata.continuationBaselineBefore }
        : {}),
      ...(params.metadata?.continuationBaselineAfter
        ? { continuationBaselineAfter: params.metadata.continuationBaselineAfter }
        : {}),
      ...(params.metadata?.promptPlan ? { promptPlan: params.metadata.promptPlan } : {}),
    },
  };

  if (!params.deferCommit) {
    await params.repository.writeHistoryGeneration(historyGeneration);
    await params.repository.writePromptGeneration(promptGeneration);
  }

  historyIndex.heads[params.actorKey] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    activeGenerationId: historyGenerationId,
    visibleGenerationIds: uniqueStrings([
      ...(historyIndex.heads[params.actorKey]?.visibleGenerationIds ?? []),
      previousHistoryGenerationId,
      historyGenerationId,
    ]),
    updatedAt: nowIso,
  };

  historyIndex.lineages[historyGenerationId] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    generationId: historyGenerationId,
    parentGenerationId: previousHistoryGenerationId,
    rolledBackFromGenerationId: null,
    predecessorGenerationIds: uniqueStrings([previousHistoryGenerationId]),
    successorGenerationIds: [],
    forkGenerationIds: [],
    branchLabel: null,
    updatedAt: nowIso,
  };
  historyIndex.generations[historyGenerationId] = {
    generationId: historyGenerationId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    sealed: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (previousHistoryGenerationId) {
    const previousLineage = historyIndex.lineages[previousHistoryGenerationId] ?? {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      actorKey: params.actorKey,
      actorId: params.actorId,
      generationId: previousHistoryGenerationId,
      parentGenerationId: null,
      rolledBackFromGenerationId: null,
      predecessorGenerationIds: [],
      successorGenerationIds: [],
      forkGenerationIds: [],
      branchLabel: null,
      updatedAt: nowIso,
    };
    historyIndex.lineages[previousHistoryGenerationId] = {
      ...previousLineage,
      successorGenerationIds: uniqueStrings([
        ...(previousLineage.successorGenerationIds ?? []),
        historyGenerationId,
      ]),
      updatedAt: nowIso,
    };
    const previousManifest = historyIndex.generations[previousHistoryGenerationId];
    if (previousManifest) {
      historyIndex.generations[previousHistoryGenerationId] = {
        ...previousManifest,
        sealed: true,
        updatedAt: nowIso,
      };
    }
  }
  historyIndex.updatedAt = nowIso;

  promptIndex.heads[params.actorKey] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    activePromptGenerationId: promptGenerationId,
    updatedAt: nowIso,
  };
  promptIndex.generations[promptGenerationId] = {
    promptGenerationId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    sealed: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  promptIndex.updatedAt = nowIso;

  sessionIndex.session.activeActorKey = params.actorKey;
  sessionIndex.session.actorBindings[params.actorKey] = {
    actorKey: params.actorKey,
    actorId: params.actorId,
    boundAt: nowIso,
    historyHeadGenerationId: historyGenerationId,
    promptHeadGenerationId: promptGenerationId,
  };
  sessionIndex.session.activeSelection = {
    sessionId,
    activeActorKey: params.actorKey,
    historyHeadGenerationId: historyGenerationId,
    promptHeadGenerationId: promptGenerationId,
    selectedAt: nowIso,
  };
  sessionIndex.session.updatedAt = nowIso;
  sessionIndex.updatedAt = nowIso;

  const artifactRef: ConversationArtifactRef = {
    artifactId: `${promptGenerationId}::artifact`,
    ownerDomain: "prompt",
    ownerId: promptGenerationId,
    artifactKind: "compaction_summary",
    filePath: null,
    metadata: {
      sourceHistoryGenerationId: previousHistoryGenerationId,
      targetHistoryGenerationId: historyGenerationId,
      summaryPreview: params.summary.slice(0, 160),
      ...(params.metadata?.workContext ? { workContext: params.metadata.workContext } : {}),
      ...(params.metadata?.policyDecision ? { policyDecision: params.metadata.policyDecision } : {}),
    },
    createdAt: nowIso,
  };
  const diagnosticRef: ConversationArtifactRef = {
    artifactId: `${promptGenerationId}::context-control`,
    ownerDomain: "prompt",
    ownerId: promptGenerationId,
    artifactKind: "diagnostic",
    filePath: null,
    metadata: {
      workContext: params.metadata?.workContext ?? null,
      policyContext: params.metadata?.policyContext ?? null,
      policyDecision: params.metadata?.policyDecision ?? null,
      continuationBaselineBefore: params.metadata?.continuationBaselineBefore ?? null,
      continuationBaselineAfter: params.metadata?.continuationBaselineAfter ?? null,
      promptPlan: params.metadata?.promptPlan ?? null,
    },
    createdAt: nowIso,
  };
  artifactRefs.refs = [
    ...artifactRefs.refs.filter(
      (ref) => ref.artifactId !== artifactRef.artifactId && ref.artifactId !== diagnosticRef.artifactId,
    ),
    artifactRef,
    diagnosticRef,
  ];
  artifactRefs.updatedAt = nowIso;

  if (!params.deferCommit) {
    await params.repository.writeHistoryIndex(historyIndex);
    await params.repository.writePromptIndex(promptIndex);
    await params.repository.writeSessionIndex(sessionIndex);
    await params.repository.writeArtifactRefs(artifactRefs);
  }

  return {
    historyGenerationId,
    promptGenerationId,
    historyIndex,
    promptIndex,
    sessionIndex,
    artifactRefs,
    historyGenerations: [
      ...(sealedPreviousHistoryGeneration ? [sealedPreviousHistoryGeneration] : []),
      historyGeneration,
    ],
    promptGenerations: [promptGeneration],
  };
}
