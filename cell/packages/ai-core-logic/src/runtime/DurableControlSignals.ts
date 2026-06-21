import type {
  DurableControlSignalClass,
  DurableControlSignalConsumedTombstone,
  DurableControlSignalData,
  DurableControlSignalInput,
  DurableControlSignalMailboxKind,
  DurableControlSignalPayloadSummary,
  DurableControlSignalSnapshotData,
  DurableControlSignalSnapshotStore,
  DurableControlSignalStore,
} from "@cell/ai-core-contract/runtime/DurableControlSignal";

const INTERRUPT_PRIORITY = 0;
const WAKE_PRIORITY = 10;
const ORDINARY_PRIORITY = 100;
const RECENT_CONSUMED_TOMBSTONE_LIMIT = 128;

const WAKE_MAILBOXES = new Set<DurableControlSignalMailboxKind>([
  "control",
  "toolResult",
  "asyncCompletion",
  "childDone",
  "memberCoordination",
  "humanInput",
  "memberChatInbox",
  "heartbeat",
]);

export function createEmptyDurableControlSignalStore(): DurableControlSignalStore {
  return {
    events: [],
    idempotencyIndex: {},
    consumedEventIds: {},
    consumedCheckpoint: { sequence: 0 },
    consumedTombstones: {},
    nextSequence: 1,
  };
}

export function cloneDurableControlSignalStore(
  store: DurableControlSignalStore | null | undefined,
): DurableControlSignalStore {
  const events = (store?.events ?? []).map((event) => ({ ...event }));
  const consumedTombstones = { ...(store?.consumedTombstones ?? {}) };
  return {
    events,
    idempotencyIndex: { ...(store?.idempotencyIndex ?? {}) },
    consumedEventIds: { ...(store?.consumedEventIds ?? {}) },
    consumedCheckpoint: store?.consumedCheckpoint ? { ...store.consumedCheckpoint } : { sequence: inferConsumedCheckpointSequence(store) },
    consumedTombstones,
    nextSequence: inferNextSequence(store, events),
  };
}

export function classifyDurableControlSignal(input: Pick<DurableControlSignalInput, "signalKind" | "mailboxKind" | "payload">): DurableControlSignalClass {
  if (input.signalKind === "interrupt_requested") return "interrupt";

  const payloadKind = typeof input.payload === "object" && input.payload !== null && "kind" in input.payload
    ? String((input.payload as { kind?: unknown }).kind ?? "")
    : "";
  if (input.mailboxKind === "control" && (payloadKind === "cancel_requested" || payloadKind === "shutdown_requested")) {
    return "interrupt";
  }

  if (input.signalKind === "async_completed" || input.signalKind === "resume_requested") return "wake";
  if (input.signalKind === "mailbox_enqueue" && input.mailboxKind && WAKE_MAILBOXES.has(input.mailboxKind)) return "wake";

  return "ordinary";
}

export function priorityForDurableControlSignal(signalClass: DurableControlSignalClass): number {
  if (signalClass === "interrupt") return INTERRUPT_PRIORITY;
  if (signalClass === "wake") return WAKE_PRIORITY;
  return ORDINARY_PRIORITY;
}

function buildIdempotencyKey(input: DurableControlSignalInput): string {
  if (input.idempotencyKey) return input.idempotencyKey;
  return [
    input.actorKey,
    input.fiberId ?? "",
    input.signalKind,
    input.mailboxKind ?? "",
    input.opId ?? "",
    input.toolCallId ?? "",
    input.correlationId ?? "",
  ].join(":");
}

export function normalizeDurableControlSignal(
  input: DurableControlSignalInput,
  options: { sequence?: number; now?: number } = {},
): DurableControlSignalData {
  const signalClass = input.signalClass ?? classifyDurableControlSignal(input);
  const idempotencyKey = buildIdempotencyKey(input);
  const eventId = input.eventId ?? `ctrl_${options.sequence ?? 1}`;

  return {
    eventId,
    sequence: options.sequence,
    actorKey: input.actorKey,
    actorId: input.actorId,
    fiberId: input.fiberId,
    mailboxKind: input.mailboxKind,
    signalKind: input.signalKind,
    signalClass,
    priority: input.priority ?? priorityForDurableControlSignal(signalClass),
    opId: input.opId,
    toolCallId: input.toolCallId,
    causationId: input.causationId,
    correlationId: input.correlationId,
    idempotencyKey,
    createdAt: input.createdAt ?? options.now ?? Date.now(),
    payload: input.payload,
    payloadSummary: input.payloadSummary,
    payloadRef: input.payloadRef,
  };
}

