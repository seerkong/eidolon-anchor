import { createHash } from "node:crypto";
import {
  PROVIDER_CACHE_OBSERVATION_SCHEMA_VERSION,
  type ProviderCacheCostObservation,
  type ProviderCacheCostObservationIdentity,
  type ProviderCachePrefixComparison,
  type ProviderCachePrefixDivergence,
  type ProviderCachePriceWeights,
  type ProviderCacheRelevantUnit,
  type ProviderCacheRelevantUnitKind,
  type ProviderCacheUsageTokens,
} from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation";

type JsonScalar = null | boolean | number | string;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type CreateProviderCacheCostObservationInput = Readonly<{
  identity: ProviderCacheCostObservationIdentity;
  serializedRequestBody: string;
  tokenEstimates: Readonly<{
    finalWireInputTokens?: number;
    toolSurfaceTokens: number;
    workflowControlTokens: number;
  }>;
  usage?: ProviderCacheUsageTokens | null;
  priceWeights?: ProviderCachePriceWeights | null;
}>;

const ACTOR_CLASSES = new Set(["ordinary", "workflow_lifecycle", "workflow_node"]);
const PROVIDER_PROFILES = new Set(["deepseek", "deepseek_official", "deepseek_compatible", "other"]);
const PROVIDER_PROFILE_IDS = new Set(["deepseek-chat@1", "deepseek-official-chat@1", "deepseek-compatible-chat@1"]);

const OFFICIAL_DEEPSEEK_NORMALIZED_INPUT_PRICE_WEIGHTS = Object.freeze({
  cacheHitWeight: 0.1,
  cacheMissWeight: 1,
});

/**
 * Relative charged-input weights for the DeepSeek Chat protocol family.
 * Gateway identity does not alter protocol/cache semantics.
 */
export function resolveProviderCachePriceWeights(
  providerProfileId: string,
): ProviderCachePriceWeights | null {
  return providerProfileId === "deepseek-chat@1"
    || providerProfileId === "deepseek-official-chat@1"
    || providerProfileId === "deepseek-compatible-chat@1"
    ? OFFICIAL_DEEPSEEK_NORMALIZED_INPUT_PRICE_WEIGHTS
    : null;
}

function fail(code: string, message: string): never {
  throw new TypeError(`${code}: ${message}`);
}

