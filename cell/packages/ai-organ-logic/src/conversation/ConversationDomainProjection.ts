import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ConversationDomainEvent,
  type ConversationHistoryIndexSnapshot,
  type ConversationPromptIndexSnapshot,
  type ConversationSessionIndexSnapshot,
} from "@cell/ai-organ-contract";

export type ConversationProjectionState = {
  historyIndex: ConversationHistoryIndexSnapshot;
  promptIndex: ConversationPromptIndexSnapshot;
  sessionIndex: ConversationSessionIndexSnapshot;
};

export function createEmptyConversationProjection(sessionId: string): ConversationProjectionState {
  const zeroIso = new Date(0).toISOString();
  return {
    historyIndex: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      heads: {},
      lineages: {},
      generations: {},
      updatedAt: zeroIso,
    },
    promptIndex: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      heads: {},
      generations: {},
      updatedAt: zeroIso,
    },
    sessionIndex: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      session: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId,
        activeActorKey: null,
        actorBindings: {},
        contextAssetRegistry: null,
        contextAssets: [],
        activeSelection: null,
        createdAt: zeroIso,
        updatedAt: zeroIso,
      },
      lineage: null,
      updatedAt: zeroIso,
    },
  };
}

function ensureHistoryLineage(
  state: ConversationProjectionState,
  event: Extract<
    ConversationDomainEvent,
    { type: "actor_history_generation_created" | "actor_history_generation_forked" | "actor_history_generation_rolled_back" }
  >,
  generationId: string,
  actorKey: string,
) {
  state.historyIndex.lineages[generationId] = state.historyIndex.lineages[generationId] ?? {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId: event.sessionId,
    actorKey,
    actorId: "",
    generationId,
    parentGenerationId: null,
    rolledBackFromGenerationId: null,
    predecessorGenerationIds: [],
    successorGenerationIds: [],
    forkGenerationIds: [],
    branchLabel: null,
    updatedAt: event.occurredAt,
  };
  return state.historyIndex.lineages[generationId]!;
}

