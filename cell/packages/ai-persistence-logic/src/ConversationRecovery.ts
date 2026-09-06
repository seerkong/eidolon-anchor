/**
 * Recovery algorithms over the explicitly supplied persistence repository.
 * Repository implementations own physical I/O; these reads do not update authority.
 */
import path from "node:path";
import type {
  ActorHistoryGenerationData,
  ConversationActorRawState,
  ConversationPersistenceRepository,
  ConversationSessionRawState,
} from "@cell/ai-organ-contract";
import {
  buildVisibleGenerationOrder,
  resolvePromptTargetHistoryGenerationId,
} from "./ConversationProjection";
import { resolveConversationHistoryLineage } from "./ConversationHistoryLineage";

function resolveActorKey(params: {
  session: ConversationSessionRawState;
  actorKey?: string;
}): string | null {
  const preferred = typeof params.actorKey === "string" ? params.actorKey.trim() : "";
  if (preferred) return preferred;
  return (
    params.session.activeActorKey
    ?? Object.keys(params.session.actorBindings)[0]
    ?? Object.keys(params.session.historyIndex.heads)[0]
    ?? Object.keys(params.session.promptIndex.heads)[0]
    ?? null
  );
}

export async function loadConversationSessionRawState(params: {
  sessionDir: string;
  repository: ConversationPersistenceRepository;
}): Promise<ConversationSessionRawState> {
  const sessionIndex = await params.repository.loadSessionIndex();
  const historyIndex = await params.repository.loadHistoryIndex();
  const promptIndex = await params.repository.loadPromptIndex();
  return {
    sessionId: path.basename(params.sessionDir),
    activeActorKey: sessionIndex.session.activeActorKey ?? null,
    actorBindings: sessionIndex.session.actorBindings,
    contextAssetRegistry: sessionIndex.session.contextAssetRegistry ?? null,
    contextAssets: sessionIndex.session.contextAssets ?? [],
    activeSelection: sessionIndex.session.activeSelection ?? null,
    lineage: sessionIndex.lineage ?? null,
    historyIndex,
    promptIndex,
    sessionIndex,
  };
}

export async function loadConversationActorRawState(params: {
  sessionDir: string;
  actorKey?: string;
  repository: ConversationPersistenceRepository;
}): Promise<ConversationActorRawState | null> {
  const session = await loadConversationSessionRawState(params);
  const actorKey = resolveActorKey({
    session,
    actorKey: params.actorKey,
  });

  if (!actorKey) {
    return null;
  }

  const actorBinding = session.actorBindings[actorKey];
  const promptHeadGenerationId =
    actorBinding?.promptHeadGenerationId
    ?? session.promptIndex.heads[actorKey]?.activePromptGenerationId
    ?? null;
  const promptGeneration = promptHeadGenerationId
    ? await params.repository.loadPromptGeneration(promptHeadGenerationId)
    : null;
  const declaredHistoryHeadGenerationId =
    actorBinding?.historyHeadGenerationId
    ?? session.historyIndex.heads[actorKey]?.activeGenerationId
    ?? null;
  const promptTargetHistoryGenerationId = resolvePromptTargetHistoryGenerationId({
    promptGeneration,
    historyIndex: session.historyIndex,
    actorKey,
  });
  const declaredHistoryGeneration = declaredHistoryHeadGenerationId
    ? await params.repository.loadHistoryGeneration(declaredHistoryHeadGenerationId)
    : null;
  const promptTargetHistoryGeneration = promptTargetHistoryGenerationId
    ? await params.repository.loadHistoryGeneration(promptTargetHistoryGenerationId)
    : null;
  const historyHeadGenerationId =
    promptGeneration
    && promptTargetHistoryGeneration
    && declaredHistoryGeneration?.createdReason !== "compaction"
      ? promptTargetHistoryGenerationId
      : declaredHistoryHeadGenerationId;

  let visibleGenerationIds = historyHeadGenerationId
    ? buildVisibleGenerationOrder({
        historyIndex: session.historyIndex,
        actorKey,
        activeGenerationId: historyHeadGenerationId,
      })
    : [];
  let visibleHistoryGenerations = (
    await Promise.all(visibleGenerationIds.map((generationId) => params.repository.loadHistoryGeneration(generationId)))
  ).filter((generation): generation is ActorHistoryGenerationData => !!generation);
  if (historyHeadGenerationId && visibleHistoryGenerations.length > 0) {
    // The selected head may come from the established Prompt handoff rule.
    // This is a read view; no persisted index or Session selection is changed.
    const existingHead = session.historyIndex.heads[actorKey];
    const lineage = resolveConversationHistoryLineage({
      historyIndex: { ...session.historyIndex, heads: {
        ...session.historyIndex.heads,
        [actorKey]: {
          ...(existingHead ?? {
            version: session.historyIndex.version,
            sessionId: session.historyIndex.sessionId,
            actorKey,
            actorId: actorBinding?.actorId ?? visibleHistoryGenerations[0]!.actorId,
            visibleGenerationIds: [historyHeadGenerationId],
            updatedAt: session.historyIndex.updatedAt,
          }),
          activeGenerationId: historyHeadGenerationId,
        },
      } },
      actorKey, activeGenerationId: historyHeadGenerationId,
      historyGenerations: visibleHistoryGenerations,
    });
    if (lineage.status === "rejected") throw new Error(`conversation_history_lineage_${lineage.reason}:${lineage.generationId}`);
    visibleGenerationIds = lineage.generationIds;
    const byId = new Map(visibleHistoryGenerations.map(generation => [generation.generationId, generation]));
    visibleHistoryGenerations = visibleGenerationIds.map(id => byId.get(id)!);
  }
  const activeHistoryGeneration = historyHeadGenerationId
    ? (visibleHistoryGenerations.find((generation) => generation.generationId === historyHeadGenerationId)
      ?? (historyHeadGenerationId === promptTargetHistoryGenerationId ? promptTargetHistoryGeneration : null)
      ?? (historyHeadGenerationId === declaredHistoryHeadGenerationId ? declaredHistoryGeneration : null)
      ?? await params.repository.loadHistoryGeneration(historyHeadGenerationId))
    : null;

  return {
    session,
    actorKey,
    actorId:
      actorBinding?.actorId
      ?? activeHistoryGeneration?.actorId
      ?? promptGeneration?.actorId
      ?? "",
    historyHeadGenerationId,
    promptHeadGenerationId,
    visibleGenerationIds,
    visibleHistoryGenerations,
    activeHistoryGeneration: activeHistoryGeneration ?? null,
    promptGeneration: promptGeneration ?? null,
    contextAssetIds: session.contextAssetRegistry?.assetIds ?? [],
  };
}
