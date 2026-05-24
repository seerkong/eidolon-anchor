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
};

export type ConversationPersistenceRepositoryFactory = {
  createRepository: (sessionDir: string) => ConversationPersistenceRepository;
};
