import type { ConversationPersistenceAdapter } from "@cell/ai-core-contract";
import { registerConversationPersistenceAdapter } from "@cell/ai-organ-logic/conversationCapsule/adapterRegistry";

import { LocalFileConversationPersistenceRepositoryFactory } from "./LocalFileConversationPersistenceRepository";

/**
 * local_file persistence adapter of the conversation capsule. Thin wrapper
 * over the existing local-file repository factory (no persistence logic of
 * its own); registered by enum id at assembly-module load, the same pattern
 * as the engine file_store adapter registered by the runtime-control
 * composer. Existing consumers (runtimeSupport.persistence descriptor,
 * RuntimeSnapshots) keep using the factory directly; the adapter is the
 * parallel capsule entry.
 */
export const LocalFileConversationPersistenceAdapter: ConversationPersistenceAdapter = {
  createRepository: (sessionDir: string) =>
    LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir),
};

registerConversationPersistenceAdapter("local_file", LocalFileConversationPersistenceAdapter);
