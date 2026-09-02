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
  providerContextTransitionHead: import("@cell/ai-organ-contract").ConversationProviderContextTransitionHead | null;
};

function transitionActorKey(transition: import("@cell/ai-organ-contract").ConversationProviderContextTransitionGeneration): string {
  const matches = Object.entries(transition.sessionIndex.session.actorBindings).filter(([, binding]) => (
    binding.providerEpochReceiptV2?.receiptDigest === transition.nextEpochReceiptDigest
  ));
  if (matches.length !== 1) throw new Error("provider_context_transition_generation_actor_ambiguous");
  return matches[0]![0];
}

function contextAssetActorKey(asset: import("@cell/ai-organ-contract").LocalConversationContextAssetData): string | null {
  return asset.providerContextFact?.actorKey
    ?? asset.providerContextFactCandidate?.actorKey
    ?? asset.projectionFact?.actorKey
    ?? asset.toolResultDeliveryFact?.actorKey
    ?? asset.messageDeliveryFact?.actorKey
    ?? null;
}

function mergeActorScopedTransition(
  store: InMemoryConversationStore,
  transition: import("@cell/ai-organ-contract").ConversationProviderContextTransitionGeneration,
  actorKey: string,
) {
  const currentHistory = store.historyIndex ?? defaultHistoryIndex(transition.historyIndex.sessionId);
  const currentPrompt = store.promptIndex ?? defaultPromptIndex(transition.promptIndex.sessionId);
  const currentSession = store.sessionIndex ?? defaultSessionIndex(transition.sessionIndex.sessionId);
  const currentArtifacts = store.artifactRefs ?? defaultArtifactRefs(transition.artifactRefs.sessionId);
  const targetHistoryEntries = Object.fromEntries(Object.entries(transition.historyIndex.generations)
    .filter(([, entry]) => entry.actorKey === actorKey));
  const targetLineages = Object.fromEntries(Object.entries(transition.historyIndex.lineages)
    .filter(([, entry]) => entry.actorKey === actorKey));
  const targetPromptEntries = Object.fromEntries(Object.entries(transition.promptIndex.generations)
    .filter(([, entry]) => entry.actorKey === actorKey));
  const nextAssets = [
    ...(currentSession.session.contextAssets ?? []).filter((asset) => contextAssetActorKey(asset) !== actorKey),
    ...(transition.sessionIndex.session.contextAssets ?? []).filter((asset) => contextAssetActorKey(asset) === actorKey),
  ];
  const touchedOwners = new Set([
    actorKey,
    ...Object.keys(targetHistoryEntries),
    ...Object.keys(targetPromptEntries),
  ]);
  const nextHistoryHead = transition.historyIndex.heads[actorKey];
  const nextPromptHead = transition.promptIndex.heads[actorKey];
  return {
    historyIndex: {
      ...currentHistory,
      heads: nextHistoryHead
        ? { ...currentHistory.heads, [actorKey]: nextHistoryHead }
        : Object.fromEntries(Object.entries(currentHistory.heads).filter(([key]) => key !== actorKey)),
      lineages: {
        ...Object.fromEntries(Object.entries(currentHistory.lineages).filter(([, entry]) => entry.actorKey !== actorKey)),
        ...targetLineages,
      },
      generations: {
        ...Object.fromEntries(Object.entries(currentHistory.generations).filter(([, entry]) => entry.actorKey !== actorKey)),
        ...targetHistoryEntries,
      },
      updatedAt: transition.historyIndex.updatedAt,
    },
    promptIndex: {
      ...currentPrompt,
      heads: nextPromptHead
        ? { ...currentPrompt.heads, [actorKey]: nextPromptHead }
        : Object.fromEntries(Object.entries(currentPrompt.heads).filter(([key]) => key !== actorKey)),
      generations: {
        ...Object.fromEntries(Object.entries(currentPrompt.generations).filter(([, entry]) => entry.actorKey !== actorKey)),
        ...targetPromptEntries,
      },
      updatedAt: transition.promptIndex.updatedAt,
    },
    sessionIndex: {
      ...currentSession,
      session: {
        ...currentSession.session,
        actorBindings: {
          ...currentSession.session.actorBindings,
          [actorKey]: transition.sessionIndex.session.actorBindings[actorKey]!,
        },
        contextAssets: nextAssets,
        contextAssetRegistry: {
          version: currentSession.version,
          assetIds: nextAssets.map((asset) => asset.assetId),
          updatedAt: transition.createdAt,
        },
        updatedAt: transition.sessionIndex.session.updatedAt,
      },
      updatedAt: transition.sessionIndex.updatedAt,
    },
    artifactRefs: {
      ...currentArtifacts,
      refs: [
        ...currentArtifacts.refs.filter((ref) => !touchedOwners.has(ref.ownerId)),
        ...transition.artifactRefs.refs.filter((ref) => touchedOwners.has(ref.ownerId)),
      ],
      updatedAt: transition.artifactRefs.updatedAt,
    },
  };
}

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
    providerContextTransitionHead: null,
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
    async commitProviderContextTransitionGeneration(transition) {
      const actorKey = transitionActorKey(transition);
      const currentBinding = store.sessionIndex?.session.actorBindings[actorKey];
      if (currentBinding?.providerEpochReceipt && currentBinding.providerEpochReceiptV2) {
        throw new Error("provider_context_dual_authority_forbidden");
      }
      const currentDigest = currentBinding?.providerEpochReceiptV2?.receiptDigest
        ?? currentBinding?.providerEpochReceipt?.integrityDigest
        ?? null;
      if (currentDigest !== transition.nextEpochReceiptDigest
        && currentDigest !== transition.expectedEpochReceiptDigest) {
        throw new Error("provider_context_transition_head_cas_conflict");
      }
      const nextBindingDigest = transition.sessionIndex.session.actorBindings[actorKey]
        ?.providerEpochReceiptV2?.receiptDigest ?? null;
      if (transition.sessionIndex.session.actorBindings[actorKey]?.providerEpochReceipt) {
        throw new Error("provider_context_transition_generation_dual_authority");
      }
      if (nextBindingDigest !== transition.nextEpochReceiptDigest) {
        throw new Error("provider_context_transition_generation_receipt_mismatch");
      }
      for (const generation of transition.historyGenerations) {
        store.historyGenerations.set(generation.generationId, clone(generation));
      }
      for (const generation of transition.promptGenerations) {
        store.promptGenerations.set(generation.promptGenerationId, clone(generation));
      }
      const merged = mergeActorScopedTransition(store, transition, actorKey);
      store.historyIndex = clone(merged.historyIndex);
      store.promptIndex = clone(merged.promptIndex);
      store.sessionIndex = clone(merged.sessionIndex);
      store.artifactRefs = clone(merged.artifactRefs);
      store.providerContextTransitionHead = {
        schemaVersion: "conversation.provider-context-transition-head/v1",
        transitionId: transition.transitionId,
        nextEpochReceiptDigest: transition.nextEpochReceiptDigest,
      };
    },
    async loadProviderContextTransitionHead() {
      return store.providerContextTransitionHead ? clone(store.providerContextTransitionHead) : null;
    },
    async recoverProviderContextTransitionGeneration() {
      // One synchronous memory assignment owns the complete generation.
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
