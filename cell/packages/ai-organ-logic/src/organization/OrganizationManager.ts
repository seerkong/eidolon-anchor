import { createActor } from "@cell/ai-core-logic/runtime/actor";
import type { ActorWatchState } from "@cell/ai-core-contract/coordination";
import { ensureVmRuntimeContext, ensureVmSessionState, type AiAgentVm, type VmAutonomousHolonRecord, type VmLeaderLedHolonRecord, type VmHolonRecord } from "@cell/ai-core-logic/runtime/runtime";
import { AI_AGENT_LANES } from "../lane/AiAgentLane";
import { AI_AGENT_WORKLOADS } from "../lane/AiAgentWorkload";
import { getMemberManager } from "./MemberManager";

export type OrganizationHolonRecord = VmAutonomousHolonRecord | VmLeaderLedHolonRecord;

function stripOrganizationPrefix(query: string, prefix: "collective" | "formation" | "holon"): string {
  const trimmed = String(query ?? "").trim();
  const marker = `${prefix}:`;
  return trimmed.startsWith(marker) ? trimmed.slice(marker.length) : trimmed;
}

export class OrganizationManager {
  getHolonActorKey(holonId: string): string {
    return `holon:${holonId}`;
  }

  createHolon(vm: AiAgentVm, governance: "autonomous" | "leader_led", name: string): OrganizationHolonRecord {
    return this.createManagedHolon(vm, governance, name);
  }

  getHolon(vm: AiAgentVm, holonId: string): OrganizationHolonRecord | null {
    const record = ensureVmSessionState(vm).holons[holonId];
    if (record?.governance === "autonomous") {
      return this.getAutonomousHolon(vm, holonId);
    }
    if (record?.governance === "leader_led") {
      return this.getLeaderLedHolon(vm, holonId);
    }

    const actor = vm.actors[this.getHolonActorKey(holonId)];
    if (actor?.identity?.kind === "holon" && actor.identity.holonId === holonId) {
      return actor.identity.governance === "autonomous"
        ? this.getAutonomousHolon(vm, holonId)
        : this.getLeaderLedHolon(vm, holonId);
    }

    return null;
  }

  resolveHolon(vm: AiAgentVm, query: string): OrganizationHolonRecord | null {
    const raw = String(query ?? "").trim();
    if (!raw) return null;
    if (raw.startsWith("collective:")) {
      return this.resolveAutonomousHolon(vm, raw);
    }
    if (raw.startsWith("formation:")) {
      return this.resolveLeaderLedHolon(vm, raw);
    }

    const trimmed = stripOrganizationPrefix(raw, "holon");
    if (!trimmed) return null;

    const direct = ensureVmSessionState(vm).holons[trimmed] as VmHolonRecord | undefined;
    if (direct?.governance === "autonomous") {
      return this.getAutonomousHolon(vm, trimmed);
    }
    if (direct?.governance === "leader_led") {
      return this.getLeaderLedHolon(vm, trimmed);
    }

    const actor = vm.actors[this.getHolonActorKey(trimmed)];
    if (actor?.identity?.kind === "holon" && actor.identity.holonId === trimmed) {
      return actor.identity.governance === "autonomous"
        ? this.getAutonomousHolon(vm, trimmed)
        : this.getLeaderLedHolon(vm, trimmed);
    }

    return this.resolveAutonomousHolon(vm, trimmed) ?? this.resolveLeaderLedHolon(vm, trimmed);
  }

  listHolons(vm: AiAgentVm): OrganizationHolonRecord[] {
    const ids = new Set<string>(Object.keys(ensureVmSessionState(vm).holons));
    for (const actor of Object.values(vm.actors)) {
      if (actor.identity?.kind === "holon") {
        ids.add(actor.identity.holonId);
      }
    }

    return Array.from(ids)
      .map((holonId) => this.getHolon(vm, holonId))
      .filter(Boolean)
      .map((record) => ({ ...record!, memberIds: [...record!.memberIds] }));
  }

  appointHolonLeader(vm: AiAgentVm, holonQuery: string, memberQuery: string): VmLeaderLedHolonRecord | null {
    const holon = this.resolveHolon(vm, holonQuery);
    if (!holon || holon.governance !== "leader_led") return null;
    const member = getMemberManager().resolveMember({ vm, query: memberQuery });
    if (!member) return null;
    const updatedHolon = this.addManagedHolonMember(vm, holon, member.memberId);
    if (!updatedHolon || updatedHolon.governance !== "leader_led") return null;
    return this.appointManagedHolonLeader(vm, updatedHolon, member.memberId);
  }

