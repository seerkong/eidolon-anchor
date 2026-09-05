import type { ConversationPersistenceAdapter } from "@cell/ai-core-contract";

import { LocalFileConversationPersistenceRepositoryFactory } from "./LocalFileConversationPersistenceRepository";

/**
 * local_file persistence adapter of the conversation capsule. Thin wrapper
 * over the existing local-file repository factory (no persistence logic of
 * its own). The caller selects it through an explicit runtime registry.
 * Existing runtimeSupport.persistence consumers keep using the factory directly.
 */
export const LocalFileConversationPersistenceAdapter: ConversationPersistenceAdapter = {
  createRepository: (sessionDir: string) =>
    LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir),
};
