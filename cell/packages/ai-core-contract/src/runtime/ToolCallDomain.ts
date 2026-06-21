/**
 * ToolCallDomain — single in-memory source of truth for tool-call lifecycle
 * facts (track refactor-ai-turn-tool-provider-lifecycle, P4 / decision D3).
 *
 * Owns, per `tool_call_id`, the full tool-call fact set: args, gate outcome,
 * lifecycle status, output text and failure classification. The LLM
 * `tool_call_id` is treated as the transparent unique pairing key (decision
 * D3) — no hash derivation, no array-index coupling.
 *
 * Consequences enforced here:
 *  - A `tool_call_id` is planned exactly once; a duplicate plan is rejected.
 *    This is the data-layer root-cause defense that replaced the retired
 *    "same tool consumed twice" turn-guardrail heuristic.
 *  - A terminal record (denied / completed / failed) cannot be re-resulted.
 *  - runtime-control effect evidence is demoted to audit / link-only (no full
 *    outputText / args); session recovery rebuilds tool results from this
 *    domain rather than from evidence payloads.
 */

export type ToolCallStatus =
  | "planned"
  | "dispatched"
  | "denied"
  | "deferred"
  | "executing"
  | "completed"
  | "failed";

export type ToolGateOutcome = "allow" | "deny" | "defer";

/**
 * Tool execution failure classification (the tool-side sibling of the
 * provider failureKind from decision 6). Replaces `Error: ...` string
 * prefix sniffing with an explicit enum.
 */
export type ToolFailureKind = "tool_error" | "aborted" | "timeout" | "exception";

export type ToolCallRecord = {
  /** LLM-transparent unique id; the sole pairing key. */
  toolCallId: string;
  actorKey: string;
  turnId: number;
  funcName: string;
  args: unknown;
  plannedAt: number;
  dispatchedAt?: number;
  gateOutcome?: ToolGateOutcome;
  /** Stamped only on the allow path when the tool actually begins executing. */
  executedAt?: number;
  resultAt?: number;
  outputText?: string;
  failureKind?: ToolFailureKind;
  status: ToolCallStatus;
};

/** A terminal status admits no further lifecycle transitions. */
export function isTerminalToolCallStatus(status: ToolCallStatus): boolean {
  return status === "denied" || status === "completed" || status === "failed";
}

export type PlanToolInput = {
  toolCallId: string;
  actorKey: string;
  turnId: number;
  funcName: string;
  args: unknown;
  at: number;
};

export type RecordGateDecisionInput = {
  toolCallId: string;
  gateOutcome: ToolGateOutcome;
  at: number;
};

export type MarkExecutingInput = {
  toolCallId: string;
  at: number;
};

export type RecordResultInput = {
  toolCallId: string;
  outputText: string;
  at: number;
};

export type RecordFailureInput = {
  toolCallId: string;
  failureKind: ToolFailureKind;
  outputText?: string;
  at: number;
};

/**
 * Write commands + read views over the tool-call fact set. Implementations
 * are per-vm runtime data held at `vm.runtimeContext.toolCallDomain`.
 */
export interface ToolCallDomain {
  // commands (write entries)
  planTool(input: PlanToolInput): ToolCallRecord;
  recordGateDecision(input: RecordGateDecisionInput): ToolCallRecord;
  markExecuting(input: MarkExecutingInput): ToolCallRecord;
  recordResult(input: RecordResultInput): ToolCallRecord;
  recordFailure(input: RecordFailureInput): ToolCallRecord;
  // views (read)
  getRecord(toolCallId: string): ToolCallRecord | undefined;
  getActiveRecords(): ToolCallRecord[];
  getAllRecords(): ToolCallRecord[];
}

/** Reconstructed tool-result shape used by the session recovery path. */
export type ReconstructedToolResult = {
  toolCallId: string;
  funcName: string;
  outputText: string;
  isError: boolean;
};
