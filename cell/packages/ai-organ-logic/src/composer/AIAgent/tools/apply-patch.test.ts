import { afterEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { configureLocalPermissionConfigStore } from "@cell/ai-organ-logic"
import { LocalFilePermissionConfigStore } from "@cell/ai-support"
import { applyPatchCoreLogic } from "./ApplyPatch/Logic"
import { trimDiff } from "./Edit/Logic"

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

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "organ-apply-patch-"))
  tempRoots.push(root)
  const workDir = path.join(root, "workspace")
  fs.mkdirSync(workDir, { recursive: true })
  return { root, workDir, runtime: makeRuntime(workDir) }
}

async function runPatch(workDir: string, patchText: string) {
  const runtime = makeRuntime(workDir)
  return JSON.parse(
    await applyPatchCoreLogic(
      runtime,
      {
        patchText,
      } as any,
      {} as any,
    ),
  )
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("apply_patch structured editing", () => {
  it("applies add/update/delete/move patches and returns diff plus structured metadata", async () => {
    const { workDir } = makeSandbox()
    fs.writeFileSync(path.join(workDir, "update.txt"), "old\n", "utf-8")
    fs.writeFileSync(path.join(workDir, "delete.txt"), "remove me\n", "utf-8")
    fs.writeFileSync(path.join(workDir, "move.txt"), "move me\n", "utf-8")

    const parsed = await runPatch(
      workDir,
      `*** Begin Patch
*** Add File: add.txt
+created
*** Update File: update.txt
@@
-old
+new
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: moved.txt
@@
-move me
+move done
*** End Patch
`,
    )

    expect(parsed).toMatchObject({
      ok: true,
      message: "Patch applied successfully (4 operations).",
      touched_files: ["add.txt", "update.txt", "delete.txt", "move.txt", "moved.txt"],
      added_count: 1,
      updated_count: 1,
      deleted_count: 1,
      moved_count: 1,
      match_modes_used: ["exact"],
    })
    expect(parsed.touched_files_absolute).toContain(path.join(workDir, "update.txt"))
    expect(parsed.context_refresh_hint).toContain("Files changed by apply_patch")
    expect(trimDiff(parsed.diff)).toContain("--- update.txt")
    expect(fs.readFileSync(path.join(workDir, "add.txt"), "utf-8")).toBe("created\n")
    expect(fs.readFileSync(path.join(workDir, "update.txt"), "utf-8")).toBe("new\n")
    expect(fs.existsSync(path.join(workDir, "delete.txt"))).toBe(false)
    expect(fs.existsSync(path.join(workDir, "move.txt"))).toBe(false)
    expect(fs.readFileSync(path.join(workDir, "moved.txt"), "utf-8")).toBe("move done\n")
  })

  it("rejects malformed or empty patch envelopes without mutating files", async () => {
    const { workDir } = makeSandbox()
    fs.writeFileSync(path.join(workDir, "demo.txt"), "before\n", "utf-8")

    const parsed = await runPatch(workDir, "*** Begin Patch\n*** End Patch\n")

    expect(parsed).toMatchObject({
      error: "patch_failed",
      detail: "patch must contain at least one file operation",
    })
    expect(fs.readFileSync(path.join(workDir, "demo.txt"), "utf-8")).toBe("before\n")
  })

  it("uses named and consecutive anchors to place hunks in the intended region", async () => {
    const { workDir } = makeSandbox()
    fs.writeFileSync(
      path.join(workDir, "demo.ts"),
      [
        "class First {",
        "  run() {",
        "    return value",
        "  }",
        "}",
        "class Target {",
        "  run() {",
        "    return value",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    )

    const parsed = await runPatch(
      workDir,
      `*** Begin Patch
*** Update File: demo.ts
@@ class Target
@@   run() {
-    return value
+    return changed
*** End Patch
`,
    )

    expect(parsed.match_modes_used).toEqual(["anchored_exact"])
    expect(fs.readFileSync(path.join(workDir, "demo.ts"), "utf-8")).toBe(
      [
        "class First {",
        "  run() {",
        "    return value",
        "  }",
        "}",
        "class Target {",
        "  run() {",
        "    return changed",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
  })

  it("uses normalized and fuzzy matching only when the candidate is unique", async () => {
    const { workDir } = makeSandbox()
    fs.writeFileSync(path.join(workDir, "normalized.txt"), "alpha   \nbeta\n", "utf-8")
    fs.writeFileSync(path.join(workDir, "fuzzy.txt"), "call(  one,   two )\n", "utf-8")

    const normalized = await runPatch(
      workDir,
      `*** Begin Patch
*** Update File: normalized.txt
@@
-alpha
+alpha changed
*** End Patch
`,
    )
    expect(normalized.match_modes_used).toEqual(["normalized"])
    expect(fs.readFileSync(path.join(workDir, "normalized.txt"), "utf-8")).toBe("alpha changed\nbeta\n")

    const fuzzy = await runPatch(
      workDir,
      `*** Begin Patch
*** Update File: fuzzy.txt
@@
-call(one,two)
+call(done)
*** End Patch
`,
    )
    expect(fuzzy.match_modes_used).toEqual(["fuzzy"])
    expect(fs.readFileSync(path.join(workDir, "fuzzy.txt"), "utf-8")).toBe("call(done)\n")
  })

  it("fails closed for ambiguous fuzzy matches and leaves the file unchanged", async () => {
    const { workDir } = makeSandbox()
    fs.writeFileSync(path.join(workDir, "ambiguous.txt"), "call(  one )\ncall( one  )\n", "utf-8")

    const parsed = await runPatch(
      workDir,
      `*** Begin Patch
*** Update File: ambiguous.txt
@@
-call(one)
+call(done)
*** End Patch
`,
    )

    expect(parsed).toMatchObject({
      error: "patch_failed",
    })
    expect(parsed.detail).toContain("ambiguous")
    expect(fs.readFileSync(path.join(workDir, "ambiguous.txt"), "utf-8")).toBe("call(  one )\ncall( one  )\n")
  })

  it("rejects unsafe operations before mutating any file", async () => {
    const { workDir } = makeSandbox()
    fs.writeFileSync(path.join(workDir, "existing.txt"), "keep\n", "utf-8")
    fs.writeFileSync(path.join(workDir, "source.txt"), "source\n", "utf-8")
    fs.writeFileSync(path.join(workDir, "destination.txt"), "destination\n", "utf-8")

    const addExisting = await runPatch(workDir, "*** Begin Patch\n*** Add File: existing.txt\n+replace\n*** End Patch\n")
    expect(addExisting.detail).toContain("already exists")
    expect(fs.readFileSync(path.join(workDir, "existing.txt"), "utf-8")).toBe("keep\n")

    const moveExisting = await runPatch(
      workDir,
      `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-source
+changed
*** End Patch
`,
    )
    expect(moveExisting.detail).toContain("move destination already exists")
    expect(fs.readFileSync(path.join(workDir, "source.txt"), "utf-8")).toBe("source\n")
    expect(fs.readFileSync(path.join(workDir, "destination.txt"), "utf-8")).toBe("destination\n")
  })

  it("rejects duplicate paths, missing targets, and directory targets", async () => {
    const { workDir } = makeSandbox()
    fs.writeFileSync(path.join(workDir, "dup.txt"), "one\n", "utf-8")
    fs.mkdirSync(path.join(workDir, "dir"), { recursive: true })

    const duplicate = await runPatch(
      workDir,
      `*** Begin Patch
*** Update File: dup.txt
@@
-one
+two
*** Update File: dup.txt
@@
-two
+three
*** End Patch
`,
    )
    expect(duplicate.detail).toContain("duplicate patch path")
    expect(fs.readFileSync(path.join(workDir, "dup.txt"), "utf-8")).toBe("one\n")

    const missing = await runPatch(workDir, "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch\n")
    expect(missing.detail).toContain("delete target does not exist")

    const directory = await runPatch(workDir, "*** Begin Patch\n*** Update File: dir\n@@\n-old\n+new\n*** End Patch\n")
    expect(directory.detail).toContain("update target is a directory")
  })

  it("accepts the sparrow-agents patch input alias in addition to patchText", async () => {
    const { workDir, runtime } = makeSandbox()
    fs.writeFileSync(path.join(workDir, "demo.txt"), "before\n", "utf-8")

    const parsed = JSON.parse(
      await applyPatchCoreLogic(
        runtime,
        {
          patch: "*** Begin Patch\n*** Update File: demo.txt\n@@\n-before\n+after\n*** End Patch\n",
        } as any,
        {} as any,
      ),
    )

    expect(parsed).toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(workDir, "demo.txt"), "utf-8")).toBe("after\n")
  })
})
