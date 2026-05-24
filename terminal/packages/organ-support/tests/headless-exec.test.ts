import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  parseExecConfigOverride,
  runHeadlessExec,
  writeExecLastMessageFile,
} from "../src/exec"
import { __setLlmAdapterFactoryForTest } from "../../organ/src/AIAgent/TerminalRuntime"
import { __resetSessionUlidForTest } from "../../core/src/AIAgent/SessionId"

const originalHome = process.env.HOME

function makeTempWorkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-headless-exec-"))
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

function makeTempHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-headless-exec-home-"))
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

describe("headless exec", () => {
  it("parses the supported config override subset", () => {
    expect(parseExecConfigOverride("mcp_servers={}")).toEqual({ mcp: false })
    expect(() => parseExecConfigOverride("sandbox_mode=workspace-write")).toThrow(
      "Unsupported exec config override",
    )
  })

  it("writes output-last-message on successful exec completion", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { reasoning_content: "hidden" } }] } as any
          yield { choices: [{ delta: { content: "exec reply" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    const outputLastMessagePath = path.join(activeWorkdir, "artifacts", "last-message.txt")
    const outputTracePath = path.join(activeWorkdir, "artifacts", "exec-trace.jsonl")
    const visibleChunks: string[] = []
    const diagnosticLines: string[] = []

    const result = await runHeadlessExec({
      workDir: activeWorkdir,
      input: "hello",
      mcp: false,
      outputLastMessagePath,
      outputTracePath,
      onVisibleChunk: async (chunk) => {
        visibleChunks.push(chunk)
      },
      onDiagnosticLine: async (line) => {
        diagnosticLines.push(line)
      },
    })

    expect(result).toEqual({
      status: "completed",
      visibleOutput: "exec reply",
      finalMessage: "exec reply",
      warnings: [],
      failureSummary: null,
      outputLastMessagePath,
      outputTracePath,
    })
    expect(visibleChunks.join("")).toBe("exec reply")
    expect(diagnosticLines).toEqual([])
    expect(fs.readFileSync(outputLastMessagePath, "utf-8")).toBe("exec reply")
    const traceLines = fs
      .readFileSync(outputTracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(traceLines[0]).toMatchObject({
      type: "session_start",
      cwd: activeWorkdir,
      mcpEnabled: false,
    })
    expect(traceLines.at(-1)).toMatchObject({
      type: "session_end",
      status: "completed",
      finalMessageChars: "exec reply".length,
      visibleOutputChars: "exec reply".length,
    })
  })

  it("does not overwrite an existing last-message file for failed exec results", async () => {
    activeWorkdir = makeTempWorkdir()

    const outputLastMessagePath = path.join(activeWorkdir, "artifacts", "last-message.txt")
    fs.mkdirSync(path.dirname(outputLastMessagePath), { recursive: true })
    fs.writeFileSync(outputLastMessagePath, "previous message", "utf-8")

    await writeExecLastMessageFile({
      status: "failed",
      visibleOutput: "partial output",
      finalMessage: null,
      warnings: [],
      failureSummary: "stream failed",
      outputLastMessagePath,
      outputTracePath: undefined,
    })

    expect(fs.readFileSync(outputLastMessagePath, "utf-8")).toBe("previous message")
  })

  it("surfaces provider failures as visible output and failed exec status", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        throw new Error("provider quota exceeded")
      },
    }))

    const visibleChunks: string[] = []
    const result = await runHeadlessExec({
      workDir: activeWorkdir,
      input: "hello",
      mcp: false,
      onVisibleChunk: async (chunk) => {
        visibleChunks.push(chunk)
      },
    })

    expect(result.status).toBe("failed")
    expect(result.failureSummary).toBe("Error: provider quota exceeded")
    expect(result.visibleOutput).toContain("Error: provider quota exceeded")
    expect(visibleChunks.join("")).toContain("Error: provider quota exceeded")
    expect(result.finalMessage).toBeNull()
  })
})
