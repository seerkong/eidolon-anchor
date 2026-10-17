import type {
  ConversationPersistenceRepositoryFactory,
  ConversationSessionForkReceipt,
  ConversationSessionRewindReceipt,
} from "@cell/ai-organ-contract";
import { digestProviderContextClosedValue } from "./ProviderContextEpochV2";
import { projectConversationForkReceipt } from "./ConversationSessionFork";

export type ConversationCommitEvidenceEffects = Readonly<{
  repositoryFactory: ConversationPersistenceRepositoryFactory;
  resolveSessionDir: (sessionId: string) => string;
}>;

export type ConversationCommitEvidence<T> =
  | Readonly<{ status: "committed"; receipt: T }>
  | Readonly<{ status: "unproven"; reason: "unsupported" | "missing" | "different_transaction" | "different_authority" | "invalid_evidence" }>;

function validSessionId(value: string): boolean {
  return Boolean(value) && value !== "." && value !== ".." && !/[\/\\\0]/.test(value);
}

function sameClosedValue(left: unknown, right: unknown): boolean {
  return digestProviderContextClosedValue(JSON.parse(JSON.stringify(left)))
    === digestProviderContextClosedValue(JSON.parse(JSON.stringify(right)));
}

/**
 * Inspect an owner-prepared receipt, never execute a new fork. Repository read
 * recovery may finish its already-published durable journal, without a model,
 * tool, VM snapshot or an inferred success from directory existence.
 */
export async function readConversationForkCommitEvidence(
  effects: ConversationCommitEvidenceEffects,
  prepared: ConversationSessionForkReceipt,
): Promise<ConversationCommitEvidence<ConversationSessionForkReceipt>> {
  if (!validSessionId(prepared.targetSessionId) || !validSessionId(prepared.sourceSessionId)
    || !/^sha256:[0-9a-f]{64}$/.test(prepared.transactionId) || prepared.mode !== "create") {
    return { status: "unproven", reason: "invalid_evidence" };
  }
  const repository = effects.repositoryFactory.createRepository(effects.resolveSessionDir(prepared.targetSessionId));
  if (!repository.withConversationAuthorityLease || !repository.loadConversationForkHead || !repository.loadConversationForkInitializationGeneration) {
    return { status: "unproven", reason: "unsupported" };
  }
  try {
    return await repository.withConversationAuthorityLease(async () => {
      const head = await repository.loadConversationForkHead!();
      if (!head) return { status: "unproven", reason: "missing" };
      if (head.transactionId !== prepared.transactionId) return { status: "unproven", reason: "different_transaction" };
      const generation = await repository.loadConversationForkInitializationGeneration!(prepared.transactionId);
      if (!generation) return { status: "unproven", reason: "missing" };
      const receipt = projectConversationForkReceipt(generation);
      const current = await repository.loadSessionIndex();
      const binding = current.session.actorBindings[receipt.childActorKey];
      if (!sameClosedValue(receipt, prepared) || head.targetAuthorityDigest !== receipt.targetAuthorityDigest
        || head.childProviderEpochReceiptDigest !== generation.childProviderEpochReceipt.receiptDigest
        || current.sessionId !== receipt.targetSessionId || binding?.actorId !== receipt.childActorId
        || binding.providerEpochReceiptV2?.receiptDigest !== head.childProviderEpochReceiptDigest
        || binding.historyHeadGenerationId !== generation.historyIndex.heads[receipt.childActorKey]?.activeGenerationId
        || binding.promptHeadGenerationId !== generation.promptIndex.heads[receipt.childActorKey]?.activePromptGenerationId) {
        return { status: "unproven", reason: "different_authority" };
      }
      return { status: "committed", receipt };
    });
  } catch {
    return { status: "unproven", reason: "invalid_evidence" };
  }
}

/** Prepared is the trusted receipt captured by the owner's beforeCommit hook. */
export async function readConversationRewindCommitEvidence(
  effects: ConversationCommitEvidenceEffects,
  prepared: ConversationSessionRewindReceipt,
): Promise<ConversationCommitEvidence<ConversationSessionRewindReceipt>> {
  if (!validSessionId(prepared.sessionId) || !/^sha256:[0-9a-f]{64}$/.test(prepared.transactionId)) {
    return { status: "unproven", reason: "invalid_evidence" };
  }
  const repository = effects.repositoryFactory.createRepository(effects.resolveSessionDir(prepared.sessionId));
  if (!repository.loadProviderContextTransitionEvidence) return { status: "unproven", reason: "unsupported" };
  try {
    const evidence = await repository.loadProviderContextTransitionEvidence();
    if (!evidence.sessionIndexExists || !evidence.transition) return { status: "unproven", reason: "missing" };
    const { head, generation, actorKey } = evidence.transition;
    if (head.transitionId !== prepared.transactionId || generation.transitionId !== prepared.transactionId) {
      return { status: "unproven", reason: "different_transaction" };
    }
    const binding = evidence.sessionIndex.session.actorBindings[prepared.actorKey];
    const history = generation.historyGenerations.find(item => item.generationId === prepared.nextHeads.historyHeadGenerationId);
    if (actorKey !== prepared.actorKey || evidence.sessionIndex.sessionId !== prepared.sessionId
      || binding?.actorId !== prepared.actorId || prepared.proof.sourceActorId !== prepared.actorId
      || prepared.proof.sourceActorKey !== prepared.actorKey || prepared.proof.sourceSessionId !== prepared.sessionId
      || generation.expectedEpochReceiptDigest !== prepared.previousProviderEpochReceiptDigest
      || head.nextEpochReceiptDigest !== prepared.nextProviderEpochReceiptDigest
      || binding.providerEpochReceiptV2?.receiptDigest !== prepared.nextProviderEpochReceiptDigest
      || binding.historyHeadGenerationId !== prepared.nextHeads.historyHeadGenerationId
      || binding.promptHeadGenerationId !== prepared.nextHeads.promptHeadGenerationId
      || generation.createdAt !== prepared.committedAt || history?.messageCount !== prepared.retainedMessageCount
      || (history.messages.at(-1)?.message.messageId ?? history.messages.at(-1)?.recordId) !== prepared.proof.cutoffMessageId) {
      return { status: "unproven", reason: "different_authority" };
    }
    return { status: "committed", receipt: prepared };
  } catch {
    return { status: "unproven", reason: "invalid_evidence" };
  }
}
