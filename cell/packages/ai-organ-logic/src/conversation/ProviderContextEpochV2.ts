import { createHash } from "node:crypto";

import type {
  ProviderContextCompactionProof,
  ProviderContextCompactionRetainedFact,
  ProviderContextCompactionProofV2,
  LegacyProviderContextCompactionProof,
  LegacyProviderContextCompactionRetainedFact,
  ProviderContextEpochTransitionReason,
  ProviderContextLegacyImportResult,
  ProviderContextLegacyMigrationMarker,
  ProviderContextRetentionPolicy,
  ProviderEpochReceipt,
  ProviderEpochReceiptV2,
  ProviderRequestAdmissionReceipt,
  Sha256Digest,
} from "@cell/ai-organ-contract";
import { computeProviderEpochReceiptIntegrityDigest } from "./ProviderEpochProjection";
import {
  canonicalActorProviderContextFactSuccessorNamespace,
  normalizeActorProviderContextFactNamespace,
} from "./ActorProviderContextFact";

export class ProviderContextEpochError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderContextEpochError";
    this.code = code;
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function fail(code: string, message: string): never {
  throw new ProviderContextEpochError(code, message);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneClosed(value: unknown, field = "value"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("PROVIDER_CONTEXT_EPOCH_INVALID", `${field} has a non-finite number`);
    return value;
  }
  if (typeof value !== "object") fail("PROVIDER_CONTEXT_EPOCH_INVALID", `${field} is not closed JSON`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
    fail("PROVIDER_CONTEXT_EPOCH_INVALID", `${field} has symbol keys`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail("PROVIDER_CONTEXT_EPOCH_INVALID", `${field} has custom prototype`);
    const next: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) fail("PROVIDER_CONTEXT_EPOCH_INVALID", `${field} is sparse or accessor-backed`);
      next.push(cloneClosed(descriptor.value, `${field}[${index}]`));
    }
    const extra = Reflect.ownKeys(descriptors).filter((key) => key !== "length" && !(typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)));
    if (extra.length) fail("PROVIDER_CONTEXT_EPOCH_INVALID", `${field} has extra array keys`);
    return Object.freeze(next);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("PROVIDER_CONTEXT_EPOCH_INVALID", `${field} has custom prototype`);
  const next: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(descriptors).sort(codeUnitCompare)) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) fail("PROVIDER_CONTEXT_EPOCH_INVALID", `${field}.${key} is not enumerable own data`);
    next[key] = cloneClosed(descriptor.value, `${field}.${key}`);
  }
  return Object.freeze(next);
}

export function assertProviderContextClosedValue(value: unknown, field = "value"): void {
  cloneClosed(value, field);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(codeUnitCompare).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function sha(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

export function digestProviderContextClosedValue(value: unknown): Sha256Digest {
  return sha(cloneClosed(value, "digestValue"));
}

/**
 * Exact digest of the persisted history-message value. Persistence codecs may
 * reconstruct object properties in a different insertion order, so the
 * frontier uses the same code-unit-sorted closed JSON encoding as the other
 * ProviderContext receipts. Arrays remain order-sensitive and every scalar
 * byte remains exact.
 */
export function digestProviderContextHistoryFrontier(messages: unknown): Sha256Digest {
  const persisted = JSON.parse(JSON.stringify(messages ?? []));
  return sha(persisted);
}

/**
 * Require an exact persisted-byte history prefix, independent of generation
 * identity or lineage metadata. Callers select the domain-specific error code
 * but share this one byte-authority comparison at validation and admission.
 */
export function assertExactProviderContextHistoryPrefix(input: Readonly<{
  messages: readonly unknown[];
  messageCount: number;
  frontierDigest: Sha256Digest;
  mismatchCode: string;
}>): void {
  if (!Number.isSafeInteger(input.messageCount)
    || input.messageCount < 0
    || input.messageCount > input.messages.length
    || digestProviderContextHistoryFrontier(
      input.messages.slice(0, input.messageCount),
    ) !== input.frontierDigest) {
    throw new Error(input.mismatchCode);
  }
}

function exactDigest(value: unknown, field: string): Sha256Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("PROVIDER_CONTEXT_EPOCH_INVALID", `${field} is not sha256`);
  return value as Sha256Digest;
}

function nullableDigest(value: unknown, field: string): Sha256Digest | null {
  return value === null ? null : exactDigest(value, field);
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) fail("PROVIDER_CONTEXT_EPOCH_INVALID", `${field} is not exact non-empty text`);
  return value;
}

