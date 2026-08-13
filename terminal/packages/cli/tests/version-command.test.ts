import { describe, expect, it } from "bun:test"
import path from "node:path"

const packageRoot = path.resolve(import.meta.dir, "..")

describe("eidolon version command", () => {
  it("prints the unified CLI package version", async () => {
    const packageJson = await Bun.file(path.join(packageRoot, "package.json")).json() as { version: string }
    const process = Bun.spawn([
      "bun",
      "--preload",
      "../tui/src/entry/preload.ts",
      "src/index.ts",
      "--version",
    ], {
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    })

    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout.trim()).toBe(packageJson.version)
  })
})
