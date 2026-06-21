import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import {
  createInitialHistoryProjectionState,
  reduceHistoryProjection,
  type CommittedHistoryMessageEvent,
  type HistoryProjectionState,
} from "@cell/ai-core-logic/stream/MessageHistoryGraph";

/**
 * Message assembly: pure implementation backing the capsule's
 * messageAssemblyDerivation (contract MessageAssemblyDerivation in
 * @cell/ai-core-contract). It does NOT re-implement the semantic->committed
 * merge; it reduces with the same pure core (`reduceHistoryProjection`) that
 * MessageHistoryGraph uses, so semantic->committed keeps a single commit
 * boundary (spec case message-assembly-single-commit-boundary).
 *
 * Commit boundaries follow the existing MessageHistoryGraph semantics:
 * tool_call_result / questionnaire_result / user_input / turn_start /
 * turn_end / actor switch flush the pending assistant; content and think
 * deltas only accumulate. A single boundary event may commit more than one
 * message (e.g. pending assistant + tool result), so `committed` is the
 * ordered batch for that reduction and is present only when non-empty.
 */

export function initializeMessageAssemblyState(): HistoryProjectionState {
  return createInitialHistoryProjectionState();
}

export function reduceMessageAssemblySemanticEvent(
  state: HistoryProjectionState,
  event: SemanticEvent,
): { state: HistoryProjectionState; committed?: CommittedHistoryMessageEvent[] } {
  const next = reduceHistoryProjection(state, { kind: "semantic", event });
  if (next.lastCommittedBatch.length === 0) {
    return { state: next };
  }
  return { state: next, committed: next.lastCommittedBatch };
}
