import type {
  ActorRuntimeFacetCodecEntry,
  ActorRuntimeFacetEnvelope,
  ActorRuntimeFacetEvent,
  ActorRuntimeFacetIndex,
  ActorRuntimeFacetIndexInput,
  ActorRuntimeFacetProcessorConfig,
  ActorRuntimeFacetProviderBoundaryRuntime,
  ActorRuntimeFacetReadInvocation,
  ActorRuntimeFacetRegistry,
  ActorRuntimeFacetReplaceInvocation,
  ActorRuntimeFacetSelector,
  ActorRuntimeFacetToolOutcomeProjectionInput,
  ActorRuntimeFacetVmRuntime,
  ImmutableJsonValue,
} from "@cell/ai-core-contract/runtime/ActorRuntimeFacet";

export type ActorRuntimeFacetErrorCode =
  | "ACTOR_RUNTIME_FACET_INVALID"
  | "ACTOR_RUNTIME_FACET_DUPLICATE"
  | "ACTOR_RUNTIME_FACET_UNKNOWN_CODEC"
  | "ACTOR_RUNTIME_FACET_SCHEMA_MISMATCH"
  | "ACTOR_RUNTIME_FACET_ACTOR_NOT_FOUND"
  | "ACTOR_RUNTIME_FACET_NOT_FOUND"
  | "ACTOR_RUNTIME_FACET_REVISION_CONFLICT";

export class ActorRuntimeFacetError extends Error {
  readonly code: ActorRuntimeFacetErrorCode;
  readonly cause?: unknown;

  constructor(code: ActorRuntimeFacetErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`);
    this.name = "ActorRuntimeFacetError";
    this.code = code;
    this.cause = options?.cause;
  }
}

/** A capability hook deliberately terminated an invocation-scoped effect. */
export class ActorRuntimeFacetProviderBoundaryError extends Error {
  readonly code = "ACTOR_RUNTIME_FACET_PROVIDER_BOUNDARY" as const;
  readonly facetId: string;

  constructor(facetId: string, message: string) {
    super(message);
    this.name = "ActorRuntimeFacetProviderBoundaryError";
    this.facetId = facetId;
  }
}

const DEFAULT_MAX_VALUE_DEPTH = 64;

function fail(
  code: ActorRuntimeFacetErrorCode,
  message: string,
  options?: { cause?: unknown },
): never {
  throw new ActorRuntimeFacetError(code, message, options);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ownDataDescriptors(
  value: unknown,
  location: string,
  options?: { allowArray?: boolean },
): Record<string, PropertyDescriptor> {
  if (value === null || typeof value !== "object") {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location} must be an own-data object`);
  }
  if (Array.isArray(value) && options?.allowArray !== true) {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location} must not be an array`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location} must have a plain or null prototype`);
  }
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location} must not contain symbol properties`);
  }
  return Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
}

function requiredDataValue(
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
  location: string,
): unknown {
  const descriptor = descriptors[key];
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location}.${key} must be an enumerable own-data property`);
  }
  return descriptor.value;
}

