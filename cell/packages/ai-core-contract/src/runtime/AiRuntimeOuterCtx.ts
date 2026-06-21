import type { ConversationPersistenceRepositoryFactory } from "@cell/ai-organ-contract/persistence/conversation/ConversationPersistence";
import type { PersistenceWritePort } from "./PersistencePorts";

export type AiRuntimeOuterCtx = {
  metadata?: Record<string, unknown>;
  workDir?: string;
  /**
   * Explicitly-injected write-behind persistence port (P3,
   * refactor-persistent-session-backplane / `one-way-persistence-ports`).
   *
   * The live executor enqueues durable work (effect-evidence WAL append,
   * conversation-compaction persistence, snapshot writes) through this typed
   * field instead of inlining repository / journal file I/O or reading an
   * untyped factory off `metadata`. A write failure is non-fatal; when storage
   * is off this is a no-op port. Absent ⇒ memory-only profile (no durable
   * write).
   */
  persistenceWritePort?: PersistenceWritePort;
  /**
   * Explicitly-injected conversation-persistence repository factory (P3).
   *
   * Replaces the prior implicit
   * `metadata.conversationPersistenceRepositoryFactory` untyped channel. The
   * executor's compaction path resolves the repository through this typed field
   * for the index reads / generation reads whose results feed live
   * conversation-domain state (compute, not fire-and-forget durable write).
   * Absent ⇒ memory-only profile (a vm-scoped in-memory fallback is used).
   */
  conversationPersistenceRepositoryFactory?: ConversationPersistenceRepositoryFactory;
};