function integer(value: unknown, field: string, zero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1)) fail("PROVIDER_CONTEXT_EPOCH_INVALID", `${field} is not a safe integer`);
  return Number(value);
}

function retention(value: ProviderContextRetentionPolicy): ProviderContextRetentionPolicy {
  return Object.freeze({
    maxRevisionsPerNamespace: integer(value.maxRevisionsPerNamespace, "retention.maxRevisionsPerNamespace"),
    maxCanonicalFactBytesPerEpoch: integer(value.maxCanonicalFactBytesPerEpoch, "retention.maxCanonicalFactBytesPerEpoch"),
  });
}

function heads(value: ProviderEpochReceiptV2["baselineHeads"]): ProviderEpochReceiptV2["baselineHeads"] {
  return Object.freeze({
    historyHeadGenerationId: string(value.historyHeadGenerationId, "heads.historyHeadGenerationId"),
    promptHeadGenerationId: string(value.promptHeadGenerationId, "heads.promptHeadGenerationId"),
    factHeadDigest: nullableDigest(value.factHeadDigest, "heads.factHeadDigest"),
  });
}

const REASONS = new Set<ProviderContextEpochTransitionReason>([
  "initial_projection", "provider_model_profile_switch", "history_compaction", "history_rewind_or_fork",
  "frozen_resource_revision_accepted", "provider_surface_revision_accepted", "legacy_context_import", "recovery_rebuild",
]);

export function createProviderEpochReceiptV2(input: Omit<ProviderEpochReceiptV2, "schemaVersion" | "receiptDigest">): ProviderEpochReceiptV2 {
  cloneClosed(input, "receipt");
  if (!REASONS.has(input.reason)) fail("PROVIDER_CONTEXT_EPOCH_INVALID", "reason is unsupported");
  if ((input.reason === "history_compaction") !== (input.compactionProofDigest !== null)) {
    fail("PROVIDER_CONTEXT_EPOCH_INVALID", "compaction proof must exist exactly for history_compaction");
  }
  const facts = Object.freeze({
    schemaVersion: "provider.epoch-receipt/v2" as const,
    sessionId: string(input.sessionId, "sessionId"), actorKey: string(input.actorKey, "actorKey"), actorId: string(input.actorId, "actorId"),
    epoch: integer(input.epoch, "epoch", true), previousReceiptDigest: nullableDigest(input.previousReceiptDigest, "previousReceiptDigest"),
    targetProviderId: string(input.targetProviderId, "targetProviderId"), targetModelId: string(input.targetModelId, "targetModelId"),
    targetProfileId: input.targetProfileId, baselineHeads: heads(input.baselineHeads),
    sourceHistoryMessageCount: integer(input.sourceHistoryMessageCount, "sourceHistoryMessageCount", true),
    sourceFrontierDigest: exactDigest(input.sourceFrontierDigest, "sourceFrontierDigest"),
    pendingDeliveryDigest: exactDigest(input.pendingDeliveryDigest, "pendingDeliveryDigest"), handoffDigest: exactDigest(input.handoffDigest, "handoffDigest"),
    frozenResourceDigest: exactDigest(input.frozenResourceDigest, "frozenResourceDigest"), providerSurfaceDigest: exactDigest(input.providerSurfaceDigest, "providerSurfaceDigest"),
    retentionPolicy: retention(input.retentionPolicy), reason: input.reason,
    compactionProofDigest: nullableDigest(input.compactionProofDigest, "compactionProofDigest"), createdAt: string(input.createdAt, "createdAt"),
  });
  const receiptDigest = sha(facts);
  return Object.freeze({ ...facts, receiptDigest });
}