function optionalDataValue(
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
  location: string,
): unknown {
  const descriptor = descriptors[key];
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location}.${key} must be an enumerable own-data property`);
  }
  return descriptor.value;
}

function assertExactKeys(
  descriptors: Record<string, PropertyDescriptor>,
  expected: readonly string[],
  location: string,
): void {
  const actual = Object.keys(descriptors).sort(codeUnitCompare);
  const sortedExpected = [...expected].sort(codeUnitCompare);
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    fail(
      "ACTOR_RUNTIME_FACET_INVALID",
      `${location} must contain exactly ${sortedExpected.join(", ")}`,
    );
  }
}

function normalizeProcessorConfig(config: ActorRuntimeFacetProcessorConfig): number {
  const descriptors = ownDataDescriptors(config, "config");
  const keys = Object.keys(descriptors);
  if (keys.some((key) => key !== "maxValueDepth")) {
    fail("ACTOR_RUNTIME_FACET_INVALID", "config contains an unknown field or function");
  }
  const value = optionalDataValue(descriptors, "maxValueDepth", "config");
  if (value === undefined) return DEFAULT_MAX_VALUE_DEPTH;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("ACTOR_RUNTIME_FACET_INVALID", "config.maxValueDepth must be a positive safe integer");
  }
  return value as number;
}

function normalizeClosedJson(
  value: unknown,
  location: string,
  maxDepth: number,
  depth = 0,
  ancestors = new Set<object>(),
): ImmutableJsonValue {
  if (depth > maxDepth) {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location} exceeds maxValueDepth ${maxDepth}`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("ACTOR_RUNTIME_FACET_INVALID", `${location} must contain only finite numbers`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location} must contain only closed JSON values`);
  }
  if (ancestors.has(value)) {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location} must not be cyclic`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = ownDataDescriptors(value, location, { allowArray: true });
      const extraKeys = Object.keys(descriptors).filter((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key));
      if (extraKeys.length > 0) {
        fail("ACTOR_RUNTIME_FACET_INVALID", `${location} array must not contain extra properties`);
      }
      const result: ImmutableJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
          fail("ACTOR_RUNTIME_FACET_INVALID", `${location} array must be dense own-data JSON`);
        }
        result.push(normalizeClosedJson(descriptor.value, `${location}[${index}]`, maxDepth, depth + 1, ancestors));
      }
      return Object.freeze(result);
    }

    const descriptors = ownDataDescriptors(value, location);
    const result: Record<string, ImmutableJsonValue> = {};
    for (const key of Object.keys(descriptors).sort(codeUnitCompare)) {
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        fail("ACTOR_RUNTIME_FACET_INVALID", `${location}.${key} must be enumerable own-data JSON`);
      }
      result[key] = normalizeClosedJson(descriptor.value, `${location}.${key}`, maxDepth, depth + 1, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function normalizeNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location} must be a non-empty string`);
  }
  return value;
}

function normalizeRevision(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location} must be a non-negative safe integer`);
  }
  return value as number;
}

function normalizeOccurredAt(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("ACTOR_RUNTIME_FACET_INVALID", `${location} must be a non-negative finite number`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizeEnvelopeStructure(
  input: unknown,
  maxDepth: number,
  location: string,
): ActorRuntimeFacetEnvelope {
  const descriptors = ownDataDescriptors(input, location);
  assertExactKeys(descriptors, ["facetId", "schemaVersion", "revision", "value"], location);
  return Object.freeze({
    facetId: normalizeNonEmptyString(requiredDataValue(descriptors, "facetId", location), `${location}.facetId`),
    schemaVersion: normalizeNonEmptyString(
      requiredDataValue(descriptors, "schemaVersion", location),
      `${location}.schemaVersion`,
    ),
    revision: normalizeRevision(requiredDataValue(descriptors, "revision", location), `${location}.revision`),
    value: normalizeClosedJson(requiredDataValue(descriptors, "value", location), `${location}.value`, maxDepth),
  });
}

function normalizeEnvelopeWithRegistry(
  registry: ActorRuntimeFacetRegistry,
  input: unknown,
  maxDepth: number,
  location: string,
): ActorRuntimeFacetEnvelope {
  const envelope = normalizeEnvelopeStructure(input, maxDepth, location);
  const codec = registry.resolve(envelope.facetId, envelope.schemaVersion);
  let normalizedValue: unknown;
  try {
    normalizedValue = codec.normalize(envelope.value);
  } catch (cause) {
    fail(
      "ACTOR_RUNTIME_FACET_INVALID",
      `${location}.value was rejected by codec ${envelope.facetId}@${envelope.schemaVersion}`,
      { cause },
    );
  }
  return Object.freeze({
    ...envelope,
    value: normalizeClosedJson(normalizedValue, `${location}.value(codec)`, maxDepth),
  });
}

function indexEntries(input: ActorRuntimeFacetIndexInput): Array<[string | null, unknown]> {
  if (Array.isArray(input)) {
    const descriptors = ownDataDescriptors(input, "runtimeFacets", { allowArray: true });
    const entries: Array<[null, unknown]> = [];
    for (let index = 0; index < input.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        fail("ACTOR_RUNTIME_FACET_INVALID", "runtimeFacets array must be dense own-data");
      }
      entries.push([null, descriptor.value]);
    }
    const extraKeys = Object.keys(descriptors).filter((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key));
    if (extraKeys.length > 0) {
      fail("ACTOR_RUNTIME_FACET_INVALID", "runtimeFacets array must not contain extra properties");
    }
    return entries;
  }

  const descriptors = ownDataDescriptors(input, "runtimeFacets");
  return Object.keys(descriptors).map((key) => {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      fail("ACTOR_RUNTIME_FACET_INVALID", `runtimeFacets.${key} must be enumerable own-data`);
    }
    return [key, descriptor.value];
  });
}

