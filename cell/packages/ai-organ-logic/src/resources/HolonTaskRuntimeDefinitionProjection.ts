import {
  HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_KIND,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_BYTES,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_FQN,
  HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  type FrozenHolonTaskRuntimeAdmission,
  type HolonTaskDigest,
  type HolonTaskResourceRef,
  type HolonTaskRuntimeDefinition,
} from "@cell/ai-organ-contract"
import { canonicalHolonEffectiveSnapshotBytes } from "holarchy-core-contract"
import {
  sha256Digest,
  type EffectiveResourceRegistry,
  type ResourceContentIdentity,
  type ResourceRecord,
} from "halfcode-compiler.xnl/resource-core"
import type { AIWorkflowAgentResourceProjection } from "ai-workflow-contract"
import {
  freezeHolonExecutionBinding,
  type EidolonHolonExecutionBindingFreezeReceipt,
  type EidolonHolonExecutionBindingProjection,
} from "./HolonExecutionBindingProjection"

import { parseHolonTaskRuntimeDefinitionBytes } from "../organization/HolonTaskRuntimeContract"
import { EidolonResourceRegistryError } from "./EidolonResourceRegistryError"

export interface EidolonHolonTaskRuntimeDefinitionProjection {
  readonly schemaVersion: "eidolon.holon-task-runtime-definition-projection/v1"
  readonly resource: ResourceRecord
  readonly definition: HolonTaskRuntimeDefinition
  readonly definitionContentIdentity: ResourceContentIdentity
  readonly bindingProjection: EidolonHolonExecutionBindingProjection
  readonly bindingFreezeReceipt: EidolonHolonExecutionBindingFreezeReceipt
  readonly closureResourceIds: readonly string[]
  readonly admission: FrozenHolonTaskRuntimeAdmission
  readonly registryRevision: string
}

export interface HolonTaskRuntimeDefinitionProjectionInput {
  readonly registry: EffectiveResourceRegistry
  readonly contentIdentities: ReadonlyMap<string, ResourceContentIdentity>
  readonly kindDefinitionAuthorityDigests: ReadonlyMap<string, `sha256:${string}`>
  readonly registryRevision: string
  readonly holonExecutionBindings: readonly EidolonHolonExecutionBindingProjection[]
  readonly agentResources: AIWorkflowAgentResourceProjection
  readonly freezeBinding?: (
    projection: EidolonHolonExecutionBindingProjection,
  ) => EidolonHolonExecutionBindingFreezeReceipt
}

const compareUtf16 = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const fail = (code: string, message: string): never => {
  throw new EidolonResourceRegistryError(code, message)
}

function resourceId(ref: HolonTaskResourceRef): string {
  return ref.slice("resource://".length)
}

function resourceRef(id: string): HolonTaskResourceRef {
  return `resource://${id}`
}

function exactResource(registry: EffectiveResourceRegistry, id: string): ResourceRecord {
  const entry = registry.byId.get(id)
  if (!entry?.resource) {
    return fail(
      "EIDOLON_HOLON_TASK_DEFINITION_CLOSURE_MISSING",
      `Resource '${id}' is not present in the effective registry.`,
    )
  }
  return entry.resource
}

function requiredIdentity(
  identities: ReadonlyMap<string, ResourceContentIdentity>,
  id: string,
): ResourceContentIdentity {
  const identity = identities.get(id)
  if (!identity) {
    return fail(
      "EIDOLON_HOLON_TASK_DEFINITION_CONTENT_IDENTITY_MISSING",
      `Resource '${id}' has no effective content identity.`,
    )
  }
  return identity
}

function canonicalBase64Property(resource: ResourceRecord, property: string): Uint8Array {
  const value = resource.node.properties[property]
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    return fail(
      "EIDOLON_HOLON_TASK_DEFINITION_BYTES_MISSING",
      `Resource '${resource.resourceId}' requires exact '${property}' base64 bytes.`,
    )
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"))
  if (bytes.byteLength === 0 || Buffer.from(bytes).toString("base64") !== value) {
    return fail(
      "EIDOLON_HOLON_TASK_DEFINITION_BYTES_INVALID",
      `Resource '${resource.resourceId}' '${property}' is not canonical base64.`,
    )
  }
  return bytes
}

function assertCanonicalKindDefinition(input: HolonTaskRuntimeDefinitionProjectionInput): void {
  const kindDefinition = input.registry.kindDefinitions.get(
    HOLON_TASK_RUNTIME_DEFINITION_KIND,
  )?.definition
  if (!kindDefinition
    || kindDefinition.resourceId !== HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_FQN
    || input.kindDefinitionAuthorityDigests.get(HOLON_TASK_RUNTIME_DEFINITION_KIND)
      !== sha256Digest(Uint8Array.from(HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_BYTES))) {
    fail(
      "EIDOLON_HOLON_TASK_DEFINITION_KIND_DEFINITION_MISMATCH",
      `Kind '${HOLON_TASK_RUNTIME_DEFINITION_KIND}' must be owned by the canonical Eidolon KindDefinition bytes.`,
    )
  }
}