export function createProviderRequestAdmissionReceipt(input: Omit<ProviderRequestAdmissionReceipt, "schemaVersion" | "admissionDigest">): ProviderRequestAdmissionReceipt {
  cloneClosed(input, "admission");
  const admittedFactRange = input.admittedFactRange === null ? null : Object.freeze({
    previousHeadDigest: nullableDigest(input.admittedFactRange.previousHeadDigest, "admittedFactRange.previousHeadDigest"),
    firstSequence: integer(input.admittedFactRange.firstSequence, "admittedFactRange.firstSequence"),
    lastSequence: integer(input.admittedFactRange.lastSequence, "admittedFactRange.lastSequence"),
    count: integer(input.admittedFactRange.count, "admittedFactRange.count"),
    factDigests: Object.freeze(input.admittedFactRange.factDigests.map((value, index) => exactDigest(value, `admittedFactRange.factDigests[${index}]`))),
  });
  if (admittedFactRange && (
    admittedFactRange.lastSequence < admittedFactRange.firstSequence
    || admittedFactRange.count !== admittedFactRange.lastSequence - admittedFactRange.firstSequence + 1
    || admittedFactRange.factDigests.length !== admittedFactRange.count
  )) fail("PROVIDER_CONTEXT_EPOCH_INVALID", "admitted fact range is not exact");
  const facts = Object.freeze({
    schemaVersion: "provider.request-admission-receipt/v1" as const,
    sessionId: string(input.sessionId, "sessionId"), actorKey: string(input.actorKey, "actorKey"), actorId: string(input.actorId, "actorId"),
    epoch: integer(input.epoch, "epoch", true), epochReceiptDigest: exactDigest(input.epochReceiptDigest, "epochReceiptDigest"),
    previousAdmissionDigest: nullableDigest(input.previousAdmissionDigest, "previousAdmissionDigest"), currentHeads: heads(input.currentHeads),
    historyMessageCount: integer(input.historyMessageCount, "historyMessageCount", true),
    historyFrontierDigest: exactDigest(input.historyFrontierDigest, "historyFrontierDigest"),
    factAppendIntentDigest: exactDigest(input.factAppendIntentDigest, "factAppendIntentDigest"), admittedFactRange,
    finalRequestDigest: exactDigest(input.finalRequestDigest, "finalRequestDigest"),
    deliveryConfirmationDigests: Object.freeze(input.deliveryConfirmationDigests.map((value, index) => exactDigest(value, `deliveryConfirmationDigests[${index}]`))),
    admittedAt: string(input.admittedAt, "admittedAt"),
  });
  return Object.freeze({ ...facts, admissionDigest: sha(facts) });
}

export function createProviderContextCompactionProof(
  input: Omit<ProviderContextCompactionProofV2, "schemaVersion" | "proofDigest">,
): ProviderContextCompactionProofV2 {
  cloneClosed(input, "compactionProof");
  if (integer(input.successorEpoch, "successorEpoch", true) !== integer(input.sourceEpoch, "sourceEpoch", true) + 1) {
    fail("PROVIDER_CONTEXT_EPOCH_INVALID", "successor epoch must be source epoch plus one");
  }
  const retained = input.retained.map((entry): ProviderContextCompactionRetainedFact => {
    const sourceNamespace = normalizeActorProviderContextFactNamespace(entry.sourceNamespace);
    const successorNamespace = normalizeActorProviderContextFactNamespace(entry.successorNamespace);
    const expectedSuccessorNamespace = canonicalActorProviderContextFactSuccessorNamespace(sourceNamespace);
    if (expectedSuccessorNamespace === null || successorNamespace !== expectedSuccessorNamespace) {
      fail("PROVIDER_CONTEXT_EPOCH_INVALID", "retained namespace successor is not canonical");
    }
    return Object.freeze({
      sourceNamespace,
      successorNamespace,
      sourceFactDigest: exactDigest(entry.sourceFactDigest, "retained.sourceFactDigest"), namespaceRevision: integer(entry.namespaceRevision, "retained.namespaceRevision"),
      payloadDigest: exactDigest(entry.payloadDigest, "retained.payloadDigest"), callRecordDigest: exactDigest(entry.callRecordDigest, "retained.callRecordDigest"),
      resultRecordDigest: exactDigest(entry.resultRecordDigest, "retained.resultRecordDigest"),
      requestAdmissionIntentDigest: exactDigest(entry.requestAdmissionIntentDigest, "retained.requestAdmissionIntentDigest"),
      requestAdmissionDigest: exactDigest(entry.requestAdmissionDigest, "retained.requestAdmissionDigest"),
      successorFactDigest: exactDigest(entry.successorFactDigest, "retained.successorFactDigest"),
    });
  }).sort((left, right) => codeUnitCompare(left.successorNamespace, right.successorNamespace));
  const facts = Object.freeze({
    schemaVersion: "provider.context-compaction-proof/v2" as const,
    sessionId: string(input.sessionId, "sessionId"), actorKey: string(input.actorKey, "actorKey"),
    sourceEpoch: input.sourceEpoch, successorEpoch: input.successorEpoch, retained: Object.freeze(retained), createdAt: string(input.createdAt, "createdAt"),
  });
  // The successor fact carries this proof digest while the proof also records
  // that successor fact's digest. Hashing both fields would be a circular
  // fixed-point requirement. The durable authority is therefore deliberately
  // combined: proofDigest binds every retained source/provenance field, while
  // the transition receipt's baseline fact head binds the successor chain;
  // commitProviderContextTransition cross-validates each recorded successor.
  const digestFacts = {
    ...facts,
    retained: facts.retained.map(({ successorFactDigest: _successorFactDigest, ...entry }) => entry),
  };
  return Object.freeze({ ...facts, proofDigest: sha(digestFacts) });
}

