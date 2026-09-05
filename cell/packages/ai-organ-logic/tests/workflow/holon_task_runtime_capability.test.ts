import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  type FrozenHolonTaskRuntimeAdmission,
} from "@cell/ai-organ-contract"

import {
  HOLON_TASK_RUNTIME_CAPABILITY_FACET,
  assignHolonTaskThroughCapability,
  listHolonTaskRuntimeCapabilityAdmissions,
  mountHolonTaskRuntimeCapability,
  registerHolonTaskRuntimeCapabilityBinding,
  type HolonTaskRuntimeCapabilityRoute,
  type HolonTaskRuntimeCapabilityVm,
} from "../../src/organization/HolonTaskRuntimeCapability"

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as const
const scope = Object.freeze({
  supportRoot: "/tmp/eidolon-holon-task-runtime",
  registryRef: "resource://registries/holon-task-runtime",
} as const)

function admission(memberRef: string, suffix: string, holonRef = "holon:review") {
  const bindingDigest = digest(suffix === "a" ? "1" : "2")
  return {
    kind: "frozen-holon-task-runtime-admission",
    schemaVersion: HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
    admissionId: `admission:${holonRef}:${suffix}`,
    registryRevision: `registry:${suffix}`,
    definitionDigest: digest(suffix),
    definition: {
      kind: "holon-task-runtime-definition",
      schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
      definitionRef: `resource://runtime/${suffix}`,
      version: "1",
      rootHolonRef: holonRef,
      executionBinding: { ref: `resource://binding/${suffix}`, digest: bindingDigest },
      taskSpace: {
        profileRef: "resource://profile/review",
        policyRef: "resource://policy/review",
        requiredRoleRefs: ["role:reviewer"],
        requiredCapabilityRefs: ["resource://capability/review"],
      },
      input: { schemaRef: "resource://schema/input" },
      output: { schemaRef: "resource://schema/output", materialPortRefs: [] },
      defaultForHolon: true,
    },
    executionTarget: { kind: "member", memberRef },
    snapshotAuthority: {
      kind: "holon-task-runtime-snapshot-authority",
      schemaVersion: HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
      holonRef,
      effectiveAt: "2026-09-04T00:00:00.000Z",
      holonSnapshotRef: `snapshot:${holonRef}:1`,
      holonSnapshotDigest: digest("b"),
      snapshotArtifactDigest: digest("c"),
      executionBindingRef: `resource://binding/${suffix}`,
      executionBindingDigest: bindingDigest,
      eligibleMemberRefs: [memberRef],
      eligibleRoleRefs: ["role:reviewer"],
    },
  } as const
}

function vm(): HolonTaskRuntimeCapabilityVm {
  const facets = new Map<string, unknown>()
  return {
    actorRuntime: {
      ensureFacet<T>(key: string, factory: () => T): T {
        if (!facets.has(key)) facets.set(key, factory())
        return facets.get(key) as T
      },
    },
  }
}

function invocation(requestId: string) {
  return {
    kind: "holon-task-runtime-invocation",
    schemaVersion: HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
    requestId,
    idempotencyKey: `idempotency:${requestId}`,
    replyMode: "final",
    occurredAt: "2026-09-04T00:00:01.000Z",
    origin: { kind: "product", surface: "MemberAssign", requestRef: requestId },
    taskRequest: { kind: "derive", name: "Review change" },
    input: { content: "review" },
  } as const
}

