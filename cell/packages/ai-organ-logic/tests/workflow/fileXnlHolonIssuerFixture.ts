import {
  canonicalHolonEffectiveSnapshotIssuanceReceiptBytes,
  type HolonAuthorityCommitReceipt,
  type HolonAuthoritySnapshot,
  type HolonAuthorityTables,
  type HolonEffectiveSnapshot,
  type HolonEffectiveSnapshotIssuanceReceipt,
  type ProjectOrganizationSnapshotConfig,
} from "holarchy-core-contract"
import { commitHolonAuthority } from "holarchy-core-logic"
import { HolarchyFileXnlCapsule } from "holarchy-file-xnl-capsule"
import { sha256Digest } from "halfcode-compiler.xnl/resource-core"

export interface FileXnlHolonIssuerFixtureInput {
  readonly authorityRoot: string
  readonly authorityId: string
  readonly expectedRevision: number
  readonly tables: HolonAuthorityTables
  readonly executionId: string
  readonly executionInstant: string
  readonly rootHolonRef: string
  readonly effectiveAt: string
  readonly issuedAt: string
  readonly projectionBounds: ProjectOrganizationSnapshotConfig
}

export interface FileXnlHolonIssuerProvenance {
  readonly issuerPackage: "holarchy-file-xnl-capsule"
  readonly issuerPackageVersion: "0.2.0"
  readonly sourceAuthorityId: string
  readonly sourceRevision: string
  readonly snapshotRef: string
  readonly effectiveAt: string
  readonly issuedAt: string
}

export interface FileXnlHolonIssuerDigests {
  readonly authorityState: string
  readonly snapshotTree: `sha256:${string}`
  readonly snapshotBytes: `sha256:${string}`
  readonly issuanceReceiptBytes: `sha256:${string}`
}

export interface FileXnlHolonIssuerFixture {
  readonly commitReceipt: HolonAuthorityCommitReceipt
  readonly reconstructedAuthority: HolonAuthoritySnapshot
  readonly snapshot: HolonEffectiveSnapshot
  readonly issuanceReceipt: HolonEffectiveSnapshotIssuanceReceipt
  readonly snapshotBytes: Uint8Array
  readonly issuanceReceiptBytes: Uint8Array
  readonly provenance: FileXnlHolonIssuerProvenance
  readonly digests: FileXnlHolonIssuerDigests
}

export async function issueFileXnlOrganizationFixture(
  input: FileXnlHolonIssuerFixtureInput,
): Promise<FileXnlHolonIssuerFixture> {
  const writer = new HolarchyFileXnlCapsule({
    root: input.authorityRoot,
    authorityId: input.authorityId,
  })
  await writer.start()
  const commitReceipt = await commitHolonAuthority({ store: writer.store }, {
    expectedRevision: input.expectedRevision,
    tables: input.tables,
  }, {
    authorityId: input.authorityId,
    executionId: input.executionId,
    executionInstant: input.executionInstant,
  })

  const issuer = new HolarchyFileXnlCapsule({
    root: input.authorityRoot,
    authorityId: input.authorityId,
    observedAt: () => input.issuedAt,
  })
  const reconstructedAuthority = await issuer.start()
  if (reconstructedAuthority.revision !== commitReceipt.revision
    || reconstructedAuthority.authorityId !== commitReceipt.authorityId) {
    throw new Error("FILE_XNL_ISSUER_RECONSTRUCTION_MISMATCH")
  }

  const issued = await issuer.projectOrganizationSnapshot({
    rootHolonRef: input.rootHolonRef,
    effectiveAt: input.effectiveAt,
  }, input.projectionBounds)
  const issuanceReceiptBytes = canonicalHolonEffectiveSnapshotIssuanceReceiptBytes(
    issued.issuanceReceipt,
    issued.snapshot,
  )
  const provenance = Object.freeze({
    issuerPackage: "holarchy-file-xnl-capsule" as const,
    issuerPackageVersion: "0.2.0" as const,
    sourceAuthorityId: issued.issuanceReceipt.sourceAuthorityId,
    sourceRevision: issued.issuanceReceipt.sourceRevision,
    snapshotRef: issued.issuanceReceipt.snapshotRef,
    effectiveAt: issued.issuanceReceipt.effectiveAt,
    issuedAt: issued.issuanceReceipt.issuedAt,
  })
  const digests = Object.freeze({
    authorityState: commitReceipt.stateDigest,
    snapshotTree: issued.snapshot.treeDigest,
    snapshotBytes: sha256Digest(issued.canonicalBytes),
    issuanceReceiptBytes: sha256Digest(issuanceReceiptBytes),
  })

  return Object.freeze({
    commitReceipt,
    reconstructedAuthority,
    snapshot: issued.snapshot,
    issuanceReceipt: issued.issuanceReceipt,
    snapshotBytes: issued.canonicalBytes,
    issuanceReceiptBytes,
    provenance,
    digests,
  })
}
