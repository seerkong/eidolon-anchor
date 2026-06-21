import {
  CONVERSATION_PERSISTENCE_ADAPTER_IDS,
  type ConversationPersistenceAdapter,
  type ConversationPersistenceAdapterId,
} from "@cell/ai-core-contract";

/**
 * Persistence adapter registry of the conversation capsule. Adapters are
 * registered and resolved by enum id (same pattern as the engine file_store
 * adapter); the composition layer wires concrete implementations in T2.3.
 */

const conversationPersistenceAdapters = new Map<
  ConversationPersistenceAdapterId,
  ConversationPersistenceAdapter
>();

export function registerConversationPersistenceAdapter(
  id: ConversationPersistenceAdapterId,
  adapter: ConversationPersistenceAdapter,
): void {
  conversationPersistenceAdapters.set(id, adapter);
}

export function resolveConversationPersistenceAdapter(
  id: ConversationPersistenceAdapterId,
): ConversationPersistenceAdapter {
  const adapter = conversationPersistenceAdapters.get(id);
  if (!adapter) {
    const registered = [...conversationPersistenceAdapters.keys()].join(", ") || "<none>";
    throw new Error(
      `Unknown conversation persistence adapter id "${id}". `
      + `Registered adapters: [${registered}]. `
      + `Known ids: [${CONVERSATION_PERSISTENCE_ADAPTER_IDS.join(", ")}].`,
    );
  }
  return adapter;
}