function inferEventSequence(event: Pick<DurableControlSignalData, "eventId" | "sequence">): number {
  if (typeof event.sequence === "number" && Number.isFinite(event.sequence)) return event.sequence;
  const match = /^ctrl_(\d+)$/.exec(event.eventId);
  return match ? Number(match[1]) : 0;
}

function inferConsumedCheckpointSequence(store: DurableControlSignalStore | null | undefined): number {
  if (typeof store?.consumedCheckpoint?.sequence === "number") return store.consumedCheckpoint.sequence;
  return Object.keys(store?.consumedEventIds ?? {}).reduce((max, eventId) => {
    const event = store?.events?.find((candidate) => candidate.eventId === eventId);
    const sequence = event ? inferEventSequence(event) : inferEventSequence({ eventId });
    return Math.max(max, sequence);
  }, 0);
}

function inferNextSequence(
  store: DurableControlSignalStore | null | undefined,
  events: DurableControlSignalData[] = store?.events ?? [],
): number {
  if (typeof store?.nextSequence === "number" && Number.isFinite(store.nextSequence) && store.nextSequence > 0) {
    return store.nextSequence;
  }
  const eventMax = events.reduce((max, event) => Math.max(max, inferEventSequence(event)), 0);
  const tombstoneMax = Object.values(store?.consumedTombstones ?? {}).reduce((max, event) => Math.max(max, inferEventSequence(event)), 0);
  return Math.max(eventMax, tombstoneMax, inferConsumedCheckpointSequence(store)) + 1;
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map((item) => normalize(item));
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return String(value);
  }
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function summarizePayload(payload: unknown): DurableControlSignalPayloadSummary | undefined {
  if (payload === undefined) return undefined;
  const serialized = stableStringify(payload);
  return {
    byteLength: new TextEncoder().encode(serialized).byteLength,
    digest: hashString(serialized),
    valueKind: payload === null ? "null" : Array.isArray(payload) ? "array" : typeof payload,
  };
}

function toBoundedSignalSnapshot(event: DurableControlSignalData): DurableControlSignalSnapshotData {
  const summary = event.payloadSummary ?? summarizePayload(event.payload);
  return {
    eventId: event.eventId,
    sequence: inferEventSequence(event),
    actorKey: event.actorKey,
    actorId: event.actorId,
    fiberId: event.fiberId,
    mailboxKind: event.mailboxKind,
    signalKind: event.signalKind,
    signalClass: event.signalClass,
    priority: event.priority,
    opId: event.opId,
    toolCallId: event.toolCallId,
    causationId: event.causationId,
    correlationId: event.correlationId,
    idempotencyKey: event.idempotencyKey,
    createdAt: event.createdAt,
    payloadSummary: summary,
    payloadRef: event.payloadRef,
  };
}

function toConsumedTombstone(event: DurableControlSignalData, consumedAt: number): DurableControlSignalConsumedTombstone {
  return {
    ...toBoundedSignalSnapshot(event),
    consumedAt,
  };
}

function pruneRecentConsumedTombstones(store: DurableControlSignalStore): void {
  const tombstones = Object.values(store.consumedTombstones ?? {})
    .sort((a, b) => inferEventSequence(b) - inferEventSequence(a) || b.consumedAt - a.consumedAt);
  const keep = new Set(tombstones.slice(0, RECENT_CONSUMED_TOMBSTONE_LIMIT).map((event) => event.eventId));
  for (const eventId of Object.keys(store.consumedTombstones ?? {})) {
    if (!keep.has(eventId)) {
      delete store.consumedTombstones?.[eventId];
      delete store.consumedEventIds[eventId];
    }
  }
  const keepIds = new Set(Object.values(store.consumedTombstones ?? {}).map((event) => event.eventId));
  for (const [key, eventId] of Object.entries(store.idempotencyIndex)) {
    const isPending = store.events.some((event) => event.eventId === eventId);
    if (!isPending && !keepIds.has(eventId)) delete store.idempotencyIndex[key];
  }
}

function advanceConsumedCheckpoint(store: DurableControlSignalStore, updatedAt: number): void {
  let sequence = store.consumedCheckpoint?.sequence ?? 0;
  let eventId = store.consumedCheckpoint?.eventId;
  const consumedBySequence = new Map(
    Object.values(store.consumedTombstones ?? {}).map((event) => [inferEventSequence(event), event.eventId]),
  );
  while (consumedBySequence.has(sequence + 1)) {
    sequence += 1;
    eventId = consumedBySequence.get(sequence);
  }
  store.consumedCheckpoint = {
    sequence,
    eventId,
    updatedAt,
  };
}