  addHolonMember(vm: AiAgentVm, holonQuery: string, memberQuery: string): OrganizationHolonRecord | null {
    const holon = this.resolveHolon(vm, holonQuery);
    const member = getMemberManager().resolveMember({ vm, query: memberQuery });
    if (!holon || !member) return null;
    return this.addManagedHolonMember(vm, holon, member.memberId);
  }

  setHolonWatchState(vm: AiAgentVm, holonQuery: string, watchState: ActorWatchState): OrganizationHolonRecord | null {
    const holon = this.resolveHolon(vm, holonQuery);
    if (!holon) return null;
    return this.setManagedHolonWatchState(vm, holon, watchState);
  }

  private ensureOrganizationActorFiber(vm: AiAgentVm, actorKey: string, actorId: string): void {
    const actor = vm.actors[actorKey];
    const driver = ensureVmRuntimeContext(vm).driver as any;
    if (!actor || !driver) return;

    const fiberId = `${actorKey}:${actorId}`;
    if ((driver.getState().fibers as any)?.[fiberId]) {
      return;
    }

    driver.spawnFiber({
      fiberId,
      vm,
      actor,
      messages: actor.messages,
      basePriority: 1,
      kind: "control",
      lane: AI_AGENT_LANES.autonomousHolon,
      workload: AI_AGENT_WORKLOADS.autonomousHolonTask,
    });
    driver.suspendFiber(fiberId, Date.now(), "external");
  }

  private getAutonomousHolonActor(vm: AiAgentVm, holonId: string) {
    const actor =
      vm.actors[this.getHolonActorKey(holonId)]
      ?? vm.actors[`collective:${holonId}`];
    return actor?.identity?.kind === "holon" && actor.identity.governance === "autonomous" ? actor : null;
  }

  private getLeaderLedHolonActor(vm: AiAgentVm, holonId: string) {
    const actor =
      vm.actors[this.getHolonActorKey(holonId)]
      ?? vm.actors[`formation:${holonId}`];
    return actor?.identity?.kind === "holon" && actor.identity.governance === "leader_led" ? actor : null;
  }

  private ensureAutonomousHolonActor(vm: AiAgentVm, record: VmAutonomousHolonRecord) {
    const key = this.getHolonActorKey(record.holonId);
    let actor = this.getAutonomousHolonActor(vm, record.holonId);
    if (!actor) {
      actor = createActor({
        key,
        id: record.holonId,
        type: "detached",
        identity: {
          kind: "holon",
          holonId: record.holonId,
          governance: "autonomous",
          name: record.name,
        },
        holonState: {
          governance: "autonomous",
          holonId: record.holonId,
          name: record.name,
          memberIds: [...record.memberIds],
          watchState: record.watchState ?? "unwatched",
          taskOwnership: {},
          tasks: {},
        },
      });
      vm.actors[key] = actor;
      if (!vm.actorRuntime.has(key)) {
        vm.actorRuntime.register(key, actor);
      }
    } else if (!actor.holonState || actor.holonState.governance !== "autonomous") {
      actor.holonState = {
        governance: "autonomous",
        holonId: record.holonId,
        name: record.name,
        memberIds: [...record.memberIds],
        watchState: record.watchState ?? actor.watchState ?? "unwatched",
        taskOwnership: {},
        tasks: {},
      };
    }
    actor.watchState = actor.holonState?.watchState ?? record.watchState ?? "unwatched";
    this.ensureOrganizationActorFiber(vm, key, record.holonId);
    return actor;
  }

