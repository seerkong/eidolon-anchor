import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM, ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime"
import {
  HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  type FrozenHolonTaskRuntimeAdmission,
} from "@cell/ai-organ-contract"
import {
  registerHolonTaskRuntimeCapabilityBinding,
  type HolonTaskRuntimeCapabilityRoute,
} from "../../src/organization/HolonTaskRuntimeCapability"
import {
  assignCanonicalAutonomousHolon,
  assignCanonicalAutonomousMember,
} from "../../src/organization/CanonicalHolonAssignmentFacade"
import { getOrganizationManager } from "../../src/organization/OrganizationManager"
import { bootstrapLocalHolonTaskRuntime } from "../../src/organization/HolonTaskRuntimeComposition"
import { buildHolonAssignToolDef } from "../../src/composer/AIAgent/tools/HolonAssign"
import { buildMemberAssignToolDef } from "../../src/composer/AIAgent/tools/MemberAssign"

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as const

function admission(holonRef: string, memberRef: string): FrozenHolonTaskRuntimeAdmission {
  return {
    kind: "frozen-holon-task-runtime-admission",
    schemaVersion: HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
    admissionId: `admission:${holonRef}:${memberRef}`,
    registryRevision: "registry:1",
    definitionDigest: digest("a"),
    definition: {
      kind: "holon-task-runtime-definition",
      schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
      definitionRef: "resource://runtime/standalone-review",
      version: "1",
      rootHolonRef: holonRef,
      executionBinding: { ref: "resource://binding/reviewer", digest: digest("1") },
      taskSpace: {
        profileRef: "resource://profile/review",
        policyRef: "resource://policy/review",
        requiredRoleRefs: ["role:reviewer"],
        requiredCapabilityRefs: [],
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
      executionBindingRef: "resource://binding/reviewer",
      executionBindingDigest: digest("1"),
      eligibleMemberRefs: [memberRef],
      eligibleRoleRefs: ["role:reviewer"],
    },
  }
}

function route(value: FrozenHolonTaskRuntimeAdmission): HolonTaskRuntimeCapabilityRoute {
  return {
    routeRef: `resource://routes/${value.admissionId}`,
    deployment: { ensure: async () => ({ deploymentId: `deployment:${value.admissionId}` }) },
    taskSpace: {
      async submit(input) {
        const taskSpaceId = `task-space:${input.invocation.requestId}`
        return {
          taskSpaceId,
          taskId: input.taskId,
          commandId: input.commandId,
          submissionFingerprint: input.submissionFingerprint,
          replayed: false,
          snapshotReceipt: {
            kind: "holon-task-snapshot-receipt",
            schemaVersion: "eidolon.holon-task-snapshot-receipt/v1",
            taskSpaceId,
            holonRef: value.snapshotAuthority.holonRef,
            effectiveAt: value.snapshotAuthority.effectiveAt,
            holonSnapshotRef: value.snapshotAuthority.holonSnapshotRef,
            holonSnapshotDigest: value.snapshotAuthority.holonSnapshotDigest,
            snapshotArtifactDigest: value.snapshotAuthority.snapshotArtifactDigest,
            issuerReceiptId: digest("d"),
            issuerReceiptArtifactDigest: digest("e"),
            executionBindingRef: value.snapshotAuthority.executionBindingRef,
            executionBindingDigest: value.snapshotAuthority.executionBindingDigest,
            eligibleMemberRefs: value.snapshotAuthority.eligibleMemberRefs,
            eligibleRoleRefs: value.snapshotAuthority.eligibleRoleRefs,
          },
        }
      },
    },
    coordinatorMailbox: {
      async sendWake(message) {
        return {
          coordinatorActorRef: `coordinator:${message.deploymentId}`,
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
          result: { summary: "standalone done" },
          outputArtifactRefs: [],
          replayed: false,
        }
      },
    },
  }
}

function runtime() {
  const actor = createActor({ key: "main", id: "main" })
  const vm = createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor } })
  return { actor, vm, toolCallId: "tool-call:standalone" } as any
}

