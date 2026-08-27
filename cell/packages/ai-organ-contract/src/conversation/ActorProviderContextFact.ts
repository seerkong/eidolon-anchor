export type Sha256Digest = `sha256:${string}`;

export type ActorProviderContextFactNamespace =
  | "work-context"
  | "provider-projection"
  | "workflow-stage-context";

export type ActorProviderContextFactHistoryAnchor = Readonly<{
  historyGenerationId: string;
  messageCount: number;
  frontierDigest: Sha256Digest;
}>;

export type ActorProviderContextFactDeliveryProof =
  | Readonly<{
      kind: "first-delivery-pair";
      toolCallId: string;
      callRecordDigest: Sha256Digest;
      resultRecordDigest: Sha256Digest;
      /**
       * Digest of the closed append intent created before this fact. The final
       * request-admission receipt is created after the fact chain exists and
       * binds this intent plus the exact resulting fact range, avoiding a
       * cryptographic cycle between factDigest and admissionDigest.
       */
      requestAdmissionIntentDigest: Sha256Digest;
    }>
  | Readonly<{
      kind: "compacted-delivery-proof";
      proofDigest: Sha256Digest;
      sourceFactDigest: Sha256Digest;
      callRecordDigest: Sha256Digest;
      resultRecordDigest: Sha256Digest;
      requestAdmissionIntentDigest: Sha256Digest;
      requestAdmissionDigest: Sha256Digest;
    }>;

export type ActorProviderContextFact = Readonly<{
  schemaVersion: "eidolon.actor-provider-context-fact/v1";
  sessionId: string;
  actorKey: string;
  actorId: string;
  epoch: number;
  namespace: ActorProviderContextFactNamespace;
  namespaceRevision: number;
  sequence: number;
  previousFactDigest: Sha256Digest | null;
  previousSequenceFactDigest: Sha256Digest | null;
  anchor: ActorProviderContextFactHistoryAnchor;
  sourceDeliveryProofs: readonly ActorProviderContextFactDeliveryProof[];
  payloadDigest: Sha256Digest;
  payload: Readonly<Record<string, unknown>>;
  observedAt: string;
  factDigest: Sha256Digest;
  factId: Sha256Digest;
}>;

export type ActorProviderContextFactHead = Readonly<{
  schemaVersion: "eidolon.actor-provider-context-fact-head/v1";
  sessionId: string;
  actorKey: string;
  actorId: string;
  epoch: number;
  sequence: number;
  factDigest: Sha256Digest;
  conversationRevision: number;
}>;

export type ActorProviderContextFactAppendInvocation = Readonly<{
  expectedConversationRevision: number;
  expectedHeadDigest: Sha256Digest | null;
  fact: ActorProviderContextFact;
}>;

export type ActorProviderContextFactAppendResult = Readonly<{
  acceptedConversationRevision: number;
  head: ActorProviderContextFactHead;
}>;

export interface ActorProviderContextFactRuntime {
  append(input: ActorProviderContextFactAppendInvocation): ActorProviderContextFactAppendResult;
  read(input: Readonly<{
    sessionId: string;
    actorKey: string;
    epoch: number;
  }>): readonly ActorProviderContextFact[];
}
