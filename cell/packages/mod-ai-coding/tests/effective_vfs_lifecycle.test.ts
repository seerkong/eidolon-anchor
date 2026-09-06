import { expect, it, spyOn } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { prepareEffectiveEidolonVfs, loadBuiltinEidolonVfs } from "@cell/mod-ai-coding/builtin-vfs"
import { LocalFileEffectiveEidolonVfsAuthority } from "@cell/ai-support/runtime/LocalFileEffectiveEidolonVfsAuthority"

it("closes the owned SQLite backend when bootstrap fails before returning, and keeps caller-owned backends open", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "effective-vfs-lifetime-"))
  const home = path.join(root, "home"), workspace = path.join(root, "workspace")
  await mkdir(home)
  await mkdir(path.join(workspace, "resources"), { recursive: true })
  await writeFile(path.join(workspace, "resources", "manifest.xnl"), "invalid ResourcePackage")
  const close = spyOn(LocalFileEffectiveEidolonVfsAuthority.prototype, "close")
  try {
    await expect(prepareEffectiveEidolonVfs({ homeEidolonRoot: home, workspaceEidolonRoot: workspace })).rejects.toThrow()
    expect(close).toHaveBeenCalledTimes(1)
    const builtin = await loadBuiltinEidolonVfs()
    const injected = new LocalFileEffectiveEidolonVfsAuthority({ databasePath: path.join(root, "injected.sqlite"), workspaceEidolonRoot: workspace, builtinSnapshot: builtin.vfsSnapshot })
    await expect(prepareEffectiveEidolonVfs({ homeEidolonRoot: home, workspaceEidolonRoot: workspace, publicationAuthority: injected })).rejects.toThrow()
    expect(close).toHaveBeenCalledTimes(1)
    injected.close()
  } finally { close.mockRestore(); await rm(root, { recursive: true, force: true }) }
})

it("closes an owned successful bootstrap once when dispose repeats", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "effective-vfs-dispose-"))
  const home = path.join(root, "home"), workspace = path.join(root, "workspace")
  await mkdir(home); await mkdir(workspace)
  const close = spyOn(LocalFileEffectiveEidolonVfsAuthority.prototype, "close")
  try {
    const runtime = await prepareEffectiveEidolonVfs({ homeEidolonRoot: home, workspaceEidolonRoot: workspace })
    runtime.dispose(); runtime.dispose()
    expect(close).toHaveBeenCalledTimes(1)
    const builtin = await loadBuiltinEidolonVfs()
    const injected = new LocalFileEffectiveEidolonVfsAuthority({ databasePath: path.join(root, "injected.sqlite"), workspaceEidolonRoot: workspace, builtinSnapshot: builtin.vfsSnapshot })
    const callerOwned = await prepareEffectiveEidolonVfs({ homeEidolonRoot: home, workspaceEidolonRoot: workspace, publicationAuthority: injected })
    callerOwned.dispose(); callerOwned.dispose()
    expect(close).toHaveBeenCalledTimes(1)
    expect(injected.read().revision.authorityId).toBe("eidolon-effective-vfs")
    injected.close()
  } finally { close.mockRestore(); await rm(root, { recursive: true, force: true }) }
})
