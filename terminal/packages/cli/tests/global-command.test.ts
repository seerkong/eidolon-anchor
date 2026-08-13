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
      installed: ["sys-ai-workflow"],
    })
    expect(await Bun.file(path.join(globalRoot, "skills", "sys-ai-workflow", "SKILL.md")).exists()).toBe(true)
  })
})
