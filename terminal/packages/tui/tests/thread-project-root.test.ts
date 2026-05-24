import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import yargs from "yargs/yargs"

import { findNearestProjectRoot } from "@cell/platform-support"
import { thread } from "../src/entry/thread"

let tempRoot: string | null = null

afterEach(() => {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe("tui thread project root resolution", () => {
  it("walks upward to find the nearest directory containing .eidolon", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-thread-root-"))
    const projectRoot = path.join(tempRoot, "repo")
    const packageDir = path.join(projectRoot, "terminal", "packages", "tui")

    fs.mkdirSync(path.join(projectRoot, ".eidolon"), { recursive: true })
    fs.mkdirSync(packageDir, { recursive: true })

    expect(findNearestProjectRoot(packageDir)).toBe(projectRoot)
  })

  it("returns the starting directory when no .eidolon directory exists in ancestors", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-thread-root-"))
    const startDir = path.join(tempRoot, "no-project", "terminal", "packages", "tui")

    fs.mkdirSync(startDir, { recursive: true })

    expect(findNearestProjectRoot(startDir)).toBe(startDir)
  })

  it("does not treat the home-level .eidolon directory as a project root", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-thread-root-"))
    const homeDir = path.join(tempRoot, "home")
    const startDir = path.join(homeDir, "infra-dev", "depa-processor")

    fs.mkdirSync(path.join(homeDir, ".eidolon"), { recursive: true })
    fs.mkdirSync(startDir, { recursive: true })

    expect(findNearestProjectRoot(startDir, ".eidolon", { homeDir })).toBe(startDir)
  })

  it("accepts the hidden print-logs flag under strict option parsing", async () => {
    const parsed = await yargs(["--print-logs"])
      .command("$0 [project]", "", thread.builder as any, () => {})
      .strictOptions()
      .strictCommands()
      .help(false)
      .parseAsync()

    expect(parsed.printLogs).toBe(true)
  })
})
