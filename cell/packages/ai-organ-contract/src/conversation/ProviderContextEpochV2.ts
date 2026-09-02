import type { ProviderEpochProfileId, ProviderEpochReceipt } from "./LocalConversationSession";
import type { ActorProviderContextFactNamespace, Sha256Digest } from "./ActorProviderContextFact";

export type ProviderContextEpochTransitionReason =
  | "initial_projection"
  | "provider_model_profile_switch"
  | "history_compaction"
  | "history_rewind_or_fork"
  | "frozen_resource_revision_accepted"
  | "provider_surface_revision_accepted"
  | "legacy_context_import"
  | "recovery_rebuild";

export type ProviderContextAuthorityHeads = Readonly<{
  historyHeadGenerationId: string;
  promptHeadGenerationId: string;
  factHeadDigest: Sha256Digest | null;
}>;

export type ProviderContextRetentionPolicy = Readonly<{
  maxRevisionsPerNamespace: number;
  maxCanonicalFactBytesPerEpoch: number;
}>;

export type ProviderEpochReceiptV2 = Readonly<{
  schemaVersion: "provider.epoch-receipt/v2";
  sessionId: string;
  actorKey: string;
  actorId: string;
  epoch: number;
  previousReceiptDigest: Sha256Digest | null;
  targetProviderId: string;
  targetModelId: string;
  targetProfileId: ProviderEpochProfileId;
  baselineHeads: ProviderContextAuthorityHeads;
  /** Exact committed prefix length covered by sourceFrontierDigest. */
  sourceHistoryMessageCount: number;
  sourceFrontierDigest: Sha256Digest;
  pendingDeliveryDigest: Sha256Digest;
  handoffDigest: Sha256Digest;
  frozenResourceDigest: Sha256Digest;
  providerSurfaceDigest: Sha256Digest;
  retentionPolicy: ProviderContextRetentionPolicy;
  reason: ProviderContextEpochTransitionReason;
  compactionProofDigest: Sha256Digest | null;
  createdAt: string;
  receiptDigest: Sha256Digest;
}>;

export type ProviderRequestAdmissionReceipt = Readonly<{
  schemaVersion: "provider.request-admission-receipt/v1";
  sessionId: string;
  actorKey: string;
  actorId: string;
  epoch: number;
  epochReceiptDigest: Sha256Digest;
  previousAdmissionDigest: Sha256Digest | null;
  currentHeads: ProviderContextAuthorityHeads;
  /** Exact history prefix visible when this request was admitted. */
  historyMessageCount: number;
  /** Canonical digest of the first historyMessageCount committed records. */
  historyFrontierDigest: Sha256Digest;
  factAppendIntentDigest: Sha256Digest;
  admittedFactRange: Readonly<{
    previousHeadDigest: Sha256Digest | null;
    firstSequence: number;
    lastSequence: number;
    count: number;
    factDigests: readonly Sha256Digest[];
  }> | null;
  finalRequestDigest: Sha256Digest;
  deliveryConfirmationDigests: readonly Sha256Digest[];
  admittedAt: string;
  admissionDigest: Sha256Digest;
}>;

export type LegacyProviderContextCompactionRetainedFact = Readonly<{
  namespace: ActorProviderContextFactNamespace;
  sourceFactDigest: Sha256Digest;
  namespaceRevision: number;
  payloadDigest: Sha256Digest;
  callRecordDigest: Sha256Digest;
  resultRecordDigest: Sha256Digest;
  requestAdmissionIntentDigest: Sha256Digest;
  requestAdmissionDigest: Sha256Digest;
  successorFactDigest: Sha256Digest;
}>;

export type LegacyProviderContextCompactionProof = Readonly<{
  schemaVersion: "provider.context-compaction-proof/v1";
  sessionId: string;
  actorKey: string;
  sourceEpoch: number;
  successorEpoch: number;
  retained: readonly LegacyProviderContextCompactionRetainedFact[];
  createdAt: string;
  proofDigest: Sha256Digest;
}>;

export type ProviderContextCompactionRetainedFact = Readonly<{
  sourceNamespace: ActorProviderContextFactNamespace;
  successorNamespace: ActorProviderContextFactNamespace;
  sourceFactDigest: Sha256Digest;
  namespaceRevision: number;
  payloadDigest: Sha256Digest;
  callRecordDigest: Sha256Digest;
  resultRecordDigest: Sha256Digest;
  requestAdmissionIntentDigest: Sha256Digest;
  requestAdmissionDigest: Sha256Digest;
  successorFactDigest: Sha256Digest;
}>;

export type ProviderContextCompactionProofV2 = Readonly<{
  schemaVersion: "provider.context-compaction-proof/v2";
  sessionId: string;
  actorKey: string;
  sourceEpoch: number;
  successorEpoch: number;
  retained: readonly ProviderContextCompactionRetainedFact[];
  createdAt: string;
  proofDigest: Sha256Digest;
}>;

export type ProviderContextCompactionProof =
  | LegacyProviderContextCompactionProof
  | ProviderContextCompactionProofV2;

export type ProviderContextLegacyMigrationMarker = Readonly<{
  schemaVersion: "provider.context-legacy-migration/v1";
  sourceTreeDigest: Sha256Digest;
  sourceReceiptDigest: Sha256Digest;
  projectedFactDigest: Sha256Digest;
  targetReceiptDigest: Sha256Digest;
  mappedReason: ProviderContextEpochTransitionReason;
  status: "completed";
  markerDigest: Sha256Digest;
}>;

export type ProviderContextLegacyImportResult = Readonly<{
  legacyReceipt: ProviderEpochReceipt;
  targetReceipt: ProviderEpochReceiptV2;
  mappedReason: ProviderContextEpochTransitionReason;
  marker: ProviderContextLegacyMigrationMarker;
}>;

export type ProviderContextTransitionCommand = Readonly<{
  schemaVersion: "provider.context-transition-command/v1";
  sessionId: string;
  actorKey: string;
  actorId: string;
  expectedConversationRevision: number;
  expectedEpochReceiptDigest: Sha256Digest;
  expectedLatestAdmissionDigest: Sha256Digest | null;
  priorHeads: ProviderContextAuthorityHeads;
  nextHeads: ProviderContextAuthorityHeads;
  reason: Exclude<ProviderContextEpochTransitionReason, "recovery_rebuild">;
  nextReceipt: ProviderEpochReceiptV2;
  nextFactHead: import("./ActorProviderContextFact").ActorProviderContextFactHead | null;
  retainedFactDigests: readonly Sha256Digest[];
  appendedFactDigests: readonly Sha256Digest[];
  deliveryConfirmationDigests: readonly Sha256Digest[];
  compactionProof: ProviderContextCompactionProof | null;
  /**
   * Complete staged Conversation projection for transitions which replace a
   * history/prompt head. Provider/resource-only transitions keep this null.
   * The repository publishes these bytes as one immutable generation and the
   * Conversation Processor validates the same projection before exposing it.
   */
  generation: import("../persistence/conversation/ConversationPersistence").ConversationProviderContextTransitionGeneration | null;
  occurredAt: string;
}>;
