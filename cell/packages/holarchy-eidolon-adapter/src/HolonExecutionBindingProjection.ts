import {
  HOLON_EXECUTION_BINDING_KIND,
  HOLON_EXECUTION_BINDING_KIND_DEFINITION_BYTES,
  HOLON_EXECUTION_BINDING_KIND_DEFINITION_FQN,
  parseHolonExecutionBindingBytes,
  validateHolonExecutionBindingGraph,
  type HolonExecutionBinding,
  type HolonExecutionResourceRef,
} from "./HolonExecutionBinding"
import {
  HOLON_EFFECTIVE_SNAPSHOT_KIND,
  HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_BYTES,
  HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_FQN,
  parseHolonEffectiveSnapshotBytes,
  parseHolonEffectiveSnapshotIssuanceReceiptBytes,
  type HolonEffectiveSnapshot,
  type HolonEffectiveSnapshotIssuanceReceipt,
} from "holarchy-core-contract"
import {
  buildResourceDependencySnapshot,
  sha256Digest,
  type EffectiveResourceRegistry,
  type ResourceContentIdentity,
  type ResourceRecord,
} from "halfcode-compiler.xnl/resource-core"
import type { AIWorkflowAgentResourceProjection } from "ai-workflow-contract"

import { HolarchyEidolonAdapterError as EidolonResourceRegistryError } from "./HolarchyEidolonAdapterError"

export interface EidolonHolonExecutionBindingProjection {
  readonly schemaVersion: "eidolon.holon-execution-binding-projection/v1"
  readonly resource: ResourceRecord
  readonly binding: HolonExecutionBinding
  readonly snapshotResource: ResourceRecord
  readonly snapshot: HolonEffectiveSnapshot
  readonly receipt: HolonEffectiveSnapshotIssuanceReceipt
  readonly bindingBytesDigest: `sha256:${string}`
  readonly receiptBytesDigest: `sha256:${string}`
  readonly closureResourceIds: readonly string[]
  readonly registryRevision: string
}

export interface EidolonHolonExecutionAgentProof {
  readonly agentDefinitionRef: HolonExecutionResourceRef
  readonly agentContentDigest: `sha256:${string}`
  readonly closureResourceIds: readonly string[]
  readonly snapshotRevision: `sha256:${string}`
}

export interface EidolonHolonExecutionBindingFreezeReceipt {
  readonly schemaVersion: "eidolon.holon-execution-binding-freeze/v1"
  readonly bindingRef: HolonExecutionResourceRef
  readonly snapshotRef: HolonExecutionResourceRef
  readonly snapshotTreeDigest: `sha256:${string}`
  readonly snapshotReceiptDigest: `sha256:${string}`
  readonly bindingBytesDigest: `sha256:${string}`
  readonly registryRevision: string
  readonly closure: readonly Readonly<{
    readonly resourceId: string
    readonly kind: string
    readonly authorityDigest: `sha256:${string}`
    readonly contentDigest: `sha256:${string}`
  }>[]
  readonly agentProofs: readonly EidolonHolonExecutionAgentProof[]
  readonly semanticFingerprint: `sha256:${string}`
}

export interface HolonExecutionBindingProjectionInput {
  readonly registry: EffectiveResourceRegistry
  readonly contentIdentities: ReadonlyMap<string, ResourceContentIdentity>
  readonly kindDefinitionAuthorityDigests: ReadonlyMap<string, `sha256:${string}`>
  readonly registryRevision: string
}

export interface HolonExecutionBindingFreezeInput {
  readonly registry: EffectiveResourceRegistry
  readonly contentIdentities: ReadonlyMap<string, ResourceContentIdentity>
  readonly registryRevision: string
  readonly projection: EidolonHolonExecutionBindingProjection
  readonly agentResources: AIWorkflowAgentResourceProjection
}

const authenticProjections = new WeakSet<object>()
const authenticFreezeReceipts = new WeakSet<object>()