describe("standalone Holon task product routing", () => {
  it("addresses file-admitted Holon and Member refs without a second session organization", async () => {
    const local = runtime()
    ensureVmRuntimeContext(local.vm).driver = {} as any
    const mounted = bootstrapLocalHolonTaskRuntime({
      vm: local.vm,
      supportRoot: "/tmp/eidolon-file-admitted-public-routing",
      registryRef: "resource://registries/file-admitted-public-routing",
    })
    const candidate = admission("holon-file-team", "member-file-worker")
    registerHolonTaskRuntimeCapabilityBinding(local.vm, mounted.scope, {
      admission: candidate, route: route(candidate),
      processorConfig: { leaseDurationMs: 30_000, maxSteps: 64 },
    })
    expect(getOrganizationManager().listHolons(local.vm)).toEqual([])
    for (const [index, [tool, target]] of ([
      [buildHolonAssignToolDef(), "holon-file-team"],
      [buildMemberAssignToolDef(), "member-file-worker"],
    ] as const).entries()) {
      const result = JSON.parse(await (tool as any).run({ ...local, toolCallId: `file-admission-${index}` }, {
        // A word boundary at the title limit must not make the canonical name
        // invalid; the full content remains the actual task input.
        target, mode: "final", content: `${"x".repeat(119)} use the installed system Skills`,
      }, {}))
      expect(result.ok).toBe(true)
      expect(result.admission_id).toBe(candidate.admissionId)
      expect(result.terminal_status).toBe("Succeeded")
      expect(result.service_runtime_ref).toBe(mounted.serviceRuntimeRef)
    }
    expect(getOrganizationManager().listHolons(local.vm)).toEqual([])
  })

  it("rejects a file-admitted Member shared by two Holons instead of guessing an owner", async () => {
    const local = runtime()
    ensureVmRuntimeContext(local.vm).driver = {} as any
    const mounted = bootstrapLocalHolonTaskRuntime({
      vm: local.vm, supportRoot: "/tmp/eidolon-file-admitted-ambiguous-member",
      registryRef: "resource://registries/file-admitted-ambiguous-member",
    })
    for (const holonRef of ["file-team-a", "file-team-b"]) {
      const candidate = admission(holonRef, "shared-file-worker")
      registerHolonTaskRuntimeCapabilityBinding(local.vm, mounted.scope, {
        admission: candidate, route: route(candidate),
        processorConfig: { leaseDurationMs: 30_000, maxSteps: 64 },
      })
    }
    const result = JSON.parse(await buildMemberAssignToolDef().run(local, {
      target: "shared-file-worker", mode: "final", content: "An ambiguous task",
    }, {}))
    expect(result.error).toBe("canonical_member_holon_ambiguous")
    expect(result.holon_ids).toEqual(["file-team-a", "file-team-b"])
    expect(getOrganizationManager().listHolons(local.vm)).toEqual([])
  })

  it("bootstraps without Workflow and routes Holon/member through the same service owner", async () => {
    const local = runtime()
    const holon = getOrganizationManager().createHolon(local.vm, "autonomous", "review-board")
    local.vm.actors[`holon:${holon.holonId}`].holonState.memberIds = ["member:alice"]
    const mounted = bootstrapLocalHolonTaskRuntime({
      vm: local.vm,
      supportRoot: "/tmp/eidolon-product-holon-runtime",
      registryRef: "resource://registries/product-holon-runtime",
    })
    const candidate = admission(holon.holonId, "member:alice")
    const registered = registerHolonTaskRuntimeCapabilityBinding(local.vm, mounted.scope, {
      admission: candidate,
      route: route(candidate),
      processorConfig: { leaseDurationMs: 30_000, maxSteps: 64 },
    })

    const holonResult = JSON.parse(await assignCanonicalAutonomousHolon({
      runtime: local,
      target: holon.holonId,
      mode: "final",
      content: "review the change",
    }))
    const memberResult = JSON.parse(await assignCanonicalAutonomousMember({
      runtime: local,
      target: "member:alice",
      mode: "none",
      content: "review another change",
      memberId: "member:alice",
      memberName: "Alice",
      surface: "MemberAssign",
    }))

    expect(holonResult).toMatchObject({ ok: true, admission_id: candidate.admissionId })
    expect(memberResult).toMatchObject({ ok: true, admission_id: candidate.admissionId })
    expect(holonResult.service_runtime_ref).toBe(mounted.serviceRuntimeRef)
    expect(memberResult.service_runtime_ref).toBe(mounted.serviceRuntimeRef)
    expect(registered.serviceRuntimeRef).toBe(mounted.serviceRuntimeRef)
  })

  it("rejects a Member address shared by multiple autonomous Holons", async () => {
    const local = runtime()
    const first = getOrganizationManager().createHolon(local.vm, "autonomous", "first")
    const second = getOrganizationManager().createHolon(local.vm, "autonomous", "second")
    for (const holon of [first, second]) {
      local.vm.actors[`holon:${holon.holonId}`].holonState.memberIds = ["member:shared"]
    }
    bootstrapLocalHolonTaskRuntime({
      vm: local.vm,
      supportRoot: "/tmp/eidolon-product-holon-runtime-ambiguous",
      registryRef: "resource://registries/product-holon-runtime-ambiguous",
    })
    const result = JSON.parse(await assignCanonicalAutonomousMember({
      runtime: local,
      target: "member:shared",
      mode: "final",
      content: "do not guess",
      memberId: "member:shared",
      memberName: "Shared",
      surface: "ActorAssign",
    }))
    expect(result).toMatchObject({
      ok: false,
      error: "canonical_member_holon_ambiguous",
      holon_ids: [first.holonId, second.holonId].sort(),
    })
  })
})
