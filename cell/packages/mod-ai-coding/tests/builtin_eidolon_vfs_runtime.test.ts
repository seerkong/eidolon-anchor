import { describe, expect, it } from "bun:test"

import {
  BUILTIN_EIDOLON_VFS_ASSET_PATH,
  createEmbeddedBuiltinEidolonVfsAssetPort,
  createSourceBuiltinEidolonVfsAssetPort,
  loadBuiltinEidolonVfs,
  type EmbeddedBuiltinFile,
} from "../src/builtin-vfs"

function embeddedFile(bytes: Uint8Array, name = BUILTIN_EIDOLON_VFS_ASSET_PATH): EmbeddedBuiltinFile {
  const blob = new Blob([bytes]) as EmbeddedBuiltinFile
  Object.defineProperty(blob, "name", { value: name, enumerable: true })
  return blob
}

describe("Builtin Eidolon VFS runtime", () => {
  it("loads the canonical source snapshot without any physical workspace .eidolon", async () => {
    const builtin = await loadBuiltinEidolonVfs(createSourceBuiltinEidolonVfsAssetPort())
    expect(builtin.snapshot).toMatchObject({
      schemaVersion: "eidolon.builtin-vfs/v1",
      rootPath: "/.eidolon",
    })
    expect(builtin.snapshot.nodeCount).toBeGreaterThan(18)
    expect((await builtin.readPort.stat("/.eidolon/resources/Agents/CodeAgent.xnl"))?.kind).toBe("file")
    expect(new TextDecoder().decode(
      await builtin.readPort.readBytes("/.eidolon/resources/Agents/CodeAgent.xnl"),
    )).toContain("#eidolon.coding.CodeAgent")
  })

  it("uses one deserializer and exposes identical source and BunFS proofs", async () => {
    const sourcePort = createSourceBuiltinEidolonVfsAssetPort()
    const bytes = await sourcePort.readSnapshotBytes()
    const source = await loadBuiltinEidolonVfs(sourcePort)
    const embedded = await loadBuiltinEidolonVfs(
      createEmbeddedBuiltinEidolonVfsAssetPort([embeddedFile(bytes)]),
    )
    expect(embedded.snapshot).toEqual(source.snapshot)
    expect(await embedded.readPort.readDirectory("/.eidolon/resources"))
      .toEqual(await source.readPort.readDirectory("/.eidolon/resources"))
    expect(await embedded.readPort.readBytes("/.eidolon/resources/manifest.xnl"))
      .toEqual(await source.readPort.readBytes("/.eidolon/resources/manifest.xnl"))
  })

  it("fails closed for missing, duplicate, invalid or out-of-root input", async () => {
    expect(() => createEmbeddedBuiltinEidolonVfsAssetPort([])).toThrow("found 0")
    const source = createSourceBuiltinEidolonVfsAssetPort()
    const file = embeddedFile(await source.readSnapshotBytes())
    expect(() => createEmbeddedBuiltinEidolonVfsAssetPort([file, file])).toThrow("found 2")
    await expect(loadBuiltinEidolonVfs({
      source: "bunfs",
      async readSnapshotBytes() { return new Uint8Array([0xff]) },
    })).rejects.toThrow("not valid UTF-8")
    const builtin = await loadBuiltinEidolonVfs(source)
    await expect(builtin.readPort.stat("/outside")).rejects.toThrow("outside /.eidolon")
    await expect(builtin.readPort.readBytes("/.eidolon/resources/missing.xnl")).resolves.toBeUndefined()
  })

  it("does not expose mutable byte aliases", async () => {
    const builtin = await loadBuiltinEidolonVfs(createSourceBuiltinEidolonVfsAssetPort())
    const path = "/.eidolon/resources/manifest.xnl"
    const first = await builtin.readPort.readBytes(path)
    const original = first?.[0]
    if (first) first[0] = 0
    const second = await builtin.readPort.readBytes(path)
    expect(second?.[0]).toBe(original)
    expect(Object.isFrozen(builtin)).toBe(true)
    expect(Object.isFrozen(builtin.snapshot)).toBe(true)
  })
})