function normalizeIndex(
  input: ActorRuntimeFacetIndexInput | undefined,
  maxDepth: number,
  registry?: ActorRuntimeFacetRegistry,
): ActorRuntimeFacetIndex {
  if (input === undefined) return Object.freeze({});
  const byFacet = new Map<string, ActorRuntimeFacetEnvelope>();
  for (const [indexKey, rawEnvelope] of indexEntries(input)) {
    const envelope = registry
      ? normalizeEnvelopeWithRegistry(registry, rawEnvelope, maxDepth, `runtimeFacets.${indexKey ?? byFacet.size}`)
      : normalizeEnvelopeStructure(rawEnvelope, maxDepth, `runtimeFacets.${indexKey ?? byFacet.size}`);
    if (indexKey !== null && indexKey !== envelope.facetId) {
      fail(
        "ACTOR_RUNTIME_FACET_INVALID",
        `runtimeFacets index key ${indexKey} must equal facetId ${envelope.facetId}`,
      );
    }
    if (byFacet.has(envelope.facetId)) {
      fail("ACTOR_RUNTIME_FACET_DUPLICATE", `duplicate facet ${envelope.facetId}`);
    }
    byFacet.set(envelope.facetId, envelope);
  }
  return Object.freeze(Object.fromEntries([...byFacet.entries()].sort(([left], [right]) => codeUnitCompare(left, right))));
}

export function normalizeActorRuntimeFacetIndex(
  input: ActorRuntimeFacetIndexInput | undefined,
  config: ActorRuntimeFacetProcessorConfig = {},
): ActorRuntimeFacetIndex {
  return normalizeIndex(input, normalizeProcessorConfig(config));
}

export function normalizeActorRuntimeFacetIndexForRegistry(
  registry: ActorRuntimeFacetRegistry,
  input: ActorRuntimeFacetIndexInput | undefined,
  config: ActorRuntimeFacetProcessorConfig = {},
): ActorRuntimeFacetIndex {
  return normalizeIndex(input, normalizeProcessorConfig(config), registry);
}

