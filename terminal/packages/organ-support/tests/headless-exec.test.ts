import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  parseExecConfigOverride,
  runHeadlessExec,
  writeExecLastMessageFile,
} from "../src/exec"
import {
  __setLlmAdapterFactoryForTest,
  __setRuntimeAssemblyFactoryForTest,
} from "../../organ/src/AIAgent/TerminalRuntime"
import { __resetSessionUlidForTest } from "../../core/src/AIAgent/SessionId"
import { assembleAiCodingRuntimeProfile } from "@cell/mod-profiles"
import { projectRuntimeTiming } from "../../organ/src/AIAgent/RuntimeTimingProjection"

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
  __setRuntimeAssemblyFactoryForTest(null)
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

    expect(result).toMatchObject({
      status: "completed",
      visibleOutput: "exec reply",
      finalMessage: "exec reply",
      warnings: [],
      failureSummary: null,
      outputLastMessagePath,
      outputTracePath,
    })
    expect(result.timing).toMatchObject({
      schemaVersion: 1,
      counts: {
        providerCalls: 1,
        providerFailures: 0,
        toolCalls: 0,
      },
    })
    expect(
      result.timing.components.providerWaitMs
      + result.timing.components.providerGenerationMs
      + result.timing.components.toolMs
      + result.timing.components.productOwnedMs,
    ).toBe(result.timing.window.wallMs)
    expect(result.timing.providerCalls.entries).toHaveLength(1)
    expect(result.timing.providerCalls.entries[0]).toMatchObject({
      status: "completed",
      terminalCause: "completed",
    })
    expect(JSON.stringify(result.timing)).not.toContain("hidden")
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
      timing: {
        schemaVersion: 1,
        counts: { providerCalls: 1, toolCalls: 0 },
      },
    })
  })

  it("routes provider ledger setup diagnostics to the headless diagnostic sink and continues", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir
    const sessionKey = "headless-ledger-diagnostic"
    const sessionDir = path.join(activeWorkdir, ".eidolon", "sessions", sessionKey)
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, "observability"), "blocked")
    const diagnosticLines: string[] = []

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "still running" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    const result = await runHeadlessExec({
      workDir: activeWorkdir,
      sessionKey,
      input: "hello",
      mcp: false,
      captureProviderRequests: true,
      onDiagnosticLine: (line) => {
        diagnosticLines.push(line)
      },
    })

    expect(result.status).toBe("completed")
    expect(result.finalMessage).toBe("still running")
    expect(diagnosticLines).toHaveLength(1)
    expect(diagnosticLines[0]).toContain("provider request ledger open_failed")
    expect(diagnosticLines[0]).toContain(`session=${sessionKey}`)
  })

  it("reports a complete empty-domain timing projection when runtime initialization is unavailable", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir
    __setLlmAdapterFactoryForTest(async () => {
      throw new Error("runtime init unavailable")
    })

    const outputTracePath = path.join(activeWorkdir, "artifacts", "unavailable-trace.jsonl")
    const result = await runHeadlessExec({
      workDir: activeWorkdir,
      input: "hello",
      mcp: false,
      outputTracePath,
    })

    expect(result.status).toBe("failed")
    expect(result.timing.counts).toMatchObject({ providerCalls: 0, toolCalls: 0 })
    expect(result.timing.components).toMatchObject({
      providerWaitMs: 0,
      providerGenerationMs: 0,
      toolMs: 0,
      productOwnedMs: result.timing.window.wallMs,
    })
    expect(
      result.timing.components.providerWaitMs
      + result.timing.components.providerGenerationMs
      + result.timing.components.toolMs
      + result.timing.components.productOwnedMs,
    ).toBe(result.timing.window.wallMs)
    const traceLines = fs.readFileSync(outputTracePath, "utf-8").trim().split("\n").map((line) => JSON.parse(line))
    expect(traceLines.at(-1)).toMatchObject({
      type: "session_end",
      status: "failed",
      timing: {
        schemaVersion: 1,
        counts: { providerCalls: 0, toolCalls: 0 },
      },
    })
  })

  it("recovers an existing manifest for the exact cwd and session instead of creating a new actor", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    let providerCall = 0
    let recoveredMessages: Array<{ role?: string; content?: unknown }> = []
    __setRuntimeAssemblyFactoryForTest((context) => ({
      ...assembleAiCodingRuntimeProfile(context),
      systemPrompt: "profile prompt v1",
    }))
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: { messages?: Array<{ role?: string; content?: unknown }> }) {
        providerCall += 1
        if (providerCall === 2) recoveredMessages = options.messages ?? []
        async function* stream() {
          yield { choices: [{ delta: { content: providerCall === 1 ? "first reply" : "second reply" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    const sessionKey = "exact-cwd-session-recovery"
    const first = await runHeadlessExec({
      workDir: activeWorkdir,
      sessionKey,
      input: "first persisted input",
      mcp: false,
    })
    expect(first.status).toBe("completed")

    const runtimeStateDir = path.join(activeWorkdir, ".eidolon", "sessions", sessionKey, "runtime_state")
    const manifestBefore = JSON.parse(fs.readFileSync(path.join(runtimeStateDir, "manifest.json"), "utf8"))
    const actorMetaPath = path.join(runtimeStateDir, manifestBefore.actorFiles[manifestBefore.controlActorKey])
    const actorBefore = JSON.parse(fs.readFileSync(actorMetaPath, "utf8"))
    expect(actorBefore.profileSystemPromptProvenance).toEqual(expect.objectContaining({
      owner: "runtime_profile",
      profileId: "ai-coding",
      promptIndex: 0,
    }))

    __setRuntimeAssemblyFactoryForTest((context) => ({
      ...assembleAiCodingRuntimeProfile(context),
      systemPrompt: "profile prompt v2",
    }))

    const second = await runHeadlessExec({
      workDir: activeWorkdir,
      sessionKey,
      input: "second input after recovery",
      mcp: false,
    })
    expect(second.status).toBe("completed")

    const manifestAfter = JSON.parse(fs.readFileSync(path.join(runtimeStateDir, "manifest.json"), "utf8"))
    const actorAfter = JSON.parse(fs.readFileSync(
      path.join(runtimeStateDir, manifestAfter.actorFiles[manifestAfter.controlActorKey]),
      "utf8",
    ))
    expect(actorAfter.id).toBe(actorBefore.id)
    expect(actorAfter.systemPrompts).toEqual(["profile prompt v2"])
    expect(recoveredMessages.some((message) => message.role === "system" && message.content === "profile prompt v2")).toBe(true)
    const providerText = (content: unknown): string => typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("")
        : ""
    expect(recoveredMessages.some((message) => message.role === "user" && providerText(message.content) === "first persisted input")).toBe(true)
    expect(recoveredMessages.some((message) => message.role === "assistant" && message.content === "first reply")).toBe(true)
    expect(recoveredMessages.some((message) => message.role === "user" && providerText(message.content) === "second input after recovery")).toBe(true)
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
      timing: projectRuntimeTiming({
        sessionId: "test-session",
        startedAt: 10,
        endedAt: 20,
        providerCalls: [],
        toolCalls: [],
      }),
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

  it("aborts the active turn immediately when an exact fatal tool identity fails", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    let providerCalls = 0
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        providerCalls += 1
        async function* stream() {
          if (providerCalls === 1) {
            yield {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "tc-fatal-read",
                    type: "function",
                    function: {
                      name: "read",
                      arguments: JSON.stringify({ filePath: "missing-fatal-input.txt" }),
                    },
                  }],
                },
              }],
            } as any
            return
          }
          yield { choices: [{ delta: { content: "must not retry after fatal tool failure" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    const result = await runHeadlessExec({
      workDir: activeWorkdir,
      input: "read a missing required input",
      mcp: false,
      failOnToolError: ["read"],
    })

    expect(result.status).toBe("failed")
    expect(result.failureSummary).toContain("missing-fatal-input.txt")
    expect(result.visibleOutput).not.toContain("must not retry")
    expect(providerCalls).toBe(1)
  })

  it("reports paused_with_progress when the runtime turn times out before a safepoint", async () => {
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

    expect(result.status).toBe("paused_with_progress")
    expect(result.failureSummary).toMatch(/runtime_turn_unsettled/)
    expect(result.finalMessage).toBeNull()
    expect(fs.existsSync(outputLastMessagePath)).toBe(false)
    const traceLines = fs
      .readFileSync(outputTracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(traceLines.at(-1)).toMatchObject({
      type: "session_end",
      status: "paused_with_progress",
      finalMessageChars: 0,
    })
  })

  it("auto-resumes paused progress without writing a new user input", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir
    fs.writeFileSync(path.join(activeWorkdir, "package.json"), JSON.stringify({ name: "loop-fixture" }), "utf-8")

    let streamCount = 0
    let secondPromptHumanInputCount = 0
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: { messages?: Array<{ role?: string; content?: string }> }) {
        streamCount += 1
        if (streamCount === 2) {
          secondPromptHumanInputCount = (options.messages ?? []).filter((message) => (
            message.role === "user"
            && JSON.stringify(message.content).includes("keep reading")
          )).length
        }
        async function* stream() {
          if (streamCount === 1) {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "tc-auto-resume-read",
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
            return
          }
          yield { choices: [{ delta: { content: "resumed final" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    const outputLastMessagePath = path.join(activeWorkdir, "artifacts", "last-message.txt")
    const outputTracePath = path.join(activeWorkdir, "artifacts", "exec-trace.jsonl")
    const diagnostics: string[] = []

    const result = await runHeadlessExec({
      workDir: activeWorkdir,
      input: "keep reading",
      sessionKey: "headless-auto-resume-turn",
      mcp: false,
      timeoutSeconds: 0.05,
      autoResume: true,
      maxContinuations: 2,
      outputLastMessagePath,
      outputTracePath,
      onDiagnosticLine: async (line) => {
        diagnostics.push(line)
      },
    })

    expect(result.status).toBe("completed")
    expect(result.finalMessage).toBe("resumed final")
    expect(result.timing.counts).toMatchObject({ providerCalls: 2, toolCalls: 1 })
    expect(result.timing.toolCalls.entries).toHaveLength(1)
    expect(result.timing.toolCalls.entries[0]).toMatchObject({
      toolName: "read",
      status: "completed",
      terminalCause: "completed",
    })
    expect(
      result.timing.components.providerWaitMs
      + result.timing.components.providerGenerationMs
      + result.timing.components.toolMs
      + result.timing.components.productOwnedMs,
    ).toBe(result.timing.window.wallMs)
    expect(fs.readFileSync(outputLastMessagePath, "utf-8")).toBe("resumed final")
    expect(streamCount).toBe(2)
    expect(secondPromptHumanInputCount).toBe(1)
    expect(diagnostics.join("")).toContain("[exec] auto-resume continuation 1/2")
    const traceLines = fs
      .readFileSync(outputTracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(traceLines.some((line) => line.type === "continuation_start" && line.continuationIndex === 1)).toBe(true)
    expect(traceLines.at(-1)).toMatchObject({
      type: "session_end",
      status: "completed",
      finalMessageChars: "resumed final".length,
    })
  })

  it("does not inject runtime hints during repeated bash file inspections", async () => {
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
    expect(result.finalMessage).toBe("missing hint")
    expect(result.warnings).not.toContain(
      "repeated shell inspections without code changes for scripts/build_tui_release.sh; stop rereading and either patch, answer, or change strategy",
    )
    expect(diagnosticLines.join("")).not.toContain("repeated shell inspections without code changes")
    expect(promptSawRuntimeHint).toBe(false)
  })
})
