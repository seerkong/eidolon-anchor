import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import { ensureVmSessionState, type AiAgentVm, type VmDetachedActorRecord } from "@cell/ai-core-logic/runtime/runtime";

export const DETACHED_ACTOR_KINDS = {
  delegate: "delegate",
  bash: "bash",
  toolCall: "tool_call",
} as const;

export type DetachedActorKind =
  (typeof DETACHED_ACTOR_KINDS)[keyof typeof DETACHED_ACTOR_KINDS];

export const DETACHED_ACTOR_STATUSES = {
  pending: "pending",
  running: "running",
  suspended: "suspended",
  interrupted: "interrupted",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export type DetachedActorStatus =
  (typeof DETACHED_ACTOR_STATUSES)[keyof typeof DETACHED_ACTOR_STATUSES];

export type DetachedActorRecord = VmDetachedActorRecord;

function toDetachedRecordFromActor(actor: AiAgentActor): DetachedActorRecord | null {
  const task = actor.detachedTask;
  if (!task) return null;
  return {
    taskId: task.taskId,
    kind: task.kind,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    toolCallId: task.toolCallId,
    parentFiberId: task.parentFiberId,
    childFiberId: task.childFiberId,
    childActorKey: actor.key,
    childActorId: actor.id,
    outputText: task.outputText,
    error: task.error,
  };
}

export class DetachedActorRegistry {
  constructor(private readonly vm: AiAgentVm) {}

  private get taskStore(): Record<string, DetachedActorRecord> {
    return ensureVmSessionState(this.vm).detachedActors;
  }

  private cloneRecord(record: DetachedActorRecord): DetachedActorRecord {
    return { ...record };
  }

  private findDetachedActor(taskId: string): AiAgentActor | null {
    for (const actor of Object.values(this.vm.actors)) {
      if (actor.type !== "detached") continue;
      if (actor.detachedTask?.taskId !== taskId) continue;
      return actor;
    }
    return null;
  }

  private syncActorFromRecord(record: DetachedActorRecord): void {
    const actor = this.vm.actors[record.childActorKey ?? ""];
    if (!actor || actor.type !== "detached") return;
    if (record.childActorId && actor.id !== record.childActorId) return;
    actor.detachedTask = {
      taskId: record.taskId,
      kind: record.kind,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      toolCallId: record.toolCallId,
      parentFiberId: record.parentFiberId,
      childFiberId: record.childFiberId,
      outputText: record.outputText,
      error: record.error,
    };
  }

  create(record: Omit<DetachedActorRecord, "createdAt" | "updatedAt">): DetachedActorRecord {
    const now = Date.now();
    const next: DetachedActorRecord = {
      ...record,
      createdAt: now,
      updatedAt: now,
    };
    this.taskStore[next.taskId] = next;
    this.syncActorFromRecord(next);
    return this.cloneRecord(next);
  }

  get(taskId: string): DetachedActorRecord | null {
    const actor = this.findDetachedActor(taskId);
    const actorRecord = actor ? toDetachedRecordFromActor(actor) : null;
    if (actorRecord) {
      this.taskStore[taskId] = actorRecord;
      return this.cloneRecord(actorRecord);
    }
    const record = this.taskStore[taskId];
    return record ? this.cloneRecord(record) : null;
  }

  list(): DetachedActorRecord[] {
    const merged = new Map<string, DetachedActorRecord>();
    for (const record of Object.values(this.taskStore)) {
      merged.set(record.taskId, this.cloneRecord(record));
    }
    for (const actor of Object.values(this.vm.actors)) {
      const actorRecord = toDetachedRecordFromActor(actor);
      if (!actorRecord) continue;
      merged.set(actorRecord.taskId, actorRecord);
      this.taskStore[actorRecord.taskId] = this.cloneRecord(actorRecord);
    }
    return Array.from(merged.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => this.cloneRecord(record));
  }

  replaceAll(records: DetachedActorRecord[]): DetachedActorRecord[] {
    const store = this.taskStore;
    for (const key of Object.keys(store)) {
      delete store[key];
    }
    for (const record of records) {
      store[record.taskId] = this.cloneRecord(record);
      this.syncActorFromRecord(record);
    }
    return this.list();
  }

  restoreAll(records: DetachedActorRecord[]): DetachedActorRecord[] {
    return this.replaceAll(records);
  }

  update(taskId: string, patch: Partial<Omit<DetachedActorRecord, "taskId" | "createdAt">>): DetachedActorRecord | null {
    const actor = this.findDetachedActor(taskId);
    if (actor?.detachedTask) {
      const nextTask = {
        ...actor.detachedTask,
        ...patch,
        updatedAt: Date.now(),
      };
      actor.detachedTask = nextTask;
      const next = toDetachedRecordFromActor(actor);
      if (!next) return null;
      this.taskStore[taskId] = next;
      return this.cloneRecord(next);
    }
    const existing = this.taskStore[taskId];
    if (!existing) return null;
    const next: DetachedActorRecord = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    };
    this.taskStore[taskId] = next;
    return this.cloneRecord(next);
  }
}

const REGISTRY_BY_VM = new WeakMap<AiAgentVm, DetachedActorRegistry>();

export function getDetachedActorRegistry(vm: AiAgentVm): DetachedActorRegistry {
  const existing = REGISTRY_BY_VM.get(vm);
  if (existing) {
    return existing;
  }
  const created = new DetachedActorRegistry(vm);
  REGISTRY_BY_VM.set(vm, created);
  return created;
}
