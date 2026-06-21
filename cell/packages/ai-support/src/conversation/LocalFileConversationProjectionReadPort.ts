/**
 * LocalFileConversationProjectionReadPort — the single-source-backed
 * implementation of the read-only `ConversationProjectionReadPort` contract
 * (track isolate-runtime-projection-surfaces, P1, behavior-delta requirement
 * `conversation-projection-read-port`).
 *
 * SINGLE SOURCE, NO LOADER DUPLICATION
 * ------------------------------------
 * This impl delegates to the SAME single-source loaders the persistence
 * backplane recovery read port (`RuntimeRecoveryReadPort.loadConversationSource`
 * in @cell/ai-organ-logic) reads through:
 *
 *   - conversation facts → `loadConversationSessionRawState` /
 *     `loadConversationActorRawState` / `loadConversationHistoryMessages`
 *     (all in `./local/LocalConversationRuntime`), backed by the
 *     `LocalFileConversationPersistenceRepository` (the conversation files —
 *     the single recovery source).
 *   - pending questions → the `LocalFileRuntimeSnapshotRepository`'s
 *     `readQuestionnaires()` (the single `runtime_state/questionnaires.xnl`
 *     source), NOT a second raw `readFile` of the file.
 *
 * It does NOT copy the byte-I/O / parse logic and it does NOT introduce a second
 * source. There is exactly one repository construction, OWNED HERE so callers
 * (surfaces) no longer build their own — that is the whole point of the seam:
 * the single-source policy lives in the port, not in the surface.
 *
 * MISSING-SOURCE SEMANTICS
 * ------------------------
 * A declared-but-unloadable source is surfaced with the established loader
 * semantics: `loadHistoryProjection` and `loadActorProjection` return the
 * loader's empty/`null` result when the surface previously did `.catch(() =>
 * ...)` on a missing source, keeping P2 behavior-equivalent; the single-source
 * discipline (no mixing) lives in the underlying loaders. The pending-questions
 * read returns an empty projection when the questionnaires file is absent,
 * matching the surface's prior `.catch(() => "")` on the raw read.
 */
import type {
  ConversationActorProjection,
  ConversationHistoryProjection,
  ConversationProjectionReadPort,
  ConversationProjectionTarget,
  ConversationSessionProjection,
  ConversationSessionProjectionTarget,
  PendingQuestionsProjection,
} from "@cell/ai-core-contract/runtime/ConversationProjectionReadPort";
import {
  loadConversationActorRawState,
  loadConversationHistoryMessages,
  loadConversationSessionRawState,
} from "./local/LocalConversationRuntime";
import { LocalFileConversationPersistenceRepositoryFactory } from "./local/LocalFileConversationPersistenceRepository";
import { LocalFileRuntimeSnapshotRepositoryFactory } from "../runtime/LocalFileRuntimeSnapshotRepository";

/**
 * A `ConversationProjectionReadPort` backed by the local-file single source.
 *
 * The repository is constructed INTERNALLY per read (the same cheap
 * `createRepository(sessionDir)` the surface used to call itself), so the
 * surface no longer constructs one and there is no second source path.
 */
export function createLocalFileConversationProjectionReadPort(): ConversationProjectionReadPort {
  return {
    async loadHistoryProjection(
      target: ConversationProjectionTarget,
    ): Promise<ConversationHistoryProjection> {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(
        target.sessionDir,
      );
      const loaded = await loadConversationHistoryMessages({
        sessionDir: target.sessionDir,
        actorKey: target.actorKey,
        repository,
      });
      return {
        source: loaded.source,
        messages: loaded.messages,
        historyGenerationId: loaded.historyGenerationId ?? null,
        promptGenerationId: loaded.promptGenerationId ?? null,
      };
    },

    async loadSessionProjection(
      target: ConversationSessionProjectionTarget,
    ): Promise<ConversationSessionProjection> {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(
        target.sessionDir,
      );
      return await loadConversationSessionRawState({
        sessionDir: target.sessionDir,
        repository,
      });
    },

    async loadActorProjection(
      target: ConversationProjectionTarget,
    ): Promise<ConversationActorProjection> {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(
        target.sessionDir,
      );
      return await loadConversationActorRawState({
        sessionDir: target.sessionDir,
        actorKey: target.actorKey,
        repository,
      });
    },

    async loadPendingQuestionsProjection(
      target: ConversationSessionProjectionTarget,
    ): Promise<PendingQuestionsProjection> {
      // Single source for runtime_state pending questions: the snapshot
      // repository's questionnaires file. `readQuestionnaires()` returns [] when
      // the file is absent — the same empty-on-missing semantics the surface had
      // when it raw-read `questionnaires.xnl` with `.catch(() => "")`.
      const snapshotRepository =
        LocalFileRuntimeSnapshotRepositoryFactory.createRuntimeSnapshotRepository(
          target.sessionDir,
        );
      const rows = await snapshotRepository.readQuestionnaires();
      return {
        rows: rows.filter((row) => row.status === "pending"),
      };
    },
  };
}
