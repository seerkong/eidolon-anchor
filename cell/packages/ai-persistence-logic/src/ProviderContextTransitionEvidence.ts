import { createHash } from "node:crypto";
import type {
  ConversationProviderContextTransitionEvidence,
  ConversationProviderContextTransitionGeneration,
  ConversationProviderContextTransitionHead,
  ConversationSessionIndexSnapshot,
} from "@cell/ai-organ-contract";

export function canonicalConversationJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalConversationJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map((key) => (
    `${JSON.stringify(key)}:${canonicalConversationJson(record[key])}`
  )).join(",")}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalConversationJson(value), "utf8").digest("hex")}`;
}

export function digestConversationProviderContextTransitionGeneration(
  transition: Omit<ConversationProviderContextTransitionGeneration, "transitionId">,
): `sha256:${string}` {
  return digest(transition);
}

/** Recheck inside the publication boundary; a prior absent observation may be stale. */
export function assertProviderContextTransitionSessionIdentity(
  currentSession: ConversationSessionIndexSnapshot,
  nextSession: ConversationSessionIndexSnapshot,
): void {
  if (!currentSession?.session || !currentSession.session.actorBindings
    || !nextSession?.session || !nextSession.session.actorBindings) {
    throw new Error("provider_context_transition_evidence_session_invalid");
  }
  const sessionId = nextSession.session.sessionId;
  if (currentSession.sessionId !== sessionId || currentSession.session.sessionId !== sessionId
    || nextSession.sessionId !== sessionId) {
    throw new Error("provider_context_transition_evidence_session_identity_conflict");
  }
}

export function assertProviderContextEvidenceBinding(
  binding: ConversationSessionIndexSnapshot["session"]["actorBindings"][string] | undefined,
  identity: Readonly<{ sessionId: string; actorKey: string; actorId: string }>,
): void {
  const receipt = binding?.providerEpochReceiptV2;
  if (binding?.providerEpochReceipt && receipt) throw new Error("provider_context_dual_authority_forbidden");
  if (!binding || !receipt || binding.actorKey !== identity.actorKey || binding.actorId !== identity.actorId
    || receipt.sessionId !== identity.sessionId || receipt.actorKey !== identity.actorKey || receipt.actorId !== identity.actorId) {
    throw new Error("provider_context_transition_evidence_actor_identity_conflict");
  }
  const { receiptDigest, ...facts } = receipt;
  if (receipt.schemaVersion !== "provider.epoch-receipt/v2" || digest(facts) !== receiptDigest) {
    throw new Error("provider_context_transition_evidence_receipt_digest_mismatch");
  }
}

/** Validate records, not live progress policy. In particular predecessor heads remain observable. */
export function verifyProviderContextTransitionEvidence(input: Readonly<{
  sessionIndexExists: boolean;
  sessionIndex: ConversationSessionIndexSnapshot;
  head: ConversationProviderContextTransitionHead | null;
  generation: ConversationProviderContextTransitionGeneration | null;
}>): ConversationProviderContextTransitionEvidence {
  const { sessionIndexExists, sessionIndex, head, generation } = input;
  if (!sessionIndex || !sessionIndex.session || !sessionIndex.session.actorBindings) {
    throw new Error("provider_context_transition_evidence_session_invalid");
  }
  if (!head) return { sessionIndexExists, sessionIndex, transition: null };
  if (head.schemaVersion !== "conversation.provider-context-transition-head/v1"
    || !/^sha256:[0-9a-f]{64}$/.test(head.transitionId)
    || !/^sha256:[0-9a-f]{64}$/.test(head.nextEpochReceiptDigest)) {
    throw new Error("provider_context_transition_head_invalid");
  }
  if (!generation) throw new Error("provider_context_transition_head_generation_missing");
  const { transitionId, ...facts } = generation;
  if (generation.schemaVersion !== "conversation.provider-context-transition-generation/v1"
    || digest(facts) !== transitionId) {
    throw new Error("provider_context_transition_generation_digest_mismatch");
  }
  if (transitionId !== head.transitionId || generation.nextEpochReceiptDigest !== head.nextEpochReceiptDigest) {
    throw new Error("provider_context_transition_head_generation_mismatch");
  }
  const matches = Object.entries(generation.sessionIndex.session.actorBindings).filter(([, binding]) => (
    binding.providerEpochReceiptV2?.receiptDigest === head.nextEpochReceiptDigest
  ));
  if (matches.length !== 1) throw new Error("provider_context_transition_generation_actor_ambiguous");
  const [actorKey, binding] = matches[0]!;
  const receipt = binding.providerEpochReceiptV2!;
  const { receiptDigest, ...receiptFacts } = receipt;
  if (receipt.schemaVersion !== "provider.epoch-receipt/v2" || digest(receiptFacts) !== receiptDigest) {
    throw new Error("provider_context_transition_generation_receipt_digest_mismatch");
  }
  if (binding.providerEpochReceipt) throw new Error("provider_context_dual_authority_forbidden");
  const sessionId = receipt.sessionId;
  if (sessionIndex.sessionId !== sessionId || sessionIndex.session.sessionId !== sessionId
    || generation.sessionIndex.sessionId !== sessionId || generation.sessionIndex.session.sessionId !== sessionId
    || generation.historyIndex.sessionId !== sessionId || generation.promptIndex.sessionId !== sessionId) {
    throw new Error("provider_context_transition_evidence_session_identity_conflict");
  }
  if (binding.actorKey !== actorKey || receipt.actorKey !== actorKey || binding.actorId !== receipt.actorId
  ) {
    throw new Error("provider_context_transition_evidence_actor_identity_conflict");
  }
  assertProviderContextEvidenceBinding(sessionIndex.session.actorBindings[actorKey], { sessionId, actorKey, actorId: receipt.actorId });
  return { sessionIndexExists, sessionIndex, transition: { head, generation, actorKey } };
}
