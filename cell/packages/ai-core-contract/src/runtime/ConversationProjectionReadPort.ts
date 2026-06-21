/**
 * ConversationProjectionReadPort — the typed, READ-ONLY projection-read port
 * runtime surfaces use to hydrate (rebuild visible conversation state) from the
 * single source of truth (track isolate-runtime-projection-surfaces, P1,
 * behavior-delta requirement `conversation-projection-read-port`).
 *
 * WHY THIS EXISTS
 * ---------------
 * Surfaces (TUI hydration, pending-questions, etc.) MUST NOT self-build a
 * conversation/persistence repository and read the single source directly, nor
 * copy the single-source loader logic, nor read raw runtime_state files. Doing
 * so bypasses the backplane's single-source / missing-source discipline and is
 * how the original TUI-vs-CLI divergence crept in. This port is the one typed
 * read surface a projection consumes; its implementation OWNS the repository
 * construction and delegates to the SAME single-source loaders the backplane
 * recovery read port uses (no second source, no loader duplication).
 *
 * READ-ONLY INVARIANT (behavior-delta `read-port-is-readonly`)
 * -----------------------------------------------------------
 * This contract surface exposes ONLY read views — `load*Projection` methods that
 * return read-only view types. It exposes NO method to write, mutate, compact,
 * delete, or otherwise destroy domain truth. The returned view types are
 * `readonly` so a consumer cannot reach back through them to mutate the source.
 *
 * SINGLE SOURCE (behavior-delta `tui-hydration-through-port`)
 * ----------------------------------------------------------
 * The implementation reads each fact from exactly one declared owner source (the
 * conversation files for conversation facts; the runtime_state questionnaires
 * file for pending questions). A declared-but-unloadable source is surfaced with
 * the established single-source semantics (hard-fail / empty per the underlying
 * loader), NOT a silent degrade that mixes sources. The single-source POLICY
 * lives in this port, so surfaces stay behavior-equivalent without owning it.
 */
import type { ChatMessage } from "@shared/composer";
import type {
  ConversationActorRawState,
  ConversationSessionRawState,
} from "@cell/ai-organ-contract/conversation/ConversationRawState";
import type { QuestionnaireRow } from "./Questionnaire";

/**
 * Read-only view of an actor's visible conversation history (the materialized
 * messages the surface renders). Mirrors `loadConversationHistoryMessages`'
 * `LoadedConversationMessages` semantics — `source` distinguishes a real
 * conversation read from an empty / absent source.
 */
export type ConversationHistoryProjection = {
  readonly source: "conversation" | "empty";
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly historyGenerationId?: string | null;
  readonly promptGenerationId?: string | null;
};

/**
 * Read-only view of a session's raw state (active actor, actor bindings, the
 * index snapshots). Structurally the `ConversationSessionRawState` the
 * single-source `loadConversationSessionRawState` loader returns, exposed
 * read-only so the surface cannot mutate it back onto the source.
 */
export type ConversationSessionProjection = Readonly<ConversationSessionRawState>;

/**
 * Read-only view of one actor's raw conversation state (visible generations,
 * head ids, prompt/history generations). Structurally the
 * `ConversationActorRawState` the single-source `loadConversationActorRawState`
 * loader returns; `null` means the actor has no persisted conversation state.
 */
export type ConversationActorProjection = Readonly<ConversationActorRawState> | null;

/**
 * Read-only view of the pending questionnaires for a session. Each row is the
 * typed `QuestionnaireRow`; the projection only ever exposes the `pending`
 * subset so the surface never re-reads / re-filters the raw `questionnaires.xnl`
 * file (behavior-delta `pending-questions-through-port`).
 */
export type PendingQuestionsProjection = {
  readonly rows: ReadonlyArray<QuestionnaireRow>;
};

/** Identify the conversation source for one session + actor. */
export type ConversationProjectionTarget = {
  readonly sessionDir: string;
  readonly actorKey: string;
};

/** Identify a session-level read (no actor needed). */
export type ConversationSessionProjectionTarget = {
  readonly sessionDir: string;
};

/**
 * Typed, READ-ONLY projection-read port. The single surface a runtime
 * projection consumes to hydrate visible conversation state from the single
 * source of truth.
 *
 * Every method is a `load*Projection` read returning a read-only view. There is
 * NO write/mutate/compact/delete/destroy method on this contract — that is the
 * `read-port-is-readonly` invariant, asserted structurally by the conformance
 * tests.
 */
export interface ConversationProjectionReadPort {
  /**
   * Load the visible history projection for one actor (the materialized
   * messages a surface renders). Single source: the conversation files.
   */
  loadHistoryProjection(
    target: ConversationProjectionTarget,
  ): Promise<ConversationHistoryProjection>;

  /**
   * Load the session raw-state projection (active actor / bindings / index
   * snapshots). Single source: the conversation files.
   */
  loadSessionProjection(
    target: ConversationSessionProjectionTarget,
  ): Promise<ConversationSessionProjection>;

  /**
   * Load one actor's raw-state projection. `null` when the actor has no
   * persisted conversation state. Single source: the conversation files.
   */
  loadActorProjection(
    target: ConversationProjectionTarget,
  ): Promise<ConversationActorProjection>;

  /**
   * Load the pending-questions projection for a session (typed, never the raw
   * `questionnaires.xnl` bytes). Single source: the runtime_state questionnaires
   * file.
   */
  loadPendingQuestionsProjection(
    target: ConversationSessionProjectionTarget,
  ): Promise<PendingQuestionsProjection>;
}

/**
 * The method names a value must expose to be a {@link ConversationProjectionReadPort}.
 * All are read views — there is intentionally no write/mutate/destroy member.
 */
export const CONVERSATION_PROJECTION_READ_PORT_METHODS = [
  "loadHistoryProjection",
  "loadSessionProjection",
  "loadActorProjection",
  "loadPendingQuestionsProjection",
] as const;

/**
 * Method-name prefixes / verbs a read-only port MUST NOT expose. Used by the
 * conformance test to assert no write/mutate/destroy capability leaked onto the
 * contract surface (behavior-delta `read-port-is-readonly`).
 */
export const CONVERSATION_PROJECTION_MUTATION_VERBS = [
  "write",
  "save",
  "store",
  "persist",
  "delete",
  "remove",
  "destroy",
  "mutate",
  "update",
  "apply",
  "compact",
  "commit",
  "set",
  "clear",
  "rm",
] as const;

/** Structural guard: every declared read-view method is present and callable. */
export function isConversationProjectionReadPort(
  value: unknown,
): value is ConversationProjectionReadPort {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return CONVERSATION_PROJECTION_READ_PORT_METHODS.every(
    (method) => typeof candidate[method] === "function",
  );
}
