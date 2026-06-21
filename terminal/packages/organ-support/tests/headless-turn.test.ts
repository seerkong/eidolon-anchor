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

    expect(systemPrompt).toContain("`assign`、`assign:r`、`assign:n`、`assign:s`")
    expect(systemPrompt).toContain("`assign`/`assign:r` => `final`")
    expect(systemPrompt).toContain("MCP 工具调用没有默认的单次超时")
    expect(systemPrompt).toContain('`_eidolon: { "timeoutMs": <milliseconds> }`')
    expect(systemPrompt).toContain("300000ms")
    expect(systemPrompt).toContain("只有当工作确实包含多个依赖步骤")
    expect(systemPrompt).toContain("修改后官方测试命令或可信 benchmark 套件通过时")
    expect(systemPrompt).toContain("没有代码变化时，不要重复运行同一个测试文件")
    expect(systemPrompt).toContain("优先使用仓库相对路径检查文件")
    expect(systemPrompt).toContain("对窄 bugfix 和 benchmark 类任务")
    expect(systemPrompt).toContain("只有在读过文件并复制了精确片段后")
    expect(systemPrompt).toContain("修改已有可访问文本文件时")
    expect(systemPrompt).toContain("创建或完整替换可访问目录里的文本文件时")
    expect(systemPrompt).toContain("检查可访问文件或目录时")
    expect(systemPrompt).toContain("必须使用 shell 时")
    expect(systemPrompt).toContain("项目脚本或 task runner")
    expect(systemPrompt).toContain("不要用 bash 直接修改普通文本文件")
    expect(systemPrompt).toContain("文件工具不局限于 workspace")
    expect(systemPrompt).toContain("home-directory 记法")
    expect(systemPrompt).toContain("不要把用户写的 `~/...` 改写成猜测的 workspace 相对路径")
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
