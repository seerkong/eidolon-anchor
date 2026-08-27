import { createHash } from "node:crypto";

import type {
  ActorProviderContextFact,
  ActorProviderContextFactAppendInvocation,
  ActorProviderContextFactAppendResult,
  ActorProviderContextFactDeliveryProof,
  ActorProviderContextFactHistoryAnchor,
  ActorProviderContextFactNamespace,
  ActorProviderContextFactRuntime,
  Sha256Digest,
} from "@cell/ai-organ-contract";

export class ActorProviderContextFactError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ActorProviderContextFactError";
    this.code = code;
  }
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const NAMESPACES = new Set<ActorProviderContextFactNamespace>([
  "work-context",
  "provider-projection",
  "workflow-stage-context",
]);

export function normalizeActorProviderContextFactNamespace(value: string): ActorProviderContextFactNamespace {
  if (!NAMESPACES.has(value as ActorProviderContextFactNamespace)) {
    fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", "namespace is unsupported");
  }
  return value as ActorProviderContextFactNamespace;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: string, message: string): never {
  throw new ActorProviderContextFactError(code, message);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", `${field} must be an exact non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) < 1)) {
    fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", `${field} must be a safe ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return Number(value);
}

function digest(value: unknown, field: string): Sha256Digest {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", `${field} must be a lowercase sha256 digest`);
  }
  return value as Sha256Digest;
}

function optionalDigest(value: unknown, field: string): Sha256Digest | null {
  return value === null ? null : digest(value, field);
}

function normalizeJson(value: unknown, field: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", `${field} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") {
    fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", `${field} contains a non-JSON value`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", `${field} has a custom array prototype`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const extraKeys = Reflect.ownKeys(descriptors).filter((key) => key !== "length" && !(typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)));
    if (extraKeys.length > 0) fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", `${field} has extra array keys`);
    const normalized: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", `${field} is sparse or has an accessor`);
      normalized.push(normalizeJson(descriptor.value, `${field}[${index}]`));
    }
    return Object.freeze(normalized);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", `${field} has a custom object prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
    fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", `${field} has symbol keys`);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(descriptors).sort(codeUnitCompare)) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) {
      fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", `${field}.${key} must be enumerable own data`);
    }
    result[key] = normalizeJson(descriptor.value, `${field}.${key}`);
  }
  return Object.freeze(result);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(codeUnitCompare).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function canonicalActorProviderContextFactBytes(
  fact: ActorProviderContextFact,
): Uint8Array {
  const normalized = normalizeJson(fact, "fact") as ActorProviderContextFact;
  return new TextEncoder().encode(canonicalJson(normalized));
}

export function measureActorProviderContextFactRetention(input: Readonly<{
  facts: readonly ActorProviderContextFact[];
  maxRevisionsPerNamespace: number;
  maxCanonicalFactBytesPerEpoch: number;
}>): Readonly<{
  canonicalFactBytes: number;
  revisionCounts: Readonly<Record<ActorProviderContextFactNamespace, number>>;
  atLimit: boolean;
  overLimit: boolean;
}> {
  const maxRevisions = positiveInteger(
    input.maxRevisionsPerNamespace,
    "maxRevisionsPerNamespace",
  );
  const maxBytes = positiveInteger(
    input.maxCanonicalFactBytesPerEpoch,
    "maxCanonicalFactBytesPerEpoch",
  );
  const counts: Record<ActorProviderContextFactNamespace, number> = {
    "work-context": 0,
    "provider-projection": 0,
    "workflow-stage-context": 0,
  };
  let canonicalFactBytes = 0;
  for (const fact of input.facts) {
    counts[fact.namespace] += 1;
    canonicalFactBytes += canonicalActorProviderContextFactBytes(fact).byteLength;
  }
  const namespaceCounts = Object.values(counts);
  return Object.freeze({
    canonicalFactBytes,
    revisionCounts: Object.freeze({ ...counts }),
    atLimit: namespaceCounts.some((count) => count >= maxRevisions)
      || canonicalFactBytes >= maxBytes,
    overLimit: namespaceCounts.some((count) => count > maxRevisions)
      || canonicalFactBytes > maxBytes,
  });
}