function assertPlainOwnData(value: unknown, location: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("provider_cache_observation_invalid", `${location} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("provider_cache_observation_invalid", `${location} must have a plain prototype.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      fail("provider_cache_observation_invalid", `${location} cannot contain symbol keys.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail("provider_cache_observation_invalid", `${location}.${key} must be own data.`);
    }
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], location: string): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      fail("provider_cache_observation_invalid", `${location}.${key} is not allowed.`);
    }
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("provider_cache_observation_invalid", `${location}.${key} is required.`);
    }
  }
}

function assertFiniteNonNegative(value: unknown, location: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("provider_cache_observation_invalid", `${location} must be a finite non-negative number.`);
  }
}

function normalizeIdentity(value: ProviderCacheCostObservationIdentity): ProviderCacheCostObservationIdentity {
  assertPlainOwnData(value, "identity");
  assertExactKeys(value, ["schemaVersion", "providerId", "providerProfile", "providerProfileId", "model", "actorClass", "contextEpoch"], "identity");
  if (value.schemaVersion !== PROVIDER_CACHE_OBSERVATION_SCHEMA_VERSION) {
    fail("provider_cache_observation_invalid", "identity.schemaVersion is unsupported.");
  }
  if (typeof value.providerId !== "string" || value.providerId.length === 0) {
    fail("provider_cache_observation_invalid", "identity.providerId must be non-empty.");
  }
  if (typeof value.model !== "string" || value.model.length === 0) {
    fail("provider_cache_observation_invalid", "identity.model must be non-empty.");
  }
  if (!PROVIDER_PROFILES.has(value.providerProfile)) {
    fail("provider_cache_observation_invalid", "identity.providerProfile is unsupported.");
  }
  if (!PROVIDER_PROFILE_IDS.has(value.providerProfileId)) {
    fail("provider_cache_observation_invalid", "identity.providerProfileId is unsupported.");
  }
  if (!ACTOR_CLASSES.has(value.actorClass)) {
    fail("provider_cache_observation_invalid", "identity.actorClass is unsupported.");
  }
  if (!Number.isSafeInteger(value.contextEpoch) || value.contextEpoch < 0) {
    fail("provider_cache_observation_invalid", "identity.contextEpoch must be a non-negative safe integer.");
  }
  if (value.providerProfile !== "deepseek"
    && value.providerProfile !== "deepseek_official"
    && value.providerProfile !== "deepseek_compatible") {
    fail("provider_cache_profile_identity_mismatch", "providerProfile must match the explicit versioned providerProfileId.");
  }
  return {
    schemaVersion: PROVIDER_CACHE_OBSERVATION_SCHEMA_VERSION,
    providerId: value.providerId,
    providerProfile: "deepseek",
    providerProfileId: "deepseek-chat@1",
    model: value.model,
    actorClass: value.actorClass,
    contextEpoch: value.contextEpoch,
  };
}

function normalizeJson(value: unknown, location: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("provider_cache_request_invalid", `${location} must be finite.`);
    return value;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        fail("provider_cache_request_invalid", `${location} cannot be sparse.`);
      }
      result.push(normalizeJson(value[index], `${location}[${index}]`));
    }
    return result;
  }
  assertPlainOwnData(value, location);
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    result[key] = normalizeJson(value[key], `${location}.${key}`);
  }
  return result;
}

function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function unit(kind: ProviderCacheRelevantUnitKind, ordinal: number, serializedMaterial: string): ProviderCacheRelevantUnit {
  const material = Buffer.from(serializedMaterial, "utf8");
  return { ordinal, kind, byteLength: material.byteLength, digest: digest(material) };
}

type RawSpan = Readonly<{ start: number; end: number }>;

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1;
  return cursor;
}

function scanString(source: string, start: number): number {
  if (source[start] !== '"') fail("provider_cache_request_invalid", "Expected a JSON string.");
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '"') return cursor + 1;
    cursor += 1;
  }
  return fail("provider_cache_request_invalid", "Unterminated JSON string.");
}

function scanValue(source: string, start: number): number {
  const cursor = skipWhitespace(source, start);
  const first = source[cursor];
  if (first === '"') return scanString(source, cursor);
  if (first === "{" || first === "[") {
    const stack: string[] = [first === "{" ? "}" : "]"];
    let index = cursor + 1;
    while (index < source.length && stack.length > 0) {
      const token = source[index]!;
      if (token === '"') {
        index = scanString(source, index);
        continue;
      }
      if (token === "{") stack.push("}");
      else if (token === "[") stack.push("]");
      else if (token === stack[stack.length - 1]) stack.pop();
      index += 1;
    }
    if (stack.length > 0) fail("provider_cache_request_invalid", "Unterminated JSON composite.");
    return index;
  }
  let index = cursor;
  while (index < source.length && source[index] !== "," && source[index] !== "}" && source[index] !== "]") index += 1;
  return index;
}

function topLevelValueSpans(source: string): ReadonlyMap<string, RawSpan> {
  const result = new Map<string, RawSpan>();
  let cursor = skipWhitespace(source, 0);
  if (source[cursor] !== "{") fail("provider_cache_request_invalid", "Request must be a JSON object.");
  cursor += 1;
  while (true) {
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === "}") return result;
    const keyStart = cursor;
    const keyEnd = scanString(source, keyStart);
    const key = JSON.parse(source.slice(keyStart, keyEnd)) as string;
    cursor = skipWhitespace(source, keyEnd);
    if (source[cursor] !== ":") fail("provider_cache_request_invalid", "Expected a colon after a request key.");
    const start = skipWhitespace(source, cursor + 1);
    const end = scanValue(source, start);
    result.set(key, { start, end });
    cursor = skipWhitespace(source, end);
    if (source[cursor] === ",") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "}") return result;
    fail("provider_cache_request_invalid", "Expected a comma or closing brace in request.");
  }
}

function arrayElementSpans(source: string, span: RawSpan): readonly RawSpan[] {
  let cursor = skipWhitespace(source, span.start);
  if (source[cursor] !== "[") fail("provider_cache_request_invalid", "Expected a request array.");
  cursor += 1;
  const result: RawSpan[] = [];
  while (true) {
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === "]") return result;
    const start = cursor;
    const end = scanValue(source, start);
    result.push({ start, end });
    cursor = skipWhitespace(source, end);
    if (source[cursor] === ",") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "]") return result;
    fail("provider_cache_request_invalid", "Expected a comma or closing bracket in request array.");
  }
}

type ArrayCacheMaterial = Readonly<{
  framingReplacement: string;
  elementMaterials: readonly string[];
}>;

/**
 * Partition every raw array byte without making the closing bracket a moving
 * suffix unit. The stable opening/closing framing is folded into the request
 * framing unit; each element owns the exact comma/whitespace immediately
 * before it. Consequently, append adds units but never rewrites prior units,
 * while delimiter/whitespace changes still diverge.
 */
function arrayCacheMaterial(source: string, span: RawSpan): ArrayCacheMaterial {
  const elements = arrayElementSpans(source, span);
  const firstContentStart = span.start + 1;
  const lastContentEnd = elements.length > 0 ? elements[elements.length - 1]!.end : firstContentStart;
  const stableFraming = source.slice(span.start, firstContentStart) + source.slice(lastContentEnd, span.end);
  const elementMaterials = elements.map((element, index) => {
    const start = index === 0 ? firstContentStart : elements[index - 1]!.end;
    return source.slice(start, element.end);
  });
  return {
    framingReplacement: stableFraming,
    elementMaterials,
  };
}

function normalizeUsage(value: ProviderCacheUsageTokens | null | undefined): ProviderCacheUsageTokens | null {
  if (value == null) return null;
  assertPlainOwnData(value, "usage");
  assertExactKeys(value, ["promptTokens", "completionTokens", "cacheHitTokens", "cacheMissTokens"], "usage");
  assertFiniteNonNegative(value.promptTokens, "usage.promptTokens");
  assertFiniteNonNegative(value.completionTokens, "usage.completionTokens");
  assertFiniteNonNegative(value.cacheHitTokens, "usage.cacheHitTokens");
  assertFiniteNonNegative(value.cacheMissTokens, "usage.cacheMissTokens");
  return { ...value };
}

function normalizeWeights(value: ProviderCachePriceWeights | null | undefined): ProviderCachePriceWeights | null {
  if (value == null) return null;
  assertPlainOwnData(value, "priceWeights");
  assertExactKeys(value, ["cacheHitWeight", "cacheMissWeight"], "priceWeights");
  assertFiniteNonNegative(value.cacheHitWeight, "priceWeights.cacheHitWeight");
  assertFiniteNonNegative(value.cacheMissWeight, "priceWeights.cacheMissWeight");
  return { ...value };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createProviderCacheCostObservation(
  input: CreateProviderCacheCostObservationInput,
): ProviderCacheCostObservation {
  assertPlainOwnData(input, "input");
  assertExactKeys(input, ["identity", "serializedRequestBody", "tokenEstimates", ...(Object.prototype.hasOwnProperty.call(input, "usage") ? ["usage"] : []), ...(Object.prototype.hasOwnProperty.call(input, "priceWeights") ? ["priceWeights"] : [])], "input");
  if (typeof input.serializedRequestBody !== "string") {
    fail("provider_cache_request_invalid", "serializedRequestBody must be a string.");
  }
  if (Object.prototype.hasOwnProperty.call(input, "usage") && input.usage === undefined) {
    fail("provider_cache_observation_invalid", "usage cannot be undefined.");
  }
  if (Object.prototype.hasOwnProperty.call(input, "priceWeights") && input.priceWeights === undefined) {
    fail("provider_cache_observation_invalid", "priceWeights cannot be undefined.");
  }
  assertPlainOwnData(input.tokenEstimates, "tokenEstimates");
  assertExactKeys(input.tokenEstimates, [
    ...(Object.prototype.hasOwnProperty.call(input.tokenEstimates, "finalWireInputTokens") ? ["finalWireInputTokens"] : []),
    "toolSurfaceTokens",
    "workflowControlTokens",
  ], "tokenEstimates");
  if (input.tokenEstimates.finalWireInputTokens !== undefined) {
    assertFiniteNonNegative(input.tokenEstimates.finalWireInputTokens, "tokenEstimates.finalWireInputTokens");
  }
  assertFiniteNonNegative(input.tokenEstimates.toolSurfaceTokens, "tokenEstimates.toolSurfaceTokens");
  assertFiniteNonNegative(input.tokenEstimates.workflowControlTokens, "tokenEstimates.workflowControlTokens");
  const identity = normalizeIdentity(input.identity);

  let decoded: unknown;
  try {
    decoded = JSON.parse(input.serializedRequestBody);
  } catch {
    fail("provider_cache_request_invalid", "serializedRequestBody must contain valid JSON.");
  }
  const request = normalizeJson(decoded, "request");
  if (request === null || Array.isArray(request) || typeof request !== "object") {
    fail("provider_cache_request_invalid", "serializedRequestBody must contain one object.");
  }
  if (request.model !== identity.model) {
    fail("provider_cache_observation_identity_mismatch", "identity.model must equal the final wire request model.");
  }
  const messages = request.messages;
  const tools = request.tools ?? [];
  if (!Array.isArray(messages) || !Array.isArray(tools)) {
    fail("provider_cache_request_invalid", "request.messages must be an array and request.tools must be absent or an array.");
  }
  const spans = topLevelValueSpans(input.serializedRequestBody);
  const modelSpan = spans.get("model");
  const messageSpan = spans.get("messages");
  const toolSpan = spans.get("tools");
  if (!modelSpan) fail("provider_cache_request_invalid", "request.model must be present.");
  if (!messageSpan) fail("provider_cache_request_invalid", "request.messages must be present.");
  const messageMaterial = arrayCacheMaterial(input.serializedRequestBody, messageSpan);
  const toolMaterial = toolSpan ? arrayCacheMaterial(input.serializedRequestBody, toolSpan) : null;
  // DeepSeek's prefix cache is keyed by the admitted prompt projection, not
  // by completion-side controls in the HTTP body. In particular, a
  // reasoning-only semantic continuation deliberately lowers max_tokens;
  // treating that output budget as retained input would report a false cache
  // divergence even though model, tools and every retained message are exact.
  // Keep requestDigest as the authority for the complete final-wire body and
  // make this unit describe only the versioned chat-template framing/model.
  const prefixMaterial = JSON.stringify({
    profile: identity.providerProfileId,
    model: input.serializedRequestBody.slice(modelSpan.start, modelSpan.end),
    toolsFraming: toolMaterial?.framingReplacement ?? "absent",
    messagesFraming: messageMaterial.framingReplacement,
  });
  const units = createUnitsForExplicitProfile({
    providerProfileId: identity.providerProfileId,
    prefixMaterial,
    toolMaterials: toolMaterial?.elementMaterials ?? [],
    messageMaterials: messageMaterial.elementMaterials,
  });

  const usage = normalizeUsage(input.usage);
  const priceWeights = normalizeWeights(input.priceWeights);
  const normalizedInputCost = usage && priceWeights
    ? usage.cacheHitTokens * priceWeights.cacheHitWeight + usage.cacheMissTokens * priceWeights.cacheMissWeight
    : null;
  return deepFreeze({
    identity,
    epochDigest: digest(Buffer.from(JSON.stringify(identity), "utf8")),
    requestDigest: digest(Buffer.from(input.serializedRequestBody, "utf8")),
    units,
    tokenBreakdown: {
      finalWireInputTokens: input.tokenEstimates.finalWireInputTokens
        ?? Math.ceil(Buffer.byteLength(input.serializedRequestBody, "utf8") / 4),
      toolSurfaceTokens: input.tokenEstimates.toolSurfaceTokens,
      workflowControlTokens: input.tokenEstimates.workflowControlTokens,
      usage,
      priceWeights,
      normalizedInputCost,
    },
  });
}

function createUnitsForExplicitProfile(input: Readonly<{
  providerProfileId: ProviderCacheCostObservationIdentity["providerProfileId"];
  prefixMaterial: string;
  toolMaterials: readonly string[];
  messageMaterials: readonly string[];
}>): ProviderCacheRelevantUnit[] {
  // Both v1 profiles use the explicitly versioned DeepSeek/OpenAI-compatible
  // chat template: stable request framing, then tool schemas, then messages.
  // Keep separate dispatch cases so a future compatible template cannot
  // silently inherit official ordering.
  switch (input.providerProfileId) {
    case "deepseek-chat@1":
    case "deepseek-official-chat@1":
      return createDeepSeekChatV1Units(input);
    case "deepseek-compatible-chat@1":
      return createDeepSeekChatV1Units(input);
  }
}

function createDeepSeekChatV1Units(input: Readonly<{
  prefixMaterial: string;
  toolMaterials: readonly string[];
  messageMaterials: readonly string[];
}>): ProviderCacheRelevantUnit[] {
  const units: ProviderCacheRelevantUnit[] = [unit("request_prefix", 0, input.prefixMaterial)];
  for (const material of input.toolMaterials) {
    units.push(unit("tool_schema", units.length, material));
  }
  for (const material of input.messageMaterials) {
    units.push(unit("message", units.length, material));
  }
  return units;
}

export function bindProviderCacheUsageToObservation(
  observation: ProviderCacheCostObservation,
  usage: ProviderCacheUsageTokens | null,
): ProviderCacheCostObservation {
  const normalizedUsage = normalizeUsage(usage);
  const priceWeights = observation.tokenBreakdown.priceWeights;
  return deepFreeze({
    identity: { ...observation.identity },
    epochDigest: observation.epochDigest,
    requestDigest: observation.requestDigest,
    units: observation.units.map((item) => ({ ...item })),
    tokenBreakdown: {
      finalWireInputTokens: observation.tokenBreakdown.finalWireInputTokens,
      toolSurfaceTokens: observation.tokenBreakdown.toolSurfaceTokens,
      workflowControlTokens: observation.tokenBreakdown.workflowControlTokens,
      usage: normalizedUsage,
      priceWeights: priceWeights ? { ...priceWeights } : null,
      normalizedInputCost: normalizedUsage && priceWeights
        ? normalizedUsage.cacheHitTokens * priceWeights.cacheHitWeight
          + normalizedUsage.cacheMissTokens * priceWeights.cacheMissWeight
        : null,
    },
  });
}

function sameIdentity(
  prior: ProviderCacheCostObservationIdentity,
  current: ProviderCacheCostObservationIdentity,
): boolean {
  return prior.schemaVersion === current.schemaVersion
    && prior.providerId === current.providerId
    && prior.providerProfile === current.providerProfile
    && prior.model === current.model
    && prior.actorClass === current.actorClass
    && prior.contextEpoch === current.contextEpoch;
}

function firstDivergence(
  prior: readonly ProviderCacheRelevantUnit[],
  current: readonly ProviderCacheRelevantUnit[],
  exactLcpUnitCount: number,
): ProviderCachePrefixDivergence | null {
  if (exactLcpUnitCount >= prior.length) return null;
  const before = prior[exactLcpUnitCount] ?? null;
  const after = current[exactLcpUnitCount] ?? null;
  let reason: ProviderCachePrefixDivergence["reason"] = "unit_missing";
  if (before && after) {
    if (before.kind !== after.kind) reason = "kind_changed";
    else if (before.digest !== after.digest) reason = "digest_changed";
    else if (before.byteLength !== after.byteLength) reason = "byte_length_changed";
  }
  return {
    ordinal: exactLcpUnitCount,
    reason,
    priorKind: before?.kind ?? null,
    currentKind: after?.kind ?? null,
    priorDigest: before?.digest ?? null,
    currentDigest: after?.digest ?? null,
  };
}

export function compareProviderCacheCostObservations(
  prior: ProviderCacheCostObservation,
  current: ProviderCacheCostObservation,
): ProviderCachePrefixComparison {
  const relation = sameIdentity(prior.identity, current.identity) ? "same_epoch" : "epoch_boundary";
  let exactLcpUnitCount = 0;
  let exactLcpByteLength = 0;
  if (relation === "same_epoch") {
    const limit = Math.min(prior.units.length, current.units.length);
    while (exactLcpUnitCount < limit) {
      const before = prior.units[exactLcpUnitCount]!;
      const after = current.units[exactLcpUnitCount]!;
      if (before.kind !== after.kind || before.digest !== after.digest || before.byteLength !== after.byteLength) break;
      exactLcpByteLength += before.byteLength;
      exactLcpUnitCount += 1;
    }
  }
  const priorByteLength = prior.units.reduce((sum, item) => sum + item.byteLength, 0);
  const currentByteLength = current.units.reduce((sum, item) => sum + item.byteLength, 0);
  return deepFreeze({
    relation,
    priorUnitCount: prior.units.length,
    currentUnitCount: current.units.length,
    exactLcpUnitCount,
    priorByteLength,
    currentByteLength,
    exactLcpByteLength,
    retainedPrefixIntegrity: relation === "same_epoch" ? (prior.units.length === 0 ? 1 : exactLcpUnitCount / prior.units.length) : 0,
    reuseOpportunityCoverage: relation === "same_epoch" ? (current.units.length === 0 ? 1 : exactLcpUnitCount / current.units.length) : 0,
    firstDivergence: relation === "same_epoch" ? firstDivergence(prior.units, current.units, exactLcpUnitCount) : null,
  });
}
