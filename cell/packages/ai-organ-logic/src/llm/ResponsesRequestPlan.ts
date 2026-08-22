import { createHash } from "node:crypto";
import type {
  ResponsesCheckpointRequestKind,
  ResponsesMessageFingerprint,
  ResponsesMessageFrontier,
  ResponsesNativeItem,
  ResponsesNativeWindowFingerprint,
  ResponsesProviderOutputSnapshot,
  ResponsesReplayCheckpoint,
  ResponsesRequestPlan,
  ResponsesRequestPlanInput,
  ResponsesStablePrefix,
} from "@cell/ai-organ-contract/llm/ResponsesReplay";
import {
  decideResponsesCallLineage,
  decideResponsesRequestLineage,
  isValidResponsesCallLineageProof,
  isValidResponsesProviderOutputSnapshot,
  ResponsesRequestLineageError,
} from "./ResponsesNativeIntegrity";

type JsonRecord = Record<string, unknown>;

function normalizeForStableSerialization(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    return { $number: String(value) };
  }
  if (typeof value === "undefined") return { $undefined: true };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Unsupported stable-hash value: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("Cannot stable-hash a cyclic value");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeForStableSerialization(item, ancestors));
    }
    const record = value as JsonRecord;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeForStableSerialization(record[key], ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function stableHash(domain: string, value: unknown): string {
  const normalized = normalizeForStableSerialization(value, new Set());
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(JSON.stringify(normalized))
    .digest("base64url");
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreeze(item))) as T;
  }
  if (value !== null && typeof value === "object") {
    const clone = Object.fromEntries(
      Object.entries(value as JsonRecord).map(([key, item]) => [key, cloneAndFreeze(item)]),
    );
    return Object.freeze(clone) as T;
  }
  return value;
}

function immutableItems(items: readonly ResponsesNativeItem[]): readonly ResponsesNativeItem[] {
  return cloneAndFreeze([...items]);
}

const SHA256_DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(record: JsonRecord, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isJsonCompatible(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJsonCompatible(item, ancestors));
    }
    if (!isRecord(value)) return false;
    return Object.values(value).every((item) => isJsonCompatible(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function isNativeItemArray(value: unknown): value is readonly ResponsesNativeItem[] {
  return Array.isArray(value) && value.every(
    (item) => isRecord(item) && isJsonCompatible(item, new Set()),
  );
}

function isValidMessageFrontier(value: unknown): value is ResponsesMessageFrontier {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["schemaVersion", "algorithm", "messageCount", "digest"]) &&
    value.schemaVersion === 1 &&
    value.algorithm === "sha256" &&
    Number.isSafeInteger(value.messageCount) &&
    (value.messageCount as number) >= 0 &&
    typeof value.digest === "string" &&
    SHA256_DIGEST_PATTERN.test(value.digest)
  );
}

function isValidNativeWindowFingerprint(
  value: unknown,
): value is ResponsesNativeWindowFingerprint {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["schemaVersion", "algorithm", "itemCount", "digest"]) &&
    value.schemaVersion === 1 &&
    value.algorithm === "sha256" &&
    Number.isSafeInteger(value.itemCount) &&
    (value.itemCount as number) >= 0 &&
    typeof value.digest === "string" &&
    SHA256_DIGEST_PATTERN.test(value.digest)
  );
}

export function createResponsesNativeWindowFingerprint(
  items: readonly ResponsesNativeItem[],
): ResponsesNativeWindowFingerprint {
  return Object.freeze({
    schemaVersion: 1,
    algorithm: "sha256",
    itemCount: items.length,
    digest: `sha256:${stableHash("responses-native-replay-window-v1", items)}`,
  });
}

