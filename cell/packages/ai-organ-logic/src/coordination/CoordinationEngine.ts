import { randomUUID } from "crypto";

import {
  AI_AGENT_COORDINATION_DECISIONS,
  AI_AGENT_COORDINATION_ENVELOPE,
  AI_AGENT_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_NAMES,
  AI_AGENT_COORDINATION_STATUSES,
  isAiAgentCoordinationKind,
  isAiAgentCoordinationName,
  type AiAgentCoordinationDecision,
  type AiAgentCoordinationKind,
  type AiAgentCoordinationName,
  type AiAgentCoordinationStatus,
} from "@cell/ai-core-logic";
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";

export type CoordinationName = AiAgentCoordinationName;
export type CoordinationKind = AiAgentCoordinationKind;
export type CoordinationStatus = AiAgentCoordinationStatus;
export type CoordinationDecision = AiAgentCoordinationDecision;
export type CoordinationRecordSource = "actor_owned" | "pending_mailbox" | "legacy_cache";

export type CoordinationEnvelope = {
  type: "rad_member_coordination";
  v: 1;
  coordination: CoordinationName;
  kind: CoordinationKind;
  request_id: string;
  payload: any;
};

export type CoordinationRecord = {
  request_id: string;
  coordination: CoordinationName;
  kind: CoordinationKind;
  status: CoordinationStatus;
  decision?: CoordinationDecision;
  created_at: number;
  updated_at: number;
  last_from?: string;
  last_ts?: number;

  plan?: string;
  feedback?: string;
  reason?: string;
};

export type IngestMemberInboxParams = {
  from: string;
  text: string;
  ts: number;
};

export type IngestResult =
  | { handled: false }
  | {
      handled: true;
      request_id: string;
      coordination: CoordinationName;
      kind: CoordinationKind;
      status: CoordinationStatus;
      decision?: CoordinationDecision;
      injectText?: string;
    };

export type ResolvedCoordinationRecord = {
  record: CoordinationRecord;
  source: CoordinationRecordSource;
};

function nowMs(): number {
  return Date.now();
}

function makeRequestId(): string {
  return `req_${randomUUID()}`;
}

function safeParseJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isCoordinationEnvelope(value: any): value is CoordinationEnvelope {
  const coordination = typeof value?.coordination === "string" ? value.coordination : value?.protocol;
  return (
    value &&
    typeof value === "object" &&
    value.type === AI_AGENT_COORDINATION_ENVELOPE.type &&
    value.v === AI_AGENT_COORDINATION_ENVELOPE.version &&
    typeof value.request_id === "string" &&
    isAiAgentCoordinationName(coordination) &&
    isAiAgentCoordinationKind(value.kind)
  );
}

export class CoordinationEngine {
  private readonly legacyStoreByVm = new WeakMap<AiAgentVm, Record<string, CoordinationRecord>>();

  private getLegacyStore(vm: AiAgentVm): Record<string, CoordinationRecord> {
    const existing = this.legacyStoreByVm.get(vm);
    if (existing) {
      return existing;
    }
    const created: Record<string, CoordinationRecord> = {};
    this.legacyStoreByVm.set(vm, created);
    return created;
  }

  private cloneRecord(record: CoordinationRecord): CoordinationRecord {
    return { ...record };
  }

  private mergeRecords(primary: CoordinationRecord, secondary?: CoordinationRecord | null): CoordinationRecord {
    if (!secondary) {
      return this.cloneRecord(primary);
    }
    return {
      ...secondary,
      ...primary,
      created_at: typeof secondary.created_at === "number" ? secondary.created_at : primary.created_at,
      updated_at: Math.max(primary.updated_at, secondary.updated_at),
      last_from: secondary.last_from ?? primary.last_from,
      last_ts: secondary.last_ts ?? primary.last_ts,
      plan: secondary.plan ?? primary.plan,
      feedback: secondary.feedback ?? primary.feedback,
      reason: secondary.reason ?? primary.reason,
    };
  }

