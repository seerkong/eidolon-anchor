import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  type FrozenHolonTaskRuntimeAdmission,
  type HolonTaskRuntimeCatalogSnapshot,
} from "@cell/ai-organ-contract"

import {
  HolonTaskRuntimeServiceError,
  createHolonTaskRuntimeService,
  registerHolonTaskRuntimeAdmission,
  type HolonTaskRuntime,
} from "../../src/organization/HolonTaskRuntimeService"

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as const

function admission(memberRef: string, suffix: string, defaultForHolon = true) {
  return {
    kind: "frozen-holon-task-runtime-admission",
    schemaVersion: HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
    admissionId: `admission:review-board:${suffix}:v1`,
    registryRevision: `registry:${suffix}`,
    definitionDigest: digest(suffix),
    definition: {
      kind: "holon-task-runtime-definition",
      schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
      definitionRef: `resource://eidolon.holon-task-runtime/${suffix}`,
      version: "1.0.0",
      rootHolonRef: "holon:review-board",
      executionBinding: {
        ref: `resource://eidolon.bindings/${suffix}`,
        digest: digest(suffix === "a" ? "1" : "2"),
      },
      taskSpace: {
        profileRef: "resource://eidolon.task-profiles/review",
        policyRef: "resource://eidolon.task-policies/default",
        requiredRoleRefs: ["role:reviewer"],
        requiredCapabilityRefs: ["resource://eidolon.capabilities/review"],
      },
      input: { schemaRef: "resource://eidolon.schemas/review-input" },
      output: {
        schemaRef: "resource://eidolon.schemas/review-output",
        materialPortRefs: ["resource://eidolon.materials/review-report"],
      },
      defaultForHolon,
    },
    executionTarget: { kind: "member", memberRef },
    snapshotAuthority: {
      kind: "holon-task-runtime-snapshot-authority",
      schemaVersion: HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
      holonRef: "holon:review-board",
      effectiveAt: "2026-09-03T00:00:00.000Z",
      holonSnapshotRef: "snapshot:review-board:1",
      holonSnapshotDigest: digest("b"),
      snapshotArtifactDigest: digest("c"),
      executionBindingRef: `resource://eidolon.bindings/${suffix}`,
      executionBindingDigest: digest(suffix === "a" ? "1" : "2"),
      eligibleMemberRefs: [memberRef],
      eligibleRoleRefs: ["role:reviewer"],
    },
  }
}

function taskSnapshotReceipt(
  value: FrozenHolonTaskRuntimeAdmission,
  taskSpaceId: string,
) {
  const authority = value.snapshotAuthority
  return {
    kind: "holon-task-snapshot-receipt" as const,
    schemaVersion: "eidolon.holon-task-snapshot-receipt/v1" as const,
    taskSpaceId,
    holonRef: authority.holonRef,
    effectiveAt: authority.effectiveAt,
    holonSnapshotRef: authority.holonSnapshotRef,
    holonSnapshotDigest: authority.holonSnapshotDigest,
    snapshotArtifactDigest: authority.snapshotArtifactDigest,
    issuerReceiptId: digest("d"),
    issuerReceiptArtifactDigest: digest("e"),
    executionBindingRef: authority.executionBindingRef,
    executionBindingDigest: authority.executionBindingDigest,
    eligibleMemberRefs: authority.eligibleMemberRefs,
    eligibleRoleRefs: authority.eligibleRoleRefs,
  }
}

function invocation(requestId = "request:42", replyMode: "final" | "none" | "stream" = "final") {
  return {
    kind: "holon-task-runtime-invocation",
    schemaVersion: HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
    requestId,
    idempotencyKey: `idempotency:${requestId}`,
    replyMode,
    occurredAt: "2026-09-03T00:00:01.000Z",
    origin: { kind: "product", surface: "HolonAssign", requestRef: requestId },
    taskRequest: { kind: "derive", name: "Review change" },
    input: { changeRef: "commit:abc" },
  }
}

