import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import type { TaskNode } from "@cell/ai-core-contract/plan/TaskTree";
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import { TaskTreeManager } from "@cell/ai-organ-logic/plan/TaskTreeManager";
import type { AiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver";
import type { MemberManager, MemberRecord } from "./MemberManager";
import { getOrganizationManager } from "./OrganizationManager";
import {
  parseHolonTaskScope,
} from "./holonRuntimeProtocol";

export type AutonomousHolonTaskRunner = {
  tickOnce: () => Promise<void>;
};

function resolveHolonEventActor(params: {
  vm: AiAgentVm
  controlActor: AiAgentActor
  activeForm?: string | null
}): { key: string; id: string } {
  const activeForm = String(params.activeForm ?? "").trim()
  const holonScope = parseHolonTaskScope(activeForm)
  if (holonScope?.governance === "autonomous") {
    const autonomousHolon = getOrganizationManager().resolveAutonomousHolon(params.vm, holonScope.holonId)
    if (autonomousHolon) {
      return { key: getOrganizationManager().getHolonActorKey(autonomousHolon.holonId), id: autonomousHolon.holonId }
    }
  }
  if (holonScope?.governance === "leader_led") {
    const leaderLedHolon = getOrganizationManager().resolveLeaderLedHolon(params.vm, holonScope.holonId)
    if (leaderLedHolon) {
      return { key: getOrganizationManager().getHolonActorKey(leaderLedHolon.holonId), id: leaderLedHolon.holonId }
    }
  }
  return { key: params.controlActor.key, id: params.controlActor.id }
}

function recordAutonomousHolonTaskOwnership(vm: AiAgentVm, holonId: string, taskId: string, ownerActorKey: string): void {
  const actor = vm.actors[getOrganizationManager().getHolonActorKey(holonId)]
  if (actor?.identity?.kind !== "holon" || actor.identity.governance !== "autonomous") return
  actor.holonState = {
    governance: "autonomous",
    holonId,
    name: actor.holonState?.governance === "autonomous" ? actor.holonState.name : actor.identity.name,
    memberIds: [...(actor.holonState?.governance === "autonomous" ? actor.holonState.memberIds : [])],
    watchState: actor.holonState?.watchState ?? actor.watchState,
    taskOwnership: {
      ...((actor.holonState?.governance === "autonomous" ? actor.holonState.taskOwnership : {}) ?? {}),
      [taskId]: ownerActorKey,
    },
    tasks: Object.fromEntries(
      Object.entries(actor.holonState?.governance === "autonomous" ? actor.holonState.tasks : {}).map(([entryTaskId, task]) => [entryTaskId, { ...task }]),
    ),
  }
}

function findClaimable(nodes: TaskNode[]): TaskNode | null {
  const inProgress = nodes.find((n) => n.status === "in_progress");
  if (inProgress) {
    return findClaimable(inProgress.children);
  }
  return nodes.find((n) => n.status === "pending") ?? null;
}

function findNodeById(nodes: TaskNode[], id: string): TaskNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const child = findNodeById(n.children, id);
    if (child) return child;
  }
  return null;
}

function isFiberBusy(rec: MemberRecord): boolean {
  const fiber = (rec.driver.getState().fibers as any)?.[rec.fiberId];
  const status = String(fiber?.status ?? "");
  return status === "running";
}

function filterAutonomousHolonRosterForTask(params: {
  claimable: TaskNode
  collectiveRoster: MemberRecord[]
  vm: AiAgentVm
}): MemberRecord[] {
  const activeForm = String(params.claimable.activeForm ?? "").trim()
  if (!activeForm) return params.collectiveRoster
  const holonScope = parseHolonTaskScope(activeForm)
  if (holonScope?.governance === "autonomous") {
    const autonomousHolon = getOrganizationManager().resolveAutonomousHolon(params.vm, holonScope.holonId)
    if (!autonomousHolon) return []
    const memberIds = new Set(autonomousHolon.memberIds)
    return params.collectiveRoster.filter((member) => memberIds.has(member.memberId))
  }
  if (holonScope?.governance === "leader_led") {
    const leaderLedHolon = getOrganizationManager().resolveLeaderLedHolon(params.vm, holonScope.holonId)
    if (!leaderLedHolon) return []
    if (leaderLedHolon.leaderMemberId) {
      return params.collectiveRoster.filter((member) => member.memberId === leaderLedHolon.leaderMemberId)
    }
    const memberIds = new Set(leaderLedHolon.memberIds)
    return params.collectiveRoster.filter((member) => memberIds.has(member.memberId))
  }

  return params.collectiveRoster
}

