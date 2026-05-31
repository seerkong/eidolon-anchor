import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { assembleAiCodingRuntimeProfile } from "@cell/mod-profiles"
import {
  __setLlmAdapterFactoryForTest,
  __setRuntimeAssemblyFactoryForTest,
  configureTerminalRuntime,
  disposeTerminalRuntimeBridge,
  getTerminalRuntimeBridge,
} from "@terminal/organ/AIAgent/TerminalRuntime"

const originalHome = process.env.HOME

function makeTempWorkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-runtime-composer-"))
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

function makeTempHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-runtime-composer-home-"))
  fs.mkdirSync(path.join(dir, ".eidolon"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, ".eidolon", "llm-provider.json"),
    JSON.stringify(
      {
        providers: [
          {
            name: "openai",
            baseURL: "https://api.example.com",
            apiKey: "test-key",
            models: [{ name: "test-model", context: 128000, output: 8192 }],
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
              model: "openai/test-model",
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

afterEach(async () => {
  await disposeTerminalRuntimeBridge("composer-adoption")
  __setLlmAdapterFactoryForTest(null)
  __setRuntimeAssemblyFactoryForTest(null)
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

describe("TerminalRuntime composer adoption", () => {
  it("passes model-level reasoning effort into LLM request extraBody", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-runtime-composer-home-"))
    fs.mkdirSync(path.join(activeHomeDir, ".eidolon"), { recursive: true })
    fs.writeFileSync(
      path.join(activeHomeDir, ".eidolon", "llm-provider.json"),
      JSON.stringify(
        {
          providers: [
            {
              name: "codeflicker",
              adapter: "codex",
              baseURL: "http://127.0.0.1:8018/v1",
              apiKey: "dummy",
              models: [
                {
                  name: "wanqing/gpt-5.4",
                  context: 128000,
                  output: 8192,
                  reasoning: { effort: "high" },
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    )
    fs.writeFileSync(
      path.join(activeHomeDir, ".eidolon", "agent-preset.json"),
      JSON.stringify(
        {
          preset: "default",
          presets: {
            default: {
              main: {
                model: "codeflicker/wanqing/gpt-5.4",
              },
            },
          },
        },
        null,
        2,
      ),
    )
    process.env.HOME = activeHomeDir

    let capturedExtraBody: Record<string, unknown> | undefined
    __setLlmAdapterFactoryForTest(async (adapterType) => ({
      type: adapterType,
      async createStream(options: { extraBody?: Record<string, unknown> }) {
        capturedExtraBody = options.extraBody
        async function* stream() {
          yield { choices: [{ delta: { content: "ok" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    configureTerminalRuntime({
      workDir: activeWorkdir,
      mcp: false,
    })

    const runtime = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtime).toBeTruthy()

    const reply = await runtime!.turn("hello")
    expect(reply).toContain("ok")
    expect(capturedExtraBody).toEqual({
      reasoning: {
        effort: "high",
      },
    })
  })

  it("uses provider adapter from llm-provider.json instead of inferring from provider name", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-runtime-composer-home-"))
    fs.mkdirSync(path.join(activeHomeDir, ".eidolon"), { recursive: true })
    fs.writeFileSync(
      path.join(activeHomeDir, ".eidolon", "llm-provider.json"),
      JSON.stringify(
        {
          providers: [
            {
              name: "codeflicker",
              adapter: "codex",
              baseURL: "http://127.0.0.1:8018/v1",
              apiKey: "dummy",
              models: [{ name: "wanqing/gpt-5.4", context: 128000, output: 8192 }],
            },
            {
              name: "codex",
              adapter: "openai",
              baseURL: "http://127.0.0.1:8019/v1",
              apiKey: "dummy-openai",
              models: [{ name: "named-like-codex", context: 128000, output: 8192 }],
            },
          ],
        },
        null,
        2,
      ),
    )
    fs.writeFileSync(
      path.join(activeHomeDir, ".eidolon", "agent-preset.json"),
      JSON.stringify(
        {
          preset: "default",
          presets: {
            default: {
              main: {
                model: "codeflicker/wanqing/gpt-5.4",
              },
            },
          },
        },
        null,
        2,
      ),
    )
    process.env.HOME = activeHomeDir

    const seenAdapterTypes: string[] = []
    __setLlmAdapterFactoryForTest(async (adapterType) => {
      seenAdapterTypes.push(adapterType)
      return {
        type: adapterType,
        async createStream() {
          async function* stream() {
            yield { choices: [{ delta: { content: "ok" } }] } as any
          }
          return { stream: stream() }
        },
      }
    })

    configureTerminalRuntime({
      workDir: activeWorkdir,
      mcp: false,
    })

    const runtime = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtime).toBeTruthy()
    expect(seenAdapterTypes[0]).toBe("codex")

    const reply = await runtime!.turn("hello")
    expect(reply).toContain("ok")

    await disposeTerminalRuntimeBridge("composer-adoption")
    seenAdapterTypes.length = 0

    fs.writeFileSync(
      path.join(activeHomeDir, ".eidolon", "agent-preset.json"),
      JSON.stringify(
        {
          preset: "default",
          presets: {
            default: {
              main: {
                model: "codex/named-like-codex",
              },
            },
          },
        },
        null,
        2,
      ),
    )

    const runtimeWithCodexNamedProvider = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtimeWithCodexNamedProvider).toBeTruthy()
    expect(seenAdapterTypes[0]).toBe("openai")
  })

  it("consumes the richer assembly result for prompt and runtime registries", async () => {
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

    configureTerminalRuntime({
      workDir: activeWorkdir,
      mcp: false,
    })

    const runtime = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtime).toBeTruthy()

    const llmTurn = await runtime!.turn("hello")
    expect(llmTurn).toContain("ok")
    expect(systemPrompt).toContain(`你是位于 ${activeWorkdir} 的 coding agent。`)
    expect(systemPrompt).toContain("工作循环：")
    expect(systemPrompt).toContain("定位/复现 -> 按需规划 -> 修改 -> 验证 -> 收口")

    const memberList = await runtime!.turn("/member list")
    expect(memberList).toContain("\"member_count\":0")
  })

  it("does not keep a hidden member list route when the assembly removes that action", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    __setRuntimeAssemblyFactoryForTest((context) => {
      const assembly = assembleAiCodingRuntimeProfile(context)
      return {
        ...assembly,
        slashCommands: assembly.slashCommands.map((command) =>
          command.namespace === "member"
            ? {
                ...command,
                actions: Object.fromEntries(
                  Object.entries(command.actions).filter(([action]) => action !== "list"),
                ),
              }
            : command,
        ),
      }
    })
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "llm-fallback" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    configureTerminalRuntime({
      workDir: activeWorkdir,
      mcp: false,
    })

    const runtime = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtime).toBeTruthy()

    const memberList = await runtime!.turn("/member list")
    expect(memberList).toContain("llm-fallback")
    expect(memberList).not.toContain("\"member_count\":0")

    const memberHelp = await runtime!.turn("/member help")
    expect(memberHelp).not.toContain("/member list")
  })

  it("uses the assembly-provided tool registry for direct slash execution", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    __setRuntimeAssemblyFactoryForTest((context) => {
      const assembly = assembleAiCodingRuntimeProfile(context)
      return {
        ...assembly,
        createRegistries: (options) => {
          const registries = assembly.createRegistries(options)
          return {
            ...registries,
            toolRegistry: new ToolFuncRegistry(),
          }
        },
      }
    })
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "llm-fallback" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    configureTerminalRuntime({
      workDir: activeWorkdir,
      mcp: false,
    })

    const runtime = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtime).toBeTruthy()

    const memberList = await runtime!.turn("/member list")
    expect(memberList).toContain("Unknown tool: MemberList")
  })

  it("can add a new direct slash action through the assembly contract", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    __setRuntimeAssemblyFactoryForTest((context) => {
      const assembly = assembleAiCodingRuntimeProfile(context)
      return {
        ...assembly,
        slashCommands: assembly.slashCommands.map((command) =>
          command.namespace === "member"
            ? {
                ...command,
                actions: {
                  ...command.actions,
                  catalog: {
                    toolName: "MemberCatalog",
                    parse: { kind: "literal", form: "catalog" },
                    help: "`/member catalog` Show the member catalog",
                  },
                },
              }
            : command,
        ),
        createRegistries: (options) => {
          const registries = assembly.createRegistries(options)
          const toolRegistry = new ToolFuncRegistry()
          toolRegistry.registerMany(registries.toolRegistry.list())
          toolRegistry.register({
            schema: {
              function: {
                name: "MemberCatalog",
              },
            },
            run: async () => "catalog-ok",
          } as any)
          return {
            ...registries,
            toolRegistry,
          }
        },
      }
    })
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "llm-fallback" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    configureTerminalRuntime({
      workDir: activeWorkdir,
      mcp: false,
    })

    const runtime = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtime).toBeTruthy()

    const catalog = await runtime!.turn("/member catalog")
    expect(catalog).toContain("catalog-ok")

    const memberHelp = await runtime!.turn("/member help")
    expect(memberHelp).toContain("/member catalog")
  })

  it("injects runtime hints into the next turn through the shared mailbox path", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    let capturedMessages: Array<{ role: string; content?: unknown }> = []
    __setLlmAdapterFactoryForTest(async (adapterType) => ({
      type: adapterType,
      async createStream(options: { messages?: Array<{ role: string; content?: unknown }> }) {
        capturedMessages = options.messages ?? []
        async function* stream() {
          yield { choices: [{ delta: { content: "ok" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    configureTerminalRuntime({
      workDir: activeWorkdir,
      mcp: false,
    })

    const runtime = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtime).toBeTruthy()

    await runtime!.injectRuntimeHint?.(
      "Use the confirmed repo-relative path `src/app.py`; do not fall back to `app.py`.",
    )
    const reply = await runtime!.turn("hello")

    expect(reply).toContain("ok")
    expect(capturedMessages).toContainEqual({
      role: "user",
      content: "Runtime hint:\nUse the confirmed repo-relative path `src/app.py`; do not fall back to `app.py`.",
    })
    expect(capturedMessages).toContainEqual({
      role: "user",
      content: "hello",
    })
  })
})