describe("HolonTaskRuntimeService", () => {
  it("registers admissions through explicit catalog transitions and assigns without Workflow", async () => {
    let catalog: HolonTaskRuntimeCatalogSnapshot = Object.freeze({ revision: 0, admissions: Object.freeze([]) })
    const calls: string[] = []
    const runtime: HolonTaskRuntime = {
      catalog: {
        read: async () => catalog,
        async compareAndSet(input) {
          if (catalog.revision !== input.expectedRevision) throw new Error("catalog-cas-conflict")
          catalog = input.next
          return catalog
        },
      },
      deployment: {
        async ensure(input) {
          calls.push(`deployment:${input.admission.admissionId}`)
          return { deploymentId: `deployment:${input.admission.admissionId}` }
        },
      },
      taskSpace: {
        async submit(input) {
          calls.push(`task:${input.taskId}`)
          const taskSpaceId = `task-space:${input.invocation.requestId}`
          return {
            taskSpaceId,
            taskId: input.taskId,
            commandId: input.commandId,
            submissionFingerprint: input.submissionFingerprint,
            replayed: false,
            snapshotReceipt: taskSnapshotReceipt(input.admission, taskSpaceId),
          }
        },
      },
      coordinatorMailbox: {
        async sendWake(message) {
          calls.push(`mailbox:${message.kind}:${message.holonRef}`)
          return {
            coordinatorActorRef: `coordinator:${message.deploymentId}:${message.holonRef}`,
            messageId: message.messageId,
            replayed: false,
          }
        },
      },
      settlement: {
        async observe(input) {
          calls.push(`settlement:${input.taskId}`)
          return {
            status: "succeeded",
            settlementCommandId: `settled:${input.taskId}`,
            result: { summary: "accepted" },
            outputArtifactRefs: ["artifact:review-report"],
            replayed: false,
          }
        },
      },
    }
    const alice = admission("member:alice", "a")
    const firstCatalog = await registerHolonTaskRuntimeAdmission(runtime, alice)
    const replayedCatalog = await registerHolonTaskRuntimeAdmission(runtime, alice)
    expect(firstCatalog.revision).toBe(1)
    expect(replayedCatalog).toBe(firstCatalog)

    const service = createHolonTaskRuntimeService(runtime)
    const receipt = await service.assign(
      { kind: "holon", holonRef: "holon:review-board" },
      invocation(),
      { leaseDurationMs: 60_000, maxSteps: 32 },
    )
    expect(receipt.admissionId).toBe(alice.admissionId)
    expect(receipt.settlement?.status).toBe("succeeded")
    expect(calls.map((entry) => entry.split(":")[0]))
      .toEqual(["deployment", "task", "mailbox", "settlement"])
    expect(calls[2]).toContain("holon-task.coordinator-wake")
  })

  it("reuses one admission while binding a distinct snapshot receipt per TaskSpace", async () => {
    const alice = admission("member:alice", "a")
    let catalog: HolonTaskRuntimeCatalogSnapshot = Object.freeze({
      revision: 1,
      admissions: Object.freeze([alice] as FrozenHolonTaskRuntimeAdmission[]),
    })
    const service = createHolonTaskRuntimeService(minimalRuntime(
      () => catalog,
      (next) => { catalog = next },
    ))
    const first = await service.assign(
      { kind: "holon", holonRef: "holon:review-board" },
      invocation("request:first", "none"),
      { leaseDurationMs: 60_000, maxSteps: 32 },
    )
    const second = await service.assign(
      { kind: "holon", holonRef: "holon:review-board" },
      invocation("request:second", "none"),
      { leaseDurationMs: 60_000, maxSteps: 32 },
    )
    expect(first.admissionId).toBe(second.admissionId)
    expect(first.task.taskSpaceId).not.toBe(second.task.taskSpaceId)
    expect(first.task.snapshotReceipt.taskSpaceId).toBe(first.task.taskSpaceId)
    expect(second.task.snapshotReceipt.taskSpaceId).toBe(second.task.taskSpaceId)
  })

  it("resolves exact Member bindings and fails closed for required or ambiguous targets", async () => {
    const alice = admission("member:alice", "a")
    const bob = admission("member:bob", "b")
    let catalog: HolonTaskRuntimeCatalogSnapshot = Object.freeze({
      revision: 2,
      admissions: Object.freeze([alice, bob] as FrozenHolonTaskRuntimeAdmission[]),
    })
    const runtime = minimalRuntime(() => catalog, (next) => { catalog = next })
    const service = createHolonTaskRuntimeService(runtime)

    const bobReceipt = await service.assign(
      { kind: "member", holonRef: "holon:review-board", memberRef: "member:bob" },
      invocation("request:bob", "none"),
      { leaseDurationMs: 60_000, maxSteps: 32 },
    )
    expect(bobReceipt.admissionId).toBe(bob.admissionId)
    expect(bobReceipt.settlement).toBeNull()

    await expect(service.assign(
      { kind: "member", holonRef: "holon:review-board", memberRef: "member:charlie" },
      invocation("request:charlie"),
      { leaseDurationMs: 60_000, maxSteps: 32 },
    )).rejects.toMatchObject({ code: "EIDOLON_HOLON_TASK_BINDING_REQUIRED" })

    await expect(service.assign(
      { kind: "holon", holonRef: "holon:review-board" },
      invocation("request:ambiguous"),
      { leaseDurationMs: 60_000, maxSteps: 32 },
    )).rejects.toMatchObject({ code: "EIDOLON_HOLON_TASK_BINDING_AMBIGUOUS" })
  })

  it("keeps the service facade free of hidden catalog and actor state", async () => {
    const source = await readFile(
      new URL("../../src/organization/HolonTaskRuntimeService.ts", import.meta.url),
      "utf8",
    )
    expect(source).not.toContain("new Map")
    expect(source).not.toContain("WeakMap")
    expect(source).not.toContain("ai-workflow-contract")
    expect(source).not.toContain("FileTaskSpace")
    expect(source).not.toContain("dispatchMember(")
    expect(source).toContain("coordinatorMailbox.sendWake")
  })
})

function minimalRuntime(
  readCatalog: () => HolonTaskRuntimeCatalogSnapshot,
  writeCatalog: (value: HolonTaskRuntimeCatalogSnapshot) => void,
): HolonTaskRuntime {
  return {
    catalog: {
      read: async () => readCatalog(),
      async compareAndSet(input) {
        if (readCatalog().revision !== input.expectedRevision) throw new Error("catalog-cas-conflict")
        writeCatalog(input.next)
        return input.next
      },
    },
    deployment: { ensure: async () => ({ deploymentId: "deployment:review-board" }) },
    taskSpace: {
      async submit(input) {
        const taskSpaceId = `task-space:${input.invocation.requestId}`
      return {
        taskSpaceId,
        taskId: input.taskId,
        commandId: input.commandId,
        submissionFingerprint: input.submissionFingerprint,
        replayed: false,
          snapshotReceipt: taskSnapshotReceipt(input.admission, taskSpaceId),
        }
      },
    },
    coordinatorMailbox: {
      async sendWake(message) {
        return {
          coordinatorActorRef: "coordinator:review-board",
          messageId: message.messageId,
          replayed: false,
        }
      },
    },
    settlement: {
      async observe(input) {
        return {
          status: "succeeded",
          settlementCommandId: `settled:${input.taskId}`,
          result: { summary: "done" },
          outputArtifactRefs: [],
          replayed: false,
        }
      },
    },
  }
}

void HolonTaskRuntimeServiceError
