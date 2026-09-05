import { createHash } from "node:crypto"

import {
  AI_ORGANIZATION_TASK_PROFILE_KIND,
  normalizeHolonTaskSnapshotReceipt as normalizeLegacySnapshotReceipt,
  normalizeHolonTaskTarget,
} from "ai-workflow-contract"
import {
  HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  HOLON_TASK_SNAPSHOT_RECEIPT_SCHEMA_VERSION,
  type HolonTaskDigest,
  type HolonTaskExecutionProfile,
  type HolonTaskExecutionTarget,
  type HolonTaskRuntimeOrigin,
} from "@cell/ai-organ-contract"
import { canonicalHolonEffectiveSnapshotBytes } from "holarchy-core-contract"
import type { FrozenHolonTaskTarget } from "ai-workflow-contract"

import { createHolonTaskExecutionProfile } from "./HolonTaskExecutionProfile"
import { HolonTaskRuntimeContractError } from "./HolonTaskRuntimeContract"
import type { MaterializedHolonDeploymentDefinition } from "./HolonDeploymentDefinition"

export interface LegacyWorkflowHolonTaskProfileProjectionContext {
  readonly executionTarget: HolonTaskExecutionTarget
  readonly registryRevision: string
  readonly definitionDigest: HolonTaskDigest
}

function digestBytes(bytes: Uint8Array): HolonTaskDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function digestValue(value: unknown): HolonTaskDigest {
  return digestBytes(new TextEncoder().encode(JSON.stringify(value)))
}

/**
 * Projects already-verified Workflow freeze facts into the reusable neutral
 * admission consumed by HolonTaskRuntimeService. No VM governance names or
 * live organization lookups participate in this projection.
 */
export async function projectFrozenWorkflowHolonTaskAdmission(input: Readonly<{
  readonly proof: FrozenHolonTaskTarget
  readonly deployment: MaterializedHolonDeploymentDefinition
  /** Workflow adapter scope; the canonical service itself does not interpret it. */
  readonly scopeRef?: string
}>): Promise<import("@cell/ai-organ-contract").FrozenHolonTaskRuntimeAdmission> {
  const target = normalizeHolonTaskTarget(input.proof.target)
  const projection = input.deployment.bindingProjection
  const definition = input.deployment.definition
  const reconstructedProof = await input.deployment.resourceRegistry.freezeWorkflowHolonTaskTarget(target)
  const bindingResourceId = target.executionBinding.ref.slice("resource://".length)
  const bindingContentIdentity = input.deployment.bindingFreezeReceipt.closure.find(
    ({ resourceId }) => resourceId === bindingResourceId,
  ) ?? invalid(
    "$workflowAdmission.binding",
    "Frozen Workflow target binding is absent from the deployment closure",
  )
  if (input.proof.semanticFingerprint !== reconstructedProof.semanticFingerprint
    || input.proof.snapshotRevision !== reconstructedProof.snapshotRevision
    || JSON.stringify(input.proof.closureResourceIds) !== JSON.stringify(reconstructedProof.closureResourceIds)) {
    invalid("$workflowAdmission", "Frozen Workflow target proof is not reproducible from deployment authority")
  }
  if (target.holon.rootHolonRef !== projection.snapshot.rootHolonRef
    || target.holon.effectiveAt !== projection.snapshot.effectiveAt
    || target.executionBinding.ref !== projection.binding.bindingRef
    || target.executionBinding.digest !== bindingContentIdentity.contentDigest
    || definition.registryRevision !== projection.registryRevision
    || definition.snapshotTreeDigest !== projection.snapshot.treeDigest
    || definition.snapshotReceiptDigest !== projection.receiptBytesDigest) {
    invalid("$workflowAdmission", "Frozen target and materialized deployment authority differ")
  }
  const memberRefs = projection.snapshot.records
    .filter((record) => record.kind === "Member")
    .map((record) => record.id)
    .sort()
  const roleRefs = projection.snapshot.records
    .filter((record) => record.kind === "Role")
    .map((record) => record.id)
    .sort()
  const definitionDigest = digestValue({
    targetFingerprint: input.proof.semanticFingerprint,
    deploymentFingerprint: definition.bindingSemanticFingerprint,
    scopeRef: input.scopeRef ?? null,
  })
  const snapshotArtifactDigest = digestBytes(
    await canonicalHolonEffectiveSnapshotBytes(projection.snapshot),
  )
  const definitionRef = `${target.invocation.workflowRef}/holon-task-runtime/${encodeURIComponent(
    target.invocation.nodeId,
  )}` as `resource://${string}`
  return Object.freeze({
    kind: "frozen-holon-task-runtime-admission",
    schemaVersion: HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
    admissionId: `workflow-admission:${definitionDigest}`,
    registryRevision: definition.registryRevision,
    definitionDigest,
    definition: Object.freeze({
      kind: "holon-task-runtime-definition",
      schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
      definitionRef,
      version: "workflow-compatibility-v1",
      rootHolonRef: target.holon.rootHolonRef,
      executionBinding: target.executionBinding,
      taskSpace: target.taskSpace,
      input: Object.freeze({ schemaRef: "resource://eidolon.schemas.closed-value" }),
      output: target.output,
      // Workflow admissions are addressed explicitly by admissionId. They must
      // never become the product-level default route for a Holon; that authority
      // belongs to a resource-authored standalone runtime definition.
      defaultForHolon: false,
    }),
    executionTarget: projection.binding.target,
    snapshotAuthority: Object.freeze({
      kind: "holon-task-runtime-snapshot-authority",
      schemaVersion: HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
      holonRef: projection.snapshot.rootHolonRef,
      effectiveAt: projection.snapshot.effectiveAt,
      holonSnapshotRef: projection.snapshot.snapshotId,
      holonSnapshotDigest: projection.snapshot.treeDigest,
      snapshotArtifactDigest,
      executionBindingRef: target.executionBinding.ref,
      executionBindingDigest: target.executionBinding.digest,
      eligibleMemberRefs: Object.freeze(memberRefs),
      eligibleRoleRefs: Object.freeze(roleRefs),
    }),
  })
}

