import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { ensureVmSessionState } from "@cell/ai-core-logic/runtime/runtime"
import type { TaskNode } from "@cell/ai-core-contract/plan/TaskTree"
import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager"
import { buildAutonomousHolonTaskScope, buildLeaderLedHolonTaskScope } from "@cell/ai-organ-logic/organization/holonRuntimeProtocol"
import { resolveActorSubject } from "../_resolveActorTarget"
import type { ActorStatusInnerConfig, ActorStatusInnerInput, ActorStatusInnerOutput, ActorStatusInnerRuntime } from "./InnerTypes"

function countRootTaskStatuses(nodes: TaskNode[], activeForm: string): {
  total: number
  pending: number
  in_progress: number
  completed: number
  failed: number
  cancelled: number
} {
  const summary = {
    total: 0,
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }

  for (const node of nodes) {
    if (node.activeForm !== activeForm) continue
    summary.total += 1
    if (node.status === "pending") summary.pending += 1
    else if (node.status === "in_progress") summary.in_progress += 1
    else if (node.status === "completed") summary.completed += 1
    else if (node.status === "failed") summary.failed += 1
    else if (node.status === "cancelled") summary.cancelled += 1
  }

  return summary
}

function countFormationRouteStatuses(routes: Record<string, { status?: string }> | undefined): {
  total: number
  pending: number
  in_progress: number
  completed: number
  failed: number
  cancelled: number
} {
  const summary = {
    total: 0,
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }

  for (const route of Object.values(routes ?? {})) {
    summary.total += 1
    if (route?.status === "completed") summary.completed += 1
    else if (route?.status === "failed") summary.failed += 1
    else if (route?.status === "cancelled") summary.cancelled += 1
    else if (route?.status === "routed" || route?.status === "streaming") summary.in_progress += 1
    else summary.pending += 1
  }

  return summary
}

function countCollectiveTaskStatuses(tasks: Record<string, { status?: string }> | undefined): {
  total: number
  pending: number
  in_progress: number
  completed: number
  failed: number
  cancelled: number
} {
  const summary = {
    total: 0,
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }

  for (const task of Object.values(tasks ?? {})) {
    summary.total += 1
    if (task?.status === "completed") summary.completed += 1
    else if (task?.status === "failed") summary.failed += 1
    else if (task?.status === "cancelled") summary.cancelled += 1
    else if (task?.status === "routed") summary.in_progress += 1
    else summary.pending += 1
  }

  return summary
}

function resolveLifecycleState(runtime: ActorStatusInnerRuntime, target: any): string | null {
  if (
    target?.organizationKind === "holon"
    || target?.identity?.kind === "holon"
  ) {
    return "active"
  }

  if (target?.identity?.kind === "member") {
    const member = getMemberManager().findByActor({
      vm: runtime.vm,
      actorKey: target.key,
      actorId: target.id,
    })
    return member?.lifecycleState ?? "active"
  }

  if (target?.type === "detached") {
    if (target.detachedTask) {
      return target.detachedTask.status === "completed" || target.detachedTask.status === "failed" || target.detachedTask.status === "cancelled"
        ? "exited"
        : "active"
    }
    const detached = Object.values(ensureVmSessionState(runtime.vm).detachedActors).find((entry) => (
      entry.childActorKey === target.key
      && (entry.childActorId == null || entry.childActorId === target.id)
    ))
    if (!detached) return "active"
    return detached.status === "completed" || detached.status === "failed" || detached.status === "cancelled"
      ? "exited"
      : "active"
  }

  return typeof target?.type === "string" ? "active" : null
}

function resolveDetachedProjection(runtime: ActorStatusInnerRuntime, target: any): {
  task_id: string
  status: string
  kind: string
} | null {
  if (target?.type !== "detached") return null
  if (target.detachedTask) {
    return {
      task_id: target.detachedTask.taskId,
      status: target.detachedTask.status,
      kind: target.detachedTask.kind,
    }
  }
  const detached = Object.values(ensureVmSessionState(runtime.vm).detachedActors).find((entry) => (
    entry.childActorKey === target.key
    && (entry.childActorId == null || entry.childActorId === target.id)
  ))
  if (!detached) return null
  return {
    task_id: detached.taskId,
    status: detached.status,
    kind: detached.kind,
  }
}

