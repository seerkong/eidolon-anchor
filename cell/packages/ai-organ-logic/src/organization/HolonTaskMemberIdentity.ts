import type { HolonMemberRuntimeLifecycleFact } from "holarchy-eidolon-adapter"
import type { TaskClaimToken } from "task-manager-contract"

type MemberIdentity = Pick<HolonMemberRuntimeLifecycleFact, "runtimeRef" | "holonRef" | "memberRef" | "sessions">

export async function resolveHolonTaskMemberIdentity(
  runtime: Readonly<{ store: Readonly<{ load(deploymentId: string): Promise<Readonly<{ members: readonly MemberIdentity[] }>> }> }>,
  input: Readonly<{
    subscription: Readonly<{ deploymentId: string; holonRef: string; taskSpaceId: string; taskId: string }>
    claim: Pick<TaskClaimToken, "assigneeRef" | "claimId" | "attempt">
  }>,
): Promise<Readonly<{ memberRef: string; sessionRef?: string }> | undefined> {
  const snapshot = await runtime.store.load(input.subscription.deploymentId)
  const members = snapshot.members.filter((member) => member.runtimeRef === input.claim.assigneeRef)
  if (members.length === 0) return undefined
  if (members.length !== 1 || members[0]!.holonRef !== input.subscription.holonRef) {
    throw new Error("EIDOLON_HOLON_TASK_MEMBER_IDENTITY_MISMATCH")
  }
  const member = members[0]!
  const sessions = member.sessions.filter((session) => session.mode === "task-attempt"
    && session.taskSpaceId === input.subscription.taskSpaceId && session.taskId === input.subscription.taskId
    && session.claimId === input.claim.claimId && session.attempt === input.claim.attempt)
  if (sessions.length > 1) throw new Error("EIDOLON_HOLON_TASK_MEMBER_SESSION_AMBIGUOUS")
  return Object.freeze({ memberRef: member.memberRef, ...(sessions[0] ? { sessionRef: sessions[0].sessionRef } : {}) })
}