  private toActorOwnedRecord(actor: AiAgentActor, coordination: CoordinationName): CoordinationRecord | null {
    if (coordination === AI_AGENT_COORDINATION_NAMES.planApproval && actor.planApproval?.requestId) {
      return {
        request_id: actor.planApproval.requestId,
        coordination,
        kind: actor.planApproval.kind ?? AI_AGENT_COORDINATION_KINDS.planRequest,
        status: actor.planApproval.status,
        decision: actor.planApproval.decision,
        created_at: actor.planApproval.updatedAt,
        updated_at: actor.planApproval.updatedAt,
      };
    }

    if (coordination === AI_AGENT_COORDINATION_NAMES.shutdown && actor.shutdownCoordination?.requestId) {
      return {
        request_id: actor.shutdownCoordination.requestId,
        coordination,
        kind: actor.shutdownCoordination.kind ?? AI_AGENT_COORDINATION_KINDS.shutdownRequest,
        status: actor.shutdownCoordination.status,
        decision: actor.shutdownCoordination.decision,
        created_at: actor.shutdownCoordination.updatedAt,
        updated_at: actor.shutdownCoordination.updatedAt,
      };
    }

    return null;
  }

  private findActorOwnedRecord(vm: AiAgentVm, request_id: string): CoordinationRecord | null {
    for (const actor of Object.values(vm.actors)) {
      const planApproval = this.toActorOwnedRecord(actor, AI_AGENT_COORDINATION_NAMES.planApproval);
      if (planApproval?.request_id === request_id) {
        return planApproval;
      }

      const shutdown = this.toActorOwnedRecord(actor, AI_AGENT_COORDINATION_NAMES.shutdown);
      if (shutdown?.request_id === request_id) {
        return shutdown;
      }
    }
    return null;
  }

  private collectPendingMailboxRecords(vm: AiAgentVm): Map<string, CoordinationRecord> {
    const merged = new Map<string, CoordinationRecord>();

    for (const actor of Object.values(vm.actors)) {
      for (const mailboxTag of ["coordination", "memberInbox"] as const) {
        const pending = actor.peekMailbox(mailboxTag) as Array<{ from?: string; text?: string; ts?: number }>;
        for (const payload of pending) {
          const text = String(payload?.text ?? "");
          if (!text) continue;
          const env = this.parseEnvelopeText(text);
          if (!env) continue;

          const request_id = String(env.request_id);
          const from = String(payload?.from ?? "");
          const ts = typeof payload?.ts === "number" ? payload.ts : nowMs();
          const existing = merged.get(request_id);
          const base: CoordinationRecord = {
            request_id,
            coordination: env.coordination,
            kind: env.kind,
            status: existing?.status ?? AI_AGENT_COORDINATION_STATUSES.pending,
            decision: existing?.decision,
            created_at: existing?.created_at ?? ts,
            updated_at: ts,
            last_from: from,
            last_ts: ts,
            plan: existing?.plan,
            feedback: existing?.feedback,
            reason: existing?.reason,
          };
          merged.set(request_id, this.applyEnvelope(base, { coordination: env.coordination, kind: env.kind, payload: env.payload ?? {} }));
        }
      }
    }

    return merged;
  }

  __resetForTest(): void {
    // No-op now that coordination state is owned by each AiAgentVm.
  }

  makeOutbound(
    params:
      | { coordination: CoordinationName; kind: CoordinationKind; payload: any }
      | { coordination: CoordinationName; kind: CoordinationKind; request_id: string; payload: any },
  ): { request_id: string; text: string } {
    const request_id = "request_id" in params ? params.request_id : makeRequestId();
    const env: CoordinationEnvelope = {
      type: AI_AGENT_COORDINATION_ENVELOPE.type,
      v: AI_AGENT_COORDINATION_ENVELOPE.version,
      coordination: params.coordination,
      kind: params.kind,
      request_id,
      payload: params.payload ?? {},
    };
    return { request_id, text: JSON.stringify(env) };
  }

  resolve(vm: AiAgentVm, request_id: string): ResolvedCoordinationRecord | null {
    const storeRecord = this.getLegacyStore(vm)[request_id];
    const pendingMailboxRecord = this.collectPendingMailboxRecords(vm).get(request_id) ?? null;
    const actorOwnedRecord = this.findActorOwnedRecord(vm, request_id);
    if (actorOwnedRecord) {
      return {
        record: this.mergeRecords(actorOwnedRecord, storeRecord),
        source: "actor_owned",
      };
    }
    if (pendingMailboxRecord) {
      return {
        record: this.mergeRecords(pendingMailboxRecord, storeRecord),
        source: "pending_mailbox",
      };
    }
    return storeRecord
      ? {
          record: this.cloneRecord(storeRecord),
          source: "legacy_cache",
        }
      : null;
  }

  get(vm: AiAgentVm, request_id: string): CoordinationRecord | null {
    return this.resolve(vm, request_id)?.record ?? null;
  }

