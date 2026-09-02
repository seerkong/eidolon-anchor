import type {
  LocalConversationContextAssetData,
  LocalConversationContextAssetRegistrySlot,
} from "./LocalConversationContextAsset";
import type { ActorProviderContextFactHead } from "./ActorProviderContextFact";
import type {
  ProviderContextLegacyMigrationMarker,
  ProviderEpochReceiptV2,
  ProviderRequestAdmissionReceipt,
} from "./ProviderContextEpochV2";

export type LocalConversationSessionActorBinding = {
  actorKey: string;
  actorId: string;
  actorName?: string | null;
  actorKind?: string | null;
  boundAt?: string | null;
  historyHeadGenerationId?: string | null;
  promptHeadGenerationId?: string | null;
  /** Monotonic provider-context identity; history rewinds invalidate it. */
  contextEpoch?: number;
  providerEpochReceipt?: ProviderEpochReceipt;
  /** Immutable epoch authority. The v1 receipt is legacy compatibility input only. */
  providerEpochReceiptV2?: ProviderEpochReceiptV2;
  /** One-way, CAS-bound proof that legacy v1/late-status authority was retired. */
  providerContextLegacyMigrationMarker?: ProviderContextLegacyMigrationMarker;
  /** Append-only successful final-wire admissions for the active epoch. */
  providerRequestAdmissions?: readonly ProviderRequestAdmissionReceipt[];
  providerContextFactHead?: ActorProviderContextFactHead | null;
  metadata?: Record<string, unknown>;
};

export type ProviderEpochProfileId =
  | "anthropic-chat@1"
  | "claude-code@1"
  | "deepseek-chat@1"
  /** @deprecated persisted migration input only */
  | "deepseek-compatible-chat@1"
  /** @deprecated persisted migration input only */
  | "deepseek-official-chat@1"
  | "openai-chat@1"
  | "openai-responses@1";

export type ProviderEpochReceipt = Readonly<{
  schemaVersion: "provider.epoch-receipt/v1";
  sessionId: string;
  actorKey: string;
  actorId: string;
  epoch: number;
  targetProviderId: string;
  targetProfileId: ProviderEpochProfileId;
  /** Number of non-system canonical messages captured at the epoch boundary. */
  sourceMessageCount: number;
  /** Pending tool-result pairs retained exactly in the epoch's first handoff. */
  pendingToolCallIds: readonly string[];
  sourceFrontierDigest: `sha256:${string}`;
  handoffDigest: `sha256:${string}`;
  /** Integrity digest over every identity and projection-address field above. */
  integrityDigest: `sha256:${string}`;
  reason: "initial_projection" | "model_control" | "recovery_rebuild";
  createdAt: string;
}>;

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
