import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  EIDOLON_HOLON_TASK_PROFILE_KIND,
  HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
} from "@cell/ai-organ-contract"
import { createAIOrganizationTaskProfile } from "ai-workflow-contract"

import {
  createHolonTaskExecutionProfile,
  normalizeHolonTaskExecutionProfile,
} from "../../src/organization/HolonTaskExecutionProfile"
import {
  adaptLegacyWorkflowHolonTaskProfile,
  projectLegacyWorkflowHolonTaskOrigin,
} from "../../src/organization/LegacyWorkflowHolonTaskProfileAdapter"

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as const

const snapshotReceipt = () => ({
  kind: "holon-task-snapshot-receipt",
  schemaVersion: "eidolon.holon-task-snapshot-receipt/v1",
  taskSpaceId: "task-space:review-board",
  holonRef: "holon:review-board",
  effectiveAt: "2026-09-03T00:00:00.000Z",
  holonSnapshotRef: "snapshot:review-board:1",
  holonSnapshotDigest: digest("b"),
  snapshotArtifactDigest: digest("c"),
  issuerReceiptId: digest("d"),
  issuerReceiptArtifactDigest: digest("e"),
  executionBindingRef: "resource://eidolon.bindings/reviewer",
  executionBindingDigest: digest("a"),
  eligibleMemberRefs: ["member:alice"],
  eligibleRoleRefs: ["role:reviewer"],
})

const admission = () => ({
  kind: "frozen-holon-task-runtime-admission",
  schemaVersion: HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  admissionId: "admission:review-board:reviewer:v1",
  registryRevision: "registry:42",
  definitionDigest: digest("f"),
  definition: {
    kind: "holon-task-runtime-definition",
    schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
    definitionRef: "resource://eidolon.holon-task-runtime/reviewer",
    version: "1.0.0",
    rootHolonRef: "holon:review-board",
    executionBinding: {
      ref: "resource://eidolon.bindings/reviewer",
      digest: digest("a"),
    },
    taskSpace: {
      profileRef: "resource://eidolon.task-profiles/review",
      policyRef: "resource://eidolon.task-policies/default",
      requiredRoleRefs: ["role:reviewer"],
      requiredCapabilityRefs: ["resource://eidolon.capabilities/review"],
    },
    input: { schemaRef: "resource://eidolon.schemas/closed-value" },
    output: {
      schemaRef: "resource://eidolon.schemas/review-output",
      materialPortRefs: ["resource://eidolon.materials/review-report"],
    },
    defaultForHolon: true,
  },
  executionTarget: { kind: "member", memberRef: "member:alice" },
  snapshotAuthority: {
    kind: "holon-task-runtime-snapshot-authority",
    schemaVersion: HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
    holonRef: "holon:review-board",
    effectiveAt: "2026-09-03T00:00:00.000Z",
    holonSnapshotRef: "snapshot:review-board:1",
    holonSnapshotDigest: digest("b"),
    snapshotArtifactDigest: digest("c"),
    executionBindingRef: "resource://eidolon.bindings/reviewer",
    executionBindingDigest: digest("a"),
    eligibleMemberRefs: ["member:alice"],
    eligibleRoleRefs: ["role:reviewer"],
  },
})

