import type { ConversationProviderContextTransitionGeneration } from "../persistence/conversation/ConversationPersistence";
import type { ConversationForkAuthorityHeads, ConversationForkPointProof } from "./ConversationSessionFork";
import type { Sha256Digest } from "./ActorProviderContextFact";

export type ConversationSessionRewindSelector = Readonly<{
  kind: "through_committed_message";
  messageId: string;
}>;

export type ConversationSessionRewindCommand = Readonly<{
  schemaVersion: "conversation.session-rewind-command/v1";
  sessionId: string;
  actorKey?: string | null;
  selector: ConversationSessionRewindSelector;
  expectedSourceAuthorityDigest?: Sha256Digest | null;
  occurredAt: string;
}>;

export type ConversationSessionRewindRejectionCode =
  | "SESSION_NOT_FOUND"
  | "ACTOR_NOT_FOUND"
  | "SOURCE_AUTHORITY_CHANGED"
  | "SOURCE_HISTORY_HEAD_MISSING"
  | "SOURCE_PROMPT_HEAD_MISSING"
  | "SOURCE_PROVIDER_EPOCH_MISSING"
  | "MESSAGE_NOT_FOUND"
  | "MESSAGE_ID_AMBIGUOUS"
  | "TOOL_PAIR_BOUNDARY_OPEN"
  | "PROMPT_STATE_UNPROVABLE"
  | "REWIND_NO_CHANGE"
  | "REWIND_TRANSACTION_CONFLICT";

export type ConversationSessionRewindRejection = Readonly<{
  code: ConversationSessionRewindRejectionCode;
  message: string;
  facts?: Readonly<Record<string, unknown>>;
}>;

export type ConversationSessionRewindReceipt = Readonly<{
  schemaVersion: "conversation.session-rewind-receipt/v1";
  sessionId: string;
  actorKey: string;
  actorId: string;
  proof: ConversationForkPointProof;
  previousHeads: ConversationForkAuthorityHeads;
  nextHeads: ConversationForkAuthorityHeads;
  previousProviderEpochReceiptDigest: Sha256Digest;
  nextProviderEpochReceiptDigest: Sha256Digest;
  retainedMessageCount: number;
  removedMessageCount: number;
  transactionId: Sha256Digest;
  committedAt: string;
}>;

export type ConversationSessionRewindResult =
  | Readonly<{ status: "committed"; receipt: ConversationSessionRewindReceipt }>
  | Readonly<{ status: "rejected"; rejection: ConversationSessionRewindRejection }>;

export type ConversationSessionRewindPlan = Readonly<{
  transition: ConversationProviderContextTransitionGeneration;
  receipt: ConversationSessionRewindReceipt;
}>;

export type ConversationSessionRewindPlanResult =
  | Readonly<{ status: "planned"; transition: ConversationProviderContextTransitionGeneration; receipt: ConversationSessionRewindReceipt }>
  | Readonly<{ status: "rejected"; rejection: ConversationSessionRewindRejection }>;

/** Path-neutral Conversation write capability consumed by runtime surfaces. */
export interface ConversationSessionRewindPort {
  rewind(command: ConversationSessionRewindCommand): Promise<ConversationSessionRewindResult>;
}

export function isConversationSessionRewindPort(value: unknown): value is ConversationSessionRewindPort {
  return Boolean(value && typeof value === "object" && typeof (value as { rewind?: unknown }).rewind === "function");
}
