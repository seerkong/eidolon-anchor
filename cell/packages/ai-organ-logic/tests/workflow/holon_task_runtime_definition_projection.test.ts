import { describe, expect, it } from "bun:test"

import {
  HOLON_TASK_RUNTIME_DEFINITION_KIND,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_BYTES,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_FQN,
} from "@cell/ai-organ-contract"
import {
  computeHolonEffectiveSnapshotTreeDigest,
  type HolonEffectiveSnapshot,
} from "holarchy-core-contract"
import {
  createResourceContentIdentity,
  sha256Digest,
  type EffectiveResourceRegistry,
  type ResourceContentIdentity,
  type ResourceRecord,
} from "halfcode-compiler.xnl/resource-core"

import { canonicalHolonTaskRuntimeDefinitionBytes } from "../../src/organization/HolonTaskRuntimeContract"
import { projectHolonTaskRuntimeDefinitions } from "../../src/resources/HolonTaskRuntimeDefinitionProjection"

const created = Object.freeze({
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "fixture",
})
const selected = Object.freeze({
  effectiveDate: "2026-01-01",
  effectiveState: true as const,
  changeSetId: "fixture-change",
})

function resource(
  kind: string,
  resourceId: string,
  properties: Readonly<Record<string, string>> = {},
): ResourceRecord {
  return Object.freeze({
    kind,
    resourceId,
    metadata: Object.freeze({ apiVersion: "eidolon.ai/v1", version: "1.0.0" }),
    sourceShape: "single-file" as const,
    logicalPath: `/${resourceId}.xnl`,
    documentUri: `file:///${resourceId}.xnl`,
    format: "xnl" as const,
    node: Object.freeze({
      tag: kind,
      resourceId,
      metadata: Object.freeze({ apiVersion: "eidolon.ai/v1", version: "1.0.0" }),
      properties: Object.freeze(properties),
      body: Object.freeze([]),
      subdomains: Object.freeze({}),
    }),
  })
}

function identity(
  resourceId: string,
  contentDigest: `sha256:${string}` = sha256Digest(`content:${resourceId}`),
): ResourceContentIdentity {
  return createResourceContentIdentity({
    resourceId,
    authorityDigest: sha256Digest(`authority:${resourceId}`),
    contributions: Object.freeze([{ key: "content", digest: contentDigest }]),
  })
}