describe("Holon task execution profile compatibility", () => {
  it("creates one closed neutral profile bound to the exact admission receipt", () => {
    const profile = createHolonTaskExecutionProfile(admission(), snapshotReceipt())
    expect(profile.profileKind).toBe(EIDOLON_HOLON_TASK_PROFILE_KIND)
    expect(normalizeHolonTaskExecutionProfile(profile)).toEqual(profile)
    expect(Object.isFrozen(profile)).toBe(true)

    expect(() => normalizeHolonTaskExecutionProfile({
      ...profile,
      facts: {
        ...profile.facts,
        snapshotReceipt: {
          ...profile.facts.snapshotReceipt,
          executionBindingDigest: digest("0"),
        },
      },
    })).toThrow("exact admission authority")
  })

  it("adapts a verified legacy Workflow profile without leaking Workflow identity into the core definition", () => {
    const legacyTarget = {
      kind: "holon-task-target",
      schemaVersion: "ai-workflow.holon-task-target/v1",
      invocation: {
        workflowKind: "AIDataWorkflow",
        workflowRef: "resource://workflows/review",
        nodeId: "review-node",
        invocationId: "invocation:42",
      },
      holon: {
        rootHolonRef: "holon:review-board",
        effectiveAt: "2026-09-03T00:00:00.000Z",
      },
      executionBinding: {
        ref: "resource://eidolon.bindings/reviewer",
        digest: digest("a"),
      },
      taskSpace: {
        profileRef: "resource://eidolon.task-profiles/review",
        policyRef: "resource://eidolon.task-policies/default",
        requiredRoleRefs: ["role:reviewer"],
        requiredCapabilityRefs: ["resource://eidolon.capabilities/review"],
      },
      output: {
        schemaRef: "resource://eidolon.schemas/review-output",
        materialPortRefs: ["resource://eidolon.materials/review-report"],
      },
    }
    const legacyReceipt = {
      ...snapshotReceipt(),
      schemaVersion: "ai-workflow.holon-task-snapshot-receipt/v1",
    }
    const legacyProfile = createAIOrganizationTaskProfile(legacyTarget, legacyReceipt)

    const projected = adaptLegacyWorkflowHolonTaskProfile(legacyProfile, {
      executionTarget: { kind: "member", memberRef: "member:alice" },
      registryRevision: "registry:legacy-42",
      definitionDigest: digest("f"),
    })

    expect(projected.profileKind).toBe(EIDOLON_HOLON_TASK_PROFILE_KIND)
    expect(projected.facts.admission.definition.rootHolonRef).toBe("holon:review-board")
    expect(projected.facts.admission.snapshotAuthority.schemaVersion)
      .toBe(HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION)
    expect(projected.facts.snapshotReceipt.schemaVersion)
      .toBe("eidolon.holon-task-snapshot-receipt/v1")
    expect(JSON.stringify(projected.facts.admission.definition)).not.toContain("workflowKind")
    expect(JSON.stringify(projected.facts.admission.definition)).not.toContain("nodeId")
    expect(projectLegacyWorkflowHolonTaskOrigin(legacyProfile, "run:42")).toEqual({
      kind: "workflow",
      workflowKind: "AIDataWorkflow",
      workflowRef: "resource://workflows/review",
      runId: "run:42",
      nodeId: "review-node",
      invocationId: "invocation:42",
    })
  })

  it("keeps the Workflow dependency isolated to the legacy adapter module", async () => {
    const canonicalSources = await Promise.all([
      readFile(new URL("../../src/organization/HolonTaskExecutionProfile.ts", import.meta.url), "utf8"),
      readFile(new URL("../../src/organization/HolonTaskRuntimeContract.ts", import.meta.url), "utf8"),
    ])
    expect(canonicalSources.join("\n")).not.toContain("ai-workflow-contract")

    const adapterSource = await readFile(
      new URL("../../src/organization/LegacyWorkflowHolonTaskProfileAdapter.ts", import.meta.url),
      "utf8",
    )
    expect(adapterSource).toContain("ai-workflow-contract")
    expect(adapterSource).toContain("normalizeHolonTaskTarget")
    expect(adapterSource).toContain("normalizeHolonTaskSnapshotReceipt")
  })

  it("keeps the legacy Workflow runtime as a thin adapter over the canonical Processor", async () => {
    const wrapper = await readFile(
      new URL("../../src/organization/HolonWorkflowTaskRuntime.ts", import.meta.url),
      "utf8",
    )
    expect(wrapper).toContain("executeHolonTask(")
    expect(wrapper).not.toContain("settleTask(")
    expect(wrapper).not.toContain("startTask(")
    expect(wrapper).not.toContain("heartbeatTaskClaim(")
    expect(wrapper).not.toContain("createHolonTaskPumpDispatchIntent(")
  })
})