export function isValidResponsesReplayCheckpoint(
  value: unknown,
): value is ResponsesReplayCheckpoint {
  try {
    if (!isRecord(value)) return false;
    if (!hasOnlyKeys(value, [
      "schemaVersion",
      "kind",
      "factClass",
      "authority",
      "recoveryRole",
      "actorId",
      "providerId",
      "model",
      "baselineEpoch",
      "contextDigest",
      "messageFrontier",
      "requestKind",
      "requestInput",
      "output",
      "nativeWindow",
      "nativeWindowFingerprint",
      "lineageProof",
    ])) return false;
    if (
      value.schemaVersion !== 2 ||
      value.kind !== "provider_replay_checkpoint" ||
      value.factClass !== "checkpoint_snapshot" ||
      value.authority !== "non_authoritative" ||
      value.recoveryRole !== "none" ||
      !isNonEmptyString(value.actorId) ||
      !isNonEmptyString(value.providerId) ||
      !isNonEmptyString(value.model) ||
      !Number.isSafeInteger(value.baselineEpoch) ||
      (value.baselineEpoch as number) < 0 ||
      typeof value.contextDigest !== "string" ||
      !SHA256_DIGEST_PATTERN.test(value.contextDigest) ||
      !isValidMessageFrontier(value.messageFrontier) ||
      (value.requestKind !== "stateful_incremental" && value.requestKind !== "stateless_replay") ||
      !isNativeItemArray(value.requestInput) ||
      !isValidResponsesProviderOutputSnapshot(value.output) ||
      !isNativeItemArray(value.nativeWindow) ||
      !isValidNativeWindowFingerprint(value.nativeWindowFingerprint) ||
      !isValidResponsesCallLineageProof(value.lineageProof, value.nativeWindow)
    ) {
      return false;
    }

    const expectedFingerprint = createResponsesNativeWindowFingerprint(value.nativeWindow);
    if (
      value.nativeWindowFingerprint.itemCount !== expectedFingerprint.itemCount ||
      value.nativeWindowFingerprint.digest !== expectedFingerprint.digest
    ) {
      return false;
    }

    const currentTurn = [...value.requestInput, ...value.output.items];
    if (currentTurn.length > value.nativeWindow.length) return false;
    const storedSuffix = value.nativeWindow.slice(value.nativeWindow.length - currentTurn.length);
    return stableHash("responses-native-current-turn-v1", storedSuffix) ===
      stableHash("responses-native-current-turn-v1", currentTurn);
  } catch {
    return false;
  }
}

export function createResponsesMessageFrontier(
  messages: readonly unknown[],
): ResponsesMessageFrontier {
  const fingerprints = messages.map(createResponsesMessageFingerprint);
  return Object.freeze({
    schemaVersion: 1,
    algorithm: "sha256",
    messageCount: messages.length,
    digest: `sha256:${stableHash("responses-message-frontier-v1", fingerprints)}`,
  });
}

export function createResponsesMessageFingerprint(
  message: unknown,
): ResponsesMessageFingerprint {
  return Object.freeze({
    schemaVersion: 1,
    algorithm: "sha256",
    digest: `sha256:${stableHash("responses-message-fingerprint-v1", message)}`,
  });
}

export function createResponsesContextDigest(input: unknown): string {
  return `sha256:${stableHash("responses-context-digest-v1", input)}`;
}

export function createResponsesStablePromptCacheKey(prefix: ResponsesStablePrefix): string {
  return `responses_v1_${stableHash("responses-stable-prompt-prefix-v1", prefix)}`;
}

export function createResponsesReplayCheckpoint(params: {
  actorId: string;
  providerId: string;
  model: string;
  baselineEpoch: number;
  contextDigest: string;
  messageFrontier: ResponsesMessageFrontier;
  requestKind: ResponsesCheckpointRequestKind;
  priorCheckpoint?: unknown;
  requestInput: readonly ResponsesNativeItem[];
  output: ResponsesProviderOutputSnapshot;
}): ResponsesReplayCheckpoint {
  if (!isValidMessageFrontier(params.messageFrontier)) {
    throw new TypeError("Invalid Responses message frontier");
  }
  if (!isNativeItemArray(params.requestInput)) {
    throw new TypeError("Invalid Responses request input");
  }
  if (!isValidResponsesProviderOutputSnapshot(params.output)) {
    throw new TypeError("Invalid Responses provider output snapshot");
  }

  let priorNativeWindow: readonly ResponsesNativeItem[] = [];
  if (params.requestKind === "stateful_incremental") {
    if (!isValidResponsesReplayCheckpoint(params.priorCheckpoint)) {
      throw new TypeError("Stateful checkpoint requires a valid prior replay checkpoint");
    }
    if (
      params.priorCheckpoint.actorId !== params.actorId ||
      params.priorCheckpoint.providerId !== params.providerId ||
      params.priorCheckpoint.model !== params.model ||
      params.priorCheckpoint.baselineEpoch !== params.baselineEpoch ||
      params.priorCheckpoint.contextDigest !== params.contextDigest
    ) {
      throw new TypeError("Stateful checkpoint prior lineage does not match its context");
    }
    priorNativeWindow = params.priorCheckpoint.nativeWindow;
  }

  const nativeWindow = immutableItems([
    ...priorNativeWindow,
    ...params.requestInput,
    ...params.output.items,
  ]);
  const lineageProof = decideResponsesCallLineage(nativeWindow);
  if (lineageProof.status !== "valid") {
    throw new ResponsesRequestLineageError(lineageProof);
  }
  const checkpoint = Object.freeze({
    schemaVersion: 2,
    kind: "provider_replay_checkpoint",
    factClass: "checkpoint_snapshot",
    authority: "non_authoritative",
    recoveryRole: "none",
    actorId: params.actorId,
    providerId: params.providerId,
    model: params.model,
    baselineEpoch: params.baselineEpoch,
    contextDigest: params.contextDigest,
    messageFrontier: cloneAndFreeze(params.messageFrontier),
    requestKind: params.requestKind,
    requestInput: immutableItems(params.requestInput),
    output: cloneAndFreeze(params.output),
    nativeWindow,
    nativeWindowFingerprint: createResponsesNativeWindowFingerprint(nativeWindow),
    lineageProof,
  });
  if (!isValidResponsesReplayCheckpoint(checkpoint)) {
    throw new TypeError("Invalid Responses replay checkpoint");
  }
  return checkpoint;
}

