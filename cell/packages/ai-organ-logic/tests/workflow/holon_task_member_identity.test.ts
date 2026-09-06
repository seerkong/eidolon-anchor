import { expect, test } from "bun:test"
import { resolveHolonTaskMemberIdentity } from "../../src/organization/HolonTaskMemberIdentity"

const subscription = { deploymentId: "deployment", holonRef: "holon", taskSpaceId: "space", taskId: "task" }
const claim = { assigneeRef: "runtime", claimId: "claim", attempt: 2 }
const session = { mode: "task-attempt" as const, taskSpaceId: "space", taskId: "task", claimId: "claim", attempt: 2, sessionRef: "exact-session" }
const member = { runtimeRef: "runtime", holonRef: "holon", memberRef: "member", sessions: [
  { ...session, attempt: 1, claimId: "previous-claim", sessionRef: "previous-session" },
  session,
  { ...session, taskId: "another-task", sessionRef: "most-recent-unrelated-session" },
] }

test("observes the exact task-attempt session, never the newest shared member session", async () => {
  const reads: string[] = []
  const result = await resolveHolonTaskMemberIdentity({ store: { async load(id) { reads.push(id); return { members: [member] } } } }, { subscription, claim })
  expect(reads).toEqual(["deployment"])
  expect(result).toEqual({ memberRef: "member", sessionRef: "exact-session" })
})

test("does not create a missing runtime/session or borrow another claim", async () => {
  expect(await resolveHolonTaskMemberIdentity({ store: { async load() { return { members: [] } } } }, { subscription, claim })).toBeUndefined()
  const result = await resolveHolonTaskMemberIdentity({ store: { async load() { return { members: [member] } } } }, {
    subscription, claim: { ...claim, claimId: "missing-claim" },
  })
  expect(result).toEqual({ memberRef: "member" })
})

test("rejects ambiguous or wrong-organization facts instead of inventing a session", async () => {
  await expect(resolveHolonTaskMemberIdentity({ store: { async load() { return { members: [{ ...member, sessions: [session, { ...session, sessionRef: "conflict" }] }] } } } }, { subscription, claim }))
    .rejects.toThrow("EIDOLON_HOLON_TASK_MEMBER_SESSION_AMBIGUOUS")
  await expect(resolveHolonTaskMemberIdentity({ store: { async load() { return { members: [{ ...member, holonRef: "other-holon" }] } } } }, { subscription, claim }))
    .rejects.toThrow("EIDOLON_HOLON_TASK_MEMBER_IDENTITY_MISMATCH")
})
