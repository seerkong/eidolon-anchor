import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import {
  acceptWorkspaceFileCandidate,
  buildWorkspaceFileTree,
  collectWorkspaceDirectoryPaths,
  compareWorkspaceFileCandidates,
  filterWorkspaceFileTree,
  flattenWorkspaceFileTree,
  formatWorkspaceBreadcrumb,
  listWorkspaceFiles,
  readWorkspaceFilterCharacter,
} from "../src/app/tui_a1/features/composer/file-picker-dialog"

const createdDirs: string[] = []

afterEach(async () => {
  while (createdDirs.length > 0) {
    const directory = createdDirs.pop()
    if (!directory) break
    await rm(directory, { recursive: true, force: true })
  }
})

describe("tui_a1 file picker", () => {
  it("ignores heavy workspace directories while collecting candidates", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eidolon-file-picker-"))
    createdDirs.push(directory)

    await mkdir(path.join(directory, "src"), { recursive: true })
    await mkdir(path.join(directory, "node_modules/pkg"), { recursive: true })
    await mkdir(path.join(directory, ".git/hooks"), { recursive: true })
    await writeFile(path.join(directory, "src/app.ts"), "export const app = true\n")
    await writeFile(path.join(directory, "README.md"), "# hello\n")
    await writeFile(path.join(directory, "node_modules/pkg/index.js"), "ignored\n")
    await writeFile(path.join(directory, ".git/hooks/pre-commit"), "ignored\n")

    const files = await listWorkspaceFiles(directory)
    const relative = files.map((file) => path.relative(directory, file)).sort()

    expect(relative).toEqual(["README.md", "src/app.ts"])
  })

  it("builds a directory tree and keeps nested files collapsed until expanded", () => {
    const directory = "/tmp/workspace"
    const tree = buildWorkspaceFileTree(directory, [
      path.join(directory, "README.md"),
      path.join(directory, "src/app.ts"),
      path.join(directory, "src/lib/util.ts"),
    ])

    const collapsed = flattenWorkspaceFileTree(tree, new Set(), () => 0)
    expect(collapsed.map((row) => row.node.relativePath)).toEqual(["src", "README.md"])

    const expanded = flattenWorkspaceFileTree(tree, new Set(["src"]), () => 0)
    expect(expanded.map((row) => row.node.relativePath)).toEqual(["src", "src/lib", "src/app.ts", "README.md"])
  })

  it("uses frecency to sort file siblings within the tree", () => {
    const directory = "/tmp/workspace"
    const tree = buildWorkspaceFileTree(directory, [
      path.join(directory, "b.ts"),
      path.join(directory, "a.ts"),
    ])

    const rows = flattenWorkspaceFileTree(tree, new Set(), (filePath) => (filePath.endsWith("b.ts") ? 8 : 0))
    const ranked = rows
      .filter((row) => row.node.kind === "file")
      .map((row) => ({
        absolutePath: row.node.absolutePath,
        relativePath: row.node.relativePath,
        frecency: row.frecency,
      }))

    expect(ranked.sort(compareWorkspaceFileCandidates)[0]).toMatchObject({
      relativePath: "b.ts",
      frecency: 8,
    })
    expect(ranked[1]).toMatchObject({
      relativePath: "a.ts",
    })
  })

  it("updates frecency before forwarding the selected file", () => {
    const selected = {
      absolutePath: "/tmp/workspace/src/app.ts",
      relativePath: "src/app.ts",
      frecency: 3,
    }
    const calls: string[] = []
    let forwarded: typeof selected | undefined

    acceptWorkspaceFileCandidate(
      selected,
      (filePath) => {
        calls.push(filePath)
      },
      (file) => {
        forwarded = file
      },
    )

    expect(calls).toEqual([selected.absolutePath])
    expect(forwarded).toEqual(selected)
  })

  it("filters the tree by incremental query while keeping ancestor directories visible", () => {
    const directory = "/tmp/workspace"
    const tree = buildWorkspaceFileTree(directory, [
      path.join(directory, "README.md"),
      path.join(directory, "src/app.ts"),
      path.join(directory, "tests/app.test.ts"),
    ])
    const filtered = filterWorkspaceFileTree(tree, "app")
    const rows = flattenWorkspaceFileTree(filtered, collectWorkspaceDirectoryPaths(filtered), () => 0)

    expect(formatWorkspaceBreadcrumb("workspace", rows[0])).toBe("path workspace / src")
    expect(formatWorkspaceBreadcrumb("workspace", rows[1])).toBe("path workspace / src / app.ts")
    expect(rows.map((row) => row.node.relativePath)).toEqual(["src", "src/app.ts", "tests", "tests/app.test.ts"])
  })

  it("reads printable key events into filter characters", () => {
    expect(readWorkspaceFilterCharacter({ name: "r", sequence: "r" })).toBe("r")
    expect(readWorkspaceFilterCharacter({ name: ".", sequence: "." })).toBe(".")
    expect(readWorkspaceFilterCharacter({ name: "backspace", sequence: "\b" })).toBeUndefined()
    expect(readWorkspaceFilterCharacter({ name: "r", sequence: "r", ctrl: true })).toBeUndefined()
  })
})
