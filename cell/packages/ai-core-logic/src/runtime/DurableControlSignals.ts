import type {
  DurableControlSignalClass,
  DurableControlSignalData,
  DurableControlSignalInput,
  DurableControlSignalMailboxKind,
  DurableControlSignalStore,
} from "@cell/ai-core-contract/runtime/DurableControlSignal";

const INTERRUPT_PRIORITY = 0;
const WAKE_PRIORITY = 10;
const ORDINARY_PRIORITY = 100;

const WAKE_MAILBOXES = new Set<DurableControlSignalMailboxKind>([
  "control",
  "childDone",
  "coordination",
  "memberInbox",
  "heartbeatWake",
  "humanInput",
  "toolResult",
]);

export function createEmptyDurableControlSignalStore(): DurableControlSignalStore {
  return {
    events: [],
    idempotencyIndex: {},
    consumedEventIds: {},
  };
}

export function cloneDurableControlSignalStore(
  store: DurableControlSignalStore | null | undefined,
): DurableControlSignalStore {
  return {
    events: (store?.events ?? []).map((event) => ({ ...event })),
    idempotencyIndex: { ...(store?.idempotencyIndex ?? {}) },
    consumedEventIds: { ...(store?.consumedEventIds ?? {}) },
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
  }

  const signal = normalizeDurableControlSignal(
    {
      ...input,
      idempotencyKey,
    },
    {
      sequence: store.events.length + 1,
      now: options.now,
    },
  );
  store.events.push(signal);
  store.idempotencyIndex[signal.idempotencyKey] = signal.eventId;
  return { store, signal, created: true };
}

export function markDurableControlSignalConsumed(
  store: DurableControlSignalStore,
  eventId: string,
): DurableControlSignalStore {
  if (store.events.some((event) => event.eventId === eventId)) {
    store.consumedEventIds[eventId] = true;
  }
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