export function createAutonomousHolonTaskRunner(_params: {
  driver: AiAgentOrchestratorDriver;
  vm: AiAgentVm;
  controlActor: AiAgentActor;
  members: MemberManager;
  idleTimeoutMs?: number;
}): AutonomousHolonTaskRunner {
  const params = _params;
  return {
    tickOnce: async () => {
      const now = Date.now();
      const root = params.controlActor.taskTree.root;
      const claimable = findClaimable(root.children);
      const roster: MemberRecord[] = params.members.listMemberRecords({ vm: params.vm });
      const collectiveRoster = roster.filter((t) => t.lane === "autonomous_holon" && t.lifecycleState !== "exited");
      const organizationRoster = roster.filter((t) => t.lifecycleState !== "exited");

      if (!claimable) {
        const idleTimeoutMs = typeof params.idleTimeoutMs === "number" && params.idleTimeoutMs > 0
          ? params.idleTimeoutMs
          : undefined;

        if (idleTimeoutMs) {
          for (const member of collectiveRoster) {
            if (member.lifecycleState !== "active") {
              continue;
            }
            if (member.actor.hasPending("memberInbox" as any)) {
              member.lastActiveAt = now;
              continue;
            }
            if (isFiberBusy(member)) {
              continue;
            }
            if (now - member.lastActiveAt < idleTimeoutMs) {
              continue;
            }

            params.members.markMemberShutdownRequested({ vm: params.vm, memberId: member.memberId, requestId: `idle-timeout:${idleTimeoutMs}` });
            member.driver.emitFiberSignal({
              fiberId: member.fiberId,
              signalKind: "interrupt_requested",
              mailbox: { kind: "control", payload: { kind: "shutdown_requested" } as any },
              idempotencyKey: `${member.fiberId}:idle-timeout-shutdown:${idleTimeoutMs}:${now}`,
              createdAt: now,
            });

            params.vm.eventBus?.emitAutonomousHolonIdleExit?.(
              { key: member.actor.key, id: member.actor.id },
              { memberId: member.memberId, idleTimeoutMs },
            );
            params.vm.effects.orchestrationHistory?.appendEvent({
              stream: "autonomous_holon_event",
              kind: "autonomous_holon_idle_exit",
              payload: {
                member_id: member.memberId,
                idle_timeout_ms: idleTimeoutMs,
              },
            });
          }
        }

        await params.driver.tickUntilBackgroundSettled({ now, maxTicks: 20, maxWallMs: 200 });
        return;
      }

      if (organizationRoster.length === 0) {
        await params.driver.tickUntilBackgroundSettled({ now, maxTicks: 20, maxWallMs: 200 });
        return;
      }

      const eligibleCollectiveRoster = filterAutonomousHolonRosterForTask({
        claimable,
        collectiveRoster: organizationRoster,
        vm: params.vm,
      })
      if (eligibleCollectiveRoster.length === 0) {
        await params.driver.tickUntilBackgroundSettled({ now, maxTicks: 20, maxWallMs: 200 });
        return;
      }

      try {
        TaskTreeManager.apply(params.controlActor.taskTree, {
          op: "update_status",
          task_id: claimable.id,
          status: "in_progress",
        });
      } catch {
        // Another worker may have claimed it; keep going.
      }

      const claimedNode = findNodeById(root.children, claimable.id);
      const member = eligibleCollectiveRoster.find((t) => t.lifecycleState === "active") ?? eligibleCollectiveRoster[0]!;
      const text = `TASK_ID=${claimable.id}\n${String(claimedNode?.content ?? "")}`.trim();
      const claimSummary = String(claimedNode?.content ?? "").trim()
      const eventActor = resolveHolonEventActor({
        vm: params.vm,
        controlActor: params.controlActor,
        activeForm: typeof claimedNode?.activeForm === "string" ? claimedNode.activeForm : null,
      })
      const taskScope = parseHolonTaskScope(String(claimedNode?.activeForm ?? ""))
      if (taskScope?.governance === "autonomous") {
        recordAutonomousHolonTaskOwnership(params.vm, taskScope.holonId, claimable.id, member.actor.key)
      }
      params.members.sendMessage({ vm: params.vm, to: member.memberId, from: "autonomous_holon", text });
      params.members.markMemberActive({ vm: params.vm, memberId: member.memberId });

      params.vm.eventBus?.emitQuote?.(
        eventActor,
        `Holon assigned ${claimable.id} to ${member.name}${claimSummary ? `:\n${claimSummary}` : ""}`,
        "content",
      );
      params.vm.eventBus?.emitAutonomousHolonClaim?.(
        eventActor,
        { taskId: claimable.id, memberId: member.memberId },
      );
      params.vm.effects.orchestrationHistory?.appendEvent({
        stream: "autonomous_holon_event",
        kind: "autonomous_holon_claim",
        payload: {
          task_id: claimable.id,
          member_id: member.memberId,
        },
      });

      await params.driver.tickUntilForegroundSettled({ now, maxTicks: 80, maxWallMs: 2000 });
      await params.driver.tickUntilBackgroundSettled({ now, maxTicks: 80, maxWallMs: 2000 });
    },
  };
}
