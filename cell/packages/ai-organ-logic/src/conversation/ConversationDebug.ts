import type { ConversationPersistenceRepository } from "@cell/ai-organ-contract";

export type ConversationActorDebugView = {
  actorKey: string;
  actorId: string;
  activeHistoryGenerationId?: string | null;
  activePromptGenerationId?: string | null;
  visibleHistoryGenerationIds: string[];
  predecessorGenerationIds: string[];
  successorGenerationIds: string[];
  forkGenerationIds: string[];
  rolledBackFromGenerationId?: string | null;
  promptTransformKinds: string[];
  contextAssetIds: string[];
};

export type ConversationDebugSnapshot = {
  sessionId: string;
  activeActorKey?: string | null;
  actors: Record<string, ConversationActorDebugView>;
  predecessorSessionIds: string[];
  forkSessionIds: string[];
  rolledBackFromSessionId?: string | null;
};

export async function loadConversationDebugSnapshot(
  repository: ConversationPersistenceRepository,
): Promise<ConversationDebugSnapshot> {
  const historyIndex = await repository.loadHistoryIndex();
  const promptIndex = await repository.loadPromptIndex();
  const sessionIndex = await repository.loadSessionIndex();

  const actorKeys = [...new Set([
    ...Object.keys(historyIndex.heads),
    ...Object.keys(promptIndex.heads),
    ...Object.keys(sessionIndex.session.actorBindings),
  ])];

  const actors: Record<string, ConversationActorDebugView> = {};
  for (const actorKey of actorKeys) {
    const binding = sessionIndex.session.actorBindings[actorKey];
    const historyHead = historyIndex.heads[actorKey];
    const promptHead = promptIndex.heads[actorKey];
    const activeHistoryGenerationId = binding?.historyHeadGenerationId ?? historyHead?.activeGenerationId ?? null;
    const activePromptGenerationId = binding?.promptHeadGenerationId ?? promptHead?.activePromptGenerationId ?? null;
    const historyLineage = activeHistoryGenerationId ? historyIndex.lineages[activeHistoryGenerationId] : null;
    const promptGeneration = activePromptGenerationId
      ? await repository.loadPromptGeneration(activePromptGenerationId)
      : null;
    actors[actorKey] = {
      actorKey,
      actorId: binding?.actorId ?? historyHead?.actorId ?? promptHead?.actorId ?? "",
      activeHistoryGenerationId,
      activePromptGenerationId,
      visibleHistoryGenerationIds: historyHead?.visibleGenerationIds ?? [],
      predecessorGenerationIds: historyLineage?.predecessorGenerationIds ?? [],
      successorGenerationIds: historyLineage?.successorGenerationIds ?? [],
      forkGenerationIds: historyLineage?.forkGenerationIds ?? [],
      rolledBackFromGenerationId: historyLineage?.rolledBackFromGenerationId ?? null,
      promptTransformKinds: promptGeneration?.transforms.map((transform) => transform.kind) ?? [],
      contextAssetIds: sessionIndex.session.contextAssetRegistry?.assetIds ?? [],
    };
  }

  return {
    sessionId: sessionIndex.session.sessionId,
    activeActorKey: sessionIndex.session.activeActorKey ?? null,
    actors,
    predecessorSessionIds: sessionIndex.lineage?.predecessorSessionIds ?? [],
    forkSessionIds: sessionIndex.lineage?.forkSessionIds ?? [],
    rolledBackFromSessionId: sessionIndex.lineage?.rolledBackFromSessionId ?? null,
  };
}
