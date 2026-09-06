import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { invocation, openHost, waitForTerminal } from "./fixtures/holonTaskFileRuntime"
import { cancelTask, claimTask } from "task-manager-logic"
import { buildHolonTaskObserveToolDef } from "../../src/composer/AIAgent/tools/HolonTaskObserve"
import { buildHolonTaskRepairToolDef } from "../../src/composer/AIAgent/tools/HolonTaskRepair"
import { registerHolonTaskRuntimeCapabilityBinding } from "../../src/organization/HolonTaskRuntimeCapability"
import { normalizeHolonTaskExecutionProfile } from "../../src/organization/HolonTaskExecutionProfile"
import type { HolonTaskProcessorRuntime } from "../../src/organization/HolonTaskRuntimeProcessor"

const config = { leaseDurationMs: 5000, maxSteps: 16 }
const limits = { maxTasks: 1024, maxRelations: 4096, maxLeaseDurationMs: 86400000 }
const paused = (route: Awaited<ReturnType<typeof openHost>>["route"]) => ({ ...route, coordinatorMailbox: {
  async sendWake(message: any) { return { coordinatorActorRef: "paused", messageId: message.messageId, replayed: false } },
} })
const identity = (host: Awaited<ReturnType<typeof openHost>>, receipt: any) => ({ admissionId: host.admission.admissionId, taskSpaceId: receipt.task.taskSpaceId, taskId: receipt.task.taskId })