export function createLegacyProviderContextCompactionProof(
  input: Omit<LegacyProviderContextCompactionProof, "schemaVersion" | "proofDigest">,
): LegacyProviderContextCompactionProof {
  cloneClosed(input, "compactionProof");
  if (integer(input.successorEpoch, "successorEpoch", true) !== integer(input.sourceEpoch, "sourceEpoch", true) + 1) {
    fail("PROVIDER_CONTEXT_EPOCH_INVALID", "successor epoch must be source epoch plus one");
  }
  const retained = input.retained.map((entry): LegacyProviderContextCompactionRetainedFact => Object.freeze({
    namespace: normalizeActorProviderContextFactNamespace(entry.namespace),
    sourceFactDigest: exactDigest(entry.sourceFactDigest, "retained.sourceFactDigest"),
    namespaceRevision: integer(entry.namespaceRevision, "retained.namespaceRevision"),
    payloadDigest: exactDigest(entry.payloadDigest, "retained.payloadDigest"),
    callRecordDigest: exactDigest(entry.callRecordDigest, "retained.callRecordDigest"),
    resultRecordDigest: exactDigest(entry.resultRecordDigest, "retained.resultRecordDigest"),
    requestAdmissionIntentDigest: exactDigest(entry.requestAdmissionIntentDigest, "retained.requestAdmissionIntentDigest"),
    requestAdmissionDigest: exactDigest(entry.requestAdmissionDigest, "retained.requestAdmissionDigest"),
    successorFactDigest: exactDigest(entry.successorFactDigest, "retained.successorFactDigest"),
  })).sort((left, right) => codeUnitCompare(left.namespace, right.namespace));
  const facts = Object.freeze({
    schemaVersion: "provider.context-compaction-proof/v1" as const,
    sessionId: string(input.sessionId, "sessionId"),
    actorKey: string(input.actorKey, "actorKey"),
    sourceEpoch: input.sourceEpoch,
    successorEpoch: input.successorEpoch,
    retained: Object.freeze(retained),
    createdAt: string(input.createdAt, "createdAt"),
  });
  const digestFacts = {
    ...facts,
    retained: facts.retained.map(({ successorFactDigest: _successorFactDigest, ...entry }) => entry),
  };
  return Object.freeze({ ...facts, proofDigest: sha(digestFacts) });
}

export function normalizeProviderContextCompactionProof(
  input: ProviderContextCompactionProof,
): ProviderContextCompactionProof {
  if (input.schemaVersion === "provider.context-compaction-proof/v1") {
    const { schemaVersion: _schemaVersion, proofDigest: _proofDigest, ...facts } = input;
    return createLegacyProviderContextCompactionProof(facts);
  }
  const { schemaVersion: _schemaVersion, proofDigest: _proofDigest, ...facts } = input;
  return createProviderContextCompactionProof(facts);
}

function exactKeys(value: object, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const sortedExpected = [...expected].sort(codeUnitCompare);
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    fail("PROVIDER_CONTEXT_LEGACY_SHAPE_INVALID", `${field} fields are not exact`);
  }
}

