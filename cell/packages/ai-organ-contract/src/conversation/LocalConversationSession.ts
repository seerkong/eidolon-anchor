import type {
  LocalConversationContextAssetData,
  LocalConversationContextAssetRegistrySlot,
} from "./LocalConversationContextAsset";

export type LocalConversationSessionActorBinding = {
  actorKey: string;
  actorId: string;
  actorName?: string | null;
  actorKind?: string | null;
  boundAt?: string | null;
  historyHeadGenerationId?: string | null;
  promptHeadGenerationId?: string | null;
  metadata?: Record<string, unknown>;
};

export type LocalConversationSessionSelectionData = {
  sessionId: string;
  activeActorKey?: string | null;
  historyHeadGenerationId?: string | null;
  promptHeadGenerationId?: string | null;
  selectedAt: string;
  metadata?: Record<string, unknown>;
};

export type LocalConversationSessionData = {
  version: number;
  sessionId: string;
  activeActorKey?: string | null;
  actorBindings: Record<string, LocalConversationSessionActorBinding>;
  contextAssetRegistry?: LocalConversationContextAssetRegistrySlot | null;
  contextAssets?: LocalConversationContextAssetData[];
  activeSelection?: LocalConversationSessionSelectionData | null;
  createdAt: string;
  updatedAt: string;
};

export type LocalConversationSessionHeadData = {
  version: number;
  sessionId: string;
  activeActorKey?: string | null;
  updatedAt: string;
};

export type LocalConversationSessionLineageData = {
  version: number;
  sessionId: string;
  parentSessionId?: string | null;
  forkedFromGenerationId?: string | null;
  rolledBackFromSessionId?: string | null;
  predecessorSessionIds: string[];
  forkSessionIds: string[];
  updatedAt: string;
};
