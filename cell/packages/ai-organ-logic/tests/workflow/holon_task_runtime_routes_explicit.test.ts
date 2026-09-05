import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { canonicalOwnDataDigest } from "task-manager-contract"
import { InMemoryTaskSpaceOwner } from "task-manager-logic"
import {
  HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  HOLON_TASK_COORDINATOR_WAKE_SCHEMA_VERSION,
  type FrozenHolonTaskRuntimeAdmission,
  type HolonTaskRuntimeInvocation,
} from "@cell/ai-organ-contract"
import {
  HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION,
  type HolonTaskPumpJournalPort,
  type HolonTaskPumpSubscription,
} from "../../src/organization/HolonTaskPumpJournal"
import {
  createHolonTaskRuntimeRoutes,
  createHolonTaskRuntimeRouteState,
  type HolonTaskRuntimeCoordinatorPort,
  type LocalHolonTaskRuntimeBinding,
} from "../../src/organization/HolonTaskRuntimeRoutes"
import { normalizeHolonTaskExecutionProfile } from "../../src/organization/HolonTaskExecutionProfile"
import type { HolonTaskProcessorRuntime } from "../../src/organization/HolonTaskRuntimeProcessor"
import type { HolonTaskSubmissionRecord } from "@cell/ai-organ-contract/organization/HolonTaskRuntimeStorage"

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as const
const processorConfig = Object.freeze({ leaseDurationMs: 5_000, maxSteps: 16 })

function admission(): FrozenHolonTaskRuntimeAdmission {
  return Object.freeze({
    kind: "frozen-holon-task-runtime-admission",
    schemaVersion: HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
    admissionId: "admission:standalone-review",
    registryRevision: "registry:standalone-review",
    definitionDigest: digest("a"),
    definition: Object.freeze({
      kind: "holon-task-runtime-definition",
      schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
      definitionRef: "resource://fixture.task-runtime.review",
      version: "1.0.0",
      rootHolonRef: "holon-review",
      executionBinding: Object.freeze({
        ref: "resource://fixture.binding.review",
        digest: digest("b"),
      }),
      taskSpace: Object.freeze({
        profileRef: "resource://fixture.profile.review",
        policyRef: "resource://fixture.policy.review",
        requiredRoleRefs: Object.freeze(["role-reviewer"]),
        requiredCapabilityRefs: Object.freeze(["resource://fixture.capability.review"]),
      }),
      input: Object.freeze({ schemaRef: "resource://fixture.schema.input" }),
      output: Object.freeze({
        schemaRef: "resource://fixture.schema.output",
        materialPortRefs: Object.freeze(["resource://fixture.port.output"]),
      }),
      defaultForHolon: true,
    }),
    executionTarget: Object.freeze({ kind: "member", memberRef: "member-reviewer" }),
    snapshotAuthority: Object.freeze({
      kind: "holon-task-runtime-snapshot-authority",
      schemaVersion: HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
      holonRef: "holon-review",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      holonSnapshotRef: "snapshot-review",
      holonSnapshotDigest: digest("c"),
      snapshotArtifactDigest: digest("d"),
      executionBindingRef: "resource://fixture.binding.review",
      executionBindingDigest: digest("b"),
      eligibleMemberRefs: Object.freeze(["member-reviewer"]),
      eligibleRoleRefs: Object.freeze(["role-reviewer"]),
    }),
  })
}


