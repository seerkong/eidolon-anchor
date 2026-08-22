import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import yargs from "yargs"

import { createGlobalCommand } from "../src/commands/global"

describe("global command", () => {
  test("initializes bundled system skills under an explicit global root", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-command-"))
    const writes: string[] = []
    await yargs(["global", "init", "--root", globalRoot, "--json"])
      .scriptName("eidolon")
      .command(createGlobalCommand({
        stdout: { write: (chunk: string) => { writes.push(chunk); return true } },
      }))
      .exitProcess(false)
      .parseAsync()

    expect(JSON.parse(writes.join(""))).toMatchObject({
      kind: "eidolon.globalInitResult",
      globalRoot,
      installed: [
        "sys-eidolon-anchor-run",
        "sys-halfcode-resource-dsl",
        "sys-eidolon-anchor-authoring",
        "sys-eidolon-anchor-devops",
      ],
      managed: [
        { name: "sys-eidolon-anchor-run", version: "1.0.0", source: "halfcode-distribution" },
        { name: "sys-halfcode-resource-dsl", version: "1.0.0", source: "halfcode-distribution" },
        { name: "sys-eidolon-anchor-authoring", version: "1.0.7", source: "halfcode-distribution" },
        { name: "sys-eidolon-anchor-devops", version: "1.0.8", source: "halfcode-distribution" },
      ],
    })
    for (const skillName of [
      "sys-eidolon-anchor-run",
      "sys-halfcode-resource-dsl",
      "sys-eidolon-anchor-authoring",
      "sys-eidolon-anchor-devops",
    ]) {
      expect(await Bun.file(path.join(globalRoot, "skills", skillName, "SKILL.md")).exists()).toBe(true)
    }
    expect(await Bun.file(path.join(globalRoot, "skills", "sys-ai-workflow", "SKILL.md")).exists()).toBe(false)
  })

  test("reports exact managed identities in text output", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-command-"))
    const writes: string[] = []
    await yargs(["global", "init", "--root", globalRoot])
      .scriptName("eidolon")
      .command(createGlobalCommand({
        stdout: { write: (chunk: string) => { writes.push(chunk); return true } },
      }))
      .exitProcess(false)
      .parseAsync()

    const output = writes.join("")
    expect(output).toContain("sys-eidolon-anchor-run@1.0.0 (halfcode-distribution, sha256:")
    expect(output).toContain("sys-halfcode-resource-dsl@1.0.0 (halfcode-distribution, sha256:")
    expect(output).toContain("sys-eidolon-anchor-authoring@1.0.7 (halfcode-distribution, sha256:")
    expect(output).toContain("sys-eidolon-anchor-devops@1.0.8 (halfcode-distribution, sha256:")
    expect(output).not.toContain("sys-ai-workflow")
  })
})