function sha256(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function normalizeAnchor(value: ActorProviderContextFactHistoryAnchor): ActorProviderContextFactHistoryAnchor {
  const normalized = normalizeJson(value, "anchor") as Record<string, unknown>;
  const keys = Object.keys(normalized);
  if (canonicalJson(keys) !== canonicalJson(["frontierDigest", "historyGenerationId", "messageCount"])) {
    fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", "anchor has unknown or missing fields");
  }
  return Object.freeze({
    historyGenerationId: nonEmptyString(normalized.historyGenerationId, "anchor.historyGenerationId"),
    messageCount: positiveInteger(normalized.messageCount, "anchor.messageCount", true),
    frontierDigest: digest(normalized.frontierDigest, "anchor.frontierDigest"),
  });
}

function normalizeDeliveryProof(value: ActorProviderContextFactDeliveryProof): ActorProviderContextFactDeliveryProof {
  const normalized = normalizeJson(value, "sourceDeliveryProof") as Record<string, unknown>;
  if (normalized.kind === "first-delivery-pair") {
    const keys = Object.keys(normalized);
    if (canonicalJson(keys) !== canonicalJson(["callRecordDigest", "kind", "requestAdmissionIntentDigest", "resultRecordDigest", "toolCallId"])) {
      fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", "first-delivery proof has unknown or missing fields");
    }
    return Object.freeze({
      kind: "first-delivery-pair",
      toolCallId: nonEmptyString(normalized.toolCallId, "sourceDeliveryProof.toolCallId"),
      callRecordDigest: digest(normalized.callRecordDigest, "sourceDeliveryProof.callRecordDigest"),
      resultRecordDigest: digest(normalized.resultRecordDigest, "sourceDeliveryProof.resultRecordDigest"),
      requestAdmissionIntentDigest: digest(normalized.requestAdmissionIntentDigest, "sourceDeliveryProof.requestAdmissionIntentDigest"),
    });
  }
  if (normalized.kind === "compacted-delivery-proof") {
    const keys = Object.keys(normalized);
    if (canonicalJson(keys) !== canonicalJson([
      "callRecordDigest", "kind", "proofDigest", "requestAdmissionDigest",
      "requestAdmissionIntentDigest", "resultRecordDigest", "sourceFactDigest",
    ])) {
      fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", "compacted proof has unknown or missing fields");
    }
    return Object.freeze({
      kind: "compacted-delivery-proof",
      proofDigest: digest(normalized.proofDigest, "sourceDeliveryProof.proofDigest"),
      sourceFactDigest: digest(normalized.sourceFactDigest, "sourceDeliveryProof.sourceFactDigest"),
      callRecordDigest: digest(normalized.callRecordDigest, "sourceDeliveryProof.callRecordDigest"),
      resultRecordDigest: digest(normalized.resultRecordDigest, "sourceDeliveryProof.resultRecordDigest"),
      requestAdmissionIntentDigest: digest(normalized.requestAdmissionIntentDigest, "sourceDeliveryProof.requestAdmissionIntentDigest"),
      requestAdmissionDigest: digest(normalized.requestAdmissionDigest, "sourceDeliveryProof.requestAdmissionDigest"),
    });
  }
  return fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", "sourceDeliveryProof.kind is unsupported");
}

export function createActorProviderContextFact(input: Readonly<{
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
  payload: Record<string, unknown>;
  observedAt: string;
}>): ActorProviderContextFact {
  const namespace = normalizeActorProviderContextFactNamespace(input.namespace);
  const epoch = positiveInteger(input.epoch, "epoch", true);
  const namespaceRevision = positiveInteger(input.namespaceRevision, "namespaceRevision");
  const sequence = positiveInteger(input.sequence, "sequence");
  const previousFactDigest = optionalDigest(input.previousFactDigest, "previousFactDigest");
  const previousSequenceFactDigest = optionalDigest(input.previousSequenceFactDigest, "previousSequenceFactDigest");
  // A compaction successor keeps the logical namespace revision while its
  // predecessor crosses the epoch boundary. Initial revision one may
  // therefore have either no predecessor (new namespace) or an exact
  // predecessor admitted by the central compaction transition validator.
  if (namespaceRevision > 1 && previousFactDigest === null) {
    fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", "namespace predecessor is missing");
  }
  if ((sequence === 1) !== (previousSequenceFactDigest === null)) {
    fail("ACTOR_PROVIDER_CONTEXT_FACT_INVALID", "sequence predecessor does not match sequence");
  }
  const payload = normalizeJson(input.payload, "payload") as Readonly<Record<string, unknown>>;
  const payloadDigest = sha256(payload);
  const facts = Object.freeze({
    schemaVersion: "eidolon.actor-provider-context-fact/v1" as const,
    sessionId: nonEmptyString(input.sessionId, "sessionId"),
    actorKey: nonEmptyString(input.actorKey, "actorKey"),
    actorId: nonEmptyString(input.actorId, "actorId"),
    epoch,
    namespace,
    namespaceRevision,
    sequence,
    previousFactDigest,
    previousSequenceFactDigest,
    anchor: normalizeAnchor(input.anchor),
    sourceDeliveryProofs: Object.freeze(input.sourceDeliveryProofs.map(normalizeDeliveryProof)),
    payloadDigest,
    payload,
    observedAt: nonEmptyString(input.observedAt, "observedAt"),
  });
  const factDigest = sha256(facts);
  return Object.freeze({ ...facts, factDigest, factId: factDigest });
}

type ChainState = {
  revision: number;
  facts: ActorProviderContextFact[];
};

function chainKey(sessionId: string, actorKey: string, epoch: number): string {
  return `${sessionId}\u0000${actorKey}\u0000${epoch}`;
}

export function createInMemoryActorProviderContextFactRuntime(): ActorProviderContextFactRuntime {
  const chains = new Map<string, ChainState>();
  return Object.freeze({
    append(input: ActorProviderContextFactAppendInvocation): ActorProviderContextFactAppendResult {
      const fact = input.fact;
      const key = chainKey(fact.sessionId, fact.actorKey, fact.epoch);
      const current = chains.get(key) ?? { revision: 0, facts: [] };
      if (input.expectedConversationRevision !== current.revision) {
        fail("ACTOR_PROVIDER_CONTEXT_FACT_REVISION_CONFLICT", "conversation revision conflict");
      }
      const head = current.facts.at(-1) ?? null;
      if (input.expectedHeadDigest !== (head?.factDigest ?? null)
        || fact.previousSequenceFactDigest !== (head?.factDigest ?? null)
        || fact.sequence !== current.facts.length + 1) {
        fail("ACTOR_PROVIDER_CONTEXT_FACT_HEAD_CONFLICT", "actor fact head conflict");
      }
      const namespaceHead = [...current.facts].reverse().find((entry) => entry.namespace === fact.namespace) ?? null;
      if (fact.previousFactDigest !== (namespaceHead?.factDigest ?? null)
        || fact.namespaceRevision !== (namespaceHead?.namespaceRevision ?? 0) + 1) {
        fail("ACTOR_PROVIDER_CONTEXT_FACT_NAMESPACE_CONFLICT", "namespace fact head conflict");
      }
      const acceptedConversationRevision = current.revision + 1;
      chains.set(key, { revision: acceptedConversationRevision, facts: [...current.facts, fact] });
      return Object.freeze({
        acceptedConversationRevision,
        head: Object.freeze({
          schemaVersion: "eidolon.actor-provider-context-fact-head/v1",
          sessionId: fact.sessionId,
          actorKey: fact.actorKey,
          actorId: fact.actorId,
          epoch: fact.epoch,
          sequence: fact.sequence,
          factDigest: fact.factDigest,
          conversationRevision: acceptedConversationRevision,
        }),
      });
    },
    read(input: Readonly<{ sessionId: string; actorKey: string; epoch: number }>) {
      return Object.freeze([...(chains.get(chainKey(input.sessionId, input.actorKey, input.epoch))?.facts ?? [])]);
    },
  });
}

export function readActorProviderContextFacts(input: Readonly<{
  runtime: ActorProviderContextFactRuntime;
  sessionId: string;
  actorKey: string;
  epoch: number;
}>): readonly ActorProviderContextFact[] {
  return input.runtime.read(input);
}