function frontierMatches(
  frontier: ResponsesMessageFrontier,
  currentMessages: readonly unknown[],
): boolean {
  if (frontier.messageCount < 0 || frontier.messageCount > currentMessages.length) return false;
  const currentPrefix = createResponsesMessageFrontier(
    currentMessages.slice(0, frontier.messageCount),
  );
  return currentPrefix.algorithm === frontier.algorithm && currentPrefix.digest === frontier.digest;
}

function checkpointMatchesCurrentContext(
  checkpoint: ResponsesReplayCheckpoint | undefined,
  input: ResponsesRequestPlanInput,
): boolean {
  return Boolean(
    checkpoint &&
      checkpoint.actorId === input.actorId &&
      checkpoint.providerId === input.providerId &&
      checkpoint.model === input.model &&
      checkpoint.baselineEpoch === input.currentEpoch &&
      checkpoint.contextDigest === input.currentContextDigest &&
      frontierMatches(checkpoint.messageFrontier, input.currentMessages),
  );
}

function baselineMatchesCurrentContext(input: ResponsesRequestPlanInput): boolean {
  const baseline = input.baseline;
  return Boolean(
    baseline?.previousResponseId &&
      baseline.baselineEpoch === input.currentEpoch &&
      baseline.contextDigest === input.currentContextDigest,
  );
}

export function planResponsesRequest(input: ResponsesRequestPlanInput): ResponsesRequestPlan {
  const messageFrontier = createResponsesMessageFrontier(input.currentMessages);
  const checkpoint = isValidResponsesReplayCheckpoint(input.checkpoint)
    ? input.checkpoint
    : undefined;
  const checkpointMatches = checkpointMatchesCurrentContext(checkpoint, input);
  const baselineMatches = baselineMatchesCurrentContext(input);
  const checkpointResponseMatchesBaseline = Boolean(
    checkpoint?.output.responseId &&
      checkpoint.output.responseId === input.baseline?.previousResponseId,
  );
  const statefulLineage = checkpoint
    ? decideResponsesRequestLineage([...checkpoint.nativeWindow, ...input.incrementalInput])
    : undefined;

  if (
    input.mode === "stateful_chain" &&
    input.transportSupportsContinuation &&
    baselineMatches &&
    checkpointMatches &&
    checkpointResponseMatchesBaseline &&
    statefulLineage?.status === "valid"
  ) {
    return Object.freeze({
      kind: "stateful_incremental",
      previousResponseId: input.baseline!.previousResponseId,
      input: immutableItems(input.incrementalInput),
      contextDigest: input.currentContextDigest,
      messageFrontier,
      lineageProof: statefulLineage,
    });
  }

  const promptCacheKey = createResponsesStablePromptCacheKey(input.stablePrefix);
  if (checkpointMatches && checkpoint) {
    const nativeInput = immutableItems([...checkpoint.nativeWindow, ...input.incrementalInput]);
    const nativeLineage = decideResponsesRequestLineage(nativeInput);
    if (nativeLineage.status === "valid") {
    return Object.freeze({
      kind: "stateless_replay",
      source: "native_window",
      input: nativeInput,
      contextDigest: input.currentContextDigest,
      messageFrontier,
      promptCacheKey,
      lineageProof: nativeLineage,
    });
    }
  }

  const canonicalLineage = decideResponsesRequestLineage(input.fullCanonicalInput);
  if (canonicalLineage.status !== "valid") {
    throw new ResponsesRequestLineageError(canonicalLineage);
  }

  return Object.freeze({
    kind: "stateless_replay",
    source: "canonical_rebuild",
    input: immutableItems(input.fullCanonicalInput),
    contextDigest: input.currentContextDigest,
    messageFrontier,
    promptCacheKey,
    lineageProof: canonicalLineage,
  });
}