export function reduceConversationDomainEvent(
  state: ConversationProjectionState,
  event: ConversationDomainEvent,
): ConversationProjectionState {
  switch (event.type) {
    case "actor_history_generation_created": {
      const lineage = ensureHistoryLineage(state, event, event.generationId, event.actorKey);
      const actorId = event.generation?.actorId ?? lineage.actorId;
      lineage.updatedAt = event.occurredAt;
      lineage.actorId = actorId;
      state.historyIndex.generations[event.generationId] = {
        generationId: event.generationId,
        actorKey: event.actorKey,
        actorId,
        sealed: event.generation?.sealed ?? false,
        createdAt: event.generation?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
      };
      state.historyIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_history_generation_sealed": {
      state.historyIndex.generations[event.generationId] = {
        generationId: event.generationId,
        actorKey: event.actorKey,
        actorId: event.generation?.actorId ?? state.historyIndex.generations[event.generationId]?.actorId ?? "",
        sealed: true,
        createdAt: event.generation?.createdAt ?? state.historyIndex.generations[event.generationId]?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
      };
      const lineage = state.historyIndex.lineages[event.generationId];
      if (lineage) lineage.updatedAt = event.occurredAt;
      state.historyIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_history_head_moved": {
      const previousVisible = state.historyIndex.heads[event.actorKey]?.visibleGenerationIds ?? [];
      const activeGenerationId = event.head?.activeGenerationId ?? event.activeGenerationId;
      state.historyIndex.heads[event.actorKey] = {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.head?.actorId ?? state.historyIndex.heads[event.actorKey]?.actorId ?? "",
        activeGenerationId,
        visibleGenerationIds: [...new Set([activeGenerationId, ...(event.head?.visibleGenerationIds ?? previousVisible)])],
        updatedAt: event.occurredAt,
      };
      state.sessionIndex.session.actorBindings[event.actorKey] = {
        actorKey: event.actorKey,
        actorId: state.sessionIndex.session.actorBindings[event.actorKey]?.actorId ?? "",
        actorName: state.sessionIndex.session.actorBindings[event.actorKey]?.actorName ?? null,
        actorKind: state.sessionIndex.session.actorBindings[event.actorKey]?.actorKind ?? null,
        boundAt: state.sessionIndex.session.actorBindings[event.actorKey]?.boundAt ?? event.occurredAt,
        historyHeadGenerationId: activeGenerationId,
        promptHeadGenerationId:
          state.sessionIndex.session.actorBindings[event.actorKey]?.promptHeadGenerationId ?? null,
        metadata: state.sessionIndex.session.actorBindings[event.actorKey]?.metadata,
      };
      state.sessionIndex.session.activeSelection = {
        sessionId: event.sessionId,
        activeActorKey: event.actorKey,
        historyHeadGenerationId: activeGenerationId,
        promptHeadGenerationId:
          state.sessionIndex.session.activeSelection?.promptHeadGenerationId
          ?? state.sessionIndex.session.actorBindings[event.actorKey]?.promptHeadGenerationId
          ?? null,
        selectedAt: event.occurredAt,
        metadata: state.sessionIndex.session.activeSelection?.metadata,
      };
      state.historyIndex.updatedAt = event.occurredAt;
      state.sessionIndex.updatedAt = event.occurredAt;
      state.sessionIndex.session.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_history_generation_forked": {
      const source = ensureHistoryLineage(state, event, event.sourceGenerationId, event.actorKey);
      const fork = ensureHistoryLineage(state, event, event.forkGenerationId, event.actorKey);
      source.forkGenerationIds = [...new Set([...source.forkGenerationIds, event.forkGenerationId])];
      source.successorGenerationIds = [...new Set([...source.successorGenerationIds, event.forkGenerationId])];
      source.updatedAt = event.occurredAt;
      fork.parentGenerationId = event.sourceGenerationId;
      fork.predecessorGenerationIds = [...new Set([...fork.predecessorGenerationIds, event.sourceGenerationId])];
      fork.branchLabel = event.branchLabel ?? fork.branchLabel ?? "fork";
      fork.updatedAt = event.occurredAt;
      state.historyIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_history_generation_rolled_back": {
      const from = ensureHistoryLineage(state, event, event.fromGenerationId, event.actorKey);
      const to = ensureHistoryLineage(state, event, event.toGenerationId, event.actorKey);
      to.rolledBackFromGenerationId = event.fromGenerationId;
      to.updatedAt = event.occurredAt;
      from.successorGenerationIds = [...new Set([...from.successorGenerationIds, event.toGenerationId])];
      from.updatedAt = event.occurredAt;
      state.historyIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_prompt_generation_created": {
      const actorId = event.generation?.actorId ?? state.promptIndex.heads[event.actorKey]?.actorId ?? "";
      state.promptIndex.generations[event.promptGenerationId] = {
        promptGenerationId: event.promptGenerationId,
        actorKey: event.actorKey,
        actorId,
        sealed: event.generation?.sealed ?? false,
        createdAt: event.generation?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
      };
      state.promptIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_prompt_head_moved": {
      const activePromptGenerationId = event.head?.activePromptGenerationId ?? event.activePromptGenerationId;
      state.promptIndex.heads[event.actorKey] = {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.head?.actorId ?? state.promptIndex.heads[event.actorKey]?.actorId ?? "",
        activePromptGenerationId,
        updatedAt: event.occurredAt,
      };
      state.sessionIndex.session.actorBindings[event.actorKey] = {
        actorKey: event.actorKey,
        actorId: state.sessionIndex.session.actorBindings[event.actorKey]?.actorId ?? "",
        actorName: state.sessionIndex.session.actorBindings[event.actorKey]?.actorName ?? null,
        actorKind: state.sessionIndex.session.actorBindings[event.actorKey]?.actorKind ?? null,
        boundAt: state.sessionIndex.session.actorBindings[event.actorKey]?.boundAt ?? event.occurredAt,
        historyHeadGenerationId:
          state.sessionIndex.session.actorBindings[event.actorKey]?.historyHeadGenerationId ?? null,
        promptHeadGenerationId: activePromptGenerationId,
        metadata: state.sessionIndex.session.actorBindings[event.actorKey]?.metadata,
      };
      state.sessionIndex.session.activeSelection = {
        sessionId: event.sessionId,
        activeActorKey:
          state.sessionIndex.session.activeSelection?.activeActorKey
          ?? state.sessionIndex.session.activeActorKey
          ?? event.actorKey,
        historyHeadGenerationId:
          state.sessionIndex.session.activeSelection?.historyHeadGenerationId
          ?? state.sessionIndex.session.actorBindings[event.actorKey]?.historyHeadGenerationId
          ?? null,
        promptHeadGenerationId: activePromptGenerationId,
        selectedAt: event.occurredAt,
        metadata: state.sessionIndex.session.activeSelection?.metadata,
      };
      state.promptIndex.updatedAt = event.occurredAt;
      state.sessionIndex.updatedAt = event.occurredAt;
      state.sessionIndex.session.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_history_appended": {
      const generationId = event.generation?.generationId ?? event.generationId;
      state.historyIndex.generations[generationId] = {
        generationId,
        actorKey: event.actorKey,
        actorId: event.generation?.actorId ?? state.historyIndex.generations[generationId]?.actorId ?? "",
        sealed: event.generation?.sealed ?? state.historyIndex.generations[generationId]?.sealed ?? false,
        createdAt: event.generation?.createdAt ?? state.historyIndex.generations[generationId]?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
      };
      if (event.head) {
        state.historyIndex.heads[event.actorKey] = { ...event.head };
      }
      state.historyIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_history_reset": {
      const previousHead = state.historyIndex.heads[event.actorKey];
      if (previousHead) {
        state.historyIndex.heads[event.actorKey] = {
          ...previousHead,
          activeGenerationId: null,
          visibleGenerationIds: [],
          updatedAt: event.occurredAt,
        };
      }
      state.historyIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_history_compaction_applied": {
      if (event.generation) {
        state.historyIndex.generations[event.generation.generationId] = {
          generationId: event.generation.generationId,
          actorKey: event.actorKey,
          actorId: event.generation.actorId,
          sealed: event.generation.sealed,
          createdAt: event.generation.createdAt,
          updatedAt: event.occurredAt,
        };
      }
      if (event.head) {
        state.historyIndex.heads[event.actorKey] = { ...event.head };
      }
      state.historyIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_prompt_basis_selected": {
      state.promptIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_prompt_generation_sealed": {
      state.promptIndex.generations[event.promptGenerationId] = {
        promptGenerationId: event.promptGenerationId,
        actorKey: event.actorKey,
        actorId: event.generation?.actorId ?? state.promptIndex.generations[event.promptGenerationId]?.actorId ?? "",
        sealed: true,
        createdAt: event.generation?.createdAt ?? state.promptIndex.generations[event.promptGenerationId]?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
      };
      state.promptIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_prompt_transform_applied": {
      state.promptIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "actor_prompt_reset": {
      state.promptIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "local_conversation_session_created": {
      state.sessionIndex.session = event.session
        ? { ...event.session }
        : {
            ...state.sessionIndex.session,
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
          };
      state.sessionIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "local_conversation_session_forked": {
      if (event.lineage) {
        state.sessionIndex.lineage = { ...event.lineage };
      }
      state.sessionIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "local_conversation_session_closed": {
      if (event.session) {
        state.sessionIndex.session = { ...event.session };
      }
      state.sessionIndex.session.updatedAt = event.occurredAt;
      state.sessionIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "local_conversation_session_head_selected": {
      if (event.session) {
        state.sessionIndex.session = { ...event.session };
      }
      state.sessionIndex.session.activeActorKey = event.session?.activeActorKey ?? event.activeActorKey;
      state.sessionIndex.session.activeSelection = event.selection
        ? { ...event.selection }
        : {
            sessionId: event.sessionId,
            activeActorKey: event.activeActorKey,
            historyHeadGenerationId: state.sessionIndex.session.activeSelection?.historyHeadGenerationId ?? null,
            promptHeadGenerationId: state.sessionIndex.session.activeSelection?.promptHeadGenerationId ?? null,
            selectedAt: event.occurredAt,
            metadata: state.sessionIndex.session.activeSelection?.metadata,
          };
      state.sessionIndex.session.updatedAt = event.occurredAt;
      state.sessionIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "local_conversation_session_actor_bound": {
      state.sessionIndex.session.actorBindings[event.actorKey] = event.binding
        ? { ...event.binding }
        : {
            actorKey: event.actorKey,
            actorId: event.actorId,
            actorName: event.actorName ?? null,
            actorKind: event.actorKind ?? null,
            boundAt: event.occurredAt,
            historyHeadGenerationId: event.historyHeadGenerationId ?? null,
            promptHeadGenerationId: event.promptHeadGenerationId ?? null,
          };
      state.sessionIndex.session.updatedAt = event.occurredAt;
      state.sessionIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "local_conversation_session_lineage_updated": {
      state.sessionIndex.lineage = event.lineage
        ? { ...event.lineage }
        : {
            version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
            sessionId: event.sessionId,
            parentSessionId: event.parentSessionId ?? null,
            forkedFromGenerationId: event.forkedFromGenerationId ?? null,
            rolledBackFromSessionId: event.rolledBackFromSessionId ?? null,
            predecessorSessionIds: state.sessionIndex.lineage?.predecessorSessionIds ?? [],
            forkSessionIds: state.sessionIndex.lineage?.forkSessionIds ?? [],
            updatedAt: event.occurredAt,
          };
      state.sessionIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "local_conversation_session_active_selection_updated": {
      state.sessionIndex.session.activeActorKey = event.activeActorKey;
      state.sessionIndex.session.activeSelection = event.selection
        ? { ...event.selection }
        : {
            sessionId: event.sessionId,
            activeActorKey: event.activeActorKey,
            historyHeadGenerationId: event.historyHeadGenerationId ?? null,
            promptHeadGenerationId: event.promptHeadGenerationId ?? null,
            selectedAt: event.occurredAt,
          };
      state.sessionIndex.session.updatedAt = event.occurredAt;
      state.sessionIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "local_conversation_context_asset_registered": {
      const current = state.sessionIndex.session.contextAssetRegistry;
      state.sessionIndex.session.contextAssetRegistry = {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        assetIds: [...new Set([...(current?.assetIds ?? []), event.assetId])],
        updatedAt: event.occurredAt,
      };
      state.sessionIndex.session.contextAssets = [
        ...(state.sessionIndex.session.contextAssets ?? []).filter((asset) => asset.assetId !== event.assetId),
        ...(event.asset ? [event.asset] : []),
      ];
      state.sessionIndex.session.updatedAt = event.occurredAt;
      state.sessionIndex.updatedAt = event.occurredAt;
      return state;
    }
    case "local_conversation_context_asset_removed": {
      if (event.session) {
        state.sessionIndex.session = { ...event.session };
      }
      const current = state.sessionIndex.session.contextAssetRegistry;
      state.sessionIndex.session.contextAssetRegistry = current
        ? {
            ...current,
            assetIds: current.assetIds.filter((assetId) => assetId !== event.assetId),
            updatedAt: event.occurredAt,
          }
        : null;
      state.sessionIndex.session.contextAssets = (state.sessionIndex.session.contextAssets ?? []).filter(
        (asset) => asset.assetId !== event.assetId,
      );
      state.sessionIndex.session.updatedAt = event.occurredAt;
      state.sessionIndex.updatedAt = event.occurredAt;
      return state;
    }
  }
}

export function reduceConversationDomainEvents(
  sessionId: string,
  events: ConversationDomainEvent[],
): ConversationProjectionState {
  return events.reduce(
    (state, event) => reduceConversationDomainEvent(state, event),
    createEmptyConversationProjection(sessionId),
  );
}
