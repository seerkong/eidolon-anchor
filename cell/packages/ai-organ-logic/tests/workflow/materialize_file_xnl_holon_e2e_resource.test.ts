import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  parseHolonEffectiveSnapshotBytes,
  parseHolonEffectiveSnapshotIssuanceReceiptBytes,
} from "holarchy-core-contract"
import { HolarchyFileXnlCapsule } from "holarchy-file-xnl-capsule"

import {
  FILE_XNL_HOLON_E2E_RESOURCE_CONFIG,
  FILE_XNL_HOLON_E2E_SCENARIO,
} from "./fileXnlHolonE2eScenario"
import {
  createNodeFileXnlHolonE2eResourceRuntime,
  listFileXnlHolonE2eGeneratorOwnedPaths,
  materializeFileXnlHolonE2eResource,
} from "./materializeFileXnlHolonE2eResource"

const temporaryRoots: string[] = []
const committedRoot = path.resolve(import.meta.dir, "../resources/holon-task-e2e")

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryEmptyRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-e2e-resource-"))
  temporaryRoots.push(root)
  return root
}

describe("inspectable File-XNL Holon E2E resource", () => {
  it("materializes through the runtime-first Processor and rejects a non-empty root", async () => {
    expect(Object.isFrozen(FILE_XNL_HOLON_E2E_SCENARIO)).toBe(true)
    expect(Object.isFrozen(FILE_XNL_HOLON_E2E_SCENARIO.tables.MemberVersion)).toBe(true)
    expect(Object.isFrozen(FILE_XNL_HOLON_E2E_SCENARIO.tables.MemberVersion[0])).toBe(true)
    const root = await temporaryEmptyRoot()
    const result = await materializeFileXnlHolonE2eResource(
      createNodeFileXnlHolonE2eResourceRuntime(),
      { outputRoot: root },
      FILE_XNL_HOLON_E2E_RESOURCE_CONFIG,
    )

    expect(result).toMatchObject({
      schemaVersion: "eidolon.holon-e2e-resource/v1",
      scenarioId: FILE_XNL_HOLON_E2E_SCENARIO.scenarioId,
      authorityId: FILE_XNL_HOLON_E2E_SCENARIO.issuer.authorityId,
      revision: 1,
      recordCount: 12,
    })
    expect(JSON.stringify(result)).not.toContain(root)

    const occupied = await temporaryEmptyRoot()
    await writeFile(path.join(occupied, "sentinel.txt"), "keep\n", "utf8")
    await expect(materializeFileXnlHolonE2eResource(
      createNodeFileXnlHolonE2eResourceRuntime(),
      { outputRoot: occupied },
      FILE_XNL_HOLON_E2E_RESOURCE_CONFIG,
    )).rejects.toThrow("HOLON_E2E_OUTPUT_ROOT_NOT_EMPTY")
    expect(await readFile(path.join(occupied, "sentinel.txt"), "utf8")).toBe("keep\n")
  })

  it("regenerates the committed path set and bytes exactly", async () => {
    const candidate = await temporaryEmptyRoot()
    await materializeFileXnlHolonE2eResource(
      createNodeFileXnlHolonE2eResourceRuntime(),
      { outputRoot: candidate },
      FILE_XNL_HOLON_E2E_RESOURCE_CONFIG,
    )

    const expectedPaths = await listFileXnlHolonE2eGeneratorOwnedPaths(committedRoot)
    const actualPaths = await listFileXnlHolonE2eGeneratorOwnedPaths(candidate)
    expect(actualPaths).toEqual(expectedPaths)
    for (const relativePath of expectedPaths) {
      expect(await readFile(path.join(candidate, relativePath))).toEqual(
        await readFile(path.join(committedRoot, relativePath)),
      )
    }
  })

  it("freshly reconstructs the generated authority and parses the issued proof", async () => {
    const candidate = await temporaryEmptyRoot()
    const result = await materializeFileXnlHolonE2eResource(
      createNodeFileXnlHolonE2eResourceRuntime(),
      { outputRoot: candidate },
      FILE_XNL_HOLON_E2E_RESOURCE_CONFIG,
    )
    const capsule = new HolarchyFileXnlCapsule({
      root: path.join(candidate, "authority"),
      authorityId: result.authorityId,
      observedAt: () => FILE_XNL_HOLON_E2E_SCENARIO.issuer.issuedAt,
    })
    const reconstructed = await capsule.start()
    const snapshotBytes = await readFile(path.join(candidate, "issued/holon-effective-snapshot.json"))
    const snapshot = await parseHolonEffectiveSnapshotBytes(snapshotBytes)
    const receiptBytes = await readFile(path.join(candidate, "issued/issuance-receipt.json"))
    const receipt = parseHolonEffectiveSnapshotIssuanceReceiptBytes(receiptBytes, snapshot)

    expect(reconstructed).toMatchObject({ authorityId: result.authorityId, revision: 1 })
    expect(snapshot.records).toHaveLength(12)
    expect(snapshot.treeDigest).toBe(result.snapshotTreeDigest)
    expect(receipt.snapshotRef).toBe(snapshot.snapshotId)
    expect(receipt.sourceRevision).toBe("1")
  })

  it("contains no host path or runtime-private Agent data", async () => {
    const candidate = await temporaryEmptyRoot()
    await materializeFileXnlHolonE2eResource(
      createNodeFileXnlHolonE2eResourceRuntime(),
      { outputRoot: candidate },
      FILE_XNL_HOLON_E2E_RESOURCE_CONFIG,
    )
    await mkdir(path.join(candidate, "unused"))
    const paths = await listFileXnlHolonE2eGeneratorOwnedPaths(candidate)
    const text = (await Promise.all(paths.map((relativePath) => readFile(path.join(candidate, relativePath), "utf8")))).join("\n")
    expect(text).not.toMatch(/\/Users\/|\/private\/tmp\/|[A-Za-z]:\\/)
    expect(text).not.toMatch(/prompt|reasoning|providerConfig|actorSnapshot|mailbox|conversationHistory/i)
  })
})
