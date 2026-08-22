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
            id: "openai",
            adapter: "openai",
            options: { baseURL: "https://api.example.com", apiKey: "test-key" },
            models: [{ id: "test-model", limits: { context: 128000, output: 8192 } }],
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

function writeStandaloneAgentResourcePackage(workdir: string): void {
  const root = path.join(workdir, ".eidolon", "resources")
  const files: Record<string, string> = {
    "manifest.xnl": `<ResourcePackage #eidolon.terminal.fixture.package apiVersion="halfcode.resources/v1" version="1.0.0" {
  lifecycle = "Active"
  description = "Terminal resource Agent fixture"
} (
  <Catalogs [
    <Catalog #kind_definitions { kind = "KindDefinition" shape = "directory" root = "vfs://./KindDefinitions/" entry = "manifest.xnl" }>
    <Catalog #agents { kind = "AIAgentDefinition" shape = "single-file" root = "vfs://./Agents/" }>
    <Catalog #prompts { kind = "Prompt" shape = "single-file" root = "vfs://./Prompts/" }>
  ]>
)>
`,
    "KindDefinitions/AIAgentDefinition/manifest.xnl": `<KindDefinition #eidolon.terminal.fixture.kind.AIAgentDefinition apiVersion="halfcode.resources/v1" version="1.0.0" {
  lifecycle = "Stable"
  resourceKind = "AIAgentDefinition"
  sourceShapes = ["single-file"]
  currentApiVersion = "depa.flows/v1"
  supportedApiVersions = ["depa.flows/v1"]
}>
`,
    "KindDefinitions/Prompt/manifest.xnl": `<KindDefinition #eidolon.terminal.fixture.kind.Prompt apiVersion="halfcode.resources/v1" version="1.0.0" {
  lifecycle = "Stable"
  resourceKind = "Prompt"
  sourceShapes = ["single-file"]
  currentApiVersion = "depa.flows/v1"
  supportedApiVersions = ["depa.flows/v1"]
}>
`,
    "Agents/Terminal.xnl": `<AIAgentDefinition #eidolon.terminal.fixture.Agent apiVersion="depa.flows/v1" version="1.0.0" {
  lifecycle = "Active"
  description = "Terminal resource Agent"
} (
  <Messages [
    <Message #system { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.terminal.fixture.Prompt" }>
  ]>
  <ToolRefs []>
  <MaterialPortRefs []>
)>
`,
    "Prompts/Terminal.xnl": `<Prompt #eidolon.terminal.fixture.Prompt apiVersion="depa.flows/v1" version="1.0.0" {
  lifecycle = "Active"
} (
  <Content ?>Use the exact Terminal resource context.</?>
)>
`,
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
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
  it("settles an unsupported image turn with its modality error and remains reusable", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-runtime-composer-home-"))
    fs.mkdirSync(path.join(activeHomeDir, ".eidolon"), { recursive: true })
    fs.writeFileSync(
      path.join(activeHomeDir, ".eidolon", "llm-provider.json"),
      JSON.stringify(
        {
          providers: [
            {
              id: "deepseek-test",
              adapter: "deepseek",
              options: { baseURL: "https://api.example.com", apiKey: "test-key" },
              models: [
                {
                  id: "deepseek-v4-flash",
                  limits: { context: 128000, output: 8192 },
                  capabilities: { modalities: { input: ["text"], output: ["text"] } },
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
      path.join(activeHomeDir, ".eidolon", "agent-present.json"),
      JSON.stringify(
        {
          preset: "default",
          presets: { default: { main: { model: "deepseek-test/deepseek-v4-flash" } } },
        },
        null,
        2,
      ),
    )
    process.env.HOME = activeHomeDir

    let providerCalls = 0
    __setLlmAdapterFactoryForTest(async () => ({
      type: "deepseek" as const,
      async createStream() {
        providerCalls += 1
        async function* stream() {
          yield { choices: [{ delta: { content: "ok" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    configureTerminalRuntime({ workDir: activeWorkdir, mcp: false })
    const runtime = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtime).toBeTruthy()

    const rejected = runtime!.turn([
      { type: "text", text: "inspect this image" },
      {
        type: "image",
        mime: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        filename: "screen.png",
      },
    ])
    await expect(Promise.race([
      rejected,
      new Promise((_, reject) => setTimeout(() => reject(new Error("turn did not settle")), 3_000)),
    ])).rejects.toMatchObject({
      code: "unsupported_modality",
      message: expect.stringContaining("does not support image input"),
    })
    expect(providerCalls).toBe(0)

    const reply = await runtime!.turn("continue with text only")
    expect(reply).toContain("ok")
    expect(providerCalls).toBe(1)
  })

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
              id: "codeflicker",
              adapter: "codex",
              options: { baseURL: "http://127.0.0.1:8018/v1", apiKey: "dummy" },
              models: [
                {
                  id: "wanqing/gpt-5.4",
                  limits: { context: 128000, output: 8192 },
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
      path.join(activeHomeDir, ".eidolon", "agent-present.json"),
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
    expect(capturedExtraBody).toEqual(expect.objectContaining({
      reasoning: {
        effort: "high",
      },
    }))
  })

  it("passes id-only provider model options into the runtime adapter", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-runtime-composer-home-"))
    fs.mkdirSync(path.join(activeHomeDir, ".eidolon"), { recursive: true })
    fs.writeFileSync(
      path.join(activeHomeDir, ".eidolon", "llm-provider.json"),
      JSON.stringify(
        {
          providers: [
            {
              id: "fhl_mom",
              adapter: "openai-responses",
              options: {
                baseURL: "https://www.fhl.mom",
                apiKey: "k-fhl",
              },
              models: [
                {
                  id: "gpt-5.5",
                  limits: { context: 400000, output: 128000 },
                  options: {
                    serviceTier: "priority",
                    store: false,
                    reasoningEffort: "high",
                  },
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
      path.join(activeHomeDir, ".eidolon", "agent-present.json"),
      JSON.stringify(
        {
          preset: "default",
          presets: {
            default: {
              main: {
                model: "fhl_mom/gpt-5.5",
              },
            },
          },
        },
        null,
        2,
      ),
    )
    process.env.HOME = activeHomeDir

    const adapterCalls: Array<{
      adapterType: string
      overrides?: { apiKey?: string; baseUrl?: string; model?: string; options?: Record<string, unknown> }
    }> = []
    __setLlmAdapterFactoryForTest(async (adapterType, _workDir, overrides) => {
      adapterCalls.push({ adapterType, overrides })
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
    expect(adapterCalls[0]).toEqual({
      adapterType: "codex",
      overrides: {
        apiKey: "k-fhl",
        baseUrl: "https://www.fhl.mom",
        model: "gpt-5.5",
        options: {
          baseURL: "https://www.fhl.mom",
          apiKey: "k-fhl",
          serviceTier: "priority",
          store: false,
          reasoningEffort: "high",
        },
      },
    })

    const reply = await runtime!.turn("hello")
    expect(reply).toContain("ok")
  })

  it("resolves explicit provider/model runtime config without falling back to the default provider", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-runtime-composer-home-"))
    fs.mkdirSync(path.join(activeHomeDir, ".eidolon"), { recursive: true })
    fs.writeFileSync(
      path.join(activeHomeDir, ".eidolon", "llm-provider.json"),
      JSON.stringify(
        {
          providers: [
            {
              id: "openai",
              adapter: "openai",
              options: { baseURL: "https://api.openai.example/v1", apiKey: "k-openai" },
              models: [{ id: "gpt-4o", limits: { context: 128000, output: 8192 } }],
            },
            {
              id: "fhl_mom",
              adapter: "openai-responses",
              options: {
                baseURL: "https://www.fhl.mom",
                apiKey: "k-fhl",
              },
              models: [
                {
                  id: "gpt-5.5",
                  limits: { context: 400000, output: 128000 },
                  options: {
                    serviceTier: "priority",
                    store: false,
                    reasoningEffort: "high",
                  },
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
      path.join(activeHomeDir, ".eidolon", "agent-present.json"),
      JSON.stringify(
        {
          "default-preset": "default",
          presets: {
            default: {
              primary: {
                model: "openai/gpt-4o",
              },
            },
          },
        },
        null,
        2,
      ),
    )
    process.env.HOME = activeHomeDir

    const adapterCalls: Array<{
      adapterType: string
      overrides?: { apiKey?: string; baseUrl?: string; model?: string; options?: Record<string, unknown> }
    }> = []
    __setLlmAdapterFactoryForTest(async (adapterType, _workDir, overrides) => {
      adapterCalls.push({ adapterType, overrides })
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
      model: "fhl_mom/gpt-5.5",
      mcp: false,
    })

    const runtime = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtime).toBeTruthy()
    expect(adapterCalls[0]).toEqual({
      adapterType: "codex",
      overrides: {
        apiKey: "k-fhl",
        baseUrl: "https://www.fhl.mom",
        model: "gpt-5.5",
        options: {
          baseURL: "https://www.fhl.mom",
          apiKey: "k-fhl",
          serviceTier: "priority",
          store: false,
          reasoningEffort: "high",
        },
      },
    })

    const reply = await runtime!.turn("hello")
    expect(reply).toContain("ok")
  })

  it("uses primary preset model as the startup model without a code default provider", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-runtime-composer-home-"))
    fs.mkdirSync(path.join(activeHomeDir, ".eidolon"), { recursive: true })
    fs.writeFileSync(
      path.join(activeHomeDir, ".eidolon", "llm-provider.json"),
      JSON.stringify(
        {
          providers: [
            {
              id: "ee-new-api",
              adapter: "openai-responses",
              options: { baseURL: "https://ee.example.test/v1", apiKey: "k-ee" },
              models: [{ id: "gpt-5.5", limits: { context: 400000, output: 128000 } }],
            },
          ],
        },
        null,
        2,
      ),
    )
    fs.writeFileSync(
      path.join(activeHomeDir, ".eidolon", "agent-present.json"),
      JSON.stringify(
        {
          "default-preset": "default",
          presets: {
            default: {
              primary: {
                model: "ee-new-api/gpt-5.5",
              },
            },
          },
        },
        null,
        2,
      ),
    )
    process.env.HOME = activeHomeDir

    const adapterCalls: Array<{
      adapterType: string
      overrides?: { apiKey?: string; baseUrl?: string; model?: string; options?: Record<string, unknown> }
    }> = []
    __setLlmAdapterFactoryForTest(async (adapterType, _workDir, overrides) => {
      adapterCalls.push({ adapterType, overrides })
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
    expect(adapterCalls[0]).toEqual({
      adapterType: "codex",
      overrides: {
        apiKey: "k-ee",
        baseUrl: "https://ee.example.test/v1",
        model: "gpt-5.5",
        options: {
          baseURL: "https://ee.example.test/v1",
          apiKey: "k-ee",
        },
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
              id: "codeflicker",
              adapter: "codex",
              options: { baseURL: "http://127.0.0.1:8018/v1", apiKey: "dummy" },
              models: [{ id: "wanqing/gpt-5.4", limits: { context: 128000, output: 8192 } }],
            },
            {
              id: "codex",
              adapter: "openai",
              options: { baseURL: "http://127.0.0.1:8019/v1", apiKey: "dummy-openai" },
              models: [{ id: "named-like-codex", limits: { context: 128000, output: 8192 } }],
            },
          ],
        },
        null,
        2,
      ),
    )
    fs.writeFileSync(
      path.join(activeHomeDir, ".eidolon", "agent-present.json"),
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
      path.join(activeHomeDir, ".eidolon", "agent-present.json"),
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
    expect(systemPrompt).not.toContain("动态加载；每轮从 .eidolon/skills 重新读取")
    expect(systemPrompt).not.toContain("可用 Skill")

    const memberList = await runtime!.turn("/member list")
    expect(memberList).toContain("\"member_count\":0")
  })

  it("merges standalone resource Agents into the same Terminal runtime assembly", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir
    writeStandaloneAgentResourcePackage(activeWorkdir)

    const observedAgentConfigs: Array<Record<string, any>> = []
    __setRuntimeAssemblyFactoryForTest((context) => {
      observedAgentConfigs.push(context.loadedAgents)
      return assembleAiCodingRuntimeProfile(context)
    })
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "ok" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    configureTerminalRuntime({ workDir: activeWorkdir, mcp: false })
    const runtime = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtime).toBeTruthy()

    const resourceAgent = observedAgentConfigs.at(-1)?.["resource://eidolon.terminal.fixture.Agent"]
    expect(resourceAgent).toMatchObject({
      name: "resource://eidolon.terminal.fixture.Agent",
      description: "Terminal resource Agent",
      tools: [],
      prompt: [],
      requireExactTools: true,
      seedMessages: [{
        role: "system",
        content: "Use the exact Terminal resource context.",
      }],
    })
  })

  it("reuses one request observation binding across initial and refreshed adapters and disposes it", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    const providerPath = path.join(activeHomeDir, ".eidolon", "llm-provider.json")
    const providerConfig = JSON.parse(fs.readFileSync(providerPath, "utf-8"))
    providerConfig.providers[0].models.push({ id: "second-model", limits: { context: 128000, output: 8192 } })
    fs.writeFileSync(providerPath, JSON.stringify(providerConfig, null, 2))

    const port = { append: () => {} }
    const adapterPorts: unknown[] = []
    const requestExecutionIdentities: Array<Record<string, string>> = []
    let bindingCalls = 0
    let disposeCalls = 0
    __setLlmAdapterFactoryForTest(async (adapterType, _workDir, _overrides, providerRuntime) => {
      adapterPorts.push(providerRuntime?.requestObservationPort)
      return {
        type: adapterType,
        async createStream(options: { executionIdentity?: Record<string, string> }) {
          requestExecutionIdentities.push(options.executionIdentity ?? {})
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
      providerRequestObservationBindingFactory: (context) => {
        bindingCalls += 1
        expect(context.sessionId).toBe("composer-adoption")
        expect(context.sessionDir).toContain(path.join(".eidolon", "sessions", "composer-adoption"))
        return { port, dispose: () => { disposeCalls += 1 } }
      },
    })

    const runtime = await getTerminalRuntimeBridge("composer-adoption")
    expect(runtime).toBeTruthy()
    expect(bindingCalls).toBe(1)
    expect(adapterPorts).toEqual([port])

    await runtime!.turn("before refresh")

    await runtime!.setActorActiveModel?.({}, { providerID: "openai", modelID: "second-model" })
    expect(adapterPorts).toEqual([port, port])
    await runtime!.turn("after refresh")

    expect(requestExecutionIdentities).toHaveLength(2)
    expect(requestExecutionIdentities.every((identity) => Boolean(identity.actorId))).toBe(true)
    expect(requestExecutionIdentities.every((identity) => Boolean(identity.turnId))).toBe(true)
    expect(requestExecutionIdentities.every((identity) => Boolean(identity.operationId))).toBe(true)
    expect(requestExecutionIdentities.every((identity) => Boolean(identity.requestId))).toBe(true)
    expect(new Set(requestExecutionIdentities.map((identity) => identity.requestId)).size).toBe(2)
    expect(requestExecutionIdentities.map((identity) => identity.actorId)).not.toContain("actor")
    expect(requestExecutionIdentities.map((identity) => identity.turnId)).not.toContain("turn")

    await disposeTerminalRuntimeBridge("composer-adoption")
    expect(disposeCalls).toBe(1)
  })

  it("consumes /work-mode locally without provider calls or semantic history", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    let providerCalls = 0
    let providerMessages: Array<{ role?: string; content?: string }> = []
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: { messages?: Array<{ role?: string; content?: string }> }) {
        providerCalls += 1
        providerMessages = options.messages ?? []
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

    const commandOutput = await runtime!.turn("/work-mode plan")
    expect(commandOutput).toContain("work_mode: plan")
    expect(providerCalls).toBe(0)

    await runtime!.turn("hello")
    expect(providerCalls).toBe(1)
    expect(providerMessages.some((message) => String(message.content ?? "").includes("work_mode: plan"))).toBe(true)
    expect(providerMessages.some((message) => String(message.content ?? "").includes("/work-mode plan"))).toBe(false)
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

  it("does not expose a terminal runtime-prompt mutation capability", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    __setLlmAdapterFactoryForTest(async (adapterType) => ({
      type: adapterType,
      async createStream() {
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
    expect("injectRuntimeHint" in runtime!).toBe(false)
  })

  it("keeps provider tool results independent from TUI display projection", async () => {
    activeWorkdir = makeTempWorkdir()
    activeHomeDir = makeTempHomeDir()
    process.env.HOME = activeHomeDir

    const fullToolOutput = [
      "TOOL_OUTPUT_START",
      "A".repeat(8_000),
      "TOOL_OUTPUT_END_SENTINEL",
    ].join("\n")
    const uiPreview = fullToolOutput.slice(0, 64)
    const providerToolContents: string[] = []

    __setRuntimeAssemblyFactoryForTest((context) => {
      const assembly = assembleAiCodingRuntimeProfile(context)
      return {
        ...assembly,
        createRegistries: (options) => {
          const registries = assembly.createRegistries(options)
          const toolRegistry = new ToolFuncRegistry()
          toolRegistry.registerMany(registries.toolRegistry.list())
          toolRegistry.register({
            schema: {
              function: {
                name: "LongOutput",
                description: "Return a long deterministic output for projection isolation tests.",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: {},
                },
              },
            },
            run: async () => fullToolOutput,
          } as any)
          return {
            ...registries,
            toolRegistry,
          }
        },
      }
    })

    let providerCalls = 0
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: { messages?: Array<{ role?: string; content?: unknown }> }) {
        providerCalls += 1
        providerToolContents.push(
          ...(options.messages ?? [])
            .filter((message) => message.role === "tool")
            .map((message) => String(message.content ?? "")),
        )
        async function* stream() {
          if (providerCalls === 1) {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-long-output",
                        type: "function",
                        function: { name: "LongOutput", arguments: "{}" },
                      },
                    ],
                  },
                },
              ],
            } as any
            return
          }
          yield { choices: [{ delta: { content: "saw full tool result" } }] } as any
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

    const observedUiPayloads: string[] = []
    const sub = runtime!.subscribeHistoryEvents?.((event) => {
      if (event.stream !== "tool_call_result") return
      const payload = JSON.parse(event.payload)
      observedUiPayloads.push(String(payload.result ?? "").slice(0, 64))
    })
    try {
      const reply = await runtime!.turn("call the long output tool")
      expect(reply).toContain("saw full tool result")
    } finally {
      sub?.unsubscribe()
    }

    expect(observedUiPayloads).toContain(uiPreview)
    expect(providerToolContents.length).toBeGreaterThan(0)
    const deliveredToolContent = providerToolContents.find((content) => content.includes("TOOL_OUTPUT_START")) ?? ""
    expect(deliveredToolContent).toContain("TOOL_OUTPUT_END_SENTINEL")
    expect(deliveredToolContent).not.toBe(uiPreview)
    expect(deliveredToolContent.length).toBe(fullToolOutput.length)
  })
})
