import type { AiAgentMailboxSchema } from "./AiAgentActor";

export type DurableControlSignalKind =
  | "mailbox_enqueue"
  | "async_completed"
  | "interrupt_requested"
  | "resume_requested"
  | "suspend_recorded"
  | "late_completion_ignored";

export type DurableControlSignalClass = "interrupt" | "wake" | "ordinary";

export type DurableControlSignalMailboxKind = keyof AiAgentMailboxSchema;

export type DurableControlSignalData = {
  eventId: string;
  sequence?: number;
  actorKey: string;
  actorId?: string;
  fiberId?: string;
  mailboxKind?: DurableControlSignalMailboxKind;
  signalKind: DurableControlSignalKind;
  signalClass: DurableControlSignalClass;
  priority: number;
  opId?: string;
  toolCallId?: string;
  causationId?: string;
  correlationId?: string;
  idempotencyKey: string;
  createdAt: number;
  payload?: unknown;
  payloadSummary?: DurableControlSignalPayloadSummary;
  payloadRef?: DurableControlSignalPayloadRef;
};

export type DurableControlSignalPayloadSummary = {
  byteLength: number;
  digest: string;
  valueKind: string;
};

export type DurableControlSignalPayloadRef = {
  kind: "actor_mailbox" | "artifact" | "conversation" | "external";
  ref: string;
};

export type DurableControlSignalSnapshotData = Omit<DurableControlSignalData, "payload"> & {
  payload?: never;
};

export type DurableControlSignalConsumedCheckpoint = {
  sequence: number;
  eventId?: string;
  updatedAt?: number;
};

export type DurableControlSignalConsumedTombstone = Omit<DurableControlSignalSnapshotData, "payloadSummary" | "payloadRef"> & {
  consumedAt: number;
  payloadSummary?: DurableControlSignalPayloadSummary;
  payloadRef?: DurableControlSignalPayloadRef;
};

export type DurableControlSignalInput = Omit<
  Partial<DurableControlSignalData>,
  "eventId" | "idempotencyKey" | "signalClass" | "priority" | "createdAt"
> & {
  eventId?: string;
  actorKey: string;
  signalKind: DurableControlSignalKind;
  idempotencyKey?: string;
  signalClass?: DurableControlSignalClass;
  priority?: number;
  createdAt?: number;
};

export type DurableControlSignalStore = {
  events: DurableControlSignalData[];
  idempotencyIndex: Record<string, string>;
  consumedEventIds: Record<string, true>;
  consumedCheckpoint?: DurableControlSignalConsumedCheckpoint;
  consumedTombstones?: Record<string, DurableControlSignalConsumedTombstone>;
  nextSequence?: number;
};

export type DurableControlSignalSnapshotStore = Omit<DurableControlSignalStore, "events"> & {
  events: DurableControlSignalSnapshotData[];
};
