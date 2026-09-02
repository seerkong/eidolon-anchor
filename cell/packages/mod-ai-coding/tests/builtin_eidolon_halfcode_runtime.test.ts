import { describe, expect, it } from "bun:test"

import {
  createEmbeddedBuiltinEidolonVfsAssetPort,
  createSourceBuiltinEidolonVfsAssetPort,
  loadBuiltinEidolonResourceTree,
  type EmbeddedBuiltinFile,
} from "../src/builtin-vfs"

function comparableTree(value: Awaited<ReturnType<typeof loadBuiltinEidolonResourceTree>>) {
  return {
    snapshot: value.builtin.snapshot,
    manifest: value.tree.manifest,
    byKind: [...value.tree.registry.byKind.entries()],
    kindDefinitions: [...value.tree.registry.kindDefinitions.entries()],
    contentIdentities: [...value.tree.contentIdentities.entries()],
  }
}

describe("Builtin Eidolon VFS Halfcode read port", () => {
  it("loads the same closed mature Coding Agent tree from source and embedded bytes", async () => {
    const sourcePort = createSourceBuiltinEidolonVfsAssetPort()
    const bytes = await sourcePort.readSnapshotBytes()
    const blob = new Blob([bytes]) as EmbeddedBuiltinFile
    Object.defineProperty(blob, "name", {
      value: "eidolon-builtin/GeneratedBuiltinEidolonVfsSnapshot.xnl",
    })

    const source = await loadBuiltinEidolonResourceTree(sourcePort)
    const embedded = await loadBuiltinEidolonResourceTree(
      createEmbeddedBuiltinEidolonVfsAssetPort([blob]),
    )
    const agents = source.tree.registry.byKind.get("AIAgentDefinition") ?? []

    expect(comparableTree(embedded)).toEqual(comparableTree(source))
    expect(agents.map((record) => record.resourceId)).toEqual(["eidolon.coding.CodeAgent"])
    expect(source.tree.contentIdentities.get("eidolon.coding.CodeAgent")?.contentDigest)
      .toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(source.tree.diagnostics).toEqual([])
  })
})
