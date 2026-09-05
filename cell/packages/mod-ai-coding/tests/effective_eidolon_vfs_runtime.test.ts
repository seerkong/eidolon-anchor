import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { prepareEffectiveEidolonVfs } from "@cell/mod-ai-coding/builtin-vfs"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("production Effective Eidolon VFS preparation", () => {
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