async function fixture(options: Readonly<{
  readonly duplicateDefault?: boolean
  readonly bindingDigest?: `sha256:${string}`
  readonly requiredRoleRef?: string
  readonly targetMemberRef?: string
  readonly rootHolonRef?: string
  readonly freezeSnapshotTreeDigest?: `sha256:${string}`
  readonly authorizedOutputMaterial?: boolean
}> = {}) {
  const tree = Object.freeze({
    apiVersion: "holon.workbench/v1" as const,
    kind: "HolonEffectiveSnapshot" as const,
    snapshotId: "snapshot-review",
    rootHolonRef: "holon-review",
    effectiveAt: "2026-01-01T00:00:00.000Z",
    sourceRevision: "revision-review",
    records: Object.freeze([
      Object.freeze({
        kind: "OrganizationalSubject" as const,
        id: "subject-review",
        subjectType: "holon" as const,
      }),
      Object.freeze({
        kind: "OrganizationalSubject" as const,
        id: "subject-reviewer",
        subjectType: "member" as const,
      }),
      Object.freeze({
        kind: "Holon" as const,
        id: "holon-review",
        subjectId: "subject-review",
        code: "review",
        ...created,
      }),
      Object.freeze({
        kind: "HolonVersion" as const,
        id: "holon-review:v1",
        holonId: "holon-review",
        name: "Review",
        purpose: "Review work",
        boundary: "Review boundary",
        ...selected,
        sequence: 1,
        ...created,
      }),
      Object.freeze({
        kind: "Member" as const,
        id: "member-reviewer",
        subjectId: "subject-reviewer",
        ...created,
      }),
      Object.freeze({
        kind: "MemberVersion" as const,
        id: "member-reviewer:v1",
        memberId: "member-reviewer",
        displayName: "Reviewer",
        principalKind: "ai" as const,
        ...selected,
        sequence: 2,
        ...created,
      }),
      Object.freeze({
        kind: "HolonMembership" as const,
        id: "membership-reviewer",
        ...created,
      }),
      Object.freeze({
        kind: "HolonMembershipVersion" as const,
        id: "membership-reviewer:v1",
        membershipId: "membership-reviewer",
        parentHolonId: "holon-review",
        subjectId: "subject-reviewer",
        mode: "primary" as const,
        ...selected,
        sequence: 3,
        ...created,
      }),
      Object.freeze({
        kind: "Role" as const,
        id: "role-reviewer",
        holonId: "holon-review",
        ...created,
      }),
      Object.freeze({
        kind: "RoleVersion" as const,
        id: "role-reviewer:v1",
        roleId: "role-reviewer",
        name: "Reviewer",
        purpose: "Review work",
        domains: Object.freeze(["review"]),
        accountabilities: Object.freeze(["review"]),
        policies: Object.freeze([]),
        capabilityRequirements: Object.freeze(["review"]),
        ...selected,
        sequence: 4,
        ...created,
      }),
      Object.freeze({
        kind: "RoleAssignment" as const,
        id: "assignment-reviewer",
        ...created,
      }),
      Object.freeze({
        kind: "RoleAssignmentVersion" as const,
        id: "assignment-reviewer:v1",
        roleAssignmentId: "assignment-reviewer",
        membershipId: "membership-reviewer",
        roleId: "role-reviewer",
        ...selected,
        sequence: 5,
        ...created,
      }),
    ]),
  })
  const snapshot: HolonEffectiveSnapshot = Object.freeze({
    ...tree,
    treeDigest: await computeHolonEffectiveSnapshotTreeDigest(tree),
  })
  const bindingResource = resource("HolonExecutionBinding", "fixture.binding.review")
  const snapshotResource = resource("HolonEffectiveSnapshot", "fixture.snapshot.review")
  const bindingIdentity = identity(bindingResource.resourceId)
  const definition = (resourceId: string) => Object.freeze({
    kind: "holon-task-runtime-definition" as const,
    schemaVersion: "eidolon.holon-task-runtime-definition/v1" as const,
    definitionRef: `resource://${resourceId}` as const,
    version: "1.0.0",
    rootHolonRef: options.rootHolonRef ?? "holon-review",
    executionBinding: Object.freeze({
      ref: "resource://fixture.binding.review" as const,
      digest: options.bindingDigest ?? bindingIdentity.contentDigest,
    }),
    taskSpace: Object.freeze({
      profileRef: "resource://fixture.profile.review" as const,
      policyRef: "resource://fixture.policy.review" as const,
      requiredRoleRefs: Object.freeze([options.requiredRoleRef ?? "role-reviewer"]),
      requiredCapabilityRefs: Object.freeze(["resource://fixture.capability.review" as const]),
    }),
    input: Object.freeze({ schemaRef: "resource://fixture.schema.input" as const }),
    output: Object.freeze({
      schemaRef: "resource://fixture.schema.output" as const,
      materialPortRefs: Object.freeze(["resource://fixture.port.output" as const]),
    }),
    defaultForHolon: true,
  })
  const definitionResources = ["fixture.task.review", ...(options.duplicateDefault
    ? ["fixture.task.review-secondary"]
    : [])].map((resourceId) => resource(
      HOLON_TASK_RUNTIME_DEFINITION_KIND,
      resourceId,
      {
        definitionBytesBase64: Buffer.from(
          canonicalHolonTaskRuntimeDefinitionBytes(definition(resourceId)),
        ).toString("base64"),
      },
    ))
  const closureResources = [
    resource("TaskProfile", "fixture.profile.review"),
    resource("TaskPolicy", "fixture.policy.review"),
    resource("Capability", "fixture.capability.review"),
    resource("Schema", "fixture.schema.input"),
    resource("Schema", "fixture.schema.output"),
    resource("MaterialPort", "fixture.port.output"),
  ]
  const resources = [
    ...definitionResources,
    bindingResource,
    snapshotResource,
    ...closureResources,
  ]
  const identities = new Map<string, ResourceContentIdentity>(resources.map((entry) => [
    entry.resourceId,
    entry.resourceId.startsWith("fixture.task.")
      ? identity(
        entry.resourceId,
        sha256Digest(Buffer.from(entry.node.properties.definitionBytesBase64 as string, "base64")),
      )
      : entry.resourceId === bindingResource.resourceId
        ? bindingIdentity
        : identity(entry.resourceId),
  ]))
  const registry = Object.freeze({
    byId: new Map(resources.map((entry) => [entry.resourceId, Object.freeze({
      resource: entry,
      shadowed: Object.freeze([]),
      tombstones: Object.freeze([]),
    })])),
    byKind: new Map([[HOLON_TASK_RUNTIME_DEFINITION_KIND, Object.freeze(definitionResources)]]),
    kindDefinitions: new Map([[HOLON_TASK_RUNTIME_DEFINITION_KIND, Object.freeze({
      definition: Object.freeze({ resourceId: HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_FQN }),
      origins: Object.freeze([]),
    })]]),
    layers: Object.freeze([]),
    compositionRevision: "registry-review",
    revision: "registry-review",
  }) as unknown as EffectiveResourceRegistry
  const projection = Object.freeze({
    schemaVersion: "eidolon.holon-execution-binding-projection/v1" as const,
    resource: bindingResource,
    binding: Object.freeze({
      apiVersion: "eidolon.ai/v1" as const,
      kind: "HolonExecutionBinding" as const,
      bindingRef: "resource://fixture.binding.review" as const,
      snapshotRef: "resource://fixture.snapshot.review" as const,
      target: Object.freeze({
        kind: "member" as const,
        memberRef: options.targetMemberRef ?? "member-reviewer",
      }),
      adapter: Object.freeze({
        kind: "ai-agent" as const,
        agentDefinitionRef: "resource://fixture.agent.reviewer" as const,
        runtimeProfileRef: "resource://fixture.runtime.review" as const,
      }),
      policy: Object.freeze({
        version: "1",
        runtime: Object.freeze({ mode: "shared-member-runtime" as const }),
        taskProfileRef: "resource://fixture.profile.review" as const,
        capabilityRefs: Object.freeze(["resource://fixture.capability.review" as const]),
        toolRefs: Object.freeze([]),
        materialRefs: Object.freeze(options.authorizedOutputMaterial === false
          ? []
          : ["resource://fixture.port.output" as const]),
      }),
    }),
    snapshotResource,
    snapshot,
    receipt: Object.freeze({
      snapshotRef: snapshot.snapshotId,
      sourceAuthorityId: "fixture-authority",
      sourceRevision: snapshot.sourceRevision,
      effectiveAt: snapshot.effectiveAt,
      treeDigest: snapshot.treeDigest,
      issuedAt: "2026-01-01T00:00:01.000Z",
    }),
    bindingBytesDigest: sha256Digest("binding-bytes"),
    receiptBytesDigest: sha256Digest("receipt-bytes"),
    closureResourceIds: Object.freeze([bindingResource.resourceId, snapshotResource.resourceId]),
    registryRevision: "registry-review",
  })
  const freezeReceipt = Object.freeze({
    schemaVersion: "eidolon.holon-execution-binding-freeze/v1" as const,
    bindingRef: projection.binding.bindingRef,
    snapshotRef: projection.binding.snapshotRef,
    snapshotTreeDigest: options.freezeSnapshotTreeDigest ?? snapshot.treeDigest,
    snapshotReceiptDigest: projection.receiptBytesDigest,
    bindingBytesDigest: projection.bindingBytesDigest,
    registryRevision: "registry-review",
    closure: Object.freeze([]),
    agentProofs: Object.freeze([]),
    semanticFingerprint: sha256Digest("semantic-review"),
  })
  return Object.freeze({
    registry,
    identities,
    projection,
    freezeReceipt,
    input: Object.freeze({
      registry,
      contentIdentities: identities,
      kindDefinitionAuthorityDigests: new Map([[
        HOLON_TASK_RUNTIME_DEFINITION_KIND,
        sha256Digest(Uint8Array.from(HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_BYTES)),
      ]]),
      registryRevision: "registry-review",
      holonExecutionBindings: Object.freeze([projection]),
      agentResources: Object.freeze({}) as never,
      freezeBinding: () => freezeReceipt,
    }),
  })
}

