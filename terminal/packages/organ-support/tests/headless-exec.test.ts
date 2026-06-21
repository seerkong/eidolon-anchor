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

  it("does not report completion when the runtime turn times out before a safepoint", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir
    fs.writeFileSync(path.join(activeWorkdir, "package.json"), JSON.stringify({ name: "loop-fixture" }), "utf-8")

    let streamCount = 0
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        streamCount += 1
        const toolCallId = `tc-repeat-read-${streamCount}`
        async function* stream() {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: toolCallId,
                      type: "function",
                      function: {
                        name: "read",
                        arguments: JSON.stringify({ filePath: "package.json" }),
                      },
                    },
                  ],
                },
              },
            ],
          } as any
        }
        return { stream: stream() }
      },
    }))

    const outputLastMessagePath = path.join(activeWorkdir, "artifacts", "last-message.txt")
    const outputTracePath = path.join(activeWorkdir, "artifacts", "exec-trace.jsonl")

    const result = await runHeadlessExec({
      workDir: activeWorkdir,
      input: "keep reading",
      sessionKey: "headless-unsettled-turn",
      mcp: false,
      timeoutSeconds: 0.05,
      outputLastMessagePath,
      outputTracePath,
    })

    expect(result.status).toBe("failed")
    expect(result.failureSummary).toMatch(/runtime_turn_unsettled|runtime_turn_completed_without_final_output|Timeout after/)
    expect(result.finalMessage).toBeNull()
    expect(fs.existsSync(outputLastMessagePath)).toBe(false)
    const traceLines = fs
      .readFileSync(outputTracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(traceLines.at(-1)).toMatchObject({
      type: "session_end",
      status: "failed",
      finalMessageChars: 0,
    })
  })

  it("injects runtime hints during repeated bash file inspections in the same turn", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir
    fs.mkdirSync(path.join(activeWorkdir, "scripts"), { recursive: true })
    fs.writeFileSync(path.join(activeWorkdir, "scripts", "build_tui_release.sh"), "echo build\n", "utf-8")

    let streamCount = 0
    let promptSawRuntimeHint = false
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: { messages?: Array<{ role?: string; content?: string }> }) {
        streamCount += 1
        promptSawRuntimeHint ||= (options.messages ?? []).some((message) =>
          String(message?.content ?? "").includes("Runtime hint:")
          && String(message?.content ?? "").includes("repeatedly inspected scripts/build_tui_release.sh"),
        )
        const toolCallId = `tc-repeat-sed-${streamCount}`
        async function* stream() {
          if (!promptSawRuntimeHint && streamCount <= 6) {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: toolCallId,
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({
                            command: "sed -n '1,240p' scripts/build_tui_release.sh",
                            workdir: ".",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            } as any
            return
          }
          yield { choices: [{ delta: { content: promptSawRuntimeHint ? "hint seen" : "missing hint" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    const diagnosticLines: string[] = []
    const result = await runHeadlessExec({
      workDir: activeWorkdir,
      input: "keep inspecting",
      mcp: false,
      timeoutSeconds: 5,
      onDiagnosticLine: async (line) => {
        diagnosticLines.push(line)
      },
    })

    expect(result.status).toBe("completed")
    expect(result.finalMessage).toBe("hint seen")
    expect(result.warnings).toContain(
      "repeated shell inspections without code changes for scripts/build_tui_release.sh; stop rereading and either patch, answer, or change strategy",
    )
    expect(diagnosticLines.join("")).toContain("repeated shell inspections without code changes")
    expect(promptSawRuntimeHint).toBe(true)
  })
})