function resolveTaskSummary(runtime: ActorStatusInnerRuntime, target: any): {
  total: number
  pending: number
  in_progress: number
  completed: number
  failed: number
  cancelled: number
} | null {
  if (target?.organizationKind === "holon" && target?.governance === "autonomous") {
    return countRootTaskStatuses(runtime.vm.actors[runtime.vm.controlActorKey]?.taskTree.root.children ?? [], buildAutonomousHolonTaskScope(target.id))
  }
  if (target?.organizationKind === "holon" && target?.governance === "leader_led") {
    return countRootTaskStatuses(runtime.vm.actors[runtime.vm.controlActorKey]?.taskTree.root.children ?? [], buildLeaderLedHolonTaskScope(target.id))
  }
  if (target?.identity?.kind === "holon" && target?.identity?.governance === "autonomous") {
    return countCollectiveTaskStatuses(target.holonState?.governance === "autonomous" ? target.holonState.tasks : undefined)
  }
  if (target?.identity?.kind === "holon" && target?.identity?.governance === "leader_led") {
    return countFormationRouteStatuses(target.holonState?.governance === "leader_led" ? target.holonState.routes : undefined)
  }
  return null
}

function resolveHolonGovernance(target: any): "autonomous" | "leader_led" | null {
  if (target?.governance === "autonomous" || target?.identity?.governance === "autonomous") return "autonomous"
  if (target?.governance === "leader_led" || target?.identity?.governance === "leader_led") return "leader_led"
  return null
}

function resolveFormalOrganizationKind(target: any): string | null {
  if (
    target?.organizationKind === "holon"
    || target?.identity?.kind === "holon"
  ) {
    return "holon"
  }
  return target?.organizationKind ?? target?.identity?.kind ?? null
}

export const makeActorStatusOuterComputed = stdMakeNullOuterComputed
export const makeActorStatusInnerRuntime = stdMakeIdentityInnerRuntime
export const makeActorStatusInnerInput = stdMakeIdentityInnerInput
export const makeActorStatusInnerConfig = stdMakeIdentityInnerConfig
export const makeActorStatusOuterOutput = stdMakeIdentityOuterOutput

export const actorStatusCoreLogic: StdInnerLogic<
  ActorStatusInnerRuntime,
  ActorStatusInnerInput,
  ActorStatusInnerConfig,
  ActorStatusInnerOutput
> = async (runtime, input) => {
  const target = resolveActorSubject(runtime.vm, String(input?.target ?? ""))
  if (!target) return JSON.stringify({ ok: false, error: "actor_not_found", target: String(input?.target ?? "") })
  const taskSummary = resolveTaskSummary(runtime, target)
  const detachedProjection = resolveDetachedProjection(runtime, target)
  const governance = resolveHolonGovernance(target)
  const memberIds =
    (target as any).memberIds
    ?? ((target as any).holonState?.memberIds)

  return JSON.stringify({
    ok: true,
    actor_key: target.key,
    actor_id: target.id,
    actor_type: (target as any).type ?? null,
    truth_source: (target as any).type ? "actor" : ((target as any).truthSource ?? "organization_projection"),
    degraded: (target as any).degraded === true,
    execution_kind: (target as any).type ?? null,
    organization_kind: resolveFormalOrganizationKind(target),
    governance,
    watch_state:
      (target as any).holonState?.watchState
      ?? (target as any).watchState
      ?? "unwatched",
    lifecycle_state: resolveLifecycleState(runtime, target),
    identity: (target as any).identity ?? null,
    member_ids: memberIds,
    member_count: Array.isArray(memberIds)
      ? memberIds.length
      : null,
    leader_member_id: (target as any).leaderMemberId ?? (target as any).holonState?.leaderMemberId ?? null,
    task_summary: taskSummary,
    detached_task: detachedProjection,
  })
}
