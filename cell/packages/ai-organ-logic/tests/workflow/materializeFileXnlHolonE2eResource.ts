import { lstat, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { sha256Digest } from "halfcode-compiler.xnl/resource-core"

import type { FileXnlHolonIssuerFixture, FileXnlHolonIssuerFixtureInput } from "./fileXnlHolonIssuerFixture"
import { issueFileXnlOrganizationFixture } from "./fileXnlHolonIssuerFixture"
import type { FileXnlHolonE2eResourceConfig } from "./fileXnlHolonE2eScenario"

const encoder = new TextEncoder()

export interface MaterializeFileXnlHolonE2eResourceRuntime {
  readonly assertEmptyOutputRoot: (outputRoot: string) => Promise<void>
  readonly ensureDirectory: (outputRoot: string, relativePath: string) => Promise<void>
  readonly writeBytes: (outputRoot: string, relativePath: string, bytes: Uint8Array) => Promise<void>
  readonly listRegularFiles: (outputRoot: string) => Promise<readonly string[]>
  readonly issueOrganization: (input: FileXnlHolonIssuerFixtureInput) => Promise<FileXnlHolonIssuerFixture>
}

export interface MaterializeFileXnlHolonE2eResourceInput {
  readonly outputRoot: string
}

export interface MaterializedFileXnlHolonE2eResource {
  readonly schemaVersion: "eidolon.holon-e2e-resource/v1"
  readonly scenarioId: string
  readonly authorityId: string
  readonly revision: number
  readonly sequence: number
  readonly authorityStateDigest: string
  readonly snapshotId: string
  readonly snapshotTreeDigest: `sha256:${string}`
  readonly snapshotBytesDigest: `sha256:${string}`
  readonly issuanceReceiptBytesDigest: `sha256:${string}`
  readonly recordCount: number
  readonly generatorOwnedPaths: readonly string[]
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertRelativePath(relativePath: string): readonly string[] {
  if (relativePath.length === 0 || path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new Error("HOLON_E2E_RELATIVE_PATH_INVALID")
  }
  const segments = relativePath.split("/")
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("HOLON_E2E_RELATIVE_PATH_INVALID")
  }
  return segments
}

function resolveChild(outputRoot: string, relativePath: string): string {
  return path.join(outputRoot, ...assertRelativePath(relativePath))
}

async function listRegularFilesRecursive(root: string, current: string, output: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  entries.sort((left, right) => compareCodeUnits(left.name, right.name))
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name)
    const stat = await lstat(absolutePath)
    if (stat.isSymbolicLink()) throw new Error("HOLON_E2E_OUTPUT_SYMLINK_REJECTED")
    if (stat.isDirectory()) {
      await listRegularFilesRecursive(root, absolutePath, output)
      continue
    }
    if (!stat.isFile()) throw new Error("HOLON_E2E_OUTPUT_FILE_TYPE_REJECTED")
    output.push(path.relative(root, absolutePath).split(path.sep).join("/"))
  }
}

export function createNodeFileXnlHolonE2eResourceRuntime(): MaterializeFileXnlHolonE2eResourceRuntime {
  return Object.freeze({
    async assertEmptyOutputRoot(outputRoot: string): Promise<void> {
      if (!path.isAbsolute(outputRoot)) throw new Error("HOLON_E2E_OUTPUT_ROOT_NOT_ABSOLUTE")
      const stat = await lstat(outputRoot)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("HOLON_E2E_OUTPUT_ROOT_INVALID")
      if ((await readdir(outputRoot)).length !== 0) throw new Error("HOLON_E2E_OUTPUT_ROOT_NOT_EMPTY")
    },
    async ensureDirectory(outputRoot: string, relativePath: string): Promise<void> {
      await mkdir(resolveChild(outputRoot, relativePath), { recursive: true })
    },
    async writeBytes(outputRoot: string, relativePath: string, bytes: Uint8Array): Promise<void> {
      await writeFile(resolveChild(outputRoot, relativePath), bytes, { flag: "wx" })
    },
    async listRegularFiles(outputRoot: string): Promise<readonly string[]> {
      const result: string[] = []
      await listRegularFilesRecursive(outputRoot, outputRoot, result)
      return Object.freeze(result.sort(compareCodeUnits))
    },
    issueOrganization: issueFileXnlOrganizationFixture,
  })
}

function manifestBytes(manifest: Omit<MaterializedFileXnlHolonE2eResource, "generatorOwnedPaths">): Uint8Array {
  return encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`)
}

export async function materializeFileXnlHolonE2eResource(
  runtime: MaterializeFileXnlHolonE2eResourceRuntime,
  input: MaterializeFileXnlHolonE2eResourceInput,
  config: FileXnlHolonE2eResourceConfig,
): Promise<MaterializedFileXnlHolonE2eResource> {
  await runtime.assertEmptyOutputRoot(input.outputRoot)
  const scenario = config.scenario
  const fixture = await runtime.issueOrganization({
    authorityRoot: resolveChild(input.outputRoot, "authority"),
    authorityId: scenario.issuer.authorityId,
    expectedRevision: scenario.issuer.expectedRevision,
    tables: scenario.tables,
    executionId: scenario.issuer.executionId,
    executionInstant: scenario.issuer.executionInstant,
    rootHolonRef: scenario.issuer.rootHolonRef,
    effectiveAt: scenario.issuer.effectiveAt,
    issuedAt: scenario.issuer.issuedAt,
    projectionBounds: scenario.issuer.projectionBounds,
  })

  await runtime.ensureDirectory(input.outputRoot, "issued")
  await runtime.writeBytes(
    input.outputRoot,
    "issued/holon-effective-snapshot.json",
    fixture.snapshotBytes,
  )
  await runtime.writeBytes(
    input.outputRoot,
    "issued/issuance-receipt.json",
    fixture.issuanceReceiptBytes,
  )

  const manifest = Object.freeze({
    schemaVersion: "eidolon.holon-e2e-resource/v1" as const,
    scenarioId: scenario.scenarioId,
    authorityId: fixture.commitReceipt.authorityId,
    revision: fixture.commitReceipt.revision,
    sequence: fixture.commitReceipt.sequence,
    authorityStateDigest: fixture.commitReceipt.stateDigest,
    snapshotId: fixture.snapshot.snapshotId,
    snapshotTreeDigest: fixture.snapshot.treeDigest,
    snapshotBytesDigest: sha256Digest(fixture.snapshotBytes),
    issuanceReceiptBytesDigest: sha256Digest(fixture.issuanceReceiptBytes),
    recordCount: fixture.snapshot.records.length,
  })
  await runtime.writeBytes(input.outputRoot, "manifest.json", manifestBytes(manifest))

  return Object.freeze({
    ...manifest,
    generatorOwnedPaths: await runtime.listRegularFiles(input.outputRoot),
  })
}

export async function listFileXnlHolonE2eGeneratorOwnedPaths(root: string): Promise<readonly string[]> {
  const paths = await createNodeFileXnlHolonE2eResourceRuntime().listRegularFiles(root)
  return Object.freeze(paths.filter((relativePath) => relativePath !== "README.md"))
}