export async function projectHolonExecutionBindings(
  input: HolonExecutionBindingProjectionInput,
): Promise<readonly EidolonHolonExecutionBindingProjection[]> {
  const resources = [...(input.registry.byKind.get(HOLON_EXECUTION_BINDING_KIND) ?? [])]
    .sort((left, right) => compareUtf16(left.resourceId, right.resourceId))
  if (resources.length === 0) return Object.freeze([])
  assertCanonicalKindDefinition(input, {
    resourceKind: HOLON_EXECUTION_BINDING_KIND,
    fqn: HOLON_EXECUTION_BINDING_KIND_DEFINITION_FQN,
    bytes: HOLON_EXECUTION_BINDING_KIND_DEFINITION_BYTES,
    code: "EIDOLON_HOLON_BINDING_KIND_DEFINITION_MISMATCH",
  })
  assertCanonicalKindDefinition(input, {
    resourceKind: HOLON_EFFECTIVE_SNAPSHOT_KIND,
    fqn: HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_FQN,
    bytes: HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_BYTES,
    code: "EIDOLON_HOLON_SNAPSHOT_KIND_DEFINITION_MISMATCH",
  })

  const decoded = resources.map((resource) => {
    const bindingBytes = canonicalBase64Property(resource, "bindingBytesBase64")
    const binding = parseHolonExecutionBindingBytes(bindingBytes)
    if (binding.bindingRef !== resourceRef(resource.resourceId)) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_HOLON_BINDING_IDENTITY_MISMATCH",
        `HolonExecutionBinding '${resource.resourceId}' bytes select '${binding.bindingRef}'.`,
      )
    }
    return Object.freeze({ resource, binding, bindingBytes })
  })
  const bindingGraph = validateHolonExecutionBindingGraph(decoded.map(({ binding }) => binding))
  const decodedByRef = new Map(decoded.map((entry) => [entry.binding.bindingRef, entry]))

  const projections: EidolonHolonExecutionBindingProjection[] = []
  for (const binding of bindingGraph) {
    const decodedBinding = decodedByRef.get(binding.bindingRef)
    if (!decodedBinding) throw new EidolonResourceRegistryError(
      "EIDOLON_HOLON_BINDING_GRAPH_INTERNAL",
      `HolonExecutionBinding '${binding.bindingRef}' disappeared during projection.`,
    )
    const snapshotId = resourceId(binding.snapshotRef)
    const snapshotResource = exactResource(input.registry, snapshotId)
    if (snapshotResource.kind !== HOLON_EFFECTIVE_SNAPSHOT_KIND) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_HOLON_SNAPSHOT_KIND_MISMATCH",
        `Resource '${snapshotId}' must be a canonical ${HOLON_EFFECTIVE_SNAPSHOT_KIND} Resource.`,
      )
    }
    const snapshotBytes = canonicalBase64Property(snapshotResource, "snapshotBytesBase64")
    const snapshot = await parseHolonEffectiveSnapshotBytes(snapshotBytes)
    const receiptBytes = canonicalBase64Property(snapshotResource, "issuanceReceiptBytesBase64")
    const receipt = parseHolonEffectiveSnapshotIssuanceReceiptBytes(receiptBytes, snapshot)
    assertTargetExists(binding, snapshot)

    const closureResourceIds = resolveBindingClosureResourceIds(binding, decodedByRef, input.registry)
    for (const resourceId of closureResourceIds) requiredIdentity(input.contentIdentities, resourceId)
    requiredIdentity(input.contentIdentities, snapshotResource.resourceId)

    const projection = Object.freeze({
      schemaVersion: "eidolon.holon-execution-binding-projection/v1",
      resource: decodedBinding.resource,
      binding,
      snapshotResource,
      snapshot,
      receipt,
      bindingBytesDigest: sha256Digest(decodedBinding.bindingBytes),
      receiptBytesDigest: sha256Digest(receiptBytes),
      closureResourceIds,
      registryRevision: input.registryRevision,
    })
    authenticProjections.add(projection)
    projections.push(projection)
  }
  return Object.freeze(projections)
}