export function createActorRuntimeFacetRegistry(
  inputEntries: readonly ActorRuntimeFacetCodecEntry[] = [],
): ActorRuntimeFacetRegistry {
  if (!Array.isArray(inputEntries)) {
    fail("ACTOR_RUNTIME_FACET_INVALID", "facet registry entries must be an array");
  }
  const entries: ActorRuntimeFacetCodecEntry[] = [];
  const exact = new Map<string, ActorRuntimeFacetCodecEntry>();
  const versions = new Map<string, Set<string>>();
  for (let index = 0; index < inputEntries.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(inputEntries, index)) {
      fail("ACTOR_RUNTIME_FACET_INVALID", "facet registry entries must be dense");
    }
    const raw = inputEntries[index] as ActorRuntimeFacetCodecEntry;
    const descriptors = ownDataDescriptors(raw, `registry[${index}]`);
    const allowedKeys = new Set(["facetId", "schemaVersion", "normalize", "onEvent", "aroundProvider", "projectAfterToolOutcome"]);
    if (Object.keys(descriptors).some((key) => !allowedKeys.has(key))) {
      fail("ACTOR_RUNTIME_FACET_INVALID", `registry[${index}] contains an unknown property`);
    }
    const facetId = normalizeNonEmptyString(
      requiredDataValue(descriptors, "facetId", `registry[${index}]`),
      `registry[${index}].facetId`,
    );
    const schemaVersion = normalizeNonEmptyString(
      requiredDataValue(descriptors, "schemaVersion", `registry[${index}]`),
      `registry[${index}].schemaVersion`,
    );
    const normalize = requiredDataValue(descriptors, "normalize", `registry[${index}]`);
    const onEvent = optionalDataValue(descriptors, "onEvent", `registry[${index}]`);
    const aroundProvider = optionalDataValue(descriptors, "aroundProvider", `registry[${index}]`);
    const projectAfterToolOutcome = optionalDataValue(descriptors, "projectAfterToolOutcome", `registry[${index}]`);
    if (typeof normalize !== "function") {
      fail("ACTOR_RUNTIME_FACET_INVALID", `registry[${index}].normalize must be a function`);
    }
    if (onEvent !== undefined && typeof onEvent !== "function") {
      fail("ACTOR_RUNTIME_FACET_INVALID", `registry[${index}].onEvent must be a function`);
    }
    if (aroundProvider !== undefined && typeof aroundProvider !== "function") {
      fail("ACTOR_RUNTIME_FACET_INVALID", `registry[${index}].aroundProvider must be a function`);
    }
    if (projectAfterToolOutcome !== undefined && typeof projectAfterToolOutcome !== "function") {
      fail("ACTOR_RUNTIME_FACET_INVALID", `registry[${index}].projectAfterToolOutcome must be a function`);
    }
    const key = `${facetId}\u0000${schemaVersion}`;
    if (exact.has(key)) {
      fail("ACTOR_RUNTIME_FACET_DUPLICATE", `duplicate codec ${facetId}@${schemaVersion}`);
    }
    const entry = Object.freeze({
      facetId,
      schemaVersion,
      normalize: normalize as ActorRuntimeFacetCodecEntry["normalize"],
      ...(onEvent ? { onEvent: onEvent as ActorRuntimeFacetCodecEntry["onEvent"] } : {}),
      ...(aroundProvider ? { aroundProvider: aroundProvider as ActorRuntimeFacetCodecEntry["aroundProvider"] } : {}),
      ...(projectAfterToolOutcome ? {
        projectAfterToolOutcome: projectAfterToolOutcome as ActorRuntimeFacetCodecEntry["projectAfterToolOutcome"],
      } : {}),
    });
    exact.set(key, entry);
    const facetVersions = versions.get(facetId) ?? new Set<string>();
    facetVersions.add(schemaVersion);
    versions.set(facetId, facetVersions);
    entries.push(entry);
  }
  entries.sort((left, right) => codeUnitCompare(
    `${left.facetId}\u0000${left.schemaVersion}`,
    `${right.facetId}\u0000${right.schemaVersion}`,
  ));
  const frozenEntries = Object.freeze(entries);
  return Object.freeze({
    entries: frozenEntries,
    resolve(facetId: string, schemaVersion: string): ActorRuntimeFacetCodecEntry {
      const entry = exact.get(`${facetId}\u0000${schemaVersion}`);
      if (entry) return entry;
      const knownVersions = versions.get(facetId);
      if (knownVersions) {
        fail(
          "ACTOR_RUNTIME_FACET_SCHEMA_MISMATCH",
          `schema mismatch for facet ${facetId}: expected one of ${[...knownVersions].sort(codeUnitCompare).join(", ")}, received ${schemaVersion}`,
        );
      }
      fail("ACTOR_RUNTIME_FACET_UNKNOWN_CODEC", `unknown codec for facet ${facetId}@${schemaVersion}`);
    },
  });
}