export function projectLegacyWorkflowHolonTaskOrigin(
  value: unknown,
  runId: string,
): HolonTaskRuntimeOrigin {
  const profile = ownData(value, "$legacyProfile")
  const facts = ownData(profile.facts, "$legacyProfile.facts")
  const target = normalizeHolonTaskTarget(facts.target)
  return Object.freeze({
    kind: "workflow",
    workflowKind: target.invocation.workflowKind,
    workflowRef: target.invocation.workflowRef,
    runId,
    nodeId: target.invocation.nodeId,
    invocationId: target.invocation.invocationId,
  })
}

const invalid = (path: string, message: string): never => {
  throw new HolonTaskRuntimeContractError(path, message)
}

function ownData(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(path, "Expected one legacy task profile object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, "Expected one plain legacy task profile object")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    return invalid(path, "Symbol properties are not allowed")
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return invalid(`${path}.${key}`, "Expected one enumerable own-data property")
    }
    result[key] = descriptor.value
  }
  return result
}

/**
 * Compatibility boundary only. The legacy Workflow package validates its own
 * DTOs; this adapter projects those verified facts into the canonical profile.
 */
export function adaptLegacyWorkflowHolonTaskProfile(
  value: unknown,
  context: LegacyWorkflowHolonTaskProfileProjectionContext,
): HolonTaskExecutionProfile {
  const profile = ownData(value, "$legacyProfile")
  if (profile.kind !== "task-profile" || profile.profileKind !== AI_ORGANIZATION_TASK_PROFILE_KIND
    || profile.schemaVersion !== 1) {
    invalid("$legacyProfile", "Expected one depa.ai.organization-task profile")
  }
  const facts = ownData(profile.facts, "$legacyProfile.facts")
  const target = normalizeHolonTaskTarget(facts.target)
  const receipt = normalizeLegacySnapshotReceipt(facts.snapshotReceipt)
  const definitionRef = `${target.invocation.workflowRef}/holon-task-runtime/${encodeURIComponent(
    target.invocation.nodeId,
  )}` as const
  const admission = {
    kind: "frozen-holon-task-runtime-admission",
    schemaVersion: HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
    admissionId: `legacy-workflow:${context.definitionDigest}`,
    registryRevision: context.registryRevision,
    definitionDigest: context.definitionDigest,
    definition: {
      kind: "holon-task-runtime-definition",
      schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
      definitionRef,
      version: "legacy-workflow-v1",
      rootHolonRef: target.holon.rootHolonRef,
      executionBinding: target.executionBinding,
      taskSpace: target.taskSpace,
      input: { schemaRef: "resource://eidolon.schemas/closed-value" },
      output: target.output,
      defaultForHolon: false,
    },
    executionTarget: context.executionTarget,
    snapshotAuthority: {
      kind: "holon-task-runtime-snapshot-authority",
      schemaVersion: HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
      holonRef: receipt.holonRef,
      effectiveAt: receipt.effectiveAt,
      holonSnapshotRef: receipt.holonSnapshotRef,
      holonSnapshotDigest: receipt.holonSnapshotDigest,
      snapshotArtifactDigest: receipt.snapshotArtifactDigest,
      executionBindingRef: receipt.executionBindingRef,
      executionBindingDigest: receipt.executionBindingDigest,
      eligibleMemberRefs: receipt.eligibleMemberRefs,
      eligibleRoleRefs: receipt.eligibleRoleRefs,
    },
  } as const
  return createHolonTaskExecutionProfile(admission, {
    ...receipt,
    schemaVersion: HOLON_TASK_SNAPSHOT_RECEIPT_SCHEMA_VERSION,
  })
}