export function freezeHolonExecutionBinding(
  input: HolonExecutionBindingFreezeInput,
): EidolonHolonExecutionBindingFreezeReceipt {
  if (!authenticProjections.has(input.projection as object)) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_HOLON_BINDING_PROJECTION_UNTRUSTED",
      "Binding freeze requires the exact projection produced by the shared registry.",
    )
  }
  const closure = Object.freeze(input.projection.closureResourceIds.map((resourceId) => {
    const resource = exactResource(input.registry, resourceId)
    const identity = requiredIdentity(input.contentIdentities, resourceId)
    return Object.freeze({
      resourceId,
      kind: resource.kind,
      authorityDigest: exactSha256(identity.authorityDigest, `${resourceId}.authorityDigest`),
      contentDigest: exactSha256(identity.contentDigest, `${resourceId}.contentDigest`),
    })
  }))
  const agentProofs = Object.freeze(agentRefs(input.projection.binding, new Map(
    (input.registry.byKind.get(HOLON_EXECUTION_BINDING_KIND) ?? []).map((resource) => {
      const projected = resourceRef(resource.resourceId)
      return [projected, projected === input.projection.binding.bindingRef
        ? input.projection.binding
        : parseHolonExecutionBindingBytes(canonicalBase64Property(resource, "bindingBytesBase64"))]
    }),
  )).map((agentDefinitionRef) => {
    const agentId = resourceId(agentDefinitionRef)
    const agent = input.agentResources.agentDefinitions.find(
      (candidate) => candidate.resource.resourceId === agentId,
    )
    if (!agent) throw new EidolonResourceRegistryError(
      "EIDOLON_HOLON_BINDING_AGENT_PROJECTION_MISSING",
      `AIAgentDefinition '${agentDefinitionRef}' has no authentic shared-registry projection.`,
    )
    const roots = agentClosureResourceIds(agent)
    const dependencySnapshot = buildResourceDependencySnapshot({
      registry: input.registry,
      roots,
      edges: input.agentResources.dependencyEdges,
      contentIdentities: input.contentIdentities,
    })
    return Object.freeze({
      agentDefinitionRef,
      agentContentDigest: requiredIdentity(input.contentIdentities, agentId).contentDigest,
      closureResourceIds: Object.freeze(dependencySnapshot.closure.map(({ resourceId }) => resourceId)),
      snapshotRevision: dependencySnapshot.snapshotRevision,
    })
  }))
  const semanticFingerprint = sha256Digest(JSON.stringify({
    schemaVersion: "eidolon.holon-execution-binding-freeze-semantic/v1",
    bindingRef: input.projection.binding.bindingRef,
    snapshotRef: input.projection.binding.snapshotRef,
    snapshotTreeDigest: input.projection.snapshot.treeDigest,
    snapshotReceiptDigest: input.projection.receiptBytesDigest,
    bindingBytesDigest: input.projection.bindingBytesDigest,
    registryRevision: input.registryRevision,
    closure,
    agentProofs,
  }))
  const receipt = Object.freeze({
    schemaVersion: "eidolon.holon-execution-binding-freeze/v1" as const,
    bindingRef: input.projection.binding.bindingRef,
    snapshotRef: input.projection.binding.snapshotRef,
    snapshotTreeDigest: input.projection.snapshot.treeDigest,
    snapshotReceiptDigest: input.projection.receiptBytesDigest,
    bindingBytesDigest: input.projection.bindingBytesDigest,
    registryRevision: input.registryRevision,
    closure,
    agentProofs,
    semanticFingerprint,
  })
  authenticFreezeReceipts.add(receipt)
  return receipt
}

export function assertHolonExecutionBindingFreezeReceipt(
  value: EidolonHolonExecutionBindingFreezeReceipt,
): EidolonHolonExecutionBindingFreezeReceipt {
  if (!authenticFreezeReceipts.has(value as object)) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_HOLON_BINDING_FREEZE_RECEIPT_UNTRUSTED",
      "Holon binding dispatch requires the authentic receipt produced by the shared registry freeze boundary.",
    )
  }
  return value
}

