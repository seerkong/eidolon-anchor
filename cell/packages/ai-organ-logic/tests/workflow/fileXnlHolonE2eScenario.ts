import type { HolonAuthorityTables, ProjectOrganizationSnapshotConfig } from "holarchy-core-contract"

export interface FileXnlHolonE2eScenario {
  readonly scenarioId: "review-team"
  readonly issuer: {
    readonly authorityId: "holarchy-file-xnl-fixture"
    readonly expectedRevision: 0
    readonly executionId: "seed-review-team"
    readonly executionInstant: "2026-01-01T00:00:00.000Z"
    readonly rootHolonRef: "holon-review-team"
    readonly effectiveAt: "2026-01-01T00:00:00.000Z"
    readonly issuedAt: "2026-01-01T00:00:01.000Z"
    readonly projectionBounds: ProjectOrganizationSnapshotConfig
  }
  readonly tables: HolonAuthorityTables
}

export interface FileXnlHolonE2eResourceConfig {
  readonly scenario: FileXnlHolonE2eScenario
}

function deepFreezeData<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor && "value" in descriptor) deepFreezeData(descriptor.value)
    }
    Object.freeze(value)
  }
  return value
}

const effectiveAt = "2026-01-01T00:00:00.000Z" as const
const created = { createdAt: effectiveAt, createdBy: "fixture-seed" }
const selected = {
  ...created,
  effectiveDate: "2026-01-01",
  effectiveState: true,
  changeSetId: "fixture-seed",
}

const tables: HolonAuthorityTables = {
  OrganizationalSubject: [
    { id: "subject-review-team", subjectType: "holon" },
    { id: "subject-reviewer", subjectType: "member" },
  ],
  Holon: [
    { id: "holon-review-team", subjectId: "subject-review-team", code: "review-team", ...created },
  ],
  HolonVersion: [{
    id: "holon-review-team:v1",
    holonId: "holon-review-team",
    name: "Review Team",
    purpose: "Review requirements",
    boundary: "Requirements",
    sequence: 1,
    ...selected,
  }],
  Member: [
    { id: "member-reviewer", subjectId: "subject-reviewer", ...created },
  ],
  MemberVersion: [{
    id: "member-reviewer:v1",
    memberId: "member-reviewer",
    displayName: "Reviewer",
    principalKind: "ai",
    sequence: 2,
    ...selected,
  }],
  HolonMembership: [{ id: "membership-reviewer", ...created }],
  HolonMembershipVersion: [{
    id: "membership-reviewer:v1",
    membershipId: "membership-reviewer",
    parentHolonId: "holon-review-team",
    subjectId: "subject-reviewer",
    mode: "primary",
    sequence: 3,
    ...selected,
  }],
  Role: [{ id: "role-reviewer", holonId: "holon-review-team", ...created }],
  RoleVersion: [{
    id: "role-reviewer:v1",
    roleId: "role-reviewer",
    name: "Reviewer",
    purpose: "Review requirements",
    domainsJson: '["requirements"]',
    accountabilitiesJson: '["review"]',
    policiesJson: "[]",
    capabilityRequirementsJson: '["requirements-review"]',
    sequence: 4,
    ...selected,
  }],
  RoleAssignment: [{ id: "assignment-reviewer", ...created }],
  RoleAssignmentVersion: [{
    id: "assignment-reviewer:v1",
    roleAssignmentId: "assignment-reviewer",
    membershipId: "membership-reviewer",
    roleId: "role-reviewer",
    sequence: 5,
    ...selected,
  }],
}

export const FILE_XNL_HOLON_E2E_SCENARIO: FileXnlHolonE2eScenario = deepFreezeData({
  scenarioId: "review-team",
  issuer: {
    authorityId: "holarchy-file-xnl-fixture",
    expectedRevision: 0,
    executionId: "seed-review-team",
    executionInstant: effectiveAt,
    rootHolonRef: "holon-review-team",
    effectiveAt,
    issuedAt: "2026-01-01T00:00:01.000Z",
    projectionBounds: { maxDepth: 4, maxRecords: 100 },
  },
  tables,
})

export const FILE_XNL_HOLON_E2E_RESOURCE_CONFIG: FileXnlHolonE2eResourceConfig = deepFreezeData({
  scenario: FILE_XNL_HOLON_E2E_SCENARIO,
})