  private ensureLeaderLedHolonActor(vm: AiAgentVm, record: VmLeaderLedHolonRecord) {
    const key = this.getHolonActorKey(record.holonId);
    let actor = this.getLeaderLedHolonActor(vm, record.holonId);
    if (!actor) {
      actor = createActor({
        key,
        id: record.holonId,
        type: "detached",
        identity: {
          kind: "holon",
          holonId: record.holonId,
          governance: "leader_led",
          name: record.name,
          leaderId: record.leaderMemberId ?? undefined,
        },
        holonState: {
          governance: "leader_led",
          holonId: record.holonId,
          name: record.name,
          memberIds: [...record.memberIds],
          leaderMemberId: record.leaderMemberId ?? null,
          watchState: record.watchState ?? "unwatched",
          routes: {},
        },
      });
      vm.actors[key] = actor;
      if (!vm.actorRuntime.has(key)) {
        vm.actorRuntime.register(key, actor);
      }
    } else if (!actor.holonState || actor.holonState.governance !== "leader_led") {
      actor.holonState = {
        governance: "leader_led",
        holonId: record.holonId,
        name: record.name,
        memberIds: [...record.memberIds],
        leaderMemberId: record.leaderMemberId ?? null,
        watchState: record.watchState ?? actor.watchState ?? "unwatched",
        routes: {},
      };
    }
    actor.watchState = actor.holonState?.watchState ?? record.watchState ?? "unwatched";
    this.ensureOrganizationActorFiber(vm, key, record.holonId);
    return actor;
  }

  private buildAutonomousHolonRecord(vm: AiAgentVm, holonId: string, fallback?: VmAutonomousHolonRecord | null): VmAutonomousHolonRecord | null {
    const actor = this.getAutonomousHolonActor(vm, holonId);
    if (actor?.holonState?.governance === "autonomous") {
      return {
        holonId,
        governance: "autonomous",
        name: actor.holonState.name,
        memberIds: [...actor.holonState.memberIds],
        leaderMemberId: null,
        watchState: actor.holonState.watchState ?? actor.watchState ?? "unwatched",
        createdAt: fallback?.createdAt ?? Date.now(),
        updatedAt: fallback?.updatedAt ?? fallback?.createdAt ?? Date.now(),
      };
    }
    if (!fallback) return null;
    return { ...fallback, memberIds: [...fallback.memberIds] };
  }

  private buildLeaderLedHolonRecord(vm: AiAgentVm, holonId: string, fallback?: VmLeaderLedHolonRecord | null): VmLeaderLedHolonRecord | null {
    const actor = this.getLeaderLedHolonActor(vm, holonId);
    if (actor?.holonState?.governance === "leader_led") {
      return {
        holonId,
        governance: "leader_led",
        name: actor.holonState.name,
        memberIds: [...actor.holonState.memberIds],
        leaderMemberId: actor.holonState.leaderMemberId ?? null,
        watchState: actor.holonState.watchState ?? actor.watchState ?? "unwatched",
        createdAt: fallback?.createdAt ?? Date.now(),
        updatedAt: fallback?.updatedAt ?? fallback?.createdAt ?? Date.now(),
      };
    }
    if (!fallback) return null;
    return { ...fallback, memberIds: [...fallback.memberIds] };
  }

  private writeAutonomousHolonIndex(vm: AiAgentVm, record: VmAutonomousHolonRecord): VmAutonomousHolonRecord {
    ensureVmSessionState(vm).holons[record.holonId] = {
      ...record,
      memberIds: [...record.memberIds],
    };
    return { ...record, memberIds: [...record.memberIds] };
  }

  private writeLeaderLedHolonIndex(vm: AiAgentVm, record: VmLeaderLedHolonRecord): VmLeaderLedHolonRecord {
    ensureVmSessionState(vm).holons[record.holonId] = {
      ...record,
      memberIds: [...record.memberIds],
    };
    return { ...record, memberIds: [...record.memberIds] };
  }

