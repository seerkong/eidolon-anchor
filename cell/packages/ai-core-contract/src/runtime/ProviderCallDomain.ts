/**
 * ProviderCallDomain — single in-memory source of truth for provider-call
 * metadata facts (track refactor-ai-turn-tool-provider-lifecycle, P5 /
 * decisions 5 & 6).
 *
 * Owns, per `provider_call_id`, the request metadata (model, params, tool
 * schema snapshot, prompt-generation ref) and the streamed response split into
 * two distinct facts — `reasoning` and `content` — rather than the implicit
 * content-parts reasoning merge. Provider failures are
 * classified by an explicit `ProviderFailureKind` enum instead of `Error:`
 * string prefixes. The provider_call_id corresponds 1:1 with the turn's
 * inflight LLM opId (WaitLlm.opId).
 */

export type ProviderCallStatus = "started" | "streaming" | "completed" | "failed";

/** Explicit provider failure classification (decision 6). */
export type ProviderFailureKind =
  | "network_error"
  | "provider_rate_limit"
  | "provider_invalid_response"
  | "aborted_by_user"
  | "timeout"
  | "prompt_too_long";

/** Hash-form snapshot of a tool schema offered to the provider (audit, not full schema). */
export type ToolSchemaSnapshot = {
  name: string;
  hash: string;
};

export type ProviderCallModelParams = {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: string;
};

export type ProviderCallSegment = {
  startAt: number;
  endAt: number;
  text: string;
};

/** A reasoning- or content-channel projection: full text + the segments it was built from. */
export type ProviderCallSegmentSet = {
  text: string;
  segments: ProviderCallSegment[];
};

export type ProviderCallRecord = {
  /** 1:1 with the turn's inflight LLM opId (WaitLlm.opId). */
  providerCallId: string;
  actorKey: string;
  turnId: number;
  modelRef: string;
  modelParams: ProviderCallModelParams;
  toolSchemas: ToolSchemaSnapshot[];
  promptGenerationRef?: string;
  startedAt: number;
  firstTokenAt?: number;
  completedAt?: number;
  /** Reasoning channel as an owned fact (decision 5), separate from content. */
  reasoning?: ProviderCallSegmentSet;
  /** Content channel as an owned fact, separate from reasoning. */
  content?: ProviderCallSegmentSet;
  /** Tool call ids produced by this provider call. */
  toolCallIds?: string[];
  failureKind?: ProviderFailureKind;
  rawError?: string;
  status: ProviderCallStatus;
};

export function isTerminalProviderCallStatus(status: ProviderCallStatus): boolean {
  return status === "completed" || status === "failed";
}

export type StartProviderCallInput = {
  providerCallId: string;
  actorKey: string;
  turnId: number;
  modelRef: string;
  modelParams: ProviderCallModelParams;
  toolSchemas: ToolSchemaSnapshot[];
  promptGenerationRef?: string;
  at: number;
};

export type AppendProviderSegmentInput = {
  providerCallId: string;
  startAt: number;
  endAt: number;
  text: string;
};

export type CompleteProviderCallInput = {
  providerCallId: string;
  completedAt: number;
  toolCallIds?: string[];
};

export type FailProviderCallInput = {
  providerCallId: string;
  failureKind: ProviderFailureKind;
  rawError?: string;
  at: number;
};

/**
 * Write commands + read views over the provider-call fact set. Implementations
 * are per-vm runtime data held at `vm.runtimeContext.providerCallDomain`.
 */
export interface ProviderCallDomain {
  // commands
  startProviderCall(input: StartProviderCallInput): ProviderCallRecord;
  recordFirstToken(input: { providerCallId: string; at: number }): ProviderCallRecord;
  appendReasoningSegment(input: AppendProviderSegmentInput): ProviderCallRecord;
  appendContentSegment(input: AppendProviderSegmentInput): ProviderCallRecord;
  completeProviderCall(input: CompleteProviderCallInput): ProviderCallRecord;
  failProviderCall(input: FailProviderCallInput): ProviderCallRecord;
  // views
  getRecord(providerCallId: string): ProviderCallRecord | undefined;
  getActiveRecords(): ProviderCallRecord[];
  getAllRecords(): ProviderCallRecord[];
}
