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
};