  list(vm: AiAgentVm): CoordinationRecord[] {
    const merged = new Map<string, CoordinationRecord>();

    for (const record of Object.values(this.getLegacyStore(vm))) {
      merged.set(record.request_id, this.cloneRecord(record));
    }

    for (const record of this.collectPendingMailboxRecords(vm).values()) {
      merged.set(
        record.request_id,
        this.mergeRecords(record, merged.get(record.request_id)),
      );
    }

    for (const actor of Object.values(vm.actors)) {
      for (const protocol of [AI_AGENT_COORDINATION_NAMES.planApproval, AI_AGENT_COORDINATION_NAMES.shutdown] as const) {
        const actorOwnedRecord = this.toActorOwnedRecord(actor, protocol);
        if (!actorOwnedRecord) continue;
        merged.set(
          actorOwnedRecord.request_id,
          this.mergeRecords(actorOwnedRecord, merged.get(actorOwnedRecord.request_id)),
        );
      }
    }

    return Array.from(merged.values())
      .sort((a, b) => a.created_at - b.created_at)
      .map((record) => this.cloneRecord(record));
  }

  replaceAll(vm: AiAgentVm, records: CoordinationRecord[]): CoordinationRecord[] {
    const store = this.getLegacyStore(vm);
    for (const key of Object.keys(store)) {
      delete store[key];
    }
    for (const record of records) {
      store[record.request_id] = this.cloneRecord(record);
    }
    return this.list(vm);
  }

  restoreAll(vm: AiAgentVm, records: CoordinationRecord[]): CoordinationRecord[] {
    return this.replaceAll(vm, records);
  }

  isApproved(vm: AiAgentVm, request_id: string): boolean {
    const rec = this.get(vm, request_id);
    return rec?.status === AI_AGENT_COORDINATION_STATUSES.approved;
  }

  parseEnvelopeText(text: string): CoordinationEnvelope | null {
    const parsed = safeParseJson(text);
    if (!isCoordinationEnvelope(parsed)) {
      return null;
    }
    return {
      type: AI_AGENT_COORDINATION_ENVELOPE.type,
      v: AI_AGENT_COORDINATION_ENVELOPE.version,
      coordination: parsed.coordination ?? parsed.protocol,
      kind: parsed.kind,
      request_id: parsed.request_id,
      payload: parsed.payload ?? {},
    };
  }

  ingestMemberInbox(vm: AiAgentVm, msg: IngestMemberInboxParams, options?: { cache?: boolean }): IngestResult {
    const from = String(msg.from ?? "");
    const text = String(msg.text ?? "");
    const ts = typeof msg.ts === "number" ? msg.ts : nowMs();

    const env = this.parseEnvelopeText(text);
    if (!env) {
      return { handled: false };
    }
    const request_id = String(env.request_id);
    const coordination = env.coordination;
    const kind = env.kind;
    const payload = env.payload ?? {};

    const existing = this.get(vm, request_id);
    const created_at = existing?.created_at ?? nowMs();
    const base: CoordinationRecord = {
      request_id,
      coordination,
      kind,
      status: existing?.status ?? AI_AGENT_COORDINATION_STATUSES.pending,
      decision: existing?.decision,
      created_at,
      updated_at: nowMs(),
      last_from: from,
      last_ts: ts,
      plan: existing?.plan,
      feedback: existing?.feedback,
      reason: existing?.reason,
    };

    const next = this.applyEnvelope(base, { coordination, kind, payload });

    if (options?.cache !== false) {
      this.getLegacyStore(vm)[request_id] = this.cloneRecord(next);
    }

    const injectText = this.formatInjectText(from, next, payload);
    return {
      handled: true,
      request_id,
      coordination: next.coordination,
      kind: next.kind,
      status: next.status,
      decision: next.decision,
      injectText,
    };
  }

