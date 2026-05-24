import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { runHeadlessTurn } from "../src/headless"
import { __setLlmAdapterFactoryForTest } from "../../organ/src/AIAgent/TerminalRuntime"
import { __resetSessionUlidForTest } from "../../core/src/AIAgent/SessionId"

const originalHome = process.env.HOME

function makeTempWorkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-headless-turn-"))
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

function makeTempHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-headless-home-"))
  fs.mkdirSync(path.join(dir, ".eidolon"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, ".eidolon", "llm-provider.json"),
    JSON.stringify(
      {
        providers: [
          {
            name: "openai",
            baseURL: "https://api.deepseek.com",
            apiKey: "test-key",
            models: [{ name: "deepseek-reasoner", context: 128000, output: 8192 }],
          },
        ],
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(dir, ".eidolon", "agent-preset.json"),
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

describe("headless terminal turn", () => {
  it("includes assign:r in the runtime system prompt as a formal explicit final surface", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    let systemPrompt = ""
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: { messages?: Array<{ role?: string; content?: string }> }) {
        systemPrompt = String((options.messages ?? []).find((message) => message?.role === "system")?.content ?? "")
        async function* stream() {
          yield { choices: [{ delta: { content: "ok" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    await runHeadlessTurn({
      workDir: activeWorkdir,
      input: "hello",
      mcp: false,
    })

    expect(systemPrompt).toContain("`assign`, `assign:r`, `assign:n`, `assign:s`")
    expect(systemPrompt).toContain("`assign`/`assign:r` => `final`")
    expect(systemPrompt).toContain("Use TaskTreeWrite only when the work truly has multiple dependent steps")
    expect(systemPrompt).toContain("If an official test command or benchmark-faithful suite passes after your change, stop and finalize")
    expect(systemPrompt).toContain("Do not rerun the same test file or official suite without an intervening code change")
    expect(systemPrompt).toContain("Prefer repo-relative inspection paths")
    expect(systemPrompt).toContain("For narrow bugfix tasks and benchmark-style tasks, prefer `apply_patch` for source edits")
    expect(systemPrompt).toContain("Use `edit` only for a small exact replacement after reading the file and copying the exact snippet")
    expect(systemPrompt).toContain("When changing an existing accessible text file, prefer `edit` or `apply_patch` over shell commands")
    expect(systemPrompt).toContain("When creating or fully replacing a text file in an accessible directory, prefer `write`")
    expect(systemPrompt).toContain("When inspecting an accessible file or directory, prefer `read`")
    expect(systemPrompt).toContain("If shell is necessary, prefer fast, scoped, non-interactive commands with structured parsing and minimal relevant validation")
    expect(systemPrompt).toContain("Prefer project-provided scripts or task runners")
    expect(systemPrompt).toContain("Do not use bash to directly modify normal text files")
    expect(systemPrompt).toContain("File `read`/`write`/`edit` tools are not limited to the workspace")
    expect(systemPrompt).toContain("Interpret `~/...` as home-directory notation")
    expect(systemPrompt).toContain("Do not rewrite a user path written as `~/...`")
  })

  it("runs a single shared runtime turn without launching tui", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { reasoning_content: "internal reasoning" } }] } as any
          yield { choices: [{ delta: { content: "headless reply" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    const chunks: string[] = []
    const result = await runHeadlessTurn({
      workDir: activeWorkdir,
      input: "hello",
      mcp: false,
      onChunk: (chunk) => {
        chunks.push(chunk)
      },
    })

    expect(result).toContain("headless reply")
    expect(result).not.toContain("Starting turn")
    expect(result).not.toContain("Turn no_tool_calls")
    expect(result).not.toContain("internal reasoning")
    expect(chunks.join("")).toContain("headless reply")
    expect(chunks.join("")).not.toContain("internal reasoning")
  })

  it("creates a fresh session by default for each headless invocation", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: { messages?: Array<{ role?: string }> }) {
        const userCount = (options.messages ?? []).filter((message) => message?.role === "user").length
        async function* stream() {
          yield { choices: [{ delta: { content: `users:${userCount}` } }] } as any
        }
        return { stream: stream() }
      },
    }))

    const first = await runHeadlessTurn({
      workDir: activeWorkdir,
      input: "hello",
      mcp: false,
    })
    const second = await runHeadlessTurn({
      workDir: activeWorkdir,
      input: "hello",
      mcp: false,
    })

    expect(first).toContain("users:1")
    expect(second).toContain("users:1")

    const sessionRoot = path.join(activeWorkdir, ".eidolon", "sessions")
    const sessions = fs.readdirSync(sessionRoot)
    expect(sessions.length).toBe(2)
    expect(sessions.every((name) => /^\d{14}__[0-9A-HJKMNP-TV-Z]{26}$/.test(name))).toBe(true)
  })
})