function agentRefs(
  root: HolonExecutionBinding,
  byRef: ReadonlyMap<HolonExecutionResourceRef, HolonExecutionBinding>,
): readonly HolonExecutionResourceRef[] {
  const refs = new Set<HolonExecutionResourceRef>()
  const visited = new Set<HolonExecutionResourceRef>()
  const visit = (binding: HolonExecutionBinding): void => {
    if (visited.has(binding.bindingRef)) return
    visited.add(binding.bindingRef)
    if (binding.adapter.kind === "ai-agent") refs.add(binding.adapter.agentDefinitionRef)
    if (binding.adapter.kind === "hybrid") {
      for (const candidateRef of binding.adapter.candidateBindingRefs) {
        const candidate = byRef.get(candidateRef)
        if (!candidate) throw new EidolonResourceRegistryError(
          "EIDOLON_HOLON_BINDING_CANDIDATE_MISSING",
          `Hybrid candidate '${candidateRef}' disappeared before freeze.`,
        )
        visit(candidate)
      }
    }
  }
  visit(root)
  return Object.freeze([...refs].sort(compareUtf16))
}

function agentClosureResourceIds(
  agent: AIWorkflowAgentResourceProjection["agentDefinitions"][number],
): readonly string[] {
  const ids = new Set<string>([agent.resource.resourceId])
  for (const message of agent.messages) {
    ids.add(message.prompt.resource.resourceId)
    if (message.schema) ids.add(message.schema.resource.resourceId)
  }
  if (agent.inputSchema) ids.add(agent.inputSchema.resource.resourceId)
  if (agent.outputSchema) ids.add(agent.outputSchema.resource.resourceId)
  if (agent.effectPolicy) ids.add(agent.effectPolicy.resource.resourceId)
  for (const tool of agent.tools) ids.add(tool.resource.resourceId)
  for (const port of agent.materialPorts) ids.add(port.resource.resourceId)
  return Object.freeze([...ids].sort(compareUtf16))
}

function assertCanonicalKindDefinition(
  input: HolonExecutionBindingProjectionInput,
  expected: {
    readonly resourceKind: string
    readonly fqn: string
    readonly bytes: Readonly<Uint8Array>
    readonly code: string
  },
): void {
  const kindDefinition = input.registry.kindDefinitions.get(expected.resourceKind)?.definition
  if (!kindDefinition || kindDefinition.resourceId !== expected.fqn) {
    throw new EidolonResourceRegistryError(
      expected.code,
      `Kind '${expected.resourceKind}' must be registered by canonical KindDefinition '${expected.fqn}'.`,
    )
  }
  const expectedDigest = sha256Digest(Uint8Array.from(expected.bytes))
  if (input.kindDefinitionAuthorityDigests.get(expected.resourceKind) !== expectedDigest) {
    throw new EidolonResourceRegistryError(
      expected.code,
      `KindDefinition '${expected.fqn}' bytes do not match the canonical owner bytes.`,
    )
  }
}

function canonicalBase64Property(resource: ResourceRecord, property: string): Uint8Array {
  const value = resource.node.properties[property]
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_HOLON_RESOURCE_BYTES_MISSING",
      `Resource '${resource.resourceId}' requires exact '${property}' base64 bytes.`,
    )
  }
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(Buffer.from(value, "base64"))
  } catch {
    throw new EidolonResourceRegistryError(
      "EIDOLON_HOLON_RESOURCE_BYTES_INVALID",
      `Resource '${resource.resourceId}' '${property}' is not valid base64.`,
    )
  }
  if (bytes.byteLength === 0 || Buffer.from(bytes).toString("base64") !== value) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_HOLON_RESOURCE_BYTES_INVALID",
      `Resource '${resource.resourceId}' '${property}' is not canonical base64.`,
    )
  }
  return bytes
}

function assertTargetExists(binding: HolonExecutionBinding, snapshot: HolonEffectiveSnapshot): void {
  const expectedKind = binding.target.kind === "member" ? "Member" : "Role"
  const targetRef = binding.target.kind === "member" ? binding.target.memberRef : binding.target.roleRef
  if (!snapshot.records.some((record) => record.kind === expectedKind && record.id === targetRef)) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_HOLON_BINDING_TARGET_MISSING",
      `${expectedKind} '${targetRef}' is not present in frozen snapshot '${snapshot.snapshotId}'.`,
    )
  }
}

