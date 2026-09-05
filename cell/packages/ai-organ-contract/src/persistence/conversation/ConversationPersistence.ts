import type {
  ActorHistoryGenerationData,
  ActorHistoryHeadData,
  ActorHistoryLineageData,
} from "../../conversation/ActorHistoryGeneration";
import type {
  ActorPromptGenerationData,
  ActorPromptHeadData,
} from "../../conversation/ActorPromptGeneration";
import type {
  LocalConversationSessionData,
  LocalConversationSessionLineageData,
} from "../../conversation/LocalConversationSession";
import type { ConversationArtifactRefsSnapshot } from "./ConversationArtifacts";
import type {
  ConversationForkPointProof,
  ConversationForkProviderEpochInitialization,
  ConversationSessionRepairEvidence,
} from "../../conversation/ConversationSessionFork";
import type { ProviderEpochReceiptV2 } from "../../conversation/ProviderContextEpochV2";

export const CONVERSATION_PERSISTENCE_SCHEMA_VERSION = 1;

export type ConversationHistoryGenerationManifestEntry = {
  generationId: string;
  actorKey: string;
  actorId: string;
  sealed: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConversationPromptGenerationManifestEntry = {
  promptGenerationId: string;
  actorKey: string;
  actorId: string;
  sealed: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConversationHistoryIndexSnapshot = {
  version: number;
  sessionId: string;
  heads: Record<string, ActorHistoryHeadData>;
  lineages: Record<string, ActorHistoryLineageData>;
  generations: Record<string, ConversationHistoryGenerationManifestEntry>;
  updatedAt: string;
};

export type ConversationPromptIndexSnapshot = {
  version: number;
  sessionId: string;
  heads: Record<string, ActorPromptHeadData>;
  generations: Record<string, ConversationPromptGenerationManifestEntry>;
  updatedAt: string;
};

export type ConversationSessionIndexSnapshot = {
  version: number;
  sessionId: string;
  session: LocalConversationSessionData;
  lineage?: LocalConversationSessionLineageData | null;
  updatedAt: string;
};

export type ConversationPersistenceRepository = {
  /**
   * Cross-process authority lease. Every durable Conversation writer in an
   * adapter must honor the same lease; fork holds it from source proof read
   * through target publication to close the planning/commit TOCTOU window.
   */
  withConversationAuthorityLease?: <T>(action: () => Promise<T>) => Promise<T>;
  loadHistoryIndex: () => Promise<ConversationHistoryIndexSnapshot>;
  writeHistoryIndex: (index: ConversationHistoryIndexSnapshot) => Promise<void>;
  loadHistoryGeneration: (generationId: string) => Promise<ActorHistoryGenerationData | null>;
  writeHistoryGeneration: (generation: ActorHistoryGenerationData) => Promise<void>;
  listHistoryGenerationIds: () => Promise<string[]>;

  loadPromptIndex: () => Promise<ConversationPromptIndexSnapshot>;
  writePromptIndex: (index: ConversationPromptIndexSnapshot) => Promise<void>;
  loadPromptGeneration: (promptGenerationId: string) => Promise<ActorPromptGenerationData | null>;
  writePromptGeneration: (generation: ActorPromptGenerationData) => Promise<void>;
  listPromptGenerationIds: () => Promise<string[]>;

  loadSessionIndex: () => Promise<ConversationSessionIndexSnapshot>;
  writeSessionIndex: (index: ConversationSessionIndexSnapshot) => Promise<void>;

  loadArtifactRefs: () => Promise<ConversationArtifactRefsSnapshot>;
  writeArtifactRefs: (snapshot: ConversationArtifactRefsSnapshot) => Promise<void>;

  commitConversationForkInitialization?: (
    generation: ConversationForkInitializationGeneration,
  ) => Promise<void>;
  loadConversationForkHead?: () => Promise<ConversationForkInitializationHead | null>;
  recoverConversationForkInitialization?: () => Promise<void>;
  loadConversationForkInitializationGeneration?: (
    transactionId: `sha256:${string}`,
  ) => Promise<ConversationForkInitializationGeneration | null>;

  /** Recheck Session identity at publication, before staging generation/journal writes; earlier evidence can be stale. */
  commitProviderContextTransitionGeneration?: (
    transition: ConversationProviderContextTransitionGeneration,
  ) => Promise<void>;
  loadProviderContextTransitionHead?: () => Promise<ConversationProviderContextTransitionHead | null>;
  /**
   * One consistent observation after journal recovery: current Session and its
   * latest head's immutable generation. Missing head is distinct from a missing
   * referenced generation (the latter must throw). Implementations verify the
   * reference/content/session/Actor identities, but leave current-vs-predecessor
   * receipt classification to the caller so legitimate head repair stays possible.
   */
  loadProviderContextTransitionEvidence?: () => Promise<ConversationProviderContextTransitionEvidence>;
  recoverProviderContextTransitionGeneration?: () => Promise<void>;
};

export type ConversationForkInitializationHead = Readonly<{
  schemaVersion: "conversation.fork-initialization-head/v1";
  transactionId: `sha256:${string}`;
  targetAuthorityDigest: `sha256:${string}`;
  childProviderEpochReceiptDigest: `sha256:${string}`;
}>;

/**
 * Cross-session child initialization. This is intentionally distinct from
 * ConversationProviderContextTransitionGeneration, whose predecessor is a
 * receipt in the SAME session.
 */
export type ConversationForkInitializationGeneration = Readonly<{
  schemaVersion: "conversation.fork-initialization-generation/v1";
  transactionId: `sha256:${string}`;
  mode: "create" | "repair";
  proof: ConversationForkPointProof;
  providerEpoch: ConversationForkProviderEpochInitialization;
  childProviderEpochReceipt: ProviderEpochReceiptV2;
  expectedTargetAuthorityDigest: `sha256:${string}` | null;
  expectedTargetAuthority: ConversationForkAuthoritySnapshot | null;
  targetAuthorityDigest: `sha256:${string}`;
  historyIndex: ConversationHistoryIndexSnapshot;
  promptIndex: ConversationPromptIndexSnapshot;
  sessionIndex: ConversationSessionIndexSnapshot;
  artifactRefs: ConversationArtifactRefsSnapshot;
  historyGenerations: readonly ActorHistoryGenerationData[];
  promptGenerations: readonly ActorPromptGenerationData[];
  preservedTargetTailMessageCount: number;
  repairEvidence?: ConversationSessionRepairEvidence;
  createdAt: string;
}>;

/** Closed Conversation facts used as the repair compare-and-swap input. */
export type ConversationForkAuthoritySnapshot = Readonly<{
  historyIndex: ConversationHistoryIndexSnapshot;
  promptIndex: ConversationPromptIndexSnapshot;
  sessionIndex: ConversationSessionIndexSnapshot;
  artifactRefs: ConversationArtifactRefsSnapshot;
  historyGenerations: readonly ActorHistoryGenerationData[];
  promptGenerations: readonly ActorPromptGenerationData[];
}>;

export type ConversationProviderContextTransitionHead = Readonly<{
  schemaVersion: "conversation.provider-context-transition-head/v1";
  transitionId: string;
  nextEpochReceiptDigest: string;
}>;

export type ConversationProviderContextTransitionGeneration = Readonly<{
  schemaVersion: "conversation.provider-context-transition-generation/v1";
  transitionId: string;
  expectedEpochReceiptDigest: string | null;
  nextEpochReceiptDigest: string;
  historyIndex: ConversationHistoryIndexSnapshot;
  promptIndex: ConversationPromptIndexSnapshot;
  sessionIndex: ConversationSessionIndexSnapshot;
  artifactRefs: ConversationArtifactRefsSnapshot;
  historyGenerations: readonly ActorHistoryGenerationData[];
  promptGenerations: readonly ActorPromptGenerationData[];
  createdAt: string;
}>;

export type ConversationProviderContextTransitionEvidence = Readonly<{
  /** False only when sessionIndex is a synthesized default for an absent Session. */
  sessionIndexExists: boolean;
  sessionIndex: ConversationSessionIndexSnapshot;
  transition: Readonly<{
    head: ConversationProviderContextTransitionHead;
    generation: ConversationProviderContextTransitionGeneration;
    actorKey: string;
  }> | null;
}>;

export type ConversationPersistenceRepositoryFactory = {
  createRepository: (sessionDir: string) => ConversationPersistenceRepository;
};
