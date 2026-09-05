import {
  CONVERSATION_PERSISTENCE_ADAPTER_IDS,
  type ConversationPersistenceAdapter,
  type ConversationPersistenceAdapterId,
} from "@cell/ai-core-contract";

/**
 * Persistence adapter registry of the conversation capsule. Adapters are
 * registered and resolved by enum id within an explicitly owned runtime.
 * Importing this module never installs an implementation or owns session state.
 */

export function createConversationPersistenceRegistry(
  entries: Iterable<readonly [ConversationPersistenceAdapterId, ConversationPersistenceAdapter]> = [],
): Map<ConversationPersistenceAdapterId, ConversationPersistenceAdapter> {
  return new Map(entries);
}

export function registerConversationPersistenceAdapter(
  adapters: Map<ConversationPersistenceAdapterId, ConversationPersistenceAdapter>,
  id: ConversationPersistenceAdapterId,
  adapter: ConversationPersistenceAdapter,
): void {
  adapters.set(id, adapter);
}

export function resolveConversationPersistenceAdapter(
  adapters: ReadonlyMap<ConversationPersistenceAdapterId, ConversationPersistenceAdapter>,
  id: ConversationPersistenceAdapterId,
): ConversationPersistenceAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    const registered = [...adapters.keys()].join(", ") || "<none>";
    throw new Error(
      `Unknown conversation persistence adapter id "${id}". `
      + `Registered adapters: [${registered}]. `
      + `Known ids: [${CONVERSATION_PERSISTENCE_ADAPTER_IDS.join(", ")}].`,
    );
  }
  return adapter;
}
