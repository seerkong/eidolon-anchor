import type { ChatMessage } from "@shared/composer";

import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION } from "@cell/ai-organ-contract";
import type { ConversationPersistenceRepository } from "@cell/ai-organ-contract";
import { chatMessagesToCommittedHistoryRefs } from "./LocalConversationRuntime";

type BootstrapActorHistoryParams = {
  sessionId: string;
  actorKey: string;
  actorId: string;
  messages: ChatMessage[];
  transcriptPath?: string | null;
  repository: ConversationPersistenceRepository;
};

export async function bootstrapConversationHistoryFromMessages(
  params: BootstrapActorHistoryParams,
): Promise<void> {
  const historyIndex = await params.repository.loadHistoryIndex();
  if (historyIndex.heads[params.actorKey]?.activeGenerationId) {
    return;
  }

  const sessionIndex = await params.repository.loadSessionIndex();
  const generationId = `${params.actorKey}__active`;
  const nowIso = new Date().toISOString();
  const committedMessages = chatMessagesToCommittedHistoryRefs({
    messages: params.messages,
    actorKey: params.actorKey,
    actorId: params.actorId,
    recordIdPrefix: generationId,
    transcriptPath: params.transcriptPath ?? null,
  });

  await params.repository.writeHistoryGeneration({
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    generationId,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    parentGenerationId: null,
    predecessorGenerationIds: [],
    createdReason: "bootstrap",
    sealed: false,
    messageCount: committedMessages.length,
    messages: committedMessages,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  historyIndex.heads[params.actorKey] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    activeGenerationId: generationId,
    visibleGenerationIds: [generationId],
    updatedAt: nowIso,
  };
  historyIndex.lineages[generationId] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    generationId,
    parentGenerationId: null,
    rolledBackFromGenerationId: null,
    predecessorGenerationIds: [],
    successorGenerationIds: [],
    forkGenerationIds: [],
    branchLabel: null,
    updatedAt: nowIso,
  };
  historyIndex.generations[generationId] = {
    generationId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    sealed: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  historyIndex.updatedAt = nowIso;
  await params.repository.writeHistoryIndex(historyIndex);

  sessionIndex.session.activeActorKey = sessionIndex.session.activeActorKey ?? params.actorKey;
  sessionIndex.session.actorBindings[params.actorKey] = {
    actorKey: params.actorKey,
    actorId: params.actorId,
    boundAt: nowIso,
    historyHeadGenerationId: generationId,
    promptHeadGenerationId:
      sessionIndex.session.actorBindings[params.actorKey]?.promptHeadGenerationId ?? null,
  };
  sessionIndex.session.activeSelection = {
    sessionId: params.sessionId,
    activeActorKey: params.actorKey,
    historyHeadGenerationId: generationId,
    promptHeadGenerationId:
      sessionIndex.session.actorBindings[params.actorKey]?.promptHeadGenerationId ?? null,
    selectedAt: nowIso,
  };
  sessionIndex.session.updatedAt = nowIso;
  sessionIndex.updatedAt = nowIso;
  await params.repository.writeSessionIndex(sessionIndex);
}
