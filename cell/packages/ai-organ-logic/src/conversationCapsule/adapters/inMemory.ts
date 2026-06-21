import type { ConversationPersistenceAdapter } from "@cell/ai-core-contract";
import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorHistoryGenerationData,
  type ActorPromptGenerationData,
  type ConversationArtifactRefsSnapshot,
  type ConversationHistoryIndexSnapshot,
  type ConversationPersistenceRepository,
  type ConversationPromptIndexSnapshot,
  type ConversationSessionIndexSnapshot,
} from "@cell/ai-organ-contract";

import { registerConversationPersistenceAdapter } from "../adapterRegistry";

/**
 * In-memory persistence adapter of the conversation capsule (enum id
 * "in_memory"). Pure Map-backed implementation of the conversation
 * persistence repository surface: no IO, intended for tests and memory-only
 * profiles. Stores are keyed by sessionDir so repeated createRepository calls
 * against the same sessionDir observe the same data (mirrors the file-backed
 * adapter's behavior); values are deep-copied on write and read to mimic the
 * JSON round-trip of the local_file adapter.
 */

type InMemoryConversationStore = {
  historyIndex: ConversationHistoryIndexSnapshot | null;
  promptIndex: ConversationPromptIndexSnapshot | null;
  sessionIndex: ConversationSessionIndexSnapshot | null;
  artifactRefs: ConversationArtifactRefsSnapshot | null;
  historyGenerations: Map<string, ActorHistoryGenerationData>;
  promptGenerations: Map<string, ActorPromptGenerationData>;
};

function zeroIso(): string {
  return new Date(0).toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createEmptyStore(): InMemoryConversationStore {
  return {
    historyIndex: null,
    promptIndex: null,
    sessionIndex: null,
    artifactRefs: null,
    historyGenerations: new Map(),
    promptGenerations: new Map(),
  };
}

function defaultHistoryIndex(sessionId: string): ConversationHistoryIndexSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    heads: {},
    lineages: {},
    generations: {},
    updatedAt: zeroIso(),
  };
}

function defaultPromptIndex(sessionId: string): ConversationPromptIndexSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    heads: {},
    generations: {},
    updatedAt: zeroIso(),
  };
}

function defaultSessionIndex(sessionId: string): ConversationSessionIndexSnapshot {
  return {
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
      createdAt: zeroIso(),
      updatedAt: zeroIso(),
    },
    lineage: null,
    updatedAt: zeroIso(),
  };
}

function defaultArtifactRefs(sessionId: string): ConversationArtifactRefsSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    refs: [],
    updatedAt: zeroIso(),
  };
}

function createInMemoryConversationPersistenceRepository(
  sessionDir: string,
  store: InMemoryConversationStore,
): ConversationPersistenceRepository {
  return {
    async loadHistoryIndex() {
      return clone(store.historyIndex ?? defaultHistoryIndex(sessionDir));
    },
    async writeHistoryIndex(index) {
      store.historyIndex = clone(index);
    },
    async loadHistoryGeneration(generationId) {
      const generation = store.historyGenerations.get(generationId);
      return generation ? clone(generation) : null;
    },
    async writeHistoryGeneration(generation) {
      store.historyGenerations.set(generation.generationId, clone(generation));
    },
    async listHistoryGenerationIds() {
      return [...store.historyGenerations.keys()];
    },

    async loadPromptIndex() {
      return clone(store.promptIndex ?? defaultPromptIndex(sessionDir));
    },
    async writePromptIndex(index) {
      store.promptIndex = clone(index);
    },
    async loadPromptGeneration(promptGenerationId) {
      const generation = store.promptGenerations.get(promptGenerationId);
      return generation ? clone(generation) : null;
    },
    async writePromptGeneration(generation) {
      store.promptGenerations.set(generation.promptGenerationId, clone(generation));
    },
    async listPromptGenerationIds() {
      return [...store.promptGenerations.keys()];
    },

    async loadSessionIndex() {
      return clone(store.sessionIndex ?? defaultSessionIndex(sessionDir));
    },
    async writeSessionIndex(index) {
      store.sessionIndex = clone(index);
    },

    async loadArtifactRefs() {
      return clone(store.artifactRefs ?? defaultArtifactRefs(sessionDir));
    },
    async writeArtifactRefs(snapshot) {
      store.artifactRefs = clone(snapshot);
    },
  };
}

export function createInMemoryConversationPersistenceAdapter(): ConversationPersistenceAdapter {
  const storesBySessionDir = new Map<string, InMemoryConversationStore>();
  return {
    createRepository(sessionDir: string) {
      let store = storesBySessionDir.get(sessionDir);
      if (!store) {
        store = createEmptyStore();
        storesBySessionDir.set(sessionDir, store);
      }
      return createInMemoryConversationPersistenceRepository(sessionDir, store);
    },
  };
}

/**
 * Default in-memory adapter registration. The adapter is IO-free, so the
 * capsule registers it at module load; the file-backed local_file adapter is
 * registered by the assembly layer (ai-support conversation assembly).
 */
registerConversationPersistenceAdapter("in_memory", createInMemoryConversationPersistenceAdapter());
