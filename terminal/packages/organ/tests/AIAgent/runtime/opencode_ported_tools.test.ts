import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { configureLocalPermissionConfigStore } from "@cell/ai-organ-logic"
import { LocalFilePermissionConfigStore } from "@cell/ai-support"
import { createActor, createVM } from "@cell/ai-core-logic"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

configureLocalPermissionConfigStore(LocalFilePermissionConfigStore)

describe("opencode ported tools", () => {
  it("supports bash/read/write/edit/multiedit/ls/glob/grep/batch/apply_patch", async () => {
    const workdir = makeTempDir("ported-tools-")
    const registry = composeToolRegistry()
    const actor = createActor({ key: "test" })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
      outerCtx: { workDir: workdir },
    })

    expect(String(await registry.call("bash", vm, actor, { command: "echo bash" }))).toContain("bash")

    const filePath = path.join(workdir, "a.txt")
    expect(String(await registry.call("write", vm, actor, { filePath, content: "one\ntwo" }))).toContain("Wrote")
    expect(String(await registry.call("read", vm, actor, { filePath, limit: 1 }))).toContain("1: one")
    expect(String(await registry.call("edit", vm, actor, { filePath, oldString: "two", newString: "two-edited" }))).toContain("Edited")
    const editErrorOut = JSON.parse(String(await registry.call("edit", vm, actor, {
      filePath,
      oldString: "missing-snippet",
      newString: "ignored",
    })))
    expect(editErrorOut).toMatchObject({
      error: "not_found",
      filePath,
      suggestions: expect.arrayContaining([
        expect.stringContaining("Read the file again"),
        expect.stringContaining("apply_patch"),
      ]),
    })
    const multieditOut = JSON.parse(String(await registry.call("multiedit", vm, actor, { filePath, edits: [{ oldString: "one", newString: "ONE" }, { oldString: "two-edited", newString: "TWO" }] })))
    expect(multieditOut.message).toContain("Edited")
    expect(multieditOut.diff).toContain("@@")
    expect(fs.readFileSync(filePath, "utf-8")).toContain("ONE")
    expect(fs.readFileSync(filePath, "utf-8")).toContain("TWO")

    const subDir = path.join(workdir, "sub")
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, "b.ts"), "const x = 1\n", "utf-8")
    fs.writeFileSync(path.join(subDir, "c.js"), "const y = 2\n", "utf-8")

    expect(String(await registry.call("ls", vm, actor, { path: workdir }))).toContain("sub/")
    expect(String(await registry.call("glob", vm, actor, { pattern: "**/*.ts", path: workdir }))).toContain("sub/b.ts")
    expect(String(await registry.call("grep", vm, actor, { pattern: "const", path: workdir, include: "*.{ts,js}" }))).toContain("const")

    const batch = JSON.parse(String(await registry.call("batch", vm, actor, {
      tool_calls: [
        { tool: "ls", parameters: { path: workdir } },
        { tool: "read", parameters: { filePath, limit: 1 } },
      ],
    })))
    expect(batch.ok).toBe(true)
    expect(batch.results.length).toBe(2)

    const patchFile = path.join(workdir, "patchme.txt")
    fs.writeFileSync(patchFile, "hello\n", "utf-8")
    const patchText = `*** Begin Patch\n*** Update File: ${patchFile}\n@@\n-hello\n+hello world\n*** End Patch\n`
    const patchOut = JSON.parse(String(await registry.call("apply_patch", vm, actor, { patchText })))
    expect(patchOut.message.toLowerCase()).toContain("patch")
    expect(patchOut.diff).toContain("hello world")
    expect(fs.readFileSync(patchFile, "utf-8")).toContain("hello world")
  })
})
