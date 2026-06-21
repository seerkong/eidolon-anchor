/**
 * RecoveryReadPort — the concrete recovery→read port implementation for the
 * persistent-session-backplane (track refactor-persistent-session-backplane,
 * P4 / decision D1, design line 12, behavior-delta `recovery-single-source-replay`).
 *
 * SINGLE SOURCE PER FACT
 * ----------------------
 * Recovery reads each fact from exactly one declared owner source:
 *   - conversation facts (history / prompt / session heads + generations) come
 *     from the conversation files, loaded through `loadConversationActorRawState`.
 *   - the snapshot's durable vm subset comes from the checkpoint snapshot.
 * There is NO silent degrade that mixes two half-fact sources for the same fact.
 *
 * HARD-FAIL ON DECLARED-BUT-UNLOADABLE
 * ------------------------------------
 * When the single declared conversation source is incomplete — a history head
 * is declared but its generation cannot be loaded — `loadConversationSource`
 * REJECTS (`conversation_recovery_source_incomplete`) rather than falling back
 * to any other source (behavior-delta `no-multi-source-mixing`).
 *
 * This module lives in ai-organ-logic (the reconstructor side of the P2 seam):
 * the pure byte-I/O loaders already live in `@cell/ai-support` /
 * `@cell/ai-persistence-logic`; this port is the runtime single-source policy
 * that routes recovery's source reads through one typed contract surface.
 */
import type {
  PersistenceConversationSourceInput,
  PersistenceReadPort,
  PersistenceRecoverSessionInput,
  PersistenceRecoverSessionResult,
} from "@cell/ai-core-contract/runtime/PersistencePorts";
import type { ConversationActorRawState } from "@cell/ai-organ-contract/conversation/ConversationRawState";
import { loadConversationActorRawState } from "@cell/ai-support";
import {
  getConversationPersistenceRepository as getConversationPersistenceRepositoryIo,
  hasRuntimeSnapshot as hasRuntimeSnapshotIo,
} from "@cell/ai-persistence-logic";

/**
 * Single recovery source (behavior-delta `no-multi-source-mixing`): the
 * conversation files are the only recovery source for an actor's conversation
 * facts. When they are incomplete — a history head is declared but its
 * generation cannot be loaded — this throws an explicit error instead of
 * silently degrading to another source.
 *
 * Exported so the recovery reconstructor (`recoverAiAgentRuntime`) and the read
 * port share ONE single-source assertion; there is no second copy that could
 * drift into a fallback.
 */
export function assertConversationRecoverySourceComplete(params: {
  actorKey: string;
  actorRawState: ConversationActorRawState | null;
}): void {
  const rawState = params.actorRawState;
  if (!rawState) return;
  if (rawState.historyHeadGenerationId && !rawState.activeHistoryGeneration) {
    throw new Error(
      [
        "conversation_recovery_source_incomplete",
        `actor ${params.actorKey} declares history head ${rawState.historyHeadGenerationId}`,
        "but the history generation could not be loaded from the conversation files.",
        "The conversation files are the single recovery source; recovery does not fall back to any other source.",
      ].join(": "),
    );
  }
}

/**
 * The runtime recovery→read port. Refines the P1 `PersistenceReadPort`
 * `loadConversationSource` result to the FULL `ConversationActorRawState` the
 * reconstructor needs (the P1 contract keeps an opaque minimal shape; this is
 * the runtime payload, the same pattern as `PersistenceWriteBehindPort extends
 * PersistenceWritePort`). `ConversationActorRawState` is a structural superset
 * of `PersistenceConversationSourceResult`, so this stays a valid refinement.
 */
export interface RuntimeRecoveryReadPort extends PersistenceReadPort {
  loadConversationSource(
    input: PersistenceConversationSourceInput,
  ): Promise<ConversationActorRawState | null>;
}

/**
 * A recovery→read port backed by the existing single-source loaders. The
 * concrete byte I/O stays in the persistence/support packages; this port is the
 * single-source POLICY surface recovery reads through (T4.2 / design line 12).
 */
export function createRecoveryReadPort(): RuntimeRecoveryReadPort {
  return {
    async recoverSession(
      input: PersistenceRecoverSessionInput,
    ): Promise<PersistenceRecoverSessionResult> {
      // The checkpoint snapshot is the single owner of the durable vm subset.
      // Presence of a snapshot manifest is the recoverability signal; the full
      // hydrate stays in `recoverAiAgentRuntime` (it reconstructs the live vm).
      const restoredFromSnapshot = await hasRuntimeSnapshotIo(input.sessionDir);
      if (!restoredFromSnapshot) return null;
      return { sessionId: input.sessionId, restoredFromSnapshot };
    },
    async loadConversationSource(
      input: PersistenceConversationSourceInput,
    ): Promise<ConversationActorRawState | null> {
      // Single source: the conversation files. No transcript / snapshot / journal
      // mixing for the same conversation fact.
      const repository = getConversationPersistenceRepositoryIo(input.sessionDir);
      if (!repository) return null;
      const actorRawState = await loadConversationActorRawState({
        sessionDir: input.sessionDir,
        actorKey: input.actorKey,
        repository,
      });
      // Declared-but-unloadable → hard fail (no degrade to a second source).
      assertConversationRecoverySourceComplete({
        actorKey: input.actorKey,
        actorRawState,
      });
      return actorRawState;
    },
  };
}
