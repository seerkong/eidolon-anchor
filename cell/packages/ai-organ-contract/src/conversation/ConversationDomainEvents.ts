import type { ActorHistoryGenerationData, ActorHistoryHeadData } from "./ActorHistoryGeneration";
import type {
  ActorPromptBasisRefData,
  ActorPromptGenerationData,
  ActorPromptHeadData,
  ActorPromptTransformData,
  ActorPromptTransformKind,
} from "./ActorPromptGeneration";
import type { LocalConversationContextAssetData } from "./LocalConversationContextAsset";
import type {
  LocalConversationSessionActorBinding,
  LocalConversationSessionData,
  LocalConversationSessionLineageData,
  LocalConversationSessionSelectionData,
} from "./LocalConversationSession";

export type ConversationDomainEvent =
  | {
      type: "actor_history_generation_created";
      sessionId: string;
      actorKey: string;
      generationId: string;
      generation?: ActorHistoryGenerationData;
      occurredAt: string;
    }
  | {
      type: "actor_history_appended";
      sessionId: string;
      actorKey: string;
      generationId: string;
      messageRecordId: string;
      message?: Record<string, unknown>;
      generation?: ActorHistoryGenerationData;
      head?: ActorHistoryHeadData;
      occurredAt: string;
    }
  | {
      type: "actor_history_generation_sealed";
      sessionId: string;
      actorKey: string;
      generationId: string;
      generation?: ActorHistoryGenerationData;
      occurredAt: string;
    }
  | {
      type: "actor_history_head_moved";
      sessionId: string;
      actorKey: string;
      activeGenerationId: string;
      head?: ActorHistoryHeadData;
      occurredAt: string;
    }
  | {
      type: "actor_history_generation_forked";
      sessionId: string;
      actorKey: string;
      sourceGenerationId: string;
      forkGenerationId: string;
      branchLabel?: string | null;
      occurredAt: string;
    }
  | {
      type: "actor_history_generation_rolled_back";
      sessionId: string;
      actorKey: string;
      fromGenerationId: string;
      toGenerationId: string;
      occurredAt: string;
    }
  | {
      type: "actor_history_reset";
      sessionId: string;
      actorKey: string;
      actorId?: string;
      reason: string;
      occurredAt: string;
    }
  | {
      type: "actor_history_compaction_applied";
      sessionId: string;
      actorKey: string;
      actorId?: string;
      sourceGenerationIds: string[];
      targetGenerationId: string;
      summaryText?: string | null;
      artifactId?: string | null;
      generation?: ActorHistoryGenerationData;
      head?: ActorHistoryHeadData;
      occurredAt: string;
    }
  | {
      type: "actor_prompt_generation_created";
      sessionId: string;
      actorKey: string;
      promptGenerationId: string;
      generation?: ActorPromptGenerationData;
      occurredAt: string;
    }
  | {
      type: "actor_prompt_basis_selected";
      sessionId: string;
      actorKey: string;
      promptGenerationId: string;
      basisHistoryGenerationIds: string[];
      basisMessageRecordIds?: string[];
      basisRefs?: ActorPromptBasisRefData[];
      occurredAt: string;
    }
  | {
      type: "actor_prompt_transform_applied";
      sessionId: string;
      actorKey: string;
      promptGenerationId: string;
      transformId: string;
      transformKind: ActorPromptTransformKind;
      payload?: Record<string, unknown>;
      transform?: ActorPromptTransformData;
      occurredAt: string;
    }
  | {
      type: "actor_prompt_generation_sealed";
      sessionId: string;
      actorKey: string;
      promptGenerationId: string;
      generation?: ActorPromptGenerationData;
      occurredAt: string;
    }
  | {
      type: "actor_prompt_head_moved";
      sessionId: string;
      actorKey: string;
      activePromptGenerationId: string;
      head?: ActorPromptHeadData;
      occurredAt: string;
    }
  | {
      type: "actor_prompt_reset";
      sessionId: string;
      actorKey: string;
      actorId?: string;
      reason: string;
      occurredAt: string;
    }
  | {
      type: "local_conversation_session_created";
      sessionId: string;
      session?: LocalConversationSessionData;
      occurredAt: string;
    }
  | {
      type: "local_conversation_session_forked";
      sessionId: string;
      lineage?: LocalConversationSessionLineageData;
      occurredAt: string;
    }
  | {
      type: "local_conversation_session_closed";
      sessionId: string;
      reason?: string | null;
      session?: LocalConversationSessionData;
      occurredAt: string;
    }
  | {
      type: "local_conversation_session_head_selected";
      sessionId: string;
      activeActorKey: string;
      selection?: LocalConversationSessionSelectionData;
      session?: LocalConversationSessionData;
      occurredAt: string;
    }
  | {
      type: "local_conversation_session_actor_bound";
      sessionId: string;
      actorKey: string;
      actorId: string;
      actorName?: string | null;
      actorKind?: string | null;
      historyHeadGenerationId?: string | null;
      promptHeadGenerationId?: string | null;
      binding?: LocalConversationSessionActorBinding;
      occurredAt: string;
    }
  | {
      type: "local_conversation_session_lineage_updated";
      sessionId: string;
      parentSessionId?: string | null;
      forkedFromGenerationId?: string | null;
      rolledBackFromSessionId?: string | null;
      lineage?: LocalConversationSessionLineageData;
      occurredAt: string;
    }
  | {
      type: "local_conversation_session_active_selection_updated";
      sessionId: string;
      activeActorKey: string;
      historyHeadGenerationId?: string | null;
      promptHeadGenerationId?: string | null;
      selection?: LocalConversationSessionSelectionData;
      occurredAt: string;
    }
  | {
      type: "local_conversation_context_asset_registered";
      sessionId: string;
      assetId: string;
      asset?: LocalConversationContextAssetData;
      occurredAt: string;
    }
  | {
      type: "local_conversation_context_asset_removed";
      sessionId: string;
      assetId: string;
      session?: LocalConversationSessionData;
      occurredAt: string;
    };