function closedReferences(definition: HolonTaskRuntimeDefinition): readonly string[] {
  return Object.freeze([
    resourceId(definition.taskSpace.profileRef),
    resourceId(definition.taskSpace.policyRef),
    ...definition.taskSpace.requiredCapabilityRefs.map(resourceId),
    resourceId(definition.input.schemaRef),
    resourceId(definition.output.schemaRef),
    ...definition.output.materialPortRefs.map(resourceId),
  ].sort(compareUtf16))
}

function exactEligibleRefs(
  projection: EidolonHolonExecutionBindingProjection,
): Readonly<{ readonly members: readonly string[]; readonly roles: readonly string[] }> {
  const members = projection.snapshot.records
    .filter((record) => record.kind === "Member")
    .map((record) => record.id)
    .sort(compareUtf16)
  const roles = projection.snapshot.records
    .filter((record) => record.kind === "Role")
    .map((record) => record.id)
    .sort(compareUtf16)
  return Object.freeze({ members: Object.freeze(members), roles: Object.freeze(roles) })
}

function definitionAdmissionId(input: Readonly<{
  readonly definitionDigest: string
  readonly bindingSemanticFingerprint: string
  readonly snapshotArtifactDigest: string
  readonly snapshotReceiptDigest: string
}>): string {
  return `holon-task-admission:${sha256Digest(JSON.stringify({
    schemaVersion: "eidolon.holon-task-runtime-admission-identity/v1",
    ...input,
  })).slice("sha256:".length)}`
}