function normalizeSelector(selector: ActorRuntimeFacetSelector): ActorRuntimeFacetSelector {
  const descriptors = ownDataDescriptors(selector, "selector");
  assertExactKeys(descriptors, ["actorKey", "facetId"], "selector");
  return Object.freeze({
    actorKey: normalizeNonEmptyString(requiredDataValue(descriptors, "actorKey", "selector"), "selector.actorKey"),
    facetId: normalizeNonEmptyString(requiredDataValue(descriptors, "facetId", "selector"), "selector.facetId"),
  });
}

function resolveOwner(runtime: ActorRuntimeFacetVmRuntime, selector: ActorRuntimeFacetSelector) {
  const owner = runtime.actors[selector.actorKey];
  if (!owner) {
    fail("ACTOR_RUNTIME_FACET_ACTOR_NOT_FOUND", `Actor ${selector.actorKey} was not found`);
  }
  return owner;
}

function normalizeReadInvocation(
  invocation: ActorRuntimeFacetReadInvocation,
): ActorRuntimeFacetReadInvocation {
  const descriptors = ownDataDescriptors(invocation, "readInvocation");
  assertExactKeys(descriptors, ["operationId", "occurredAt"], "readInvocation");
  return Object.freeze({
    operationId: normalizeNonEmptyString(
      requiredDataValue(descriptors, "operationId", "readInvocation"),
      "readInvocation.operationId",
    ),
    occurredAt: normalizeOccurredAt(
      requiredDataValue(descriptors, "occurredAt", "readInvocation"),
      "readInvocation.occurredAt",
    ),
  });
}

function normalizeEvent(event: ActorRuntimeFacetEvent): ActorRuntimeFacetEvent {
  const descriptors = ownDataDescriptors(event, "event");
  const kind = requiredDataValue(descriptors, "kind", "event");
  const operationId = normalizeNonEmptyString(
    requiredDataValue(descriptors, "operationId", "event"),
    "event.operationId",
  );
  const occurredAt = normalizeOccurredAt(
    requiredDataValue(descriptors, "occurredAt", "event"),
    "event.occurredAt",
  );
  if (kind === "beforeTurn") {
    assertExactKeys(descriptors, ["kind", "operationId", "occurredAt"], "event");
    return Object.freeze({ kind, operationId, occurredAt });
  }
  if (kind === "aroundProvider") {
    assertExactKeys(descriptors, ["kind", "operationId", "occurredAt", "providerAttempt"], "event");
    const providerAttempt = normalizeRevision(
      requiredDataValue(descriptors, "providerAttempt", "event"),
      "event.providerAttempt",
    );
    return Object.freeze({ kind, operationId, occurredAt, providerAttempt });
  }
  if (kind === "afterToolOutcome") {
    const ownerFactValue = optionalDataValue(descriptors, "ownerFact", "event");
    assertExactKeys(descriptors, [
      "kind", "operationId", "occurredAt", "toolCallId", "toolName", "recordDigest", "isError", "outcome",
      ...(ownerFactValue === undefined ? [] : ["ownerFact"]),
    ], "event");
    const toolCallId = normalizeNonEmptyString(
      requiredDataValue(descriptors, "toolCallId", "event"),
      "event.toolCallId",
    );
    const toolName = normalizeNonEmptyString(
      requiredDataValue(descriptors, "toolName", "event"),
      "event.toolName",
    );
    const recordDigest = normalizeNonEmptyString(
      requiredDataValue(descriptors, "recordDigest", "event"),
      "event.recordDigest",
    );
    const isError = requiredDataValue(descriptors, "isError", "event");
    if (typeof isError !== "boolean") {
      fail("ACTOR_RUNTIME_FACET_INVALID", "event.isError must be a boolean");
    }
    const outcome = requiredDataValue(descriptors, "outcome", "event");
    if (outcome !== "completed" && outcome !== "failed" && outcome !== "cancelled") {
      fail("ACTOR_RUNTIME_FACET_INVALID", "event.outcome is invalid");
    }
    return Object.freeze({
      kind,
      operationId,
      occurredAt,
      toolCallId,
      toolName,
      recordDigest,
      isError,
      outcome,
      ...(ownerFactValue === undefined ? {} : {
        ownerFact: normalizeClosedJson(ownerFactValue, "event.ownerFact", DEFAULT_MAX_VALUE_DEPTH),
      }),
    });
  }
  fail("ACTOR_RUNTIME_FACET_INVALID", `event.kind ${String(kind)} is invalid`);
}