function snapshotReceipt(value: FrozenHolonTaskRuntimeAdmission, taskSpaceId: string) {
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

function route(value: FrozenHolonTaskRuntimeAdmission, calls: string[]): HolonTaskRuntimeCapabilityRoute {
  return {
    routeRef: `resource://routes/${value.admissionId}`,
    deployment: {
      async ensure() {
        calls.push(`deployment:${value.admissionId}`)
        return { deploymentId: `deployment:${value.admissionId}` }
      },
    },
    taskSpace: {
      async submit(input) {
        calls.push(`task:${value.admissionId}`)
        const taskSpaceId = input.invocation.taskRequest.kind === "exact"
          ? input.invocation.taskRequest.identity.taskSpaceId
          : `task-space:${input.invocation.requestId}`
        return {
          taskSpaceId,
          taskId: input.taskId,
          commandId: input.commandId,
          submissionFingerprint: input.submissionFingerprint,
          replayed: false,
          snapshotReceipt: snapshotReceipt(value, taskSpaceId),
        }
      },
    },
    coordinatorMailbox: {
      async sendWake(message) {
        calls.push(`wake:${value.admissionId}`)
        return {
          coordinatorActorRef: `coordinator:${message.deploymentId}`,
          messageId: message.messageId,
          replayed: false,
        }
      },
    },
    settlement: {
      async observe(input) {
        calls.push(`settlement:${value.admissionId}`)
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

describe("HolonTaskRuntime VM capability", () => {
  it("owns exactly one service/catalog while routing multiple admissions", async () => {
    const host = vm()
    const calls: string[] = []
    const before = mountHolonTaskRuntimeCapability(host, scope)
    const alice = admission("member:alice", "a")
    const bob = admission("member:bob", "b")
    const aliceMount = registerHolonTaskRuntimeCapabilityBinding(host, scope, {
      admission: alice,
      route: route(alice, calls),
      processorConfig: { leaseDurationMs: 30_000, maxSteps: 64 },
    })
    const bobMount = registerHolonTaskRuntimeCapabilityBinding(host, scope, {
      admission: bob,
      route: route(bob, calls),
      processorConfig: { leaseDurationMs: 30_000, maxSteps: 64 },
    })
    const after = mountHolonTaskRuntimeCapability(host, scope)

    expect(after.service).toBe(before.service)
    expect(aliceMount.serviceRuntimeRef).toBe(after.serviceRuntimeRef)
    expect(bobMount.serviceRuntimeRef).toBe(after.serviceRuntimeRef)
    expect(after.readCatalog()).toBe(before.readCatalog())
    expect(after.readCatalog().revision).toBe(2)

    const result = await assignHolonTaskThroughCapability(host, scope, {
      kind: "member",
      holonRef: "holon:review",
      memberRef: "member:bob",
    }, invocation("request:bob"))
    expect(result.admissionId).toBe(bob.admissionId)
    expect(calls).toEqual([
      `deployment:${bob.admissionId}`,
      `task:${bob.admissionId}`,
      `wake:${bob.admissionId}`,
      `settlement:${bob.admissionId}`,
    ])
    expect(listHolonTaskRuntimeCapabilityAdmissions(host, scope).map(({ admissionId }) => admissionId))
      .toEqual([alice.admissionId, bob.admissionId])
  })

  it("fails closed on ambiguous Holon routing, conflicting registration, and scope replacement", async () => {
    const host = vm()
    const alice = admission("member:alice", "a")
    const bob = admission("member:bob", "b")
    for (const candidate of [alice, bob]) {
      registerHolonTaskRuntimeCapabilityBinding(host, scope, {
        admission: candidate,
        route: route(candidate, []),
        processorConfig: { leaseDurationMs: 30_000, maxSteps: 64 },
      })
    }
    await expect(assignHolonTaskThroughCapability(host, scope, {
      kind: "holon",
      holonRef: "holon:review",
    }, invocation("request:ambiguous"))).rejects.toMatchObject({
      code: "EIDOLON_HOLON_TASK_BINDING_AMBIGUOUS",
    })

    expect(() => registerHolonTaskRuntimeCapabilityBinding(host, scope, {
      admission: { ...alice, definitionDigest: digest("9") },
      route: route(alice, []),
      processorConfig: { leaseDurationMs: 30_000, maxSteps: 64 },
    } as any)).toThrow("ADMISSION_CONFLICT")
    expect(() => mountHolonTaskRuntimeCapability(host, {
      ...scope,
      supportRoot: "/tmp/another-owner",
    })).toThrow("SCOPE_CONFLICT")
  })

  it("keeps the single owner in the VM facet rather than a module WeakMap or per-binding service", async () => {
    const source = await readFile(
      new URL("../../src/organization/HolonTaskRuntimeCapability.ts", import.meta.url),
      "utf8",
    )
    expect(source).toContain(HOLON_TASK_RUNTIME_CAPABILITY_FACET)
    expect(source).toContain("actorRuntime.ensureFacet")
    expect(source).not.toContain("WeakMap")
    expect(source).not.toContain("readonly service: HolonTaskRuntimeService\n  readonly processorConfig")
    expect(source.match(/createHolonTaskRuntimeService\(/g)).toHaveLength(1)
  })

  it("routes product, Ctrl, and Data origins through one service and exact Workflow identities", async () => {
    const host = vm()
    const calls: string[] = []
    const candidate = admission("member:alice", "a")
    const before = mountHolonTaskRuntimeCapability(host, scope)
    registerHolonTaskRuntimeCapabilityBinding(host, scope, {
      admission: candidate,
      route: route(candidate, calls),
      processorConfig: { leaseDurationMs: 30_000, maxSteps: 64 },
    })

    const product = await assignHolonTaskThroughCapability(host, scope, {
      kind: "holon",
      holonRef: "holon:review",
    }, invocation("request:product"))
    const workflow = async (
      workflowKind: "AICtrlWorkflow" | "AIDataWorkflow",
      suffix: string,
    ) => assignHolonTaskThroughCapability(host, scope, {
      kind: "admission",
      admissionId: candidate.admissionId,
    }, {
      kind: "holon-task-runtime-invocation",
      schemaVersion: HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
      requestId: `request:${suffix}`,
      idempotencyKey: `idempotency:${suffix}`,
      replyMode: "none",
      occurredAt: "2026-09-04T00:00:02.000Z",
      origin: {
        kind: "workflow",
        workflowKind,
        workflowRef: `resource://workflow/${suffix}`,
        runId: `run:${suffix}`,
        nodeId: `node:${suffix}`,
        invocationId: `invocation:${suffix}`,
      },
      taskRequest: {
        kind: "exact",
        identity: {
          taskSpaceId: `task-space:${suffix}`,
          taskId: `task:${suffix}`,
          commandId: `command:${suffix}`,
        },
        name: `Workflow ${suffix}`,
      },
      input: { content: suffix },
    })
    const ctrl = await workflow("AICtrlWorkflow", "ctrl")
    const data = await workflow("AIDataWorkflow", "data")
    const after = mountHolonTaskRuntimeCapability(host, scope)

    expect(after.service).toBe(before.service)
    expect(after.readCatalog().revision).toBe(1)
    expect(product.admissionId).toBe(candidate.admissionId)
    expect(ctrl.task).toMatchObject({
      taskSpaceId: "task-space:ctrl",
      taskId: "task:ctrl",
      commandId: "command:ctrl",
    })
    expect(data.task).toMatchObject({
      taskSpaceId: "task-space:data",
      taskId: "task:data",
      commandId: "command:data",
    })
    expect(calls.filter((call) => call.startsWith("deployment:"))).toHaveLength(3)
  })
})
