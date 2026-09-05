import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  computeHolonEffectiveSnapshotTreeDigest,
  type HolonEffectiveSnapshotTree,
} from "holarchy-core-contract"
import type { FrozenHolonTaskTarget } from "ai-workflow-contract"

import { normalizeFrozenHolonTaskRuntimeAdmission } from "../../src/organization/HolonTaskRuntimeContract"
import { projectFrozenWorkflowHolonTaskAdmission } from "../../src/organization/LegacyWorkflowHolonTaskProfileAdapter"

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as const

async function authorityFixture() {
  const created = { createdAt: "2026-01-01T00:00:00.000Z", createdBy: "fixture" }
  const effective = {
    effectiveDate: "2026-01-01",
    effectiveState: true as const,
    changeSetId: "fixture:1",
    sequence: 1,
    ...created,
  }
  const tree: HolonEffectiveSnapshotTree = {
    apiVersion: "holon.workbench/v1",
    kind: "HolonEffectiveSnapshot",
    snapshotId: "snapshot:review:1",
    rootHolonRef: "holon:review",
    effectiveAt: "2026-09-04T00:00:00.000Z",
    sourceRevision: "1",
    records: [
      { kind: "OrganizationalSubject", id: "subject:review", subjectType: "holon" },
      { kind: "OrganizationalSubject", id: "subject:alice", subjectType: "member" },
      { kind: "Holon", id: "holon:review", subjectId: "subject:review", code: "review", ...created },
      {
        kind: "HolonVersion",
        id: "holon:review:v1",
        holonId: "holon:review",
        name: "Review",
        purpose: "Review changes",
        boundary: "Repository",
        ...effective,
      },
      { kind: "Member", id: "member:alice", subjectId: "subject:alice", ...created },
      {
        kind: "MemberVersion",
        id: "member:alice:v1",
        memberId: "member:alice",
        displayName: "Alice",
        principalKind: "ai",
        ...effective,
      },
      { kind: "HolonMembership", id: "membership:alice", ...created },
      {
        kind: "HolonMembershipVersion",
        id: "membership:alice:v1",
        membershipId: "membership:alice",
        parentHolonId: "holon:review",
        subjectId: "subject:alice",
        mode: "primary",
        ...effective,
      },
    ],
  }
  return Object.freeze({ ...tree, treeDigest: await computeHolonEffectiveSnapshotTreeDigest(tree) })
}

async function projectionFixture() {
  const snapshot = await authorityFixture()
  const target = Object.freeze({
    kind: "holon-task-target" as const,
    schemaVersion: "ai-workflow.holon-task-target/v1" as const,
    invocation: Object.freeze({
      workflowKind: "AICtrlWorkflow" as const,
      workflowRef: "resource://workflow/review" as const,
      nodeId: "review-node",
      invocationId: "review-invocation",
    }),
    holon: Object.freeze({ rootHolonRef: "holon:review", effectiveAt: snapshot.effectiveAt }),
    executionBinding: Object.freeze({ ref: "resource://binding/reviewer" as const, digest: digest("1") }),
    taskSpace: Object.freeze({
      profileRef: "resource://profile/review" as const,
      policyRef: "resource://policy/review" as const,
      requiredRoleRefs: Object.freeze([]),
      requiredCapabilityRefs: Object.freeze([]),
    }),
    output: Object.freeze({
      schemaRef: "resource://schema/review-output" as const,
      materialPortRefs: Object.freeze([]),
    }),
  })
  const proof: FrozenHolonTaskTarget = Object.freeze({
    schemaVersion: "ai-workflow.frozen-holon-task-target/v1",
    target,
    semanticFingerprint: digest("2"),
    snapshotRevision: digest("3"),
    closureResourceIds: Object.freeze(["binding/reviewer", "workflow/review"]),
  })
  const bindingProjection = {
    registryRevision: "registry:1",
    bindingBytesDigest: digest("9"),
    receiptBytesDigest: digest("4"),
    binding: {
      bindingRef: target.executionBinding.ref,
      target: { kind: "member", memberRef: "member:alice" },
    },
    snapshot,
  }
  const deployment = {
    definition: {
      registryRevision: bindingProjection.registryRevision,
      snapshotTreeDigest: snapshot.treeDigest,
      snapshotReceiptDigest: bindingProjection.receiptBytesDigest,
      bindingSemanticFingerprint: digest("5"),
    },
    bindingProjection,
    bindingFreezeReceipt: {
      closure: [{
        resourceId: "binding/reviewer",
        kind: "HolonExecutionBinding",
        authorityDigest: digest("8"),
        contentDigest: target.executionBinding.digest,
      }],
    },
    resourceRegistry: {
      freezeWorkflowHolonTaskTarget: async () => proof,
    },
  }
  return { proof, deployment }
}

describe("Workflow Holon task runtime adapter", () => {
  it("projects reproducible frozen Workflow authority into a neutral reusable admission", async () => {
    const fixture = await projectionFixture()
    const projected = normalizeFrozenHolonTaskRuntimeAdmission(
      await projectFrozenWorkflowHolonTaskAdmission(fixture as any),
    )

    expect(projected.executionTarget).toEqual({ kind: "member", memberRef: "member:alice" })
    expect(projected.snapshotAuthority).toMatchObject({
      holonRef: "holon:review",
      executionBindingDigest: fixture.proof.target.executionBinding.digest,
      eligibleMemberRefs: ["member:alice"],
    })
    expect(projected.definition.definitionRef).toBe("resource://workflow/review/holon-task-runtime/review-node")
    expect(projected).not.toHaveProperty("workflowInstanceId")
    expect(projected).not.toHaveProperty("runId")
  })

  it("rejects a Workflow proof that the frozen deployment cannot reproduce", async () => {
    const fixture = await projectionFixture()
    const forged = {
      ...fixture,
      proof: { ...fixture.proof, semanticFingerprint: digest("f") },
    }
    await expect(projectFrozenWorkflowHolonTaskAdmission(forged as any))
      .rejects.toThrow("not reproducible")
  })

  it("keeps WorkflowRuntimeService as an adapter over support-owned effects", async () => {
    const workflowSource = await readFile(
      new URL("../../src/workflow/runtime/WorkflowRuntimeService.ts", import.meta.url),
      "utf8",
    )
    const canonicalSupportSource = await readFile(
      new URL("../../../ai-support/src/organization/LocalHolonTaskRuntimeSupport.ts", import.meta.url),
      "utf8",
    )
    const compositionSource = await readFile(
      new URL("../../src/organization/HolonTaskRuntimeComposition.ts", import.meta.url),
      "utf8",
    )
    expect(workflowSource).not.toMatch(/new FileTaskSpaceOwner|new FileHolonTaskPumpJournal/)
    expect(workflowSource).not.toContain("HolonTaskSpaceCoordinatorActor")
    expect(workflowSource).not.toContain("assignCanonicalHolonTask")
    expect(workflowSource).toContain("assignHolonTaskThroughMountedCapability")
    expect(canonicalSupportSource).toContain("new FileTaskSpaceOwner")
    expect(canonicalSupportSource).toContain("new FileHolonTaskPumpJournal")
    expect(canonicalSupportSource).not.toContain("@cell/ai-organ-logic")
    expect(workflowSource).not.toContain('from "@cell/ai-support"')
    expect(workflowSource).toContain("requireHolonTaskRuntimeCapability")
    expect(compositionSource).toContain("storageFactory({ supportRoot })")
    expect(compositionSource).not.toContain("new FileTaskSpaceOwner")
  })
})
