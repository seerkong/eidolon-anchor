import { createSyntheticTeamFixture, type SyntheticOrganizationFixture } from "holarchy-test-support"
import type { ProjectOrganizationSnapshotConfig } from "holarchy-core-contract"

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
  readonly fixture: SyntheticOrganizationFixture
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
const fixture = createSyntheticTeamFixture({
  authorityId: "holarchy-file-xnl-fixture", effectiveDate: "2026-01-01",
  teamId: "holon-review-team", teamName: "Review Team", purpose: "Review requirements", boundary: "Requirements",
  members: [{ memberId: "member-reviewer", displayName: "Reviewer", principalKind: "ai", membershipId: "membership-reviewer",
    roles: [{ roleId: "role-reviewer", roleName: "Reviewer", assignmentId: "assignment-reviewer", purpose: "Review requirements",
      domains: ["requirements"], accountabilities: ["review"], capabilityRequirements: ["requirements-review"] }] }],
})

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
  fixture,
})

export const FILE_XNL_HOLON_E2E_RESOURCE_CONFIG: FileXnlHolonE2eResourceConfig = deepFreezeData({
  scenario: FILE_XNL_HOLON_E2E_SCENARIO,
})