export function normalizeActorRuntimeFacet(
  runtime: ActorRuntimeFacetVmRuntime,
  input: unknown,
  config: ActorRuntimeFacetProcessorConfig = {},
): ActorRuntimeFacetEnvelope {
  const maxDepth = normalizeProcessorConfig(config);
  return normalizeEnvelopeWithRegistry(
    runtime.runtimeContext.actorFacetRuntime,
    input,
    maxDepth,
    "facet",
  );
}

export function readActorRuntimeFacet(
  runtime: ActorRuntimeFacetVmRuntime,
  selectorInput: ActorRuntimeFacetSelector,
  invocation: ActorRuntimeFacetReadInvocation,
  config: ActorRuntimeFacetProcessorConfig = {},
): ActorRuntimeFacetEnvelope | null {
  normalizeProcessorConfig(config);
  normalizeReadInvocation(invocation);
  const selector = normalizeSelector(selectorInput);
  const owner = resolveOwner(runtime, selector);
  const envelope = owner.runtimeFacets[selector.facetId];
  if (!envelope) return null;
  return normalizeActorRuntimeFacet(runtime, envelope, config);
}

export function replaceActorRuntimeFacet(
  runtime: ActorRuntimeFacetVmRuntime,
  selectorInput: ActorRuntimeFacetSelector,
  invocation: ActorRuntimeFacetReplaceInvocation,
  config: ActorRuntimeFacetProcessorConfig = {},
): ActorRuntimeFacetEnvelope {
  const maxDepth = normalizeProcessorConfig(config);
  const selector = normalizeSelector(selectorInput);
  const descriptors = ownDataDescriptors(invocation, "replaceInvocation");
  assertExactKeys(descriptors, ["expectedRevision", "nextValue", "reason"], "replaceInvocation");
  const expectedRevision = normalizeRevision(
    requiredDataValue(descriptors, "expectedRevision", "replaceInvocation"),
    "replaceInvocation.expectedRevision",
  );
  const reason = normalizeNonEmptyString(
    requiredDataValue(descriptors, "reason", "replaceInvocation"),
    "replaceInvocation.reason",
  );
  void reason;
  const owner = resolveOwner(runtime, selector);
  const current = owner.runtimeFacets[selector.facetId];
  if (!current) {
    fail("ACTOR_RUNTIME_FACET_NOT_FOUND", `facet ${selector.facetId} was not found on Actor ${selector.actorKey}`);
  }
  if (current.revision !== expectedRevision) {
    fail(
      "ACTOR_RUNTIME_FACET_REVISION_CONFLICT",
      `revision conflict for ${selector.actorKey}/${selector.facetId}: expected ${expectedRevision}, current ${current.revision}`,
    );
  }

  const next = normalizeEnvelopeWithRegistry(
    runtime.runtimeContext.actorFacetRuntime,
    {
      facetId: current.facetId,
      schemaVersion: current.schemaVersion,
      revision: expectedRevision + 1,
      value: requiredDataValue(descriptors, "nextValue", "replaceInvocation"),
    },
    maxDepth,
    "replacement",
  );
  owner.runtimeFacets = Object.freeze(Object.fromEntries(
    Object.entries({ ...owner.runtimeFacets, [selector.facetId]: next })
      .sort(([left], [right]) => codeUnitCompare(left, right)),
  ));
  return next;
}

