import type { ActorHistoryGenerationData } from "./ActorHistoryGeneration";
import type { ActorPromptGenerationData } from "./ActorPromptGeneration";
import type {
  LocalConversationContextAssetData,
  LocalConversationContextAssetRegistrySlot,
} from "./LocalConversationContextAsset";
import type {
  LocalConversationSessionActorBinding,
  LocalConversationSessionLineageData,
  LocalConversationSessionSelectionData,
} from "./LocalConversationSession";
import type {
  ConversationHistoryIndexSnapshot,
  ConversationPromptIndexSnapshot,
  ConversationSessionIndexSnapshot,
} from "../persistence/conversation/ConversationPersistence";

export type ConversationSessionRawState = {
  sessionId: string;
  activeActorKey?: string | null;
  actorBindings: Record<string, LocalConversationSessionActorBinding>;
  contextAssetRegistry?: LocalConversationContextAssetRegistrySlot | null;
  contextAssets?: LocalConversationContextAssetData[];
  activeSelection?: LocalConversationSessionSelectionData | null;
  lineage?: LocalConversationSessionLineageData | null;
  historyIndex: ConversationHistoryIndexSnapshot;
  promptIndex: ConversationPromptIndexSnapshot;
  sessionIndex: ConversationSessionIndexSnapshot;
};

export type ConversationActorRawState = {
  session: ConversationSessionRawState;
  actorKey: string;
  actorId: string;
  historyHeadGenerationId?: string | null;
  promptHeadGenerationId?: string | null;
  visibleGenerationIds: string[];
  visibleHistoryGenerations: ActorHistoryGenerationData[];
  activeHistoryGeneration?: ActorHistoryGenerationData | null;
  promptGeneration?: ActorPromptGenerationData | null;
  contextAssetIds: string[];
};
