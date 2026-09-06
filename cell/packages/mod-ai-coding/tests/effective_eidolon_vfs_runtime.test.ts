import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { prepareEffectiveEidolonVfs } from "@cell/mod-ai-coding/builtin-vfs"
import { loadBuiltinEidolonVfs } from "@cell/mod-ai-coding/builtin-vfs"
import { LocalFileEffectiveEidolonVfsAuthority } from "@cell/ai-support/runtime/LocalFileEffectiveEidolonVfsAuthority"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("production Effective Eidolon VFS preparation", () => {
  it("restores a committed projection before reading overlays and updates an existing builtin node by its actual identity", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "eidolon-effective-recover-")); roots.push(parent)
    const home = path.join(parent, "home"); const workspace = path.join(parent, "workspace")
    await mkdir(home); await mkdir(workspace)
    const builtin = await loadBuiltinEidolonVfs()
    const options = { databasePath: path.join(parent, "authority.sqlite"), workspaceEidolonRoot: workspace, builtinSnapshot: builtin.vfsSnapshot }
    let fail = false
    const authority = new LocalFileEffectiveEidolonVfsAuthority({ ...options, afterCommit(record) { if (fail && record.association) throw new Error("after-head") } })
    const runtime = await prepareEffectiveEidolonVfs({ homeEidolonRoot: home, workspaceEidolonRoot: workspace, publicationAuthority: authority })
    const logicalPath = "/.eidolon/resources/Agents/CodeAgent.xnl" as const
    const original = new TextDecoder().decode(await runtime.effective.readPort.readBytes(logicalPath))
    const revised = `${original}\n`
    const candidate = await runtime.authoring.prepare({ expectedCurrentRevision: runtime.authoring.read().snapshot.revision, logicalPath, authorityText: revised })
    expect(candidate.status).toBe("prepared"); if (candidate.status !== "prepared") throw new Error("prepare")
    expect((await candidate.candidate.effective.readPort.stat(logicalPath))?.nodeId).toBe((await runtime.effective.readPort.stat(logicalPath))?.nodeId)
    fail = true
    await expect(runtime.authoring.admit(candidate.candidate, { transactionId: "bootstrap-tx", planDigest: "plan", receiptDigest: "receipt" }, { logicalPath, before: { state: "absent" }, authorityText: revised })).rejects.toThrow("after-head")
    const proof = await runtime.authoring.lookupPublication("bootstrap-tx"); expect(proof).toBeDefined()
    await expect(readFile(path.join(workspace, "resources/Agents/CodeAgent.xnl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    authority.close()
    const reopened = new LocalFileEffectiveEidolonVfsAuthority(options)
    const recovered = await prepareEffectiveEidolonVfs({ homeEidolonRoot: home, workspaceEidolonRoot: workspace, publicationAuthority: reopened })
    expect(new TextDecoder().decode(await recovered.effective.readPort.readBytes(logicalPath))).toBe(revised)
    expect(await recovered.authoring.lookupPublication("bootstrap-tx")).toEqual(proof)
    reopened.close()
  })
  it("materializes Builtin then home then workspace before exposing one read port", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "eidolon-effective-runtime-"))
    roots.push(parent)
    const home = path.join(parent, "home")
    const workspace = path.join(parent, "workspace")
    await mkdir(home)
    await mkdir(workspace)
    await writeFile(path.join(home, "runtime-config.json"), "home")
    await writeFile(path.join(workspace, "runtime-config.json"), "workspace")

    const prepared = await prepareEffectiveEidolonVfs({
      homeEidolonRoot: home,
      workspaceEidolonRoot: workspace,
    })

    expect(new TextDecoder().decode(
      await prepared.effective.readPort.readBytes("/.eidolon/runtime-config.json"),
    )).toBe("workspace")
    expect(prepared.effective.snapshot.overlays.map(({ kind }) => kind)).toEqual(["home", "workspace"])
    expect(await prepared.effective.readPort.stat("/.eidolon/resources/Agents/CodeAgent.xnl")).toBeDefined()
  })

  it("treats a workspace ResourcePackage manifest as whole-package replacement", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "eidolon-effective-package-replacement-"))
    roots.push(parent)
    const home = path.join(parent, "home")
    const workspace = path.join(parent, "workspace")
    await mkdir(home)
    await mkdir(path.join(workspace, "resources"), { recursive: true })
    await writeFile(
      path.join(workspace, "resources", "manifest.xnl"),
      `<ResourcePackage #fixture.workspace.package envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Active" packageVersion = "1.0.0" } ( <Catalogs []> )>\n`,
    )

    const prepared = await prepareEffectiveEidolonVfs({
      homeEidolonRoot: home,
      workspaceEidolonRoot: workspace,
    })

    expect(await prepared.effective.readPort.stat("/.eidolon/resources/manifest.xnl")).toBeDefined()
    expect(await prepared.effective.readPort.stat("/.eidolon/resources/Agents/CodeAgent.xnl")).toBeUndefined()
    expect(prepared.effective.snapshot.overlays.map(({ id }) => id)).toEqual([
      "home-directory",
      "workspace-directory-resource-package-replacement",
      "workspace-directory",
    ])
  })
})