export function dispatchActorRuntimeFacetEvent(
  runtime: ActorRuntimeFacetVmRuntime,
  selectorInput: ActorRuntimeFacetSelector,
  event: ActorRuntimeFacetEvent,
  config: ActorRuntimeFacetProcessorConfig = {},
): ActorRuntimeFacetEnvelope | null {
  normalizeProcessorConfig(config);
  const normalizedEvent = normalizeEvent(event);
  const selector = normalizeSelector(selectorInput);
  const current = readActorRuntimeFacet(
    runtime,
    selector,
    { operationId: normalizedEvent.operationId, occurredAt: normalizedEvent.occurredAt },
    config,
  );
  if (!current) return null;
  const entry = runtime.runtimeContext.actorFacetRuntime.resolve(current.facetId, current.schemaVersion);
  if (!entry.onEvent) return current;
  const candidate = entry.onEvent(Object.freeze({ selector, envelope: current, event: normalizedEvent }));
  if (candidate === null) return current;
  return replaceActorRuntimeFacet(runtime, selector, candidate, config);
}

/**
 * Projects runtime-only terminal output through the selected domain codec, then
 * dispatches only the resulting closed fact and ToolCall digest to the facet.
 */
export function dispatchActorRuntimeFacetToolOutcome(
  runtime: ActorRuntimeFacetVmRuntime,
  selectorInput: ActorRuntimeFacetSelector,
  input: ActorRuntimeFacetToolOutcomeProjectionInput,
  config: ActorRuntimeFacetProcessorConfig = {},
): ActorRuntimeFacetEnvelope | null {
  const selector = normalizeSelector(selectorInput);
  const current = readActorRuntimeFacet(
    runtime,
    selector,
    { operationId: input.operationId, occurredAt: input.occurredAt },
    config,
  );
  if (!current) return null;
  const entry = runtime.runtimeContext.actorFacetRuntime.resolve(current.facetId, current.schemaVersion);
  const ownerFact = entry.projectAfterToolOutcome?.(input);
  return dispatchActorRuntimeFacetEvent(runtime, selector, {
    kind: "afterToolOutcome",
    operationId: input.operationId,
    occurredAt: input.occurredAt,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    recordDigest: input.recordDigest,
    isError: input.isError,
    outcome: input.outcome,
    ...(ownerFact === undefined ? {} : { ownerFact }),
  }, config);
}

export async function runActorRuntimeFacetProviderBoundary<T>(
  runtime: ActorRuntimeFacetProviderBoundaryRuntime<T>,
  selectorInput: ActorRuntimeFacetSelector,
  event: Extract<ActorRuntimeFacetEvent, { kind: "aroundProvider" }>,
  config: ActorRuntimeFacetProcessorConfig = {},
): Promise<T> {
  normalizeProcessorConfig(config);
  const normalizedEvent = normalizeEvent(event);
  if (normalizedEvent.kind !== "aroundProvider") {
    fail("ACTOR_RUNTIME_FACET_INVALID", "provider boundary requires an aroundProvider event");
  }
  const selector = normalizeSelector(selectorInput);
  const current = dispatchActorRuntimeFacetEvent(runtime, selector, normalizedEvent, config);
  if (!current) return runtime.providerBoundary.run();
  const entry = runtime.runtimeContext.actorFacetRuntime.resolve(current.facetId, current.schemaVersion);
  if (!entry.aroundProvider) return runtime.providerBoundary.run();
  return entry.aroundProvider(
    Object.freeze({ selector, envelope: current, event: normalizedEvent }),
    runtime,
  );
}