function assertExactLegacyProviderEpochReceipt(receipt: ProviderEpochReceipt): void {
  cloneClosed(receipt, "legacyReceipt");
  exactKeys(receipt, [
    "actorId", "actorKey", "createdAt", "epoch", "handoffDigest", "integrityDigest",
    "pendingToolCallIds", "reason", "schemaVersion", "sessionId", "sourceFrontierDigest",
    "sourceMessageCount", "targetProfileId", "targetProviderId",
  ], "legacyReceipt");
  if (receipt.schemaVersion !== "provider.epoch-receipt/v1"
    || !Number.isSafeInteger(receipt.epoch) || receipt.epoch < 1
    || !Number.isSafeInteger(receipt.sourceMessageCount) || receipt.sourceMessageCount < 0
    || !Array.isArray(receipt.pendingToolCallIds)
    || receipt.pendingToolCallIds.some((id) => typeof id !== "string" || !id.trim() || id.trim() !== id)
    || new Set(receipt.pendingToolCallIds).size !== receipt.pendingToolCallIds.length
    || !["initial_projection", "model_control", "recovery_rebuild"].includes(receipt.reason)) {
    fail("PROVIDER_CONTEXT_LEGACY_SHAPE_INVALID", "legacy receipt values are invalid");
  }
  string(receipt.sessionId, "legacyReceipt.sessionId");
  string(receipt.actorKey, "legacyReceipt.actorKey");
  string(receipt.actorId, "legacyReceipt.actorId");
  string(receipt.targetProviderId, "legacyReceipt.targetProviderId");
  string(receipt.targetProfileId, "legacyReceipt.targetProfileId");
  string(receipt.createdAt, "legacyReceipt.createdAt");
  exactDigest(receipt.sourceFrontierDigest, "legacyReceipt.sourceFrontierDigest");
  exactDigest(receipt.handoffDigest, "legacyReceipt.handoffDigest");
  exactDigest(receipt.integrityDigest, "legacyReceipt.integrityDigest");
  const { integrityDigest, ...receiptFacts } = receipt;
  if (integrityDigest !== computeProviderEpochReceiptIntegrityDigest(receiptFacts)) {
    fail("PROVIDER_CONTEXT_LEGACY_SHAPE_INVALID", "legacy receipt integrity is invalid");
  }
}

export function digestLegacyProviderEpochReceipt(receipt: ProviderEpochReceipt): Sha256Digest {
  assertExactLegacyProviderEpochReceipt(receipt);
  return sha(receipt);
}

function mappedLegacyReason(receipt: ProviderEpochReceipt): ProviderContextEpochTransitionReason {
  if (receipt.reason === "model_control") return "provider_model_profile_switch";
  if (receipt.reason === "initial_projection") return "initial_projection";
  if (receipt.reason === "recovery_rebuild") return "legacy_context_import";
  return fail("PROVIDER_CONTEXT_LEGACY_REASON_UNSUPPORTED", "legacy reason is unsupported");
}

export function importLegacyProviderContextAuthority(input: Readonly<{
  runtime: Map<string, unknown>;
  sourceTreeDigest: Sha256Digest;
  legacyReceipt: ProviderEpochReceipt;
  projectedFactDigest: Sha256Digest;
  targetReceipt: ProviderEpochReceiptV2;
}>): ProviderContextLegacyImportResult {
  exactKeys(input, ["legacyReceipt", "projectedFactDigest", "runtime", "sourceTreeDigest", "targetReceipt"], "legacyImport");
  const sourceTreeDigest = exactDigest(input.sourceTreeDigest, "sourceTreeDigest");
  const projectedFactDigest = exactDigest(input.projectedFactDigest, "projectedFactDigest");
  const sourceReceiptDigest = digestLegacyProviderEpochReceipt(input.legacyReceipt);
  const mappedReason = mappedLegacyReason(input.legacyReceipt);
  if (input.targetReceipt.reason !== mappedReason) fail("PROVIDER_CONTEXT_LEGACY_TARGET_MISMATCH", "target receipt reason does not match legacy mapping");
  const key = `${input.legacyReceipt.sessionId}\u0000${input.legacyReceipt.actorKey}`;
  const markerFacts = Object.freeze({
    schemaVersion: "provider.context-legacy-migration/v1" as const,
    sourceTreeDigest, sourceReceiptDigest, projectedFactDigest,
    targetReceiptDigest: input.targetReceipt.receiptDigest, mappedReason, status: "completed" as const,
  });
  const marker: ProviderContextLegacyMigrationMarker = Object.freeze({ ...markerFacts, markerDigest: sha(markerFacts) });
  const existing = input.runtime.get(key) as ProviderContextLegacyImportResult | undefined;
  if (existing) {
    if (existing.marker.markerDigest !== marker.markerDigest) fail("PROVIDER_CONTEXT_LEGACY_IMPORT_CONFLICT", "legacy migration marker conflicts");
    return existing;
  }
  const result = Object.freeze({ legacyReceipt: Object.freeze({ ...input.legacyReceipt }), targetReceipt: input.targetReceipt, mappedReason, marker });
  input.runtime.set(key, result);
  return result;
}