  private applyEnvelope(
    rec: CoordinationRecord,
    env: { coordination: CoordinationName; kind: CoordinationKind; payload: any },
  ): CoordinationRecord {
    if (env.coordination === AI_AGENT_COORDINATION_NAMES.planApproval) {
      if (env.kind === AI_AGENT_COORDINATION_KINDS.planRequest) {
        return {
          ...rec,
          coordination: AI_AGENT_COORDINATION_NAMES.planApproval,
          kind: AI_AGENT_COORDINATION_KINDS.planRequest,
          status: AI_AGENT_COORDINATION_STATUSES.pending,
          plan: typeof env.payload?.plan === "string" ? env.payload.plan : rec.plan,
        };
      }
      if (env.kind === AI_AGENT_COORDINATION_KINDS.planReview) {
        const decision: CoordinationDecision =
          env.payload?.decision === AI_AGENT_COORDINATION_DECISIONS.reject
            ? AI_AGENT_COORDINATION_DECISIONS.reject
            : AI_AGENT_COORDINATION_DECISIONS.approve;
        return {
          ...rec,
          coordination: AI_AGENT_COORDINATION_NAMES.planApproval,
          kind: AI_AGENT_COORDINATION_KINDS.planReview,
          status:
            decision === AI_AGENT_COORDINATION_DECISIONS.approve
              ? AI_AGENT_COORDINATION_STATUSES.approved
              : AI_AGENT_COORDINATION_STATUSES.rejected,
          decision,
          feedback: typeof env.payload?.feedback === "string" ? env.payload.feedback : rec.feedback,
        };
      }
      if (env.kind === AI_AGENT_COORDINATION_KINDS.planDone) {
        return {
          ...rec,
          coordination: AI_AGENT_COORDINATION_NAMES.planApproval,
          kind: AI_AGENT_COORDINATION_KINDS.planDone,
          status: AI_AGENT_COORDINATION_STATUSES.completed,
        };
      }
    }

    if (env.coordination === AI_AGENT_COORDINATION_NAMES.shutdown) {
      if (env.kind === AI_AGENT_COORDINATION_KINDS.shutdownRequest) {
        return {
          ...rec,
          coordination: AI_AGENT_COORDINATION_NAMES.shutdown,
          kind: AI_AGENT_COORDINATION_KINDS.shutdownRequest,
          status: AI_AGENT_COORDINATION_STATUSES.pending,
        };
      }
      if (env.kind === AI_AGENT_COORDINATION_KINDS.shutdownResponse) {
        const decision: CoordinationDecision =
          env.payload?.decision === AI_AGENT_COORDINATION_DECISIONS.reject
            ? AI_AGENT_COORDINATION_DECISIONS.reject
            : AI_AGENT_COORDINATION_DECISIONS.approve;
        return {
          ...rec,
          coordination: AI_AGENT_COORDINATION_NAMES.shutdown,
          kind: AI_AGENT_COORDINATION_KINDS.shutdownResponse,
          status:
            decision === AI_AGENT_COORDINATION_DECISIONS.approve
              ? AI_AGENT_COORDINATION_STATUSES.approved
              : AI_AGENT_COORDINATION_STATUSES.rejected,
          decision,
          reason: typeof env.payload?.reason === "string" ? env.payload.reason : rec.reason,
        };
      }
      if (env.kind === AI_AGENT_COORDINATION_KINDS.shutdownDone) {
        return {
          ...rec,
          coordination: AI_AGENT_COORDINATION_NAMES.shutdown,
          kind: AI_AGENT_COORDINATION_KINDS.shutdownDone,
          status: AI_AGENT_COORDINATION_STATUSES.completed,
        };
      }
    }

    return rec;
  }

  private formatInjectText(from: string, rec: CoordinationRecord, payload: any): string {
    const prefix = from ? `Coordination(${rec.coordination}) ${rec.kind} ${rec.request_id} from ${from}` : `Coordination(${rec.coordination}) ${rec.kind} ${rec.request_id}`;
    if (rec.coordination === AI_AGENT_COORDINATION_NAMES.planApproval && rec.kind === AI_AGENT_COORDINATION_KINDS.planRequest) {
      const plan = typeof payload?.plan === "string" ? payload.plan : rec.plan;
      return plan ? `${prefix}:\n${plan}` : `${prefix}`;
    }
    if (rec.coordination === AI_AGENT_COORDINATION_NAMES.planApproval && rec.kind === AI_AGENT_COORDINATION_KINDS.planReview) {
      const decision = rec.decision ? rec.decision.toUpperCase() : "";
      const feedback = typeof payload?.feedback === "string" ? payload.feedback : rec.feedback;
      return feedback ? `${prefix}: ${decision}\n${feedback}` : `${prefix}: ${decision}`;
    }
    if (rec.coordination === AI_AGENT_COORDINATION_NAMES.shutdown && rec.kind === AI_AGENT_COORDINATION_KINDS.shutdownResponse) {
      const decision = rec.decision ? rec.decision.toUpperCase() : "";
      const reason = typeof payload?.reason === "string" ? payload.reason : rec.reason;
      return reason ? `${prefix}: ${decision}\n${reason}` : `${prefix}: ${decision}`;
    }
    return prefix;
  }
}

let ENGINE_SINGLETON: CoordinationEngine | null = null;

export function getCoordinationEngine(): CoordinationEngine {
  if (!ENGINE_SINGLETON) {
    ENGINE_SINGLETON = new CoordinationEngine();
  }
  return ENGINE_SINGLETON;
}