export async function projectHolonTaskRuntimeDefinitions(
  input: HolonTaskRuntimeDefinitionProjectionInput,
): Promise<readonly EidolonHolonTaskRuntimeDefinitionProjection[]> {
  const resources = [...(input.registry.byKind.get(HOLON_TASK_RUNTIME_DEFINITION_KIND) ?? [])]
    .sort((left, right) => compareUtf16(left.resourceId, right.resourceId))
  if (resources.length === 0) return Object.freeze([])
  assertCanonicalKindDefinition(input)

  const bindingByRef = new Map(input.holonExecutionBindings.map((projection) => [
    projection.binding.bindingRef,
    projection,
  ]))
  const freezeBinding = input.freezeBinding ?? ((projection) => freezeHolonExecutionBinding({
    projection,
    registry: input.registry,
    contentIdentities: input.contentIdentities,
    registryRevision: input.registryRevision,
    agentResources: input.agentResources,
  }))
  const projections: EidolonHolonTaskRuntimeDefinitionProjection[] = []

  for (const resource of resources) {
    const definition = parseHolonTaskRuntimeDefinitionBytes(
      canonicalBase64Property(resource, "definitionBytesBase64"),
    )
    if (definition.definitionRef !== resourceRef(resource.resourceId)) {
      fail(
        "EIDOLON_HOLON_TASK_DEFINITION_IDENTITY_MISMATCH",
        `HolonTaskRuntimeDefinition '${resource.resourceId}' bytes select '${definition.definitionRef}'.`,
      )
    }
    const definitionIdentity = requiredIdentity(input.contentIdentities, resource.resourceId)
    const bindingProjection = bindingByRef.get(definition.executionBinding.ref) ?? fail(
      "EIDOLON_HOLON_TASK_DEFINITION_BINDING_MISSING",
      `Definition '${resource.resourceId}' selects a missing HolonExecutionBinding.`,
    )
    if (definition.rootHolonRef !== bindingProjection.snapshot.rootHolonRef) {
      fail(
        "EIDOLON_HOLON_TASK_DEFINITION_HOLON_MISMATCH",
        `Definition '${resource.resourceId}' root Holon differs from its frozen binding snapshot.`,
      )
    }
    const bindingIdentity = requiredIdentity(
      input.contentIdentities,
      bindingProjection.resource.resourceId,
    )
    if (definition.executionBinding.digest !== bindingIdentity.contentDigest) {
      fail(
        "EIDOLON_HOLON_TASK_DEFINITION_BINDING_DIGEST_MISMATCH",
        `Definition '${resource.resourceId}' does not select the effective binding content identity.`,
      )
    }
    const referenced = closedReferences(definition)
    for (const id of referenced) {
      exactResource(input.registry, id)
      requiredIdentity(input.contentIdentities, id)
    }
    const eligible = exactEligibleRefs(bindingProjection)
    if ((bindingProjection.binding.target.kind === "member"
      && !eligible.members.includes(bindingProjection.binding.target.memberRef))
      || (bindingProjection.binding.target.kind === "role"
        && !eligible.roles.includes(bindingProjection.binding.target.roleRef))) {
      fail(
        "EIDOLON_HOLON_TASK_DEFINITION_TARGET_MISSING",
        `Definition '${resource.resourceId}' selects a target outside its frozen snapshot.`,
      )
    }
    if (definition.taskSpace.requiredRoleRefs.some((roleRef) => !eligible.roles.includes(roleRef))) {
      fail(
        "EIDOLON_HOLON_TASK_DEFINITION_ROLE_MISSING",
        `Definition '${resource.resourceId}' requires a Role outside its frozen snapshot.`,
      )
    }
    const authorizedMaterials = new Set(bindingProjection.binding.policy.materialRefs)
    const unauthorizedMaterials = definition.output.materialPortRefs.filter(
      (ref) => !authorizedMaterials.has(ref),
    )
    if (unauthorizedMaterials.length > 0) {
      fail(
        "EIDOLON_HOLON_TASK_DEFINITION_MATERIAL_UNAUTHORIZED",
        `Definition '${resource.resourceId}' declares output material ports outside its frozen binding: ${unauthorizedMaterials.join(", ")}.`,
      )
    }
    const bindingFreezeReceipt = freezeBinding(bindingProjection)
    if (bindingFreezeReceipt.bindingRef !== bindingProjection.binding.bindingRef
      || bindingFreezeReceipt.snapshotRef !== bindingProjection.binding.snapshotRef
      || bindingFreezeReceipt.snapshotTreeDigest !== bindingProjection.snapshot.treeDigest
      || bindingFreezeReceipt.snapshotReceiptDigest !== bindingProjection.receiptBytesDigest
      || bindingFreezeReceipt.registryRevision !== input.registryRevision
      || !/^sha256:[0-9a-f]{64}$/u.test(bindingFreezeReceipt.semanticFingerprint)) {
      fail(
        "EIDOLON_HOLON_TASK_DEFINITION_BINDING_FREEZE_MISMATCH",
        `Definition '${resource.resourceId}' received a mismatched binding freeze receipt.`,
      )
    }
    const snapshotArtifactDigest = sha256Digest(
      await canonicalHolonEffectiveSnapshotBytes(bindingProjection.snapshot),
    ) as HolonTaskDigest
    const definitionDigest = definitionIdentity.contentDigest as HolonTaskDigest
    const admission = Object.freeze({
      kind: "frozen-holon-task-runtime-admission" as const,
      schemaVersion: HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
      admissionId: definitionAdmissionId({
        definitionDigest,
        bindingSemanticFingerprint: bindingFreezeReceipt.semanticFingerprint,
        snapshotArtifactDigest,
        snapshotReceiptDigest: bindingProjection.receiptBytesDigest,
      }),
      registryRevision: input.registryRevision,
      definitionDigest,
      definition,
      executionTarget: bindingProjection.binding.target,
      snapshotAuthority: Object.freeze({
        kind: "holon-task-runtime-snapshot-authority" as const,
        schemaVersion: HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
        holonRef: bindingProjection.snapshot.rootHolonRef,
        effectiveAt: bindingProjection.snapshot.effectiveAt,
        holonSnapshotRef: bindingProjection.snapshot.snapshotId,
        holonSnapshotDigest: bindingProjection.snapshot.treeDigest,
        snapshotArtifactDigest,
        executionBindingRef: definition.executionBinding.ref,
        executionBindingDigest: definition.executionBinding.digest,
        eligibleMemberRefs: eligible.members,
        eligibleRoleRefs: eligible.roles,
      }),
    }) satisfies FrozenHolonTaskRuntimeAdmission
    projections.push(Object.freeze({
      schemaVersion: "eidolon.holon-task-runtime-definition-projection/v1" as const,
      resource,
      definition,
      definitionContentIdentity: definitionIdentity,
      bindingProjection,
      bindingFreezeReceipt,
      closureResourceIds: Object.freeze([
        resource.resourceId,
        bindingProjection.resource.resourceId,
        bindingProjection.snapshotResource.resourceId,
        ...referenced,
      ].filter((id, index, values) => values.indexOf(id) === index).sort(compareUtf16)),
      admission,
      registryRevision: input.registryRevision,
    }))
  }

  const defaults = new Map<string, string>()
  for (const projection of projections) {
    if (!projection.definition.defaultForHolon) continue
    const prior = defaults.get(projection.definition.rootHolonRef)
    if (prior) {
      fail(
        "EIDOLON_HOLON_TASK_DEFINITION_DEFAULT_AMBIGUOUS",
        `Holon '${projection.definition.rootHolonRef}' has multiple default definitions: '${prior}' and '${projection.resource.resourceId}'.`,
      )
    }
    defaults.set(projection.definition.rootHolonRef, projection.resource.resourceId)
  }
  return Object.freeze(projections)
}
