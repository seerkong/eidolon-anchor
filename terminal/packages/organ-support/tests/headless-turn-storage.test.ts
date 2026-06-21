import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { runHeadlessTurn } from "../src/headless"
import { __setLlmAdapterFactoryForTest } from "../../organ/src/AIAgent/TerminalRuntime"
import { __resetSessionUlidForTest } from "../../core/src/AIAgent/SessionId"

const originalHome = process.env.HOME

function makeTempWorkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-headless-storage-"))
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

function makeTempHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-headless-storage-home-"))
  fs.mkdirSync(path.join(dir, ".eidolon"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, ".eidolon", "llm-provider.json"),
    JSON.stringify(
      {
        providers: [
          {
            id: "openai",
            adapter: "openai",
            options: { baseURL: "https://api.deepseek.com", apiKey: "test-key" },
            models: [{ id: "deepseek-reasoner", limits: { context: 128000, output: 8192 } }],
          },
        ],
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(dir, ".eidolon", "agent-present.json"),
    JSON.stringify(
      {
        preset: "default",
        presets: {
          default: {
            main: {
              model: "openai/deepseek-reasoner",
            },
          },
        },
      },
      null,
      2,
    ),
  )
  return dir
}

function listSessionFiles(workDir: string): string[] {
  const sessionsDir = path.join(workDir, ".eidolon", "sessions")
  if (!fs.existsSync(sessionsDir)) return []
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(path.relative(sessionsDir, full))
    }
  }
  walk(sessionsDir)
  return files
}

let activeWorkdir: string | null = null
let activeHomeDir: string | null = null

afterEach(() => {
  __setLlmAdapterFactoryForTest(null)
  __resetSessionUlidForTest()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (activeWorkdir) {
    fs.rmSync(activeWorkdir, { recursive: true, force: true })
    activeWorkdir = null
  }
  if (activeHomeDir) {
    fs.rmSync(activeHomeDir, { recursive: true, force: true })
    activeHomeDir = null
  }
})

function mockSimpleReply(reply: string) {
  __setLlmAdapterFactoryForTest(async () => ({
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield { choices: [{ delta: { content: reply } }] } as any
      }
      return { stream: stream() }
    },
  }))
}

describe("headless turn storage capability flags", () => {
  it("completes a memory-only turn without session file writes when logs and files are disabled", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir
    mockSimpleReply("memory only reply")

    const result = await runHeadlessTurn({
      workDir: activeWorkdir,
      input: "hello",
      mcp: false,
      storage: { logs: false, files: false },
    })

    expect(result).toContain("memory only reply")
    expect(listSessionFiles(activeWorkdir)).toEqual([])
  })

  it("writes session files by default when storage capabilities stay enabled", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir
    mockSimpleReply("persistent reply")

    const result = await runHeadlessTurn({
      workDir: activeWorkdir,
      input: "hello",
      mcp: false,
    })

    expect(result).toContain("persistent reply")
    expect(listSessionFiles(activeWorkdir).length).toBeGreaterThan(0)
  })
})