  private createManagedHolon(vm: AiAgentVm, governance: "autonomous" | "leader_led", name: string): OrganizationHolonRecord {
    const holonId = governance === "autonomous"
      ? `collective-${Date.now()}-${Math.random().toString(16).slice(2)}`
      : `formation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const now = Date.now();

    if (governance === "autonomous") {
      const record: VmAutonomousHolonRecord = {
        holonId,
        governance,
        name,
        memberIds: [],
        leaderMemberId: null,
        watchState: "unwatched",
        createdAt: now,
        updatedAt: now,
      };
      this.ensureAutonomousHolonActor(vm, record);
      return this.writeAutonomousHolonIndex(vm, record);
    }

    const record: VmLeaderLedHolonRecord = {
      holonId,
      governance,
      name,
      memberIds: [],
      leaderMemberId: null,
      watchState: "unwatched",
      createdAt: now,
      updatedAt: now,
    };
    this.ensureLeaderLedHolonActor(vm, record);
    return this.writeLeaderLedHolonIndex(vm, record);
  }

  private addManagedHolonMember(vm: AiAgentVm, holon: OrganizationHolonRecord, memberId: string): OrganizationHolonRecord | null {
    if (holon.governance === "autonomous") {
      const actor = this.ensureAutonomousHolonActor(vm, holon);
      const memberIds = new Set(actor.holonState?.governance === "autonomous" ? actor.holonState.memberIds : holon.memberIds);
      memberIds.add(memberId);
      actor.holonState = {
        governance: "autonomous",
        holonId: holon.holonId,
        name: actor.holonState?.governance === "autonomous" ? actor.holonState.name : holon.name,
        memberIds: [...memberIds],
        watchState: actor.holonState?.watchState ?? actor.watchState ?? holon.watchState ?? "unwatched",
        taskOwnership: { ...((actor.holonState?.governance === "autonomous" ? actor.holonState.taskOwnership : {}) ?? {}) },
        tasks: Object.fromEntries(Object.entries(actor.holonState?.governance === "autonomous" ? actor.holonState.tasks : {}).map(([taskId, task]) => [taskId, { ...task }])),
      };
      actor.watchState = actor.holonState.watchState;

      return this.writeAutonomousHolonIndex(vm, {
        holonId: holon.holonId,
        governance: "autonomous",
        name: actor.holonState.name,
        memberIds: [...actor.holonState.memberIds],
        watchState: actor.holonState.watchState,
        createdAt: holon.createdAt,
        updatedAt: Date.now(),
      });
    }

    const actor = this.ensureLeaderLedHolonActor(vm, holon);
    const memberIds = new Set(actor.holonState?.governance === "leader_led" ? actor.holonState.memberIds : holon.memberIds);
    memberIds.add(memberId);
    actor.holonState = {
      governance: "leader_led",
      holonId: holon.holonId,
      name: actor.holonState?.governance === "leader_led" ? actor.holonState.name : holon.name,
      memberIds: [...memberIds],
      leaderMemberId: actor.holonState?.governance === "leader_led" ? actor.holonState.leaderMemberId ?? holon.leaderMemberId ?? null : holon.leaderMemberId ?? null,
      watchState: actor.holonState?.watchState ?? actor.watchState ?? holon.watchState ?? "unwatched",
      routes: Object.fromEntries(Object.entries(actor.holonState?.governance === "leader_led" ? actor.holonState.routes : {}).map(([routeId, route]) => [routeId, { ...route }])),
    };
    actor.identity = {
      kind: "holon",
      holonId: holon.holonId,
      governance: "leader_led",
      name: actor.holonState.name,
      leaderId: actor.holonState.leaderMemberId ?? undefined,
    };
    actor.watchState = actor.holonState.watchState;

    return this.writeLeaderLedHolonIndex(vm, {
      holonId: holon.holonId,
      governance: "leader_led",
      name: actor.holonState.name,
      memberIds: [...actor.holonState.memberIds],
      leaderMemberId: actor.holonState.leaderMemberId ?? null,
      watchState: actor.holonState.watchState,
      createdAt: holon.createdAt,
      updatedAt: Date.now(),
    });
  }

  private setManagedHolonWatchState(vm: AiAgentVm, holon: OrganizationHolonRecord, watchState: ActorWatchState): OrganizationHolonRecord | null {
    if (holon.governance === "autonomous") {
      const actor = this.ensureAutonomousHolonActor(vm, holon);
      actor.holonState = {
        governance: "autonomous",
        holonId: holon.holonId,
        name: actor.holonState?.governance === "autonomous" ? actor.holonState.name : holon.name,
        memberIds: [...(actor.holonState?.governance === "autonomous" ? actor.holonState.memberIds : holon.memberIds)],
        watchState,
        taskOwnership: { ...((actor.holonState?.governance === "autonomous" ? actor.holonState.taskOwnership : {}) ?? {}) },
        tasks: Object.fromEntries(Object.entries(actor.holonState?.governance === "autonomous" ? actor.holonState.tasks : {}).map(([taskId, task]) => [taskId, { ...task }])),
      };
      actor.watchState = watchState;

      return this.writeAutonomousHolonIndex(vm, {
        holonId: holon.holonId,
        governance: "autonomous",
        name: actor.holonState.name,
        memberIds: [...actor.holonState.memberIds],
        watchState,
        createdAt: holon.createdAt,
        updatedAt: Date.now(),
      });
    }

    const actor = this.ensureLeaderLedHolonActor(vm, holon);
    actor.holonState = {
      governance: "leader_led",
      holonId: holon.holonId,
      name: actor.holonState?.governance === "leader_led" ? actor.holonState.name : holon.name,
      memberIds: [...(actor.holonState?.governance === "leader_led" ? actor.holonState.memberIds : holon.memberIds)],
      leaderMemberId: actor.holonState?.governance === "leader_led" ? actor.holonState.leaderMemberId ?? holon.leaderMemberId ?? null : holon.leaderMemberId ?? null,
      watchState,
      routes: Object.fromEntries(Object.entries(actor.holonState?.governance === "leader_led" ? actor.holonState.routes : {}).map(([routeId, route]) => [routeId, { ...route }])),
    };
    actor.identity = {
      kind: "holon",
      holonId: holon.holonId,
      governance: "leader_led",
      name: actor.holonState.name,
      leaderId: actor.holonState.leaderMemberId ?? undefined,
    };
    actor.watchState = watchState;

    return this.writeLeaderLedHolonIndex(vm, {
      holonId: holon.holonId,
      governance: "leader_led",
      name: actor.holonState.name,
      memberIds: [...actor.holonState.memberIds],
      leaderMemberId: actor.holonState.leaderMemberId ?? null,
      watchState,
      createdAt: holon.createdAt,
      updatedAt: Date.now(),
    });
  }

  private appointManagedHolonLeader(vm: AiAgentVm, holon: VmLeaderLedHolonRecord, memberId: string): VmLeaderLedHolonRecord | null {
    const actor = this.ensureLeaderLedHolonActor(vm, holon);
    actor.holonState = {
      governance: "leader_led",
      holonId: holon.holonId,
      name: actor.holonState?.governance === "leader_led" ? actor.holonState.name : holon.name,
      memberIds: [...(actor.holonState?.governance === "leader_led" ? actor.holonState.memberIds : holon.memberIds)],
      leaderMemberId: memberId,
      watchState: actor.holonState?.watchState ?? actor.watchState ?? holon.watchState ?? "unwatched",
      routes: Object.fromEntries(Object.entries(actor.holonState?.governance === "leader_led" ? actor.holonState.routes : {}).map(([routeId, route]) => [routeId, { ...route }])),
    };
    actor.identity = {
      kind: "holon",
      holonId: holon.holonId,
      governance: "leader_led",
      name: actor.holonState.name,
      leaderId: memberId,
    };
    actor.watchState = actor.holonState.watchState;

    return this.writeLeaderLedHolonIndex(vm, {
      holonId: holon.holonId,
      governance: "leader_led",
      name: actor.holonState.name,
      memberIds: [...actor.holonState.memberIds],
      leaderMemberId: memberId,
      watchState: actor.holonState.watchState,
      createdAt: holon.createdAt,
      updatedAt: Date.now(),
    });
  }

  getAutonomousHolon(vm: AiAgentVm, holonId: string): VmAutonomousHolonRecord | null {
    const fallback = (ensureVmSessionState(vm).holons[holonId]?.governance === "autonomous"
      ? ensureVmSessionState(vm).holons[holonId]
      : null) as VmAutonomousHolonRecord | null;
    const resolved = this.buildAutonomousHolonRecord(vm, holonId, fallback);
    return resolved ? { ...resolved, memberIds: [...resolved.memberIds] } : null;
  }

  listAutonomousHolons(vm: AiAgentVm): VmAutonomousHolonRecord[] {
    const ids = new Set<string>(
      Object.values(ensureVmSessionState(vm).holons)
        .filter((record) => record.governance === "autonomous")
        .map((record) => record.holonId),
    );
    for (const actor of Object.values(vm.actors)) {
      if (actor.identity?.kind === "holon" && actor.identity.governance === "autonomous") {
        ids.add(actor.identity.holonId);
      }
    }
    return Array.from(ids)
      .map((holonId) => this.getAutonomousHolon(vm, holonId))
      .filter(Boolean)
      .map((rec) => ({ ...rec!, memberIds: [...rec!.memberIds] }));
  }

  resolveAutonomousHolon(vm: AiAgentVm, query: string): VmAutonomousHolonRecord | null {
    const trimmed = stripOrganizationPrefix(stripOrganizationPrefix(query, "holon"), "collective");
    if (!trimmed) return null;

    const direct = ensureVmSessionState(vm).holons[trimmed]?.governance === "autonomous"
      ? ensureVmSessionState(vm).holons[trimmed] as VmAutonomousHolonRecord
      : null;
    if (direct) {
      this.ensureAutonomousHolonActor(vm, direct);
      return this.getAutonomousHolon(vm, direct.holonId);
    }

    for (const actor of Object.values(vm.actors)) {
      if (actor.identity?.kind !== "holon" || actor.identity.governance !== "autonomous") continue;
      if (actor.identity.holonId !== trimmed && actor.identity.name !== trimmed && actor.identity.name.toLowerCase() !== trimmed.toLowerCase()) {
        continue;
      }
      return this.getAutonomousHolon(vm, actor.identity.holonId);
    }

    const lower = trimmed.toLowerCase();
    for (const rec of Object.values(ensureVmSessionState(vm).holons).filter((record) => record.governance === "autonomous") as VmAutonomousHolonRecord[]) {
      if (rec.name === trimmed || rec.name.toLowerCase() === lower) {
        this.ensureAutonomousHolonActor(vm, rec);
        return this.getAutonomousHolon(vm, rec.holonId);
      }
    }
    return null;
  }

  getLeaderLedHolon(vm: AiAgentVm, holonId: string): VmLeaderLedHolonRecord | null {
    const fallback = (ensureVmSessionState(vm).holons[holonId]?.governance === "leader_led"
      ? ensureVmSessionState(vm).holons[holonId]
      : null) as VmLeaderLedHolonRecord | null;
    const resolved = this.buildLeaderLedHolonRecord(vm, holonId, fallback);
    return resolved ? { ...resolved, memberIds: [...resolved.memberIds] } : null;
  }

  listLeaderLedHolons(vm: AiAgentVm): VmLeaderLedHolonRecord[] {
    const ids = new Set<string>(
      Object.values(ensureVmSessionState(vm).holons)
        .filter((record) => record.governance === "leader_led")
        .map((record) => record.holonId),
    );
    for (const actor of Object.values(vm.actors)) {
      if (actor.identity?.kind === "holon" && actor.identity.governance === "leader_led") {
        ids.add(actor.identity.holonId);
      }
    }
    return Array.from(ids)
      .map((holonId) => this.getLeaderLedHolon(vm, holonId))
      .filter(Boolean)
      .map((rec) => ({ ...rec!, memberIds: [...rec!.memberIds] }));
  }

  resolveLeaderLedHolon(vm: AiAgentVm, query: string): VmLeaderLedHolonRecord | null {
    const trimmed = stripOrganizationPrefix(stripOrganizationPrefix(query, "holon"), "formation");
    if (!trimmed) return null;

    const direct = ensureVmSessionState(vm).holons[trimmed]?.governance === "leader_led"
      ? ensureVmSessionState(vm).holons[trimmed] as VmLeaderLedHolonRecord
      : null;
    if (direct) {
      this.ensureLeaderLedHolonActor(vm, direct);
      return this.getLeaderLedHolon(vm, direct.holonId);
    }

    for (const actor of Object.values(vm.actors)) {
      if (actor.identity?.kind !== "holon" || actor.identity.governance !== "leader_led") continue;
      if (actor.identity.holonId !== trimmed && actor.identity.name !== trimmed && actor.identity.name.toLowerCase() !== trimmed.toLowerCase()) {
        continue;
      }
      return this.getLeaderLedHolon(vm, actor.identity.holonId);
    }

    const lower = trimmed.toLowerCase();
    for (const rec of Object.values(ensureVmSessionState(vm).holons).filter((record) => record.governance === "leader_led") as VmLeaderLedHolonRecord[]) {
      if (rec.name === trimmed || rec.name.toLowerCase() === lower) {
        this.ensureLeaderLedHolonActor(vm, rec);
        return this.getLeaderLedHolon(vm, rec.holonId);
      }
    }
    return null;
  }
}

const ORGANIZATION_MANAGER = new OrganizationManager();

export function getOrganizationManager(): OrganizationManager {
  return ORGANIZATION_MANAGER;
}