export function emitDurableControlSignal(
  store: DurableControlSignalStore,
  input: DurableControlSignalInput,
  options: { now?: number } = {},
): { store: DurableControlSignalStore; signal: DurableControlSignalData; created: boolean } {
  const idempotencyKey = buildIdempotencyKey(input);
  const existingEventId = store.idempotencyIndex[idempotencyKey];
  if (existingEventId) {
    const existing = store.events.find((event) => event.eventId === existingEventId);
    if (existing) return { store, signal: existing, created: false };
    const tombstone = store.consumedTombstones?.[existingEventId];
    if (tombstone) return { store, signal: tombstone as DurableControlSignalData, created: false };
  }

  const sequence = store.nextSequence ?? inferNextSequence(store);
  const signal = normalizeDurableControlSignal(
    {
      ...input,
      idempotencyKey,
    },
    {
      sequence,
      now: options.now,
    },
  );
  store.events.push(signal);
  store.idempotencyIndex[signal.idempotencyKey] = signal.eventId;
  store.nextSequence = sequence + 1;
  return { store, signal, created: true };
}

export function markDurableControlSignalConsumed(
  store: DurableControlSignalStore,
  eventId: string,
): DurableControlSignalStore {
  const event = store.events.find((candidate) => candidate.eventId === eventId);
  if (!event) return store;

  const consumedAt = Date.now();
  store.consumedEventIds[eventId] = true;
  store.consumedTombstones = {
    ...(store.consumedTombstones ?? {}),
    [eventId]: toConsumedTombstone(event, consumedAt),
  };
  store.events = store.events.filter((candidate) => candidate.eventId !== eventId);
  advanceConsumedCheckpoint(store, consumedAt);
  pruneRecentConsumedTombstones(store);
  return store;
}

export function getPendingDurableControlSignals(
  store: DurableControlSignalStore,
  filter: { actorKey?: string; fiberId?: string } = {},
): DurableControlSignalData[] {
  return store.events
    .filter((event) => !store.consumedEventIds[event.eventId])
    .filter((event) => !filter.actorKey || event.actorKey === filter.actorKey)
    .filter((event) => !filter.fiberId || event.fiberId === filter.fiberId)
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId));
}

export function serializeDurableControlSignalStoreForSnapshot(
  store: DurableControlSignalStore | null | undefined,
): DurableControlSignalSnapshotStore {
  const cloned = cloneDurableControlSignalStore(store);
  for (const event of store?.events ?? []) {
    if (store?.consumedEventIds?.[event.eventId]) {
      markDurableControlSignalConsumed(cloned, event.eventId);
    }
  }
  const pendingEvents = (store?.events ?? [])
    .filter((event) => !store?.consumedEventIds?.[event.eventId])
    .map((event) => toBoundedSignalSnapshot(event));
  const recentEventIds = new Set([
    ...pendingEvents.map((event) => event.eventId),
    ...Object.keys(cloned.consumedTombstones ?? {}),
  ]);
  return {
    events: pendingEvents,
    idempotencyIndex: Object.fromEntries(
      Object.entries(cloned.idempotencyIndex).filter(([, eventId]) => recentEventIds.has(eventId)),
    ),
    consumedEventIds: Object.fromEntries(
      Object.keys(cloned.consumedTombstones ?? {}).map((eventId) => [eventId, true] as const),
    ),
    consumedCheckpoint: cloned.consumedCheckpoint ?? { sequence: inferConsumedCheckpointSequence(store) },
    consumedTombstones: cloned.consumedTombstones ?? {},
    nextSequence: cloned.nextSequence ?? inferNextSequence(store),
  };
}

export function hydrateDurableControlSignalStoreFromSnapshot(
  store: DurableControlSignalStore | null | undefined,
): DurableControlSignalStore {
  const cloned = cloneDurableControlSignalStore(store);
  cloned.events = cloned.events.map((event) => ({
    ...event,
    sequence: inferEventSequence(event),
    payloadSummary: event.payloadSummary ?? summarizePayload(event.payload),
  }));
  cloned.nextSequence = inferNextSequence(cloned);
  cloned.consumedCheckpoint = cloned.consumedCheckpoint ?? { sequence: inferConsumedCheckpointSequence(cloned) };
  cloned.consumedTombstones = cloned.consumedTombstones ?? {};
  return cloned;
}
