import { createActor, type AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import { ensureVmRuntimeContext, ensureVmSessionState, type AiAgentVm, type VmMemberRosterEntry } from "@cell/ai-core-logic/runtime/runtime";
import { normalizeMemberRole, type MemberRole } from "@cell/ai-organ-contract/organization/MemberRole";
import type { AiAgentOrchestratorDriver } from "../OrchestratorDriver";
import { getCoordinationEngine } from "../coordination/CoordinationEngine";
import { AI_AGENT_LANES } from "../lane/AiAgentLane";
import { resolveMemberWorkload } from "../lane/AiAgentWorkload";

export type MemberLane = "member" | "autonomous_holon";
export type MemberLifecycleState = "active" | "shutting_down" | "exited";

export type MemberMessage = {
  from: string;
  text: string;
  ts: number;
};

export type MemberRecord = {
  memberId: string;
  name: string;
  role: MemberRole;
  agentType: string;
  lane: MemberLane;
  fiberId: string;
  actorKey: string;
  actorId: string;
  createdAt: number;
  lastActiveAt: number;
  lifecycleState: MemberLifecycleState;
  shutdownRequestId?: string;

  vm: AiAgentVm;
  actor: AiAgentActor;
  driver: AiAgentOrchestratorDriver;
};

export type MemberView = {
  memberId: string;
  name: string;
  role: MemberRole;
  agentType: string;
  lane: MemberLane;
  fiberId: string;
  actorKey: string;
  actorId: string;
  status: string;
  waitingReason: string | null;
  lifecycleState: MemberLifecycleState;
  shutdownRequestId: string | null;
  lastActiveAt: number;
  lastAssistantText: string | null;
  lastCompletedAt: number | null;
};

export type MemberRecoveryRecord = MemberRecord;

function makeMemberId(): string {
  return `member-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stripMemberPrefix(query: string): string {
  const trimmed = String(query ?? "").trim();
  return trimmed.startsWith("member:") ? trimmed.slice("member:".length) : trimmed;
}

export class MemberManager {
  private getRosterStore(vm: AiAgentVm): Record<string, VmMemberRosterEntry> {
    const state = ensureVmSessionState(vm);
    return state.memberRoster;
  }

  private buildRecord(vm: AiAgentVm, entry: VmMemberRosterEntry): MemberRecord | null {
    const actor = vm.actors[entry.actorKey];
    const driver = ensureVmRuntimeContext(vm).driver as AiAgentOrchestratorDriver | null;
    if (!actor || !driver) return null;
    return {
      ...entry,
      role: normalizeMemberRole(entry.role),
      vm,
      actor,
      driver,
    };
  }

  private cloneRecord(rec: MemberRecord): MemberRecord {
    return { ...rec };
  }

  __resetForTest(): void {
    // No-op now that roster state is owned by each AiAgentVm.
  }

  private getFiberSnapshot(rec: MemberRecord): any | null {
    return (rec.driver.getState().fibers as any)?.[rec.fiberId] ?? null;
  }

  private toView(rec: MemberRecord): MemberView {
    const fiber = this.getFiberSnapshot(rec);
    const fiberStatus = typeof fiber?.status === "string" ? fiber.status : "missing";
    const waitingReason = typeof fiber?.waitingReason === "string" ? fiber.waitingReason : null;

    let status = fiberStatus;
    let lifecycleState = rec.lifecycleState;
    if (fiberStatus === "cancelled" || fiberStatus === "completed" || fiberStatus === "failed") {
      lifecycleState = "exited";
      status = "exited";
    } else if (rec.lifecycleState === "shutting_down") {
      status = "shutting_down";
    } else if (rec.lifecycleState === "exited") {
      status = "exited";
    }

    let lastAssistantText: string | null = null;
    let lastCompletedAt: number | null = null;
    const messages = Array.isArray(rec.actor.messages) ? rec.actor.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as any;
      if (message?.role !== "assistant") continue;
      const content = typeof message?.content === "string" ? message.content : null;
      lastAssistantText = content && content.trim() ? content : null;
      const completedAt = typeof message?.time?.completed === "number" ? message.time.completed : typeof message?.time?.created === "number" ? message.time.created : null;
      lastCompletedAt = completedAt ?? rec.lastActiveAt;
      break;
    }
    const lastActiveAt = Math.max(
      rec.lastActiveAt,
      rec.actor.lastMemberResultNotifiedAt ?? 0,
      lastCompletedAt ?? 0,
    );

    return {
      memberId: rec.memberId,
      name: rec.name,
      role: rec.role,
      agentType: rec.agentType,
      lane: rec.lane,
      fiberId: rec.fiberId,
      actorKey: rec.actorKey,
      actorId: rec.actorId,
      status,
      waitingReason,
      lifecycleState,
      shutdownRequestId: rec.shutdownRequestId ?? null,
      lastActiveAt,
      lastAssistantText,
      lastCompletedAt,
    };
  }

  createMember(params: {
    vm: AiAgentVm;
    driver: AiAgentOrchestratorDriver;
    controlActor: AiAgentActor;
    name: string;
    role: MemberRole;
    agentType: string;
    systemPrompt?: string[];
    lane?: MemberLane;
    shareTaskTree?: boolean;
  }): MemberRecord {
    const memberId = makeMemberId();
    ensureVmRuntimeContext(params.vm).driver = params.driver;
    const key = `member:${params.name}:${Date.now()}`;
    const systemPrompts = Array.isArray(params.systemPrompt) ? params.systemPrompt.map((x) => String(x)) : [];
    const messages: any[] = systemPrompts.map((p) => ({ role: "system", content: p }));
    const role = normalizeMemberRole(params.role);

    const lane = params.lane === "autonomous_holon" ? AI_AGENT_LANES.autonomousHolon : AI_AGENT_LANES.member;

    const actor = createActor({
      key,
      type: "delegate",
      llmClient: params.controlActor.llmClient,
      modelConfig: params.controlActor.modelConfig,
      systemPrompts,
      messages,
      toolPolicy: params.controlActor.toolPolicy,
      callbacks: {
        buildToolset: params.controlActor.callbacks.buildToolset,
        processStream: params.controlActor.callbacks.processStream,
      },
    });

    actor.identity = {
      kind: "member",
      memberId,
      name: params.name,
      role,
      lane,
      agentType: params.agentType,
    } as any;

    if (params.shareTaskTree) {
      actor.taskTree = params.controlActor.taskTree;
    }

    params.vm.actors[actor.key] = actor;
    if (!params.vm.actorRuntime.has(actor.key)) {
      params.vm.actorRuntime.register(actor.key, actor);
    }

    const fiberId = `${actor.key}:${actor.id}`;
    params.driver.spawnFiber({
      fiberId,
      vm: params.vm,
      actor,
      messages,
      basePriority: 1,
      kind: "control" as any,
      lane,
      workload: resolveMemberWorkload(lane),
    });

    const now = Date.now();
    params.driver.suspendFiber(fiberId, now, "external");
    const stored: VmMemberRosterEntry = {
      memberId,
      name: params.name,
      role,
      agentType: params.agentType,
      lane,
      fiberId,
      actorKey: actor.key,
      actorId: actor.id,
      createdAt: now,
      lastActiveAt: now,
      lifecycleState: "active",
      shutdownRequestId: undefined,
    };
    this.getRosterStore(params.vm)[memberId] = stored;
    const rec = this.buildRecord(params.vm, stored);
    if (!rec) {
      throw new Error("failed_to_build_member_record");
    }
    return this.cloneRecord(rec);
  }

  listMembers(params: { vm: AiAgentVm }): MemberView[] {
    return Object.values(this.getRosterStore(params.vm))
      .map((entry) => this.buildRecord(params.vm, entry))
      .filter(Boolean)
      .map((record) => this.toView(record!))
      .sort((a, b) => {
        const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        if (byName !== 0) return byName;
        return a.memberId.localeCompare(b.memberId);
      });
  }

  listRosterRecords(params: { vm: AiAgentVm }): MemberRecord[] {
    return Object.values(this.getRosterStore(params.vm))
      .map((entry) => this.buildRecord(params.vm, entry))
      .filter(Boolean)
      .map((rec) => this.cloneRecord(rec!));
  }

  listMemberRecords(params: { vm: AiAgentVm }): MemberRecord[] {
    return this.listRosterRecords(params);
  }

  injectRecoveredMember(params: { vm: AiAgentVm; record: MemberRecoveryRecord }): MemberRecord {
    const next: VmMemberRosterEntry = {
      memberId: params.record.memberId,
      name: params.record.name,
      role: normalizeMemberRole(params.record.role),
      agentType: params.record.agentType,
      lane: params.record.lane,
      fiberId: params.record.fiberId,
      actorKey: params.record.actorKey,
      actorId: params.record.actorId,
      createdAt: params.record.createdAt,
      lastActiveAt: params.record.lastActiveAt,
      lifecycleState: params.record.lifecycleState,
      shutdownRequestId: params.record.shutdownRequestId,
    };
    this.getRosterStore(params.vm)[next.memberId] = next;
    const rec = this.buildRecord(params.vm, next);
    if (!rec) {
      throw new Error("failed_to_build_recovered_member_record");
    }
    return this.cloneRecord(rec);
  }

  replaceRecoveredRoster(params: { vm: AiAgentVm; records: MemberRecoveryRecord[] }): MemberRecord[] {
    const roster = this.getRosterStore(params.vm);
    for (const key of Object.keys(roster)) {
      delete roster[key];
    }
    for (const record of params.records) {
      this.injectRecoveredMember({ vm: params.vm, record });
    }
    return this.listRosterRecords({ vm: params.vm });
  }

  resolveMember(params: { vm: AiAgentVm; query: string }): MemberRecord | null {
    const trimmed = stripMemberPrefix(params.query);
    if (!trimmed) return null;
    const direct = this.getRosterStore(params.vm)[trimmed];
    if (direct) return this.buildRecord(params.vm, direct);
    for (const rec of Object.values(this.getRosterStore(params.vm))) {
      if (rec.memberId === trimmed) return this.buildRecord(params.vm, rec);
    }
    const lower = trimmed.toLowerCase();
    for (const rec of Object.values(this.getRosterStore(params.vm))) {
      if (rec.name === trimmed || rec.name.toLowerCase() === lower) return this.buildRecord(params.vm, rec);
    }
    return null;
  }

  getMemberView(params: { vm: AiAgentVm; query: string }): MemberView | null {
    const rec = this.resolveMember(params);
    return rec ? this.toView(rec) : null;
  }

  getMember(params: { vm: AiAgentVm; memberId: string }): MemberRecord | null {
    const rec = this.getRosterStore(params.vm)[params.memberId];
    const built = rec ? this.buildRecord(params.vm, rec) : null;
    return built ? this.cloneRecord(built) : null;
  }

  findByActor(params: { vm: AiAgentVm; actorKey: string; actorId?: string }): MemberRecord | null {
    for (const rec of Object.values(this.getRosterStore(params.vm))) {
      if (rec.actorKey !== params.actorKey) continue;
      if (params.actorId && rec.actorId !== params.actorId) continue;
      const built = this.buildRecord(params.vm, rec);
      return built ? this.cloneRecord(built) : null;
    }
    return null;
  }

  markMemberActive(params: { vm: AiAgentVm; memberId: string }): void {
    const rec = this.getRosterStore(params.vm)[params.memberId];
    if (!rec) return;
    rec.lastActiveAt = Date.now();
    if (rec.lifecycleState !== "exited") {
      rec.lifecycleState = "active";
    }
  }

  markMemberShutdownRequested(params: { vm: AiAgentVm; memberId: string; requestId?: string }): void {
    const rec = this.getRosterStore(params.vm)[params.memberId];
    if (!rec) return;
    rec.lifecycleState = "shutting_down";
    rec.shutdownRequestId = params.requestId ?? rec.shutdownRequestId;
    rec.lastActiveAt = Date.now();
  }

  markMemberExited(params: { vm: AiAgentVm; memberId: string }): void {
    const rec = this.getRosterStore(params.vm)[params.memberId];
    if (!rec) return;
    rec.lifecycleState = "exited";
    rec.lastActiveAt = Date.now();
  }

  markExitedByActor(params: { vm: AiAgentVm; actorKey: string; actorId?: string }): void {
    const rec = this.findByActor(params);
    if (!rec) return;
    this.markMemberExited({ vm: params.vm, memberId: rec.memberId });
  }

  sendMessage(params: { vm: AiAgentVm; to: string; from: string; text: string }): void {
    const rec = this.getRosterStore(params.vm)[params.to];
    if (!rec) {
      return;
    }
    const runtime = ensureVmRuntimeContext(params.vm);
    const payload: MemberMessage = { from: params.from, text: params.text, ts: Date.now() };
    rec.lastActiveAt = payload.ts;
    const actor = params.vm.actors[rec.actorKey];
    const driver = runtime.driver as AiAgentOrchestratorDriver | null;
    if (!actor || !driver) {
      return;
    }
    if (getCoordinationEngine().parseEnvelopeText(payload.text)) {
      actor.send("coordination", payload as any);
    } else {
      actor.send("memberInbox", payload as any);
    }

    if (runtime.interactiveTurnActive === true) {
      runtime.deferredMemberResumes.push({ fiberId: rec.fiberId, at: Date.now() });
    } else {
      driver.resumeFiber(rec.fiberId, Date.now());
    }

    params.vm.effects.orchestrationHistory?.appendEvent({
      stream: "member_message",
      kind: "member_message_sent",
      payload: {
        to_member_id: rec.memberId,
        to_actor_key: rec.actorKey,
        to_actor_id: rec.actorId,
        from: payload.from,
        text: payload.text,
      },
    });
  }

  broadcast(params: { vm: AiAgentVm; from: string; text: string }): void {
    for (const t of Object.values(this.getRosterStore(params.vm))) {
      this.sendMessage({ vm: params.vm, to: t.memberId, from: params.from, text: params.text });
    }
  }
}

let MEMBER_SINGLETON: MemberManager | null = null;

export function getMemberManager(): MemberManager {
  if (!MEMBER_SINGLETON) {
    MEMBER_SINGLETON = new MemberManager();
  }
  return MEMBER_SINGLETON;
}
