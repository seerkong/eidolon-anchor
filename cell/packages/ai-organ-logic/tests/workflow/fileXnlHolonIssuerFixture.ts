import {
  canonicalHolonEffectiveSnapshotIssuanceReceiptBytes,
  type HolonAuthorityCommitReceipt,
  type HolonAuthoritySnapshot,
  type HolonEffectiveSnapshot,
  type HolonEffectiveSnapshotIssuanceReceipt,
  type ProjectOrganizationSnapshotConfig,
} from "holarchy-core-contract"
import { commitOrganizationChangeSet, diffOrganizationStates, parseOrganizationState } from "holarchy-core-logic"
import { issueOrganizationFixture, type SyntheticOrganizationFixture } from "holarchy-test-support"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseHolarchyXnlHeadBytes, parseHolarchyXnlReceiptBytes } from "holarchy-file-xnl-logic"
import { HolarchyFileXnlCapsule } from "holarchy-file-xnl-capsule"
import { sha256Digest } from "halfcode-compiler.xnl/resource-core"

export interface FileXnlHolonIssuerFixtureInput {
  readonly authorityRoot: string
  readonly authorityId: string
  readonly expectedRevision: number
  readonly fixture: SyntheticOrganizationFixture
  readonly executionId: string
  readonly executionInstant: string
  readonly rootHolonRef: string
  readonly effectiveAt: string
  readonly issuedAt: string
  readonly projectionBounds: ProjectOrganizationSnapshotConfig
}

export interface FileXnlHolonIssuerProvenance {
  readonly issuerPackage: "holarchy-file-xnl-capsule"
  readonly issuerPackageVersion: string
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
  const issuerPackageVersion = await installedHolarchyIssuerVersion()
  const authorization = { resolveScope: async () => ({ kind: "all" as const }) }
  const writer = new HolarchyFileXnlCapsule({ root: input.authorityRoot, authorityId: input.authorityId, authorization })
  const initial = await writer.start()
  if (initial.revision !== input.expectedRevision) throw new Error("FILE_XNL_ISSUER_STALE_REVISION")
  if (input.fixture.state.authorityId !== input.authorityId || input.fixture.rootHolonId !== input.rootHolonRef) {
    throw new Error("FILE_XNL_ISSUER_FIXTURE_IDENTITY_MISMATCH")
  }
  let actualCommitReceipt: HolonAuthorityCommitReceipt | undefined
  const authoring = { authorization, store: {
    load: () => writer.store.load(),
    compareAndSwap: async (request: Parameters<typeof writer.store.compareAndSwap>[0]) => {
      const receipt = await writer.store.compareAndSwap(request)
      actualCommitReceipt = receipt
      return receipt
    },
  } }
  const config = { actorRef: "fixture-issuer", executionId: input.executionId, executionInstant: input.executionInstant }
  let reconstructedAuthority: HolonAuthoritySnapshot | undefined
  const project = async () => {
    const issuer = new HolarchyFileXnlCapsule({ root: input.authorityRoot, authorityId: input.authorityId, observedAt: () => input.issuedAt, authorization })
    reconstructedAuthority = await issuer.start()
    return issuer.projectOrganizationSnapshot({ rootHolonRef: input.rootHolonRef, effectiveAt: input.effectiveAt }, input.projectionBounds)
  }
  const issued = input.expectedRevision === 0
    ? await issueOrganizationFixture({
      loadOrganizationState: request => writer.loadOrganizationState(request),
      commitOrganizationChangeSet: (request, commandConfig) => commitOrganizationChangeSet(authoring, request, commandConfig),
      projectOrganizationSnapshot: project,
    }, { fixture: input.fixture, config, effectiveAt: input.effectiveAt, bounds: input.projectionBounds, issuerPackageVersion, seedId: input.executionId })
    : await (async () => {
      const current = await writer.loadOrganizationState({ authorityId: input.authorityId, effectiveDate: input.fixture.state.effectiveDate })
      // Existing stable identities retain their history. A newly issued root may
      // coexist with an older root that remains frozen in existing task proofs.
      const entities = new Map(current.entities.map(entity => [entity.id, entity]))
      for (const entity of input.fixture.state.entities) entities.set(entity.id, entity)
      const desired = parseOrganizationState({ ...current, entities: [...entities.values()] })
      const changeSet = diffOrganizationStates(current, desired, input.executionId)
      await commitOrganizationChangeSet(authoring, changeSet, config)
      return project()
    })()
  if (!actualCommitReceipt) {
    const head = parseHolarchyXnlHeadBytes(await readFile(path.join(input.authorityRoot, "head.xnl")))
    const receipt = parseHolarchyXnlReceiptBytes(await readFile(path.join(input.authorityRoot, "receipts", `${String(initial.revision).padStart(12, "0")}.xnl`)), head.receiptDigest)
    actualCommitReceipt = receipt
  }
  const commitReceipt = actualCommitReceipt
  if (!commitReceipt || !reconstructedAuthority || reconstructedAuthority.revision !== commitReceipt.revision
    || reconstructedAuthority.authorityId !== commitReceipt.authorityId) throw new Error("FILE_XNL_ISSUER_RECONSTRUCTION_MISMATCH")
  const issuanceReceiptBytes = canonicalHolonEffectiveSnapshotIssuanceReceiptBytes(issued.issuanceReceipt, issued.snapshot)
  const provenance = Object.freeze({
    issuerPackage: "holarchy-file-xnl-capsule" as const,
    issuerPackageVersion,
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

/** Resolve the installed public entry; provenance never invents a package version. */
export async function installedHolarchyIssuerVersion(): Promise<string> {
  const entry = fileURLToPath(import.meta.resolve("holarchy-file-xnl-capsule"))
  let directory = path.dirname(entry)
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))
      if (manifest.name === "holarchy-file-xnl-capsule" && typeof manifest.version === "string") return manifest.version
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    directory = path.dirname(directory)
  }
  throw new Error("FILE_XNL_ISSUER_PACKAGE_VERSION_UNAVAILABLE")
}
