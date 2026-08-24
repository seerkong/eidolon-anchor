import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  canonicalHolonEffectiveSnapshotIssuanceReceiptBytes,
  parseHolonEffectiveSnapshotBytes,
  parseHolonEffectiveSnapshotIssuanceReceiptBytes,
} from "holarchy-core-contract"
import { HolarchyFileXnlCapsule } from "holarchy-file-xnl-capsule"
import { sha256Digest } from "halfcode-compiler.xnl/resource-core"

import { issueFileXnlOrganizationFixture } from "./fileXnlHolonIssuerFixture"
import { FILE_XNL_HOLON_E2E_SCENARIO } from "./fileXnlHolonE2eScenario"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const { issuer, tables } = FILE_XNL_HOLON_E2E_SCENARIO
const {
  authorityId,
  effectiveAt,
  issuedAt,
  rootHolonRef,
  projectionBounds,
} = issuer

describe("File-XNL Holon issuer fixture", () => {
  it("writes, reconstructs and projects exact canonical admission bytes and provenance", async () => {
    const authorityRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-file-xnl-issuer-"))
    temporaryRoots.push(authorityRoot)

    const fixture = await issueFileXnlOrganizationFixture({
      authorityRoot,
      authorityId,
      expectedRevision: 0,
      tables,
      executionId: issuer.executionId,
      executionInstant: issuer.executionInstant,
      rootHolonRef,
      effectiveAt,
      issuedAt,
      projectionBounds,
    })

    const independentCapsule = new HolarchyFileXnlCapsule({
      root: authorityRoot,
      authorityId,
      observedAt: () => issuedAt,
    })
    const independentlyReconstructed = await independentCapsule.start()
    const independentlyIssued = await independentCapsule.projectOrganizationSnapshot({
      rootHolonRef,
      effectiveAt,
    }, projectionBounds)
    const independentlyIssuedReceiptBytes = canonicalHolonEffectiveSnapshotIssuanceReceiptBytes(
      independentlyIssued.issuanceReceipt,
      independentlyIssued.snapshot,
    )

    expect(fixture.commitReceipt).toMatchObject({
      authorityId,
      executionId: issuer.executionId,
      revision: 1,
    })
    expect(fixture.reconstructedAuthority).toEqual(independentlyReconstructed)
    expect(fixture.reconstructedAuthority.revision).toBe(fixture.commitReceipt.revision)
    expect(fixture.snapshot).toEqual(independentlyIssued.snapshot)
    expect(fixture.issuanceReceipt).toEqual(independentlyIssued.issuanceReceipt)
    expect(fixture.snapshotBytes).toEqual(independentlyIssued.canonicalBytes)
    expect(fixture.issuanceReceiptBytes).toEqual(independentlyIssuedReceiptBytes)
    expect(await parseHolonEffectiveSnapshotBytes(fixture.snapshotBytes)).toEqual(fixture.snapshot)
    expect(parseHolonEffectiveSnapshotIssuanceReceiptBytes(
      fixture.issuanceReceiptBytes,
      fixture.snapshot,
    )).toEqual(fixture.issuanceReceipt)

    expect(fixture.provenance).toEqual({
      issuerPackage: "holarchy-file-xnl-capsule",
      issuerPackageVersion: "0.2.0",
      sourceAuthorityId: authorityId,
      sourceRevision: "1",
      snapshotRef: fixture.snapshot.snapshotId,
      effectiveAt,
      issuedAt,
    })
    expect(fixture.digests).toEqual({
      authorityState: fixture.commitReceipt.stateDigest,
      snapshotTree: fixture.snapshot.treeDigest,
      snapshotBytes: sha256Digest(fixture.snapshotBytes),
      issuanceReceiptBytes: sha256Digest(fixture.issuanceReceiptBytes),
    })
    expect(fixture.snapshot.records).toHaveLength(12)
  })
})
