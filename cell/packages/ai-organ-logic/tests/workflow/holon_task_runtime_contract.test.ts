import { describe, expect, it } from "bun:test"

import {
  HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SPEC_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1,
  HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
} from "@cell/ai-organ-contract"
import {
  normalizeFrozenHolonTaskRuntimeAdmission,
  normalizeHolonTaskRuntimeDefinition,
  normalizeHolonTaskRuntimeInvocation,
  normalizeHolonTaskSelector,
} from "../../src/organization/HolonTaskRuntimeContract"

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}`

const definition = () => ({
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
  input: { schemaRef: "resource://eidolon.schemas/review-input" },
  output: {
    schemaRef: "resource://eidolon.schemas/review-output",
    materialPortRefs: ["resource://eidolon.materials/review-report"],
  },
  defaultForHolon: true,
})

const snapshotReceipt = () => ({
  kind: "holon-task-snapshot-receipt",
  schemaVersion: "eidolon.holon-task-snapshot-receipt/v1",
  taskSpaceId: "task-space:review-board",
  holonRef: "holon:review-board",
  effectiveAt: "2026-09-03T00:00:00.000Z",
  holonSnapshotRef: "resource://holon.snapshots/review-board-1",
  holonSnapshotDigest: digest("b"),
  snapshotArtifactDigest: digest("c"),
  issuerReceiptId: digest("d"),
  issuerReceiptArtifactDigest: digest("e"),
  executionBindingRef: "resource://eidolon.bindings/reviewer",
  executionBindingDigest: digest("a"),
  eligibleMemberRefs: ["member:alice"],
  eligibleRoleRefs: ["role:reviewer"],
})

const snapshotAuthority = () => ({
  kind: "holon-task-runtime-snapshot-authority",
  schemaVersion: HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  holonRef: "holon:review-board",
  effectiveAt: "2026-09-03T00:00:00.000Z",
  holonSnapshotRef: "resource://holon.snapshots/review-board-1",
  holonSnapshotDigest: digest("b"),
  snapshotArtifactDigest: digest("c"),
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
  definition: definition(),
  executionTarget: { kind: "member", memberRef: "member:alice" },
  snapshotAuthority: snapshotAuthority(),
})

describe("HolonTaskRuntime contract", () => {
  it("owns the exact Halfcode 0.3 runtime-definition Kind contract", () => {
    expect(HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SPEC_VERSION).toBe(1)
    expect(HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER.sourceContract).toEqual(expect.objectContaining({
      sourceShapes: ["single-file"],
      documentCardinality: "one",
      requiredFiles: [],
    }))
    expect(HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1).toEqual(expect.objectContaining({
      specVersion: 1,
      sourceContractFingerprint:
        HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER.sourceContract.sourceContractFingerprint,
      stability: "stable",
    }))
    expect(HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE)
      .toContain('envelopeVersion="halfcode.resource-envelope/v1" specVersion=1')
    expect(HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE)
      .toContain(`contractFingerprint = "${HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1.contractFingerprint}"`)
    expect(HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE)
      .not.toContain("halfcode.resources/v1")
  })

  it("normalizes a closed standalone definition and frozen admission", () => {
    const normalizedDefinition = normalizeHolonTaskRuntimeDefinition(definition())
    const normalizedAdmission = normalizeFrozenHolonTaskRuntimeAdmission(admission())

    expect(normalizedDefinition.schemaVersion).toBe(HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION)
    expect(normalizedAdmission.schemaVersion).toBe(HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION)
    expect(normalizedAdmission.executionTarget).toEqual({
      kind: "member",
      memberRef: "member:alice",
    })
    expect(Object.isFrozen(normalizedDefinition)).toBe(true)
    expect(Object.isFrozen(normalizedAdmission)).toBe(true)
    expect(JSON.stringify(normalizedAdmission)).not.toContain("workflowInstanceId")
    expect(JSON.stringify(normalizedAdmission)).not.toContain("runId")
    expect(JSON.stringify(normalizedAdmission)).not.toContain("nodeId")
    expect(JSON.stringify(normalizedAdmission)).not.toContain("taskSpaceId")
    expect(JSON.stringify(normalizedAdmission)).not.toContain("issuerReceiptId")
  })

  it("normalizes Holon/member selectors and keeps Workflow lineage inside origin", () => {
    expect(normalizeHolonTaskSelector({
      kind: "holon",
      holonRef: "holon:review-board",
    })).toEqual({ kind: "holon", holonRef: "holon:review-board" })
    expect(normalizeHolonTaskSelector({
      kind: "member",
      holonRef: "holon:review-board",
      memberRef: "member:alice",
    })).toEqual({
      kind: "member",
      holonRef: "holon:review-board",
      memberRef: "member:alice",
    })

    const invocation = normalizeHolonTaskRuntimeInvocation({
      kind: "holon-task-runtime-invocation",
      schemaVersion: HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
      requestId: "request:review-42",
      idempotencyKey: "idempotency:review-42",
      replyMode: "final",
      occurredAt: "2026-09-03T00:01:00.000Z",
      origin: {
        kind: "workflow",
        workflowKind: "AIDataWorkflow",
        workflowRef: "resource://workflows/review",
        runId: "run:42",
        nodeId: "review-node",
        invocationId: "invocation:42",
      },
      taskRequest: {
        kind: "exact",
        identity: {
          taskSpaceId: "task-space:run:42",
          taskId: "task:review:42",
          commandId: "command:review:42",
        },
        name: "Review change",
      },
      input: { changeRef: "commit:abc" },
    })
    expect(invocation.origin).toEqual({
      kind: "workflow",
      workflowKind: "AIDataWorkflow",
      workflowRef: "resource://workflows/review",
      runId: "run:42",
      nodeId: "review-node",
      invocationId: "invocation:42",
    })
  })

  it("rejects unknown fields, invalid identities and mismatched frozen facts", () => {
    expect(() => normalizeHolonTaskRuntimeDefinition({
      ...definition(),
      workflowInstanceId: "must-not-enter-core",
    })).toThrow("Unsupported field")

    expect(() => normalizeHolonTaskSelector({
      kind: "member",
      holonRef: " holon:review-board",
      memberRef: "member:alice",
    })).toThrow("canonical")

    expect(() => normalizeFrozenHolonTaskRuntimeAdmission({
      ...admission(),
      snapshotAuthority: {
        ...snapshotAuthority(),
        executionBindingDigest: digest("0"),
      },
    })).toThrow("exact definition facts")

    expect(() => normalizeFrozenHolonTaskRuntimeAdmission({
      ...admission(),
      executionTarget: { kind: "member", memberRef: "member:bob" },
    })).toThrow("eligible member")
  })

  it("rejects accessors, symbols, sparse arrays and custom prototypes without invoking getters", () => {
    let getterCalls = 0
    const accessor = definition() as Record<string, unknown>
    Object.defineProperty(accessor, "kind", {
      enumerable: true,
      get() {
        getterCalls += 1
        return "holon-task-runtime-definition"
      },
    })
    expect(() => normalizeHolonTaskRuntimeDefinition(accessor)).toThrow("own-data")
    expect(getterCalls).toBe(0)

    const symbolic = definition() as Record<PropertyKey, unknown>
    symbolic[Symbol("authority")] = "hidden"
    expect(() => normalizeHolonTaskRuntimeDefinition(symbolic)).toThrow("Symbol")

    const sparse = definition()
    sparse.output.materialPortRefs = new Array(1)
    expect(() => normalizeHolonTaskRuntimeDefinition(sparse)).toThrow("dense")

    expect(() => normalizeHolonTaskRuntimeDefinition(Object.assign(
      Object.create({ inherited: true }),
      definition(),
    ))).toThrow("plain object")
  })
})
