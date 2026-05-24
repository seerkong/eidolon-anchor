import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import { DELEGATE_RUN_MODES, type DelegateRunMode } from "@cell/ai-organ-contract/agent/DelegateRunMode";
import { DETACHED_ACTOR_KINDS, type DetachedActorKind } from "../detached/DetachedActorRegistry";
import { AI_AGENT_LANES, type AiAgentLane } from "./AiAgentLane";

export const AI_AGENT_WORKLOADS = {
  sessionTurn: "session_turn",
  memberTurn: "member_turn",
  syncDelegateTask: "sync_delegate_task",
  autonomousHolonTask: "autonomous_holon_task",
  detachedDelegateTask: "detached_delegate_task",
  detachedBashTask: "detached_bash_task",
  detachedToolCallTask: "detached_toolcall_task",
} as const;

export type AiAgentWorkload = (typeof AI_AGENT_WORKLOADS)[keyof typeof AI_AGENT_WORKLOADS];

export function resolveMainFiberWorkload(lane?: AiAgentLane): AiAgentWorkload {
  if (lane === AI_AGENT_LANES.autonomousHolon) {
    return AI_AGENT_WORKLOADS.autonomousHolonTask;
  }
  if (lane === AI_AGENT_LANES.member) {
    return AI_AGENT_WORKLOADS.memberTurn;
  }
  return AI_AGENT_WORKLOADS.sessionTurn;
}

export function resolveMemberWorkload(lane: AiAgentLane): AiAgentWorkload {
  return lane === AI_AGENT_LANES.autonomousHolon
    ? AI_AGENT_WORKLOADS.autonomousHolonTask
    : AI_AGENT_WORKLOADS.memberTurn;
}

export function resolveDelegateWorkload(
  _parentActor: AiAgentActor,
  params: {
    mode: DelegateRunMode;
    detachedActorKind?: DetachedActorKind;
  },
): AiAgentWorkload {
  if (params.mode === DELEGATE_RUN_MODES.syncWait) {
    return AI_AGENT_WORKLOADS.syncDelegateTask;
  }
  if (params.detachedActorKind === DETACHED_ACTOR_KINDS.bash) {
    return AI_AGENT_WORKLOADS.detachedBashTask;
  }
  if (params.detachedActorKind === DETACHED_ACTOR_KINDS.toolCall) {
    return AI_AGENT_WORKLOADS.detachedToolCallTask;
  }
  return AI_AGENT_WORKLOADS.detachedDelegateTask;
}

export function inferFiberWorkload(params: {
  actor: AiAgentActor;
  lane?: AiAgentLane;
  kind?: "control" | "delegate";
  detachedActorKind?: DetachedActorKind;
}): AiAgentWorkload {
  if (params.actor.identity?.kind === "member") {
    return resolveMemberWorkload((params.actor.identity.lane as AiAgentLane) ?? AI_AGENT_LANES.member);
  }
  if (params.kind === "delegate" || params.actor.type === "delegate") {
    return resolveDelegateWorkload(params.actor, {
      mode: params.lane === AI_AGENT_LANES.detached ? DELEGATE_RUN_MODES.detached : DELEGATE_RUN_MODES.syncWait,
      detachedActorKind: params.detachedActorKind,
    });
  }
  return resolveMainFiberWorkload(params.lane);
}
