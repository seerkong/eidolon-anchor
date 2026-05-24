import { afterEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { configureLocalPermissionConfigStore } from "@cell/ai-organ-logic"
import { LocalFilePermissionConfigStore } from "@cell/ai-support"
import { buildBuiltinToolDefs } from "../ToolFuncBuiltin"
import { applyPatchCoreLogic } from "./ApplyPatch/Logic"
import { editCoreLogic, trimDiff } from "./Edit/Logic"
import { globCoreLogic } from "./Glob/Logic"
import { grepCoreLogic } from "./Grep/Logic"
import { lsCoreLogic } from "./Ls/Logic"
import { readCoreLogic } from "./Read/Logic"
import { writeCoreLogic } from "./Write/Logic"
import { expandHomePath, resolveToolPath } from "./_shared"

const tempRoots: string[] = []

configureLocalPermissionConfigStore(LocalFilePermissionConfigStore)

function makeRuntime(workDir: string, authorityRoot?: string) {
  return {
    vm: {
      outerCtx: {
        workDir,
        metadata: authorityRoot
          ? {
              local_permissions: {
                authority_root: authorityRoot,
              },
            }
          : undefined,
      },
    },
  } as any
}

function makeSandboxDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "organ-file-tool-"))
  tempRoots.push(root)
  const workDir = path.join(root, "workspace")
  const externalDir = path.join(root, "outside")
  fs.mkdirSync(workDir, { recursive: true })
  fs.mkdirSync(externalDir, { recursive: true })
  return {
    workDir,
    externalFile: path.join(externalDir, "note.txt"),
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("file tool path access", () => {
  it("does not expose duplicate *_file tool variants", () => {
    const names = buildBuiltinToolDefs({ includeInternalOnly: false }).map((def) => def.schema.function.name)
    expect(names).toContain("read")
    expect(names).toContain("write")
    expect(names).toContain("edit")
    expect(names).not.toContain("read_file")
    expect(names).not.toContain("write_file")
    expect(names).not.toContain("edit_file")
  })

  it("expands ~/ paths using the current home directory", () => {
    const home = process.env.HOME
    expect(home).toBeString()
    expect(expandHomePath("~/tmp/demo3/AGENTS.md")).toBe(path.join(home!, "tmp/demo3/AGENTS.md"))
    expect(resolveToolPath("/repo/worktree", "~/tmp/demo3/AGENTS.md")).toBe(path.join(home!, "tmp/demo3/AGENTS.md"))
  })

  it("denies absolute paths outside workDir when workspace access is missing", async () => {
    const { workDir, externalFile } = makeSandboxDirs()
    const authorityRoot = path.join(path.dirname(workDir), ".eidolon")
    fs.mkdirSync(authorityRoot, { recursive: true })
    const runtime = makeRuntime(workDir, authorityRoot)

    expect(await writeCoreLogic(runtime, { filePath: externalFile, content: "first\nsecond" } as any, {} as any)).toBe(
      `Error: Path is outside workspace access map: ${externalFile}`,
    )
  })

  it("normalizes ~/ paths for ls and denies unauthorized external directory reads", async () => {
    const home = process.env.HOME
    expect(home).toBeString()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "organ-ls-home-"))
    tempRoots.push(root)
    const runtime = makeRuntime("/repo/worktree")
    const deniedPath = "~/tmp/demo5"
    const resolvedDeniedPath = path.join(home!, "tmp/demo5")
    const authorityRoot = path.join(root, ".eidolon")
    fs.mkdirSync(authorityRoot, { recursive: true })
    ;(runtime as any).vm.outerCtx.metadata = {
      local_permissions: {
        authority_root: authorityRoot,
      },
    }

    expect(await lsCoreLogic(runtime, { path: deniedPath } as any, {} as any)).toBe(
      `Error: Path is outside workspace access map: ${resolvedDeniedPath}`,
    )
  })

  it("applies read permission gate to glob and grep", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "organ-read-gate-"))
    tempRoots.push(root)
    const workDir = path.join(root, "workspace")
    const authorityRoot = path.join(root, ".eidolon")
    fs.mkdirSync(path.join(workDir, "docs"), { recursive: true })
    fs.mkdirSync(authorityRoot, { recursive: true })
    fs.writeFileSync(path.join(workDir, "docs", "a.txt"), "hello\n")
    fs.writeFileSync(
      path.join(authorityRoot, "permissions.json"),
      JSON.stringify(
        {
          permission: {
            "*": "deny",
            read: {
              "docs": "deny",
              "docs/*": "allow",
            },
          },
        },
        null,
        2,
      ),
    )
    const runtime = makeRuntime(workDir, authorityRoot)

    expect(await globCoreLogic(runtime, { path: "docs", pattern: "*.txt" } as any, {} as any)).toBe(
      "Error: local permission denied for read path: docs",
    )
    expect(await grepCoreLogic(runtime, { path: "docs", pattern: "hello" } as any, {} as any)).toBe(
      "Error: local permission denied for read path: docs",
    )
  })

  it("allows absolute paths outside workDir when workspace access grants write", async () => {
    const { workDir, externalFile } = makeSandboxDirs()
    const authorityRoot = path.join(path.dirname(workDir), ".eidolon")
    fs.mkdirSync(authorityRoot, { recursive: true })
    fs.writeFileSync(
      path.join(authorityRoot, "workspace-access.json"),
      JSON.stringify(
        {
          workspaces: {
            [workDir]: {
              entries: [
                {
                  path: path.dirname(externalFile),
                  permissions: ["read", "write"],
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    )
    const runtime = makeRuntime(workDir, authorityRoot)

    expect(await writeCoreLogic(runtime, { filePath: externalFile, content: "first\nsecond" } as any, {} as any)).toBe(
      "Wrote file successfully.",
    )
    expect(await readCoreLogic(runtime, { filePath: externalFile, offset: 1, limit: 10 } as any, {} as any)).toBe(
      "1: first\n2: second",
    )
    const editResult = await editCoreLogic(
      runtime,
      { filePath: externalFile, oldString: "second", newString: "third" } as any,
      {} as any,
    )
    const parsed = JSON.parse(editResult)
    expect(parsed).toMatchObject({
      message: `Edited ${externalFile}`,
    })
    expect(trimDiff(parsed.diff)).toBe(
      trimDiff(`--- ${externalFile}
+++ ${externalFile}
@@ -1,2 +1,2 @@
 first
-second
+third`),
    )
    expect(fs.readFileSync(externalFile, "utf-8")).toBe("first\nthird")
  })

  it("applies workspace access checks to apply_patch and supports absolute paths", async () => {
    const { workDir, externalFile } = makeSandboxDirs()
    const authorityRoot = path.join(path.dirname(workDir), ".eidolon")
    fs.mkdirSync(authorityRoot, { recursive: true })
    fs.writeFileSync(externalFile, "before\n", "utf-8")
    const runtime = makeRuntime(workDir, authorityRoot)

    expect(
      await applyPatchCoreLogic(
        runtime,
        {
          patchText: `*** Begin Patch\n*** Update File: ${externalFile}\n@@\n-before\n+after\n*** End Patch\n`,
        } as any,
        {} as any,
      ),
    ).toBe(`Error: Path is outside workspace access map: ${externalFile}`)

    fs.writeFileSync(
      path.join(authorityRoot, "workspace-access.json"),
      JSON.stringify(
        {
          workspaces: {
            [workDir]: {
              entries: [
                {
                  path: path.dirname(externalFile),
                  permissions: ["read", "write"],
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    )

    const allowed = JSON.parse(
      await applyPatchCoreLogic(
        runtime,
        {
          patchText: `*** Begin Patch\n*** Update File: ${externalFile}\n@@\n-before\n+after\n*** End Patch\n`,
        } as any,
        {} as any,
      ),
    )
    expect(allowed).toMatchObject({
      message: "Patch applied successfully (1 operation).",
    })
    expect(trimDiff(allowed.diff)).toBe(
      trimDiff(
        [
          `--- ${externalFile}`,
          `+++ ${externalFile}`,
          "@@ -1,2 +1,2 @@",
          "-before",
          "+after",
          " ",
        ].join("\n"),
      ),
    )
    expect(fs.readFileSync(externalFile, "utf-8")).toBe("after\n")
  })

  it("returns structured apply_patch failures with recovery hints", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "organ-apply-patch-failure-"))
    tempRoots.push(root)
    const workDir = path.join(root, "workspace")
    fs.mkdirSync(workDir, { recursive: true })
    fs.writeFileSync(path.join(workDir, "demo.txt"), "before\n", "utf-8")
    const runtime = makeRuntime(workDir)

    const output = await applyPatchCoreLogic(
      runtime,
      {
        patchText: `*** Begin Patch\n*** Update File: demo.txt\n@@\n-missing\n+after\n*** End Patch\n`,
      } as any,
      {} as any,
    )

    const parsed = JSON.parse(String(output))
    expect(parsed).toMatchObject({
      message: "Patch could not be applied to demo.txt: update hunk not found in demo.txt",
      filePath: "demo.txt",
      error: "patch_failed",
      detail: "update hunk not found in demo.txt",
    })
    expect(parsed.suggestions).toEqual([
      "Read the target file again and copy the exact current hunk, including unchanged context lines.",
      "Reduce the patch to a smaller single-hunk change after confirming the current file contents.",
      "If the file changed since the patch was drafted, rebuild the patch from a fresh read before retrying.",
    ])
  })
})
