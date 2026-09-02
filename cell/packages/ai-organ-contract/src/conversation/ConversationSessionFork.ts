import type { Sha256Digest } from "./ActorProviderContextFact";

/** A semantic fork selector. Surface array indexes are deliberately absent. */
export type ConversationSessionForkSelector =
  | Readonly<{ kind: "current_head" }>
  | Readonly<{ kind: "through_committed_message"; messageId: string }>;

export type ConversationForkAuthorityHeads = Readonly<{
  historyHeadGenerationId: string;
  promptHeadGenerationId: string;
  providerEpochReceiptDigest: Sha256Digest;
}>;

export type ConversationForkPointProof = Readonly<{
  schemaVersion: "conversation.fork-point-proof/v1";
  sourceSessionId: string;
  sourceActorKey: string;
  sourceActorId: string;
  selector: ConversationSessionForkSelector;
  sourceHeads: ConversationForkAuthorityHeads;
  sourceAuthorityDigest: Sha256Digest;
  cutoffHistoryGenerationId: string;
  cutoffMessageRecordId: string | null;
  cutoffMessageId: string | null;
  cutoffMessageCount: number;
  cutoffFrontierDigest: Sha256Digest;
  promptGenerationId: string;
  promptBasisDigest: Sha256Digest;
  /** Exact fork projection or a same-session active-tail structural rebase. */
  promptProofMode?: "exact" | "active_tail_rebase";
  compactionBoundary: "current_head" | "active_tail" | "historical_generation";
  toolPairBoundaryClosed: true;
  proofDigest: Sha256Digest;
}>;

export type ConversationForkProviderEpochInitialization = Readonly<{
  schemaVersion: "conversation.fork-provider-epoch-initialization/v1";
  childSessionId: string;
  childActorKey: string;
  childActorId: string;
  parentReceiptDigest: Sha256Digest;
  childReceiptDigest: Sha256Digest;
  reason: "history_rewind_or_fork";
}>;

export type ConversationSessionForkCommand = Readonly<{
  schemaVersion: "conversation.session-fork-command/v1";
  sourceSessionId: string;
  targetSessionId: string;
  actorKey?: string | null;
  selector: ConversationSessionForkSelector;
  expectedSourceAuthorityDigest?: Sha256Digest | null;
  occurredAt: string;
}>;

export type ConversationSessionRepairCommand = Readonly<{
  schemaVersion: "conversation.session-repair-command/v1";
  sourceSessionId: string;
  targetSessionId: string;
  actorKey?: string | null;
  selector: ConversationSessionForkSelector;
  expectedSourceAuthorityDigest?: Sha256Digest | null;
  expectedTargetAuthorityDigest: Sha256Digest;
  dryRun: boolean;
  occurredAt: string;
}>;

export type ConversationRepairTailRecordMapping = Readonly<{
  sourceGenerationId: string;
  sourceRecordId: string;
  sourceMessageId: string | null;
  plannedGenerationId: string;
  plannedRecordId: string;
}>;

export type ConversationSessionRepairEvidence = Readonly<{
  schemaVersion: "conversation.session-repair-evidence/v1";
  sourceProofDigest: Sha256Digest;
  expectedTargetAuthorityDigest: Sha256Digest;
  targetHeads: ConversationForkAuthorityHeads;
  plannedHeads: ConversationForkAuthorityHeads;
  tailMapping: readonly ConversationRepairTailRecordMapping[];
  evidenceDigest: Sha256Digest;
}>;

export type ConversationSessionForkRejectionCode =
  | "SOURCE_SESSION_NOT_FOUND"
  | "SOURCE_ACTOR_NOT_FOUND"
  | "SOURCE_AUTHORITY_CHANGED"
  | "SOURCE_HISTORY_HEAD_MISSING"
  | "SOURCE_PROMPT_HEAD_MISSING"
  | "SOURCE_PROVIDER_EPOCH_MISSING"
  | "TARGET_SESSION_ALREADY_EXISTS"
  | "TARGET_AUTHORITY_CHANGED"
  | "MESSAGE_NOT_FOUND"
  | "MESSAGE_ID_AMBIGUOUS"
  | "TOOL_PAIR_BOUNDARY_OPEN"
  | "PROMPT_STATE_UNPROVABLE"
  | "CONTEXT_ASSET_UNSAFE"
  | "FORK_TRANSACTION_CONFLICT"
  | "REPAIR_TAIL_UNPROVABLE";

export type ConversationSessionForkRejection = Readonly<{
  code: ConversationSessionForkRejectionCode;
  message: string;
  facts?: Readonly<Record<string, unknown>>;
}>;

export type ConversationSessionForkReceipt = Readonly<{
  schemaVersion: "conversation.session-fork-receipt/v1";
  mode: "create" | "repair";
  sourceSessionId: string;
  targetSessionId: string;
  childActorKey: string;
  childActorId: string;
  proof: ConversationForkPointProof;
  providerEpoch: ConversationForkProviderEpochInitialization;
  transactionId: Sha256Digest;
  targetAuthorityDigest: Sha256Digest;
  preservedTargetTailMessageCount: number;
  repairEvidence?: ConversationSessionRepairEvidence;
  committedAt: string;
}>;

export type ConversationSessionForkResult =
  | Readonly<{ status: "committed"; receipt: ConversationSessionForkReceipt }>
  | Readonly<{ status: "dry_run"; receipt: ConversationSessionForkReceipt }>
  | Readonly<{ status: "rejected"; rejection: ConversationSessionForkRejection }>;

/**
 * Domain write capability consumed by local/headless surfaces. Implementations
 * own authority resolution and persistence; callers never pass rendered
 * messages, filesystem paths, repositories, clocks, locks or id generators.
 */
export interface ConversationSessionForkPort {
  fork(command: ConversationSessionForkCommand): Promise<ConversationSessionForkResult>;
  repair(command: ConversationSessionRepairCommand): Promise<ConversationSessionForkResult>;
}

export const CONVERSATION_SESSION_FORK_PORT_METHODS = ["fork", "repair"] as const;

export function isConversationSessionForkPort(value: unknown): value is ConversationSessionForkPort {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return CONVERSATION_SESSION_FORK_PORT_METHODS.every((method) => typeof candidate[method] === "function");
}