describe("HolonTaskRuntimeDefinition projection", () => {
  it("derives one reproducible closed admission from exact definition, binding and snapshot facts", async () => {
    const first = await fixture()
    const [projected] = await projectHolonTaskRuntimeDefinitions(first.input)
    const second = await fixture()
    const [reconstructed] = await projectHolonTaskRuntimeDefinitions(second.input)

    expect(projected!.definitionContentIdentity.contentDigest)
      .toBe(projected!.admission.definitionDigest)
    expect(projected!.admission).toMatchObject({
      admissionId: expect.stringMatching(/^holon-task-admission:[0-9a-f]{64}$/),
      executionTarget: { kind: "member", memberRef: "member-reviewer" },
      snapshotAuthority: {
        holonRef: "holon-review",
        eligibleMemberRefs: ["member-reviewer"],
        eligibleRoleRefs: ["role-reviewer"],
        snapshotArtifactDigest: expect.stringMatching(/^sha256:/),
      },
    })
    expect(projected!.closureResourceIds).toEqual(expect.arrayContaining([
      "fixture.task.review",
      "fixture.binding.review",
      "fixture.snapshot.review",
      "fixture.profile.review",
      "fixture.policy.review",
      "fixture.capability.review",
    ]))
    expect(reconstructed!.admission).toEqual(projected!.admission)
    expect(Object.isFrozen(projected)).toBe(true)
  })

  it("fails closed on binding/snapshot/eligibility/default ambiguity instead of inferring by name", async () => {
    await expect(projectHolonTaskRuntimeDefinitions((await fixture({
      bindingDigest: `sha256:${"f".repeat(64)}`,
    })).input)).rejects.toThrow(/BINDING_DIGEST_MISMATCH/)
    await expect(projectHolonTaskRuntimeDefinitions((await fixture({
      rootHolonRef: "holon-other",
    })).input)).rejects.toThrow(/HOLON_MISMATCH/)
    await expect(projectHolonTaskRuntimeDefinitions((await fixture({
      requiredRoleRef: "role-not-issued",
    })).input)).rejects.toThrow(/ROLE_MISSING/)
    await expect(projectHolonTaskRuntimeDefinitions((await fixture({
      targetMemberRef: "member-not-issued",
    })).input)).rejects.toThrow(/TARGET_MISSING/)
    await expect(projectHolonTaskRuntimeDefinitions((await fixture({
      duplicateDefault: true,
    })).input)).rejects.toThrow(/DEFAULT_AMBIGUOUS/)
    await expect(projectHolonTaskRuntimeDefinitions((await fixture({
      freezeSnapshotTreeDigest: `sha256:${"e".repeat(64)}`,
    })).input)).rejects.toThrow(/BINDING_FREEZE_MISMATCH/)
    await expect(projectHolonTaskRuntimeDefinitions((await fixture({
      authorizedOutputMaterial: false,
    })).input)).rejects.toThrow(/MATERIAL_UNAUTHORIZED/)
  })
})