describe("owner-backed Holon task observation and repair", () => {
  test("observes without dispatch, resumes through mailbox, preserves terminal failures and successor input", async () => {
    const root = await mkdtemp(join(tmpdir(), "holon-repair-"))
    const inputs: unknown[] = []
    const host = await openHost({ root, actorDispatch: { async dispatch({ invocation }) {
      inputs.push(invocation.input)
      if (inputs.length === 1) throw new Error("MEMBER_EXECUTION_FAILED: fixture failure")
      return { output: { done: true }, replayed: false }
    } }, transformRoute: (route) => ({ ...route, coordinatorMailbox: {
      async sendWake(message) { return { coordinatorActorRef: "paused", messageId: message.messageId, replayed: false } },
    } }) })
    try {
      const accepted = await host.capability.service.assign({ kind: "admission", admissionId: host.admission.admissionId }, invocation("source", "none"), { leaseDurationMs: 5000, maxSteps: 16 })
      const selector = { admissionId: host.admission.admissionId, taskSpaceId: accepted.task.taskSpaceId, taskId: accepted.task.taskId }
      const before = await host.capability.service.observe(selector)
      expect(before.status).toBe("Ready")
      expect(inputs).toHaveLength(0)
      await host.capability.service.repair(selector, { kind: "resume", requestId: "resume-1", expectedRevision: before.revision, reason: "continue", occurredAt: new Date().toISOString() })
      await waitForTerminal(host, selector.taskSpaceId, selector.taskId)
      const failed = await host.capability.service.observe(selector)
      expect(failed.status).toBe("Failed")
      expect(failed.lastFailure?.message).toContain("fixture failure")
      const request = { kind: "successor" as const, requestId: "repair-1", expectedRevision: failed.revision, reason: "correct input", occurredAt: new Date().toISOString(), target: { kind: "admission" as const, admissionId: host.admission.admissionId }, input: { requestId: "successor" }, name: "Retry with corrected input" }
      const repair = await host.capability.service.repair(selector, request)
      await waitForTerminal(host, selector.taskSpaceId, repair.task.taskId)
      expect(inputs).toEqual([{ requestId: "source" }, { requestId: "successor" }])
      expect((await host.capability.service.observe(selector)).status).toBe("Failed")
      expect((await host.capability.service.repair(selector, request)).replayed).toBe(true)
      await expect(host.capability.service.repair(selector, { ...request, input: "changed" })).rejects.toThrow("REPAIR_CONFLICT")
      expect((await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!.tasks).toHaveLength(2)
    } finally { host.support.close(); await rm(root, { recursive: true, force: true }) }
  })

  test("closed public tools reject wrong identities and stale revisions, expose claims without dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "holon-observe-"))
    let dispatches = 0
    const host = await openHost({ root, transformRoute: paused, actorDispatch: { async dispatch() { dispatches++; return { output: {}, replayed: false } } } })
    try {
      const accepted = await host.capability.service.assign({ kind: "admission", admissionId: host.admission.admissionId }, invocation("claimed", "none"), config)
      const selector = identity(host, accepted)
      const snapshot = (await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!
      const claimed = await claimTask(host.support.taskManager, { kind: "task.claim", commandId: "claim-external", taskSpaceId: selector.taskSpaceId, expectedRevision: snapshot.revision, taskId: selector.taskId, assigneeRef: "member-runtime:live", claimedAt: new Date().toISOString(), leaseDurationMs: 5000 }, limits)
      const runtime = { vm: host.vm } as any
      const observed = JSON.parse(String(await buildHolonTaskObserveToolDef().run(runtime, { selector }, undefined as never)))
      expect(observed.status).toBe("Claimed")
      expect(observed.claim.claimId).toBe(claimed.receipt.claim.claimId)
      expect(observed.memberRuntimeRef).toBe("member-runtime:live")
      expect(observed.sessionRef).toBeNull()
      expect(observed.sessionUnavailableReason).toContain("never creates")
      expect(dispatches).toBe(0)
      expect((await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!.revision).toBe(claimed.snapshot.revision)
      await expect(buildHolonTaskObserveToolDef().run(runtime, { selector, extra: true }, undefined as never)).rejects.toThrow("TOOL_INPUT_INVALID")
      await expect(host.capability.service.observe({ ...selector, extra: true } as any)).rejects.toThrow("INPUT_INVALID")
      await expect(host.capability.service.observe({ ...selector, taskId: "absent" })).rejects.toThrow("NOT_FOUND")
      await expect(host.route.inspection!.observe({ ...selector, admissionId: "wrong" })).rejects.toThrow("ADMISSION_MISMATCH")
      await expect(buildHolonTaskRepairToolDef().run(runtime, { selector, invocation: { kind: "resume", requestId: "stale", expectedRevision: snapshot.revision, reason: "resume", occurredAt: new Date().toISOString() } }, undefined as never)).rejects.toThrow("REVISION_CONFLICT")
      await expect(host.capability.service.repair(selector, { kind: "resume", requestId: "invalid", expectedRevision: observed.revision, reason: "resume", occurredAt: "yesterday" })).rejects.toThrow("INPUT_INVALID")
      await expect(host.capability.service.repair(selector, { kind: "successor", requestId: "unsafe", expectedRevision: observed.revision, reason: "reassign active", occurredAt: new Date().toISOString(), target: { kind: "admission", admissionId: host.admission.admissionId }, input: {}, name: "unsafe" })).rejects.toThrow("ACTION_NOT_ALLOWED")
      expect(dispatches).toBe(0)
    } finally { host.support.close(); await rm(root, { recursive: true, force: true }) }
  })

  for (const action of ["resume", "successor"] as const) {
    test(`recovers ${action} after OS process exits between owner commit and subscription publication`, async () => {
      const root = await mkdtemp(join(tmpdir(), "holon-repair-crash-"))
      const inputs: unknown[] = []
      const dispatch = { async dispatch({ invocation }: any) { inputs.push(invocation.input); return { output: { done: true }, replayed: false } } }
      let host = await openHost({ root, transformRoute: paused, actorDispatch: dispatch })
      try {
        const accepted = await host.capability.service.assign({ kind: "admission", admissionId: host.admission.admissionId }, invocation("crash-source", "none"), config)
        const selector = identity(host, accepted)
        let snapshot = (await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!
        if (action === "successor") {
          await cancelTask(host.support.taskManager, { kind: "task.cancel", commandId: "cancel-source", taskSpaceId: selector.taskSpaceId, taskId: selector.taskId, expectedRevision: snapshot.revision, cancelledAt: new Date().toISOString(), reason: "correct input" }, limits)
          snapshot = (await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!
        }
        const request = { kind: action, requestId: "crash-repair", expectedRevision: snapshot.revision, reason: "recover", occurredAt: new Date().toISOString(), ...(action === "successor" ? { target: { kind: "admission", admissionId: host.admission.admissionId }, input: { requestId: "new-input" }, name: "Successor" } : {}) } as any
        host.support.close()
        const child = Bun.spawn([process.execPath, new URL("./fixtures/holonTaskRepairCrashProcess.ts", import.meta.url).pathname, root, JSON.stringify(selector), JSON.stringify(request)], { stdout: "pipe", stderr: "pipe" })
        const stderr = new Response(child.stderr).text()
        expect(await child.exited, await stderr).toBe(74)
        host = await openHost({ root, transformRoute: paused, actorDispatch: dispatch })
        const committed = (await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!
        expect(committed.revision).toBe(snapshot.revision + 1)
        expect((await host.support.listSubscriptions()).length).toBe(1)
        if (action === "successor") {
          await host.support.wakeSubscription((await host.support.listSubscriptions())[0]!)
          expect(inputs).toHaveLength(0)
          expect((await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!.tasks.find((task) => task.taskId !== selector.taskId)!.status).toBe("Ready")
        }
        await host.support.recoverPending()
        const repairedId = action === "resume" ? selector.taskId : committed.tasks.find((task) => task.taskId !== selector.taskId)!.taskId
        await waitForTerminal(host, selector.taskSpaceId, repairedId)
        expect(inputs).toEqual([action === "resume" ? { requestId: "crash-source" } : { requestId: "new-input" }])
        expect((await host.capability.service.repair(selector, request)).replayed).toBe(true)
        await expect(host.capability.service.repair(selector, { ...request, reason: "different" })).rejects.toThrow("REPAIR_CONFLICT")
        if (action === "successor") {
          expect((await host.capability.service.observe(selector)).status).toBe("Cancelled")
          const successor = await host.capability.service.observe({ ...selector, taskId: repairedId })
          expect(successor.lineage?.source).toEqual(selector)
          expect((await host.capability.service.observe(selector)).successors).toEqual([{ ...selector, taskId: repairedId }])
          // Source subscription cannot execute a same-admission successor with the old input.
          await host.support.wakeSubscription((await host.support.listSubscriptions()).find((sub) => sub.taskId === selector.taskId)!)
          expect(inputs).toHaveLength(1)
        }
      } finally { host.support.close(); await rm(root, { recursive: true, force: true }) }
    }, 10000)
  }

  test("reassigns only the successor to a newly frozen member admission and refuses wrong target reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "holon-reassign-"))
    const host = await openHost({ root, transformRoute: paused, actorDispatch: { async dispatch() { throw new Error("source must remain cancelled") } } })
    const target = { ...host.admission, admissionId: "admission:second-member", definitionDigest: `sha256:${"9".repeat(64)}` as const,
      executionTarget: { kind: "member" as const, memberRef: "member-second" },
      snapshotAuthority: { ...host.admission.snapshotAuthority, eligibleMemberRefs: ["member-second"] } }
    let calls = 0
    const memberRuntimeRef = "member-runtime:second"
    const targetRuntime: HolonTaskProcessorRuntime = {
      taskManager: host.support.taskManager, journal: host.support.journal,
      assignment: { async assign(input, config) {
        const snapshot = (await host.support.taskManager.owner.readSnapshot(input.taskSpaceId))!
        const claimed = await claimTask(host.support.taskManager, { kind: "task.claim", commandId: input.commandId, taskSpaceId: input.taskSpaceId, expectedRevision: snapshot.revision, taskId: input.taskId, assigneeRef: memberRuntimeRef, claimedAt: input.claimedAt, leaseDurationMs: input.leaseDurationMs }, config)
        return { memberRef: "member-second", memberRuntimeRef, memberRuntimeIsolation: { mode: "shared" }, claimReceipt: claimed.receipt }
      } },
      memberRuntime: { async ensure() { return { runtimeRef: memberRuntimeRef, memberRef: "member-second", sessionRef: "session:second" } }, async resolve() { return { runtimeRef: memberRuntimeRef, memberRef: "member-second" } } },
      profile: { normalize: normalizeHolonTaskExecutionProfile },
      actorDispatch: { async dispatch(input) { calls++; expect(input.memberRuntimeRef).toBe(memberRuntimeRef); expect(input.invocation.input).toEqual({ target: "second" }); return { output: { done: true }, replayed: false } } },
      clock: { nowEpochMs: Date.now }, timer: { async wait(_delay, signal) { if (signal.aborted) return false; return new Promise((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true })) } },
    }
    const route = host.support.bind({ admission: target, processorConfig: config, deploymentId: "deployment-second", contextRef: target.admissionId,
      recoveryScope: { kind: "standalone", scopeRef: target.admissionId }, snapshotReceiptId: `sha256:${"8".repeat(64)}`,
      prepareProcessorRuntime: async () => targetRuntime })
    registerHolonTaskRuntimeCapabilityBinding(host.vm, host.capability.scope, { admission: target, route, processorConfig: config })
    try {
      const accepted = await host.capability.service.assign({ kind: "admission", admissionId: host.admission.admissionId }, invocation("reassign", "none"), config)
      const selector = identity(host, accepted)
      const before = (await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!
      await cancelTask(host.support.taskManager, { kind: "task.cancel", commandId: "cancel-reassign", taskSpaceId: selector.taskSpaceId, taskId: selector.taskId, expectedRevision: before.revision, cancelledAt: new Date().toISOString(), reason: "choose another member" }, limits)
      const cancelled = (await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!
      const request = { kind: "successor" as const, requestId: "reassign-to-second", expectedRevision: cancelled.revision, reason: "select member", occurredAt: new Date().toISOString(), target: { kind: "member" as const, holonRef: target.definition.rootHolonRef, memberRef: "member-second" }, name: "Second member", input: { target: "second" } }
      const repair = await host.capability.service.repair(selector, request)
      const observed = await host.capability.service.observe(repair.task)
      expect(observed.status).toBe("Succeeded")
      expect(observed.memberRef).toBe("member-second")
      expect(observed.memberRuntimeRef).toBe(memberRuntimeRef)
      expect(calls).toBe(1)
      // A later admission makes live selector resolution ambiguous; replay uses the accepted frozen target.
      const future = { ...target, admissionId: "admission:second-member-v2", definitionDigest: `sha256:${"7".repeat(64)}` as const }
      const futureRoute = host.support.bind({ admission: future, processorConfig: config, deploymentId: "deployment-future", contextRef: future.admissionId,
        recoveryScope: { kind: "standalone", scopeRef: future.admissionId }, snapshotReceiptId: `sha256:${"6".repeat(64)}`,
        prepareProcessorRuntime: async () => { throw new Error("must not resolve or execute future recipe during replay") } })
      registerHolonTaskRuntimeCapabilityBinding(host.vm, host.capability.scope, { admission: future, route: futureRoute, processorConfig: config })
      expect((await host.capability.service.repair(selector, request)).task.admissionId).toBe(target.admissionId)
      expect(calls).toBe(1)
      await expect(host.capability.service.observe({ ...repair.task, admissionId: selector.admissionId })).rejects.toThrow("ADMISSION_MISMATCH")
      const after = (await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!
      expect(after.tasks[0]!.definition).toEqual(cancelled.tasks[0]!.definition)
      expect(after.tasks[0]!.status).toBe("Cancelled")
      expect(after.definition.relations.filter((relation) => relation.kind === "parent-child" && relation.childTaskId === selector.taskId)).toEqual(cancelled.definition.relations)
      await expect(host.capability.service.repair(repair.task, { kind: "resume", requestId: "already-done", expectedRevision: after.revision, reason: "repeat", occurredAt: new Date().toISOString() })).rejects.toThrow("ACTION_NOT_ALLOWED")
    } finally { host.support.close(); await rm(root, { recursive: true, force: true }) }
  })

  test("retains a failed wake as observation and concurrent resume replays one owner request", async () => {
    const root = await mkdtemp(join(tmpdir(), "holon-wake-error-"))
    let calls = 0
    let host = await openHost({ root, transformRoute: paused, actorDispatch: { async dispatch() { calls++; return { output: {}, replayed: false } } } })
    try {
      const accepted = await host.capability.service.assign({ kind: "admission", admissionId: host.admission.admissionId }, invocation("wake-error", "none"), config)
      const selector = identity(host, accepted)
      const before = (await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!
      const subscription = (await host.support.listSubscriptions())[0]!
      host.support.bind({ admission: host.admission, processorConfig: config, deploymentId: subscription.deploymentId, contextRef: host.admission.admissionId,
        recoveryScope: subscription.recoveryScope, snapshotReceiptId: subscription.snapshotReceiptId as `sha256:${string}`,
        prepareProcessorRuntime: async () => { throw new Error("fixture unavailable actor owner") } })
      const request = { kind: "resume" as const, requestId: "wake-repair", expectedRevision: before.revision, reason: "resume", occurredAt: new Date().toISOString() }
      await expect(host.capability.service.repair(selector, request)).rejects.toThrow("fixture unavailable actor owner")
      const stalled = await host.capability.service.observe(selector)
      expect(stalled.status).toBe("Ready")
      expect(stalled.lastWakeError?.message).toBe("fixture unavailable actor owner")
      expect(stalled.revision).toBe(before.revision + 1)
      expect(calls).toBe(0)
      const committed = (await host.support.taskManager.owner.readSnapshot(selector.taskSpaceId))!
      expect(committed.tasks[0]!.definition.profile).toEqual(before.tasks[0]!.definition.profile)
      expect(committed.tasks[0]!.definition.inputArtifacts).toHaveLength(before.tasks[0]!.definition.inputArtifacts.length + 1)
      expect((await host.support.listSubscriptions())[0]!.input).toEqual(subscription.input)
      host.support.close()
      host = await openHost({ root, transformRoute: paused, actorDispatch: { async dispatch() { calls++; return { output: {}, replayed: false } } } })
      const [first, second] = await Promise.all([
        host.capability.service.repair(selector, request), host.capability.service.repair(selector, request),
      ])
      expect(first.replayed).toBe(true)
      expect(second.replayed).toBe(true)
      expect(calls).toBe(1)
      expect((await host.capability.service.observe(selector)).lastWakeError).toBeNull()
      await expect(host.capability.service.repair(selector, { ...request, reason: "different" })).rejects.toThrow("REPAIR_CONFLICT")
    } finally { host.support.close(); await rm(root, { recursive: true, force: true }) }
  })
})