function resolveBindingClosureResourceIds(
  root: HolonExecutionBinding,
  bindings: ReadonlyMap<HolonExecutionResourceRef, Readonly<{
    readonly resource: ResourceRecord
    readonly binding: HolonExecutionBinding
    readonly bindingBytes: Uint8Array
  }>>,
  registry: EffectiveResourceRegistry,
): readonly string[] {
  const selected = new Set<string>()
  const visited = new Set<HolonExecutionResourceRef>()
  const add = (ref: HolonExecutionResourceRef, expectedKind?: string): void => {
    const id = resourceId(ref)
    const resource = exactResource(registry, id)
    if (expectedKind && resource.kind !== expectedKind) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_HOLON_BINDING_RESOURCE_KIND_MISMATCH",
        `Resource '${id}' must have kind '${expectedKind}', got '${resource.kind}'.`,
      )
    }
    selected.add(id)
  }
  const visit = (binding: HolonExecutionBinding): void => {
    if (visited.has(binding.bindingRef)) return
    visited.add(binding.bindingRef)
    add(binding.bindingRef, HOLON_EXECUTION_BINDING_KIND)
    add(binding.snapshotRef, HOLON_EFFECTIVE_SNAPSHOT_KIND)
    add(binding.policy.taskProfileRef)
    for (const ref of binding.policy.capabilityRefs) add(ref)
    for (const ref of binding.policy.toolRefs) add(ref)
    for (const ref of binding.policy.materialRefs) add(ref)
    if (binding.adapter.kind === "ai-agent") {
      add(binding.adapter.agentDefinitionRef, "AIAgentDefinition")
      add(binding.adapter.runtimeProfileRef)
    } else if (binding.adapter.kind === "human-endpoint") {
      add(binding.adapter.humanEndpointRef)
      add(binding.adapter.inboxProfileRef)
    } else if (binding.adapter.kind === "service") {
      add(binding.adapter.serviceAdapterRef)
      add(binding.adapter.runtimeProfileRef)
    } else {
      add(binding.adapter.policyRef)
      for (const candidateRef of binding.adapter.candidateBindingRefs) {
        const candidate = bindings.get(candidateRef)
        if (!candidate) throw new EidolonResourceRegistryError(
          "EIDOLON_HOLON_BINDING_CANDIDATE_MISSING",
          `Hybrid candidate '${candidateRef}' is not present in the admitted registry.`,
        )
        visit(candidate.binding)
      }
    }
  }
  visit(root)
  return Object.freeze([...selected].sort(compareUtf16))
}

function exactResource(registry: EffectiveResourceRegistry, resourceId: string): ResourceRecord {
  const resource = registry.byId.get(resourceId)?.resource
  if (!resource) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_HOLON_BINDING_RESOURCE_MISSING",
      `Resource '${resourceId}' is not present in the admitted registry.`,
    )
  }
  return resource
}

function requiredIdentity(
  identities: ReadonlyMap<string, ResourceContentIdentity>,
  resourceId: string,
): ResourceContentIdentity {
  const identity = identities.get(resourceId)
  if (!identity) throw new EidolonResourceRegistryError(
    "EIDOLON_HOLON_BINDING_CONTENT_IDENTITY_MISSING",
    `Resource '${resourceId}' has no exact content identity.`,
  )
  return identity
}

function resourceId(ref: HolonExecutionResourceRef): string {
  return ref.slice("resource://".length)
}

function resourceRef(resourceId: string): HolonExecutionResourceRef {
  return `resource://${resourceId}`
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactSha256(value: string, path: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new EidolonResourceRegistryError(
    "EIDOLON_HOLON_BINDING_DIGEST_INVALID",
    `Expected one canonical SHA-256 digest at '${path}'.`,
  )
  return value as `sha256:${string}`
}