function fixture() {
  const owner = new InMemoryTaskSpaceOwner()
  const subscriptions = new Map<string, HolonTaskPumpSubscription>()
  const retained: HolonTaskSubmissionRecord[] = []
  const journal: HolonTaskPumpJournalPort = {
    async subscribe(input) {
      const subscriptionId = canonicalOwnDataDigest([input.taskSpaceId, input.taskId])
      const prior = subscriptions.get(subscriptionId)
      if (prior) return prior
      const subscription = Object.freeze({
        ...input,
        schemaVersion: HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION,
        subscriptionId,
        inputDigest: canonicalOwnDataDigest(input.input),
      })
      subscriptions.set(subscriptionId, subscription)
      return subscription
    },
    async listSubscriptions() { return [...subscriptions.values()] },
    async dispatch() { throw new Error("UNEXPECTED_DISPATCH") },
    async readResult() { return undefined },
  }
  const state = createHolonTaskRuntimeRouteState()
  const support = createHolonTaskRuntimeRoutes({
    ...state,
    taskManager: { owner },
    journal,
    now: () => Date.parse("2026-01-02T03:04:05.000Z"),
    retainSubmission: async (record) => { retained.push(record) },
  }, { waitingProbeMs: 7 })
  const frozenAdmission = admission()
  const binding: LocalHolonTaskRuntimeBinding = {
    admission: frozenAdmission,
    processorConfig,
    deploymentId: "deployment-review",
    contextRef: "standalone-context",
    recoveryScope: { kind: "standalone", scopeRef: frozenAdmission.admissionId },
    snapshotReceiptId: digest("e"),
    automaticPump: () => false,
    async prepareProcessorRuntime() { throw new Error("UNEXPECTED_PROCESSOR_PREPARATION") },
  }
  const route = support.bind(binding)
  const invocation: HolonTaskRuntimeInvocation = {
    kind: "holon-task-runtime-invocation",
    schemaVersion: HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
    requestId: "request-memory",
    idempotencyKey: "idempotency-memory",
    replyMode: "none",
    occurredAt: "2026-01-01T00:00:00.000Z",
    origin: { kind: "product", surface: "test", requestRef: "request-memory" },
    taskRequest: { kind: "derive", name: "Memory review" },
    input: { request: "review" },
  }
  const submission = {
    admission: frozenAdmission,
    invocation,
    taskId: "task-memory",
    commandId: "create-memory",
    submissionFingerprint: digest("f"),
    config: processorConfig,
  }
  return { owner, state, support, binding, route, submission, retained, subscriptions }
}

