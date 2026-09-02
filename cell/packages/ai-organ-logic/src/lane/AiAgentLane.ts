import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import { DELEGATE_RUN_MODES, type DelegateRunMode } from "@cell/ai-organ-contract/agent/DelegateRunMode";

export const AI_AGENT_LANES = {
  interactive: "interactive",
  member: "member",
  detached: "detached",
  organization: "organization",
} as const;

export type AiAgentLane = (typeof AI_AGENT_LANES)[keyof typeof AI_AGENT_LANES];

export function normalizeAiAgentLane(lane: unknown): AiAgentLane | undefined {
  return lane === AI_AGENT_LANES.interactive
    || lane === AI_AGENT_LANES.member
    || lane === AI_AGENT_LANES.detached
    || lane === AI_AGENT_LANES.organization
    ? lane
    : undefined;
}

export function isForegroundAiAgentLane(lane: unknown): boolean {
  const normalized = normalizeAiAgentLane(lane);
  // Legacy/main fibers may omit the lane; their established default is the
  // interactive foreground lane. Only explicit background lanes are excluded.
  return normalized !== AI_AGENT_LANES.detached && normalized !== AI_AGENT_LANES.organization;
}

export function isBackgroundAiAgentLane(lane: unknown): boolean {
  const normalized = normalizeAiAgentLane(lane);
  return normalized === AI_AGENT_LANES.detached || normalized === AI_AGENT_LANES.organization;
}

export function resolveSyncDelegateLane(parentActor: AiAgentActor): AiAgentLane {
  if (parentActor.identity?.kind === "member") {
    return AI_AGENT_LANES.member;
  }
  return AI_AGENT_LANES.interactive;
}

export function resolveDelegateLane(
  parentActor: AiAgentActor,
  mode: DelegateRunMode,
): AiAgentLane {
  return mode === DELEGATE_RUN_MODES.detached ? AI_AGENT_LANES.detached : resolveSyncDelegateLane(parentActor);
}