describe("Holon task route effect boundary", () => {
  it("keeps physical task storage independent of organ rules", async () => {
    const source = await readFile(new URL("../../../ai-support/src/organization/LocalHolonTaskRuntimeSupport.ts", import.meta.url), "utf8")
    expect(source).not.toContain("@cell/ai-organ-logic")
    expect(source).not.toContain("createTaskSpace")
    expect(source).not.toContain("HolonTaskSpaceCoordinatorActor")
    expect(source).toContain("createLocalHolonTaskRuntimeStorage")
    const rules = await readFile(new URL("../../src/organization/HolonTaskRuntimeRoutes.ts", import.meta.url), "utf8")
    expect(rules).not.toMatch(/node:fs|task-manager-file-support|new File|this\.|ensureFacet/)
  })

  it("creates and replays a task through the injected owner and submission writer", async () => {
    const host = fixture()
    const first = await host.route.taskSpace.submit(host.submission)
    const replay = await host.route.taskSpace.submit(host.submission)
    expect(first.replayed).toBe(false)
    expect(replay).toEqual({ ...first, replayed: true })
    expect(first.taskSpaceId).toBe(`holon-task-space-${canonicalOwnDataDigest([
      host.binding.admission.admissionId,
      host.submission.invocation.requestId,
      host.submission.invocation.idempotencyKey,
    ]).slice(7, 47)}`)
    expect(host.retained).toEqual([{
      taskSpaceId: first.taskSpaceId,
      taskId: first.taskId,
      commandId: first.commandId,
      submissionFingerprint: first.submissionFingerprint,
    }, host.retained[0]!])
    const snapshot = await host.owner.readSnapshot(first.taskSpaceId)
    expect(snapshot?.revision).toBe(0)
    expect(snapshot?.tasks).toHaveLength(1)
    expect(normalizeHolonTaskExecutionProfile(snapshot!.tasks[0]!.profile).facts.snapshotReceipt)
      .toEqual(first.snapshotReceipt)
    expect(await host.support.listSubscriptions()).toHaveLength(1)
    host.support.close()
  })

  it("reuses one admission route and preserves context, deployment, and config rejection", async () => {
    const host = fixture()
    expect(host.support.bind({ ...host.binding })).toBe(host.route)
    expect(() => host.support.bind({ ...host.binding, snapshotReceiptId: digest("9") }))
      .toThrow("EIDOLON_HOLON_TASK_SUPPORT_CONTEXT_CONFLICT")
    expect(() => host.support.bind({ ...host.binding, contextRef: "other", deploymentId: "other" }))
      .toThrow("EIDOLON_HOLON_TASK_SUPPORT_DEPLOYMENT_CONFLICT")
    await expect(host.route.taskSpace.submit({
      ...host.submission,
      config: { ...processorConfig, maxSteps: 1 },
    })).rejects.toThrow("EIDOLON_HOLON_TASK_SUPPORT_PROCESSOR_CONFIG_CONFLICT")
    await expect(host.route.deployment.ensure({
      admission: { ...host.binding.admission, registryRevision: "wrong" },
    })).rejects.toThrow("EIDOLON_HOLON_TASK_SUPPORT_ADMISSION_MISMATCH")
    expect(host.retained).toHaveLength(0)
    expect(await fixture().support.listSubscriptions()).toHaveLength(0)
    host.support.close()
  })

  it("recovers correlations from subscriptions and preserves mailbox wake deduplication", async () => {
    const host = fixture()
    const task = await host.route.taskSpace.submit(host.submission)
    host.state.tasks.clear()
    const wake = {
      kind: "holon-task.coordinator-wake" as const,
      schemaVersion: HOLON_TASK_COORDINATOR_WAKE_SCHEMA_VERSION,
      deploymentId: host.binding.deploymentId,
      holonRef: host.binding.admission.definition.rootHolonRef,
      taskSpaceId: task.taskSpaceId,
      taskId: task.taskId,
      messageId: "wake-memory",
    }
    const first = await host.route.coordinatorMailbox.sendWake(wake)
    expect(first.replayed).toBe(false)
    expect((await host.route.coordinatorMailbox.sendWake(wake)).replayed).toBe(true)
    expect(host.state.tasks.size).toBe(1)
    expect(host.state.coordinators.size).toBe(1)
    expect(host.state.tasks.values().next().value?.invocation.requestId)
      .toStartWith("recovered:")
    host.support.close()
    expect(host.state.coordinators.size).toBe(0)
    expect(host.state.tasks.size).toBe(0)
    expect(host.state.wakeReceipts.size).toBe(0)
  })

  it("uses injected coordinator ownership and waiting-probe configuration during recovery", async () => {
    const host = fixture()
    await host.route.taskSpace.submit(host.submission)
    const scheduled: number[] = []
    let closed = false
    const coordinator: HolonTaskRuntimeCoordinatorPort = {
      actorId: "injected-coordinator",
      async wake() { throw new Error("UNEXPECTED_WAKE") },
      scheduleWake(_input, _enqueue, delay) { scheduled.push(delay) },
      close() { closed = true },
    }
    host.state.coordinators.set(
      `${host.binding.deploymentId}\u0000${host.binding.admission.definition.rootHolonRef}`,
      coordinator,
    )
    expect(await host.support.recoverPending()).toEqual({ recovered: 1, scheduled: 1, terminal: 0 })
    expect(scheduled).toEqual([7])
    host.support.close()
    expect(closed).toBe(true)
  })

  it("passes the injected clock and binding runtime into the coordinator wake", async () => {
    const host = fixture()
    const unused = async (): Promise<never> => { throw new Error("UNEXPECTED_PROCESSOR_EFFECT") }
    const processor: HolonTaskProcessorRuntime = {
      taskManager: { owner: host.owner },
      journal: host.support.journal,
      assignment: { assign: unused },
      memberRuntime: { ensure: unused, resolve: unused },
      profile: { normalize: normalizeHolonTaskExecutionProfile },
      actorDispatch: { dispatch: unused },
      clock: { nowEpochMs: () => 0 },
      timer: { wait: unused },
    }
    host.support.bind({ ...host.binding, prepareProcessorRuntime: async () => processor })
    const task = await host.route.taskSpace.submit(host.submission)
    const [subscription] = await host.support.listSubscriptions()
    let observedAt: string | undefined
    const coordinator: HolonTaskRuntimeCoordinatorPort = {
      actorId: "clock-coordinator",
      async wake(actualRuntime, input) {
        expect(actualRuntime).toBe(processor)
        expect(input.leaseDurationMs).toBe(processorConfig.leaseDurationMs)
        expect(input.maxSteps).toBe(processorConfig.maxSteps)
        observedAt = input.observedAt
        return {
          kind: "holon-task-space-pump-result",
          taskSpaceId: task.taskSpaceId,
          observedRevision: 0,
          status: "terminal",
          steps: 0,
          settlements: [],
        }
      },
      scheduleWake() { throw new Error("UNEXPECTED_SCHEDULE") },
      close() {},
    }
    host.state.coordinators.set(
      `${host.binding.deploymentId}\u0000${host.binding.admission.definition.rootHolonRef}`,
      coordinator,
    )
    await host.support.wakeSubscription(subscription!)
    expect(observedAt).toBe("2026-01-02T03:04:05.000Z")
    host.support.close()
  })
})
