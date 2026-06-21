import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "bun:test"
import type { Part } from "@terminal/core/AIAgent"
import type {
  RuntimeCompositionCatalogBundle as RuntimeCatalogConfigBundle,
  RuntimeCompositionSlashCommand as SlashCommandDescriptor,
} from "@cell/membrane/runtime-composition"
import {
  applyConversationCompaction,
  chatMessagesToCommittedHistoryRefs,
  LocalFileConversationPersistenceRepositoryFactory,
} from "@cell/ai-support"
import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION } from "@cell/ai-organ-contract"
import type { ConversationPersistenceRepository } from "@cell/ai-organ-contract"
import { createAiSlashRuntime } from "@cell/mod-ai-kernel"
import { parseProviderCatalogRaw } from "@cell/ai-organ-logic/llm"
import { __setRuntimeBridgeFactoryForTest, createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"
import { __setRuntimeCatalogAssemblyFactoryForTest } from "../src/runtime/catalog/TuiRuntimeCatalog"
import type { TuiRuntimeBridge } from "../src/runtime/bridge/TuiRuntime"

const originalHome = process.env.HOME

type TestRuntimeBridge = TuiRuntimeBridge

/**
 * Test fixture writer: seeds conversation persistence files from a message
 * list. The runtime bootstrap-backfill helper was deleted with the one-way
 * recovery handoff (spec recovery-one-way-handoff/no-bootstrap-backfill);
 * tests that need pre-existing conversation files write them directly here.
 */
async function bootstrapConversationHistoryFixture(params: {
  sessionId: string
  actorKey: string
  actorId: string
  messages: any[]
  repository: ConversationPersistenceRepository
}): Promise<void> {
  const historyIndex = await params.repository.loadHistoryIndex()
  if (historyIndex.heads[params.actorKey]?.activeGenerationId) {
    return
  }

  const sessionIndex = await params.repository.loadSessionIndex()
  const generationId = `${params.actorKey}__active`
  const nowIso = new Date().toISOString()
  const committedMessages = chatMessagesToCommittedHistoryRefs({
    messages: params.messages,
    actorKey: params.actorKey,
    actorId: params.actorId,
    recordIdPrefix: generationId,
  })

  await params.repository.writeHistoryGeneration({
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    generationId,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    parentGenerationId: null,
    predecessorGenerationIds: [],
    createdReason: "bootstrap",
    sealed: false,
    messageCount: committedMessages.length,
    messages: committedMessages,
    createdAt: nowIso,
    updatedAt: nowIso,
  })

  historyIndex.heads[params.actorKey] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    activeGenerationId: generationId,
    visibleGenerationIds: [generationId],
    updatedAt: nowIso,
  }
  historyIndex.lineages[generationId] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    generationId,
    parentGenerationId: null,
    rolledBackFromGenerationId: null,
    predecessorGenerationIds: [],
    successorGenerationIds: [],
    forkGenerationIds: [],
    branchLabel: null,
    updatedAt: nowIso,
  }
  historyIndex.generations[generationId] = {
    generationId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    sealed: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  }
  historyIndex.updatedAt = nowIso
  await params.repository.writeHistoryIndex(historyIndex)

  sessionIndex.session.activeActorKey = sessionIndex.session.activeActorKey ?? params.actorKey
  sessionIndex.session.actorBindings[params.actorKey] = {
    actorKey: params.actorKey,
    actorId: params.actorId,
    boundAt: nowIso,
    historyHeadGenerationId: generationId,
    promptHeadGenerationId:
      sessionIndex.session.actorBindings[params.actorKey]?.promptHeadGenerationId ?? null,
  }
  sessionIndex.session.activeSelection = {
    sessionId: params.sessionId,
    activeActorKey: params.actorKey,
    historyHeadGenerationId: generationId,
    promptHeadGenerationId:
      sessionIndex.session.actorBindings[params.actorKey]?.promptHeadGenerationId ?? null,
    selectedAt: nowIso,
  }
  sessionIndex.session.updatedAt = nowIso
  sessionIndex.updatedAt = nowIso
  await params.repository.writeSessionIndex(sessionIndex)
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function createTempProject() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-anchor-tui-"))
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-anchor-home-"))
  fs.mkdirSync(path.join(homeDir, ".eidolon"), { recursive: true })
  fs.writeFileSync(
    path.join(homeDir, ".eidolon", "llm-provider.json"),
    JSON.stringify(
      {
        providers: [
          {
            id: "openai",
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
    path.join(homeDir, ".eidolon", "agent-present.json"),
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
  process.env.HOME = homeDir
  return { workDir, homeDir }
}

afterEach(() => {
  __setRuntimeBridgeFactoryForTest(null)
  __setRuntimeCatalogAssemblyFactoryForTest(null)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
})

const MEMBER_LIST_SLASH_COMMANDS: SlashCommandDescriptor[] = [
  {
    namespace: "member",
    actions: {
      list: {
        toolName: "MemberList",
        parse: { kind: "literal", form: "list" },
        help: "`/member list` List members",
      },
    },
  },
]

describe("TuiRuntimeClient local-runtime mode", () => {
  it("tracks prompt history from user_input facts and usage signal updates", async () => {
    const { workDir } = createTempProject()
    let historyHandler: ((event: any) => void) | undefined
    let usageHandler: ((usage: any) => void) | undefined

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(input: string, opts?: { onControl?: (control: { cmd: "NewMessage"; category?: string }) => void; onChunk?: (chunk: string) => void }) {
        historyHandler?.({
          stream: "user_input",
          payload: input,
          startAt: 11,
          endAt: 11,
          agentKey: "main",
          agentActorId: "actor-main",
        })
        usageHandler?.({
          prompt_tokens: 42,
          completion_tokens: 0,
          total_tokens: 42,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          is_estimated: true,
        })
        await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
        await opts?.onChunk?.("ok")
        return "ok"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
      subscribeHistoryEvents(handler: (event: any) => void) {
        historyHandler = handler
        return { unsubscribe() { historyHandler = undefined } }
      },
      subscribeUsage(handler: (usage: any) => void) {
        usageHandler = handler
        return { unsubscribe() { usageHandler = undefined } }
      },
    }) as TestRuntimeBridge)

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })
    const events: any[] = []
    const unsub = sdk.event.on((event) => events.push(event))
    const session = await sdk.client.session.create({})

    await sdk.client.session.prompt({
      sessionID: session.data?.id,
      parts: [{ id: "p1", type: "text", text: "事实输入" } as Part],
    })

    const inputs = await sdk.client.session.userInputs({ sessionID: session.data?.id })
    expect(inputs.data?.map((entry) => entry.text)).toEqual(["事实输入"])
    expect(events.some((event) => event.type === "session.user_input" && event.properties.text === "事实输入")).toBe(true)
    expect(events.some((event) => event.type === "session.usage" && event.properties.usage.total_tokens === 42)).toBe(true)
    unsub()
  })

  it("uses local provider config instead of mock metadata", async () => {
    const { workDir, homeDir } = createTempProject()
    let runtimeTurnModel: unknown

    __setRuntimeBridgeFactoryForTest(async () => ({
      async setActorActiveModel(_target, model) {
        runtimeTurnModel = model
        return {
          conversationLanes: [],
          actorLanes: [],
          selectedLaneId: "lane:primary",
          selectedTarget: { laneId: "lane:primary" },
          questionnaireSurface: [],
        }
      },
      async turn(_input: string, opts?: { onControl?: (control: { cmd: "NewMessage"; category?: string }) => void; onChunk?: (chunk: string) => void }) {
        await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
        await opts?.onChunk?.("真实回复")
        return "真实回复"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
    }) as TestRuntimeBridge)

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const configProviders = await sdk.client.config.providers()
    expect(configProviders.data!.providers[0]?.id).toBe("openai")
    expect(configProviders.data!.default.openai).toBe("deepseek-reasoner")

    const config = await sdk.client.config.get()
    expect(config.data!.model).toBe("openai/deepseek-reasoner")

    const session = await sdk.client.session.create({})
    expect(session.data?.title).toBe("Local Session")
    expect(session.data?.directory).toBe(workDir)

    await sdk.client.session.prompt({
      sessionID: session.data?.id,
      model: {
        providerID: "openai",
        modelID: "deepseek-reasoner",
      },
      parts: [{ id: "p1", type: "text", text: "你好" } as Part],
    })

    const messages = await sdk.client.session.messages({ sessionID: session.data?.id })
    const assistant = messages.data!.find((entry) => entry.info.role === "assistant")?.info
    const user = messages.data!.find((entry) => entry.info.role === "user")?.info

    expect(user?.role).toBe("user")
    expect(user && "model" in user ? user.model : undefined).toEqual({
      providerID: "openai",
      modelID: "deepseek-reasoner",
    })
    expect(assistant?.role).toBe("assistant")
    expect(assistant && "providerID" in assistant ? assistant.providerID : undefined).toBe("openai")
    expect(assistant && "modelID" in assistant ? assistant.modelID : undefined).toBe("deepseek-reasoner")
    expect(runtimeTurnModel).toEqual({
      providerID: "openai",
      modelID: "deepseek-reasoner",
    })
    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("uses primary agent preset as local runtime default model", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-anchor-tui-"))
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-anchor-home-"))
    fs.mkdirSync(path.join(homeDir, ".eidolon"), { recursive: true })
    fs.writeFileSync(
      path.join(homeDir, ".eidolon", "llm-provider.json"),
      JSON.stringify(
        {
          providers: [
            {
              id: "ee-new-api",
              adapter: "openai-responses",
              options: { baseURL: "https://ee.example.test/v1", apiKey: "test-key" },
              models: [{ id: "gpt-5.5", limits: { context: 400000, output: 128000 } }],
            },
          ],
        },
        null,
        2,
      ),
    )
    fs.writeFileSync(
      path.join(homeDir, ".eidolon", "agent-present.json"),
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
    process.env.HOME = homeDir

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const configProviders = await sdk.client.config.providers()
    expect(configProviders.data!.providers[0]?.id).toBe("ee-new-api")
    expect(configProviders.data!.default["ee-new-api"]).toBe("gpt-5.5")

    const config = await sdk.client.config.get()
    expect(config.data!.model).toBe("ee-new-api/gpt-5.5")

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("keeps prompt history visible when explicit model selection fails", async () => {
    const { workDir, homeDir } = createTempProject()
    let turnCalled = false

    __setRuntimeBridgeFactoryForTest(async () => ({
      async setActorActiveModel(_target, model) {
        throw new Error(`Provider not found: ${model.providerID}`)
      },
      async turn() {
        turnCalled = true
        return "should not run"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
    }) as TestRuntimeBridge)

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })
    const session = await sdk.client.session.create({})

    await sdk.client.session.prompt({
      sessionID: session.data?.id,
      model: {
        providerID: "fhl_mon",
        modelID: "gpt-5.5",
      },
      parts: [{ id: "p1", type: "text", text: "这条输入应当保留" } as Part],
    })

    const messages = await sdk.client.session.messages({ sessionID: session.data?.id })
    const user = messages.data!.find((entry) => entry.info.role === "user")
    const assistant = messages.data!.find((entry) => entry.info.role === "assistant")

    expect(turnCalled).toBe(false)
    expect(user?.parts.find((part) => part.type === "text")?.text).toBe("这条输入应当保留")
    expect(assistant?.parts.find((part) => part.type === "text")?.text).toContain("Runtime error: Provider not found: fhl_mon")
    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("uses the formal runtime catalog descriptor instead of a hidden local config truth", async () => {
    const { workDir, homeDir } = createTempProject()
    const customBundle: RuntimeCatalogConfigBundle = {
      providerConfig: parseProviderCatalogRaw({
        providers: [
          {
            id: "anthropic",
            options: { baseURL: "https://api.anthropic.example", apiKey: "anthropic-key" },
            models: [{ id: "claude-formal", limits: { context: 200000, output: 16000 } }],
          },
        ],
      }),
      presetConfig: {
        preset: "formal",
        presets: {
          formal: {
            main: {
              model: "anthropic/claude-formal",
            },
          },
        },
      },
    }

    __setRuntimeCatalogAssemblyFactoryForTest(() => ({
      agentConfigs: {
        reviewer: {
          name: "reviewer",
          description: "Formal reviewer",
          tools: ["Read"],
          prompt: ["Review carefully."],
        },
      },
      runtimeCatalog: {
        loadConfigBundle: () => customBundle,
      },
    }))
    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        return "ok"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
    }))

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const configProviders = await sdk.client.config.providers()
    expect(configProviders.data!.providers[0]?.id).toBe("anthropic")
    expect(configProviders.data!.default.anthropic).toBe("claude-formal")

    const config = await sdk.client.config.get()
    expect(config.data!.model).toBe("anthropic/claude-formal")

    const agents = await sdk.client.app.agents()
    expect(agents.data!).toEqual([
      expect.objectContaining({
        name: "reviewer",
        description: "Formal reviewer",
      }),
    ])

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("ignores TUI_FORCE_MOCK_RESPONDER and still uses the local runtime path", async () => {
    const { workDir, homeDir } = createTempProject()
    const previousForce = process.env.TUI_FORCE_MOCK_RESPONDER
    process.env.TUI_FORCE_MOCK_RESPONDER = "1"

    const turns: string[] = []
    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(input, opts) {
        turns.push(input)
        await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
        await opts?.onChunk?.("真实运行时回复")
        return "真实运行时回复"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
    }))

    try {
      const sdk = createTuiRuntimeClient({
        mode: "local-runtime",
        directory: workDir,
      })

      const session = await sdk.client.session.create({})
      await sdk.client.session.prompt({
        sessionID: session.data?.id,
        parts: [{ id: "p1", type: "text", text: "你是谁" } as Part],
      })

      expect(turns).toEqual(["你是谁"])

      const messages = await sdk.client.session.messages({ sessionID: session.data?.id })
      const texts = messages.data!.flatMap((entry) =>
        entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )

      expect(texts).toContain("你是谁")
      expect(texts).toContain("真实运行时回复")
      expect(texts.some((text) => text.includes("我是这个终端里的 AI 助手"))).toBe(false)
      expect(texts.some((text) => text.includes("收到："))).toBe(false)
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true })
      fs.rmSync(homeDir, { recursive: true, force: true })
      if (previousForce === undefined) delete process.env.TUI_FORCE_MOCK_RESPONDER
      else process.env.TUI_FORCE_MOCK_RESPONDER = previousForce
    }
  })

  it("uses runtime-provided slash descriptors to classify direct slash commands", async () => {
    const { workDir, homeDir } = createTempProject()

    __setRuntimeBridgeFactoryForTest(async () => ({
      slashCommands: MEMBER_LIST_SLASH_COMMANDS,
      slashRuntime: createAiSlashRuntime(MEMBER_LIST_SLASH_COMMANDS),
      async turn() {
        return "member-list-ok"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
    }))

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const session = await sdk.client.session.create({})
    await sdk.client.session.command({
      sessionID: session.data?.id,
      command: "member",
      arguments: "list",
    })

    const messages = await sdk.client.session.messages({ sessionID: session.data?.id })
    const roles = messages.data!.map((entry) => entry.info.role)

    expect(roles).toEqual(["assistant"])
    expect(messages.data![0]?.parts.some((part) => part.type === "text" && part.text.includes("member-list-ok"))).toBe(true)
    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("does not fall back to a hidden slash contract when the runtime provides no descriptors", async () => {
    const { workDir, homeDir } = createTempProject()

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        return "llm-fallback"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
    }))

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const session = await sdk.client.session.create({})
    await sdk.client.session.command({
      sessionID: session.data?.id,
      command: "member",
      arguments: "list",
    })

    const messages = await sdk.client.session.messages({ sessionID: session.data?.id })
    const roles = messages.data!.map((entry) => entry.info.role)

    expect(roles).toEqual(["user", "assistant"])
    expect(messages.data![0]?.parts.some((part) => part.type === "text" && part.text.includes("/member list"))).toBe(true)
    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("uses catalog agents without starting a default runtime bridge", async () => {
    const { workDir, homeDir } = createTempProject()
    let runtimeStarts = 0

    __setRuntimeBridgeFactoryForTest(async () => {
      runtimeStarts += 1
      return {
        async agents() {
          return [
            {
              name: "code",
              description: "Default code agent",
              mode: "primary",
              permission: [],
              options: {},
            },
          ]
        },
        async turn() {
          return "ok"
        },
        async abort() {},
        dispose() {},
        subscribeNotifications(_handler: any) {
          return { unsubscribe() {} }
        },
      }
    })

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const agents = await sdk.client.app.agents()
    expect(runtimeStarts).toBe(0)
    expect(agents.data!.some((agent) => agent.name === "code")).toBe(true)

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("emits an MCP initialization status while starting the local runtime bridge", async () => {
    const { workDir, homeDir } = createTempProject()
    const bridgeStart = deferred<TuiRuntimeBridge>()
    const statusMessages: string[] = []

    __setRuntimeBridgeFactoryForTest(async () => bridgeStart.promise)

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })
    const unsubscribe = sdk.event.on("session.status", (event) => {
      const message = event.properties?.status?.message
      if (typeof message === "string") {
        statusMessages.push(message)
      }
    })

    const session = await sdk.client.session.create({})
    const prompt = sdk.client.session.prompt({
      sessionID: session.data?.id,
      parts: [{ id: "input", type: "text", text: "hello" } as any],
    })
    await tick()

    expect(statusMessages).toContain("正在初始化 MCP...")

    bridgeStart.resolve({
      async turn() {
        return "ok"
      },
      async compact() {
        return { ok: true, message: "ok" }
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
    })
    await prompt
    unsubscribe()
    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("hydrates local session history from runtime conversation state before falling back to persistence", async () => {
    const { workDir, homeDir } = createTempProject()

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        return "ok"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
      async loadConversationState() {
        return {
          activeActorKey: "main",
          session: null,
          actor: null,
          historyMessages: [
            { role: "user", content: "runtime-first user" } as any,
            { role: "assistant", content: "runtime-first assistant" } as any,
          ],
          runtimeMessages: [
            { role: "system", content: "runtime prelude" } as any,
            { role: "user", content: "runtime-first user" } as any,
            { role: "assistant", content: "runtime-first assistant" } as any,
          ],
        }
      },
    }))

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const session = await sdk.client.session.create({})
    await sdk.client.session.abort({ sessionID: session.data?.id })
    const messages = await sdk.client.session.messages({ sessionID: session.data?.id })
    const texts = messages.data!.flatMap((entry) =>
      entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )

    expect(texts).toContain("runtime-first user")
    expect(texts).toContain("runtime-first assistant")
    expect(texts).not.toContain("runtime prelude")

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("hydrates persisted local session history without starting a runtime bridge", async () => {
    const { workDir, homeDir } = createTempProject()
    const sessionID = "persisted-no-runtime-start"
    const sessionDir = path.join(workDir, ".eidolon", "sessions", sessionID)
    fs.mkdirSync(sessionDir, { recursive: true })

    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    await bootstrapConversationHistoryFixture({
      sessionId: sessionID,
      actorKey: "main",
      actorId: "actor-main",
      messages: [
        { role: "user", content: "persisted first question" } as any,
        { role: "assistant", content: "persisted first answer" } as any,
      ],
      repository,
    })

    let runtimeStarts = 0
    __setRuntimeBridgeFactoryForTest(async () => {
      runtimeStarts += 1
      return {
        async turn() {
          return "ok"
        },
        async abort() {},
        dispose() {},
        subscribeNotifications(_handler: any) {
          return { unsubscribe() {} }
        },
      }
    })

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const messages = await sdk.client.session.messages({ sessionID })
    const texts = messages.data!.flatMap((entry) =>
      entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )

    expect(runtimeStarts).toBe(0)
    expect(texts).toContain("persisted first question")
    expect(texts).toContain("persisted first answer")

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("does not materialize a local session directory during runtime bootstrap alone", async () => {
    const { workDir, homeDir } = createTempProject()
    const sessionDir = path.join(workDir, ".eidolon", "sessions", "default")

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const agents = await sdk.client.app.agents()

    expect(agents.data!.length).toBeGreaterThan(0)
    expect(fs.existsSync(sessionDir)).toBe(false)

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("keeps empty created sessions unmaterialized and out of the session list until the first meaningful mutation", async () => {
    const { workDir, homeDir } = createTempProject()

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(_input: string, opts?: { onControl?: (control: { cmd: "NewMessage"; category?: string }) => void; onChunk?: (chunk: string) => void }) {
        await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
        await opts?.onChunk?.("materialized response")
        return "materialized response"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
    }) as TestRuntimeBridge)

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const created = await sdk.client.session.create({})
    const sessionID = created.data?.id ?? ""
    expect(created.data?.materialized).toBe(false)

    const before = await sdk.client.session.list()
    expect(before.data!.some((entry) => entry.id === sessionID)).toBe(false)

    await sdk.client.session.prompt({
      sessionID,
      parts: [{ id: "p1", type: "text", text: "hello materialized session" } as Part],
    })

    const info = await sdk.client.session.get({ sessionID })
    expect(info.data?.materialized).toBe(true)

    const after = await sdk.client.session.list()
    expect(after.data!.some((entry) => entry.id === sessionID && entry.materialized === true)).toBe(true)

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("does not reuse an already materialized legacy ses_1 when creating a new local session", async () => {
    const { workDir, homeDir } = createTempProject()
    const legacySessionDir = path.join(workDir, ".eidolon", "sessions", "ses_1")
    fs.mkdirSync(path.join(legacySessionDir, "conversation"), { recursive: true })
    fs.writeFileSync(
      path.join(legacySessionDir, "conversation", "session.index.json"),
      JSON.stringify({
        version: "2026-04-19",
        sessionId: "ses_1",
        session: {
          version: "2026-04-19",
          sessionId: "ses_1",
          activeActorKey: "main",
          actorBindings: {},
          contextAssetRegistry: null,
          contextAssets: [],
          activeSelection: null,
          createdAt: new Date(1_000).toISOString(),
          updatedAt: new Date(2_000).toISOString(),
        },
        lineage: null,
        updatedAt: new Date(2_000).toISOString(),
      }, null, 2),
    )

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const created = await sdk.client.session.create({})
    expect(created.data?.id).not.toBe("ses_1")
    expect(created.data?.id).toMatch(/^\d{14}__[0-9A-HJKMNP-TV-Z]{26}$/)

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("routes /resume to the session list surface instead of sending it to the runtime", async () => {
    const { workDir, homeDir } = createTempProject()
    const turns: string[] = []
    const events: Array<{ type?: string; properties?: Record<string, unknown> }> = []

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(input: string) {
        turns.push(input)
        return "should-not-run"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
    }))

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })
    const unsub = sdk.event.on((event) => events.push(event as any))

    try {
      await sdk.client.session.command({
        command: "resume",
      })

      expect(turns).toEqual([])
      expect(
        events.some((event) =>
          event.type === "tui.command.execute" && event.properties?.command === "session.list",
        ),
      ).toBe(true)
    } finally {
      unsub()
      fs.rmSync(workDir, { recursive: true, force: true })
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it("lists persisted local sessions and hydrates their messages from conversation persistence", async () => {
    const { workDir, homeDir } = createTempProject()
    const sessionID = "persisted-session"
    const sessionDir = path.join(workDir, ".eidolon", "sessions", sessionID)
    fs.mkdirSync(sessionDir, { recursive: true })

    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    const summary = "<state_snapshot><overall_goal>resume here</overall_goal></state_snapshot>"
    await applyConversationCompaction({
      sessionDir,
      actorKey: "main",
      actorId: "actor-main",
      compressedMessages: [
        { role: "user", content: summary } as any,
        { role: "assistant", content: "Understood." } as any,
        { role: "assistant", content: "tail message" } as any,
      ],
      summary,
      acknowledgedSummary: "Understood.",
      repository,
    })

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        return ""
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
    }))

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const sessions = await sdk.client.session.list()
    expect(sessions.data!.some((entry) => entry.id === sessionID)).toBe(true)

    const messages = await sdk.client.session.messages({ sessionID })
    const texts = messages.data!.flatMap((entry) =>
      entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )

    expect(texts).not.toContain(summary)
    expect(texts.some((text) => text.includes("tail message"))).toBe(true)
    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("returns persisted session info from session.get before creating a blank in-memory fallback", async () => {
    const { workDir, homeDir } = createTempProject()
    const sessionID = "persisted-get-session"
    const sessionDir = path.join(workDir, ".eidolon", "sessions", sessionID)
    fs.mkdirSync(sessionDir, { recursive: true })

    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    await bootstrapConversationHistoryFixture({
      sessionId: sessionID,
      actorKey: "main",
      actorId: "actor-main",
      messages: [
        {
          role: "user",
          content: "persisted info question",
          startAt: 100,
          endAt: 100,
        } as any,
        {
          role: "assistant",
          content: "persisted info answer",
          startAt: 200,
          endAt: 300,
        } as any,
      ],
      repository,
    })

    const sessionIndex = await repository.loadSessionIndex()
    sessionIndex.session.createdAt = new Date(100).toISOString()
    sessionIndex.session.updatedAt = new Date(300).toISOString()
    sessionIndex.updatedAt = new Date(300).toISOString()
    await repository.writeSessionIndex(sessionIndex)

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const info = await sdk.client.session.get({ sessionID })

    expect(info.data!.id).toBe(sessionID)
    expect(info.data!.materialized).toBe(true)
    expect(info.data!.time.created).toBe(100)
    expect(info.data!.time.updated).toBe(300)
    expect(info.data!.preview?.initialUserMessage).toBe("persisted info question")
    expect(info.data!.preview?.latestMessage).toBe("persisted info answer")

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("returns session previews with real created/updated timestamps, initial user question, and latest message", async () => {
    const { workDir, homeDir } = createTempProject()
    const sessionID = "preview-session"
    const sessionDir = path.join(workDir, ".eidolon", "sessions", sessionID)
    fs.mkdirSync(sessionDir, { recursive: true })

    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    await bootstrapConversationHistoryFixture({
      sessionId: sessionID,
      actorKey: "main",
      actorId: "actor-main",
      messages: [
        {
          role: "user",
          content: "How do I restore the previous session in the TUI?",
          startAt: 1000,
          endAt: 1000,
        } as any,
        {
          role: "assistant",
          content: "A".repeat(160),
          startAt: 2000,
          endAt: 2300,
        } as any,
      ],
      repository,
    })

    const sessionIndex = await repository.loadSessionIndex()
    sessionIndex.session.createdAt = new Date(1000).toISOString()
    sessionIndex.session.updatedAt = new Date(2300).toISOString()
    sessionIndex.updatedAt = new Date(2300).toISOString()
    await repository.writeSessionIndex(sessionIndex)

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const sessions = await sdk.client.session.list()
    const preview = sessions.data!.find((entry) => entry.id === sessionID)

    expect(preview).toBeDefined()
    expect(preview?.time.created).toBe(1000)
    expect(preview?.time.updated).toBe(2300)
    expect(preview?.preview?.initialUserMessage).toBe("How do I restore the previous session in the TUI?")
    expect(preview?.preview?.latestMessage).toBe("A".repeat(160))

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("persists session rename and delete actions for restored local sessions", async () => {
    const { workDir, homeDir } = createTempProject()
    const sessionID = "persisted-action-session"
    const sessionDir = path.join(workDir, ".eidolon", "sessions", sessionID)
    fs.mkdirSync(sessionDir, { recursive: true })

    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    await bootstrapConversationHistoryFixture({
      sessionId: sessionID,
      actorKey: "main",
      actorId: "actor-main",
      messages: [
        {
          role: "user",
          content: "rename then delete me",
          startAt: 1000,
          endAt: 1000,
        } as any,
        {
          role: "assistant",
          content: "ok",
          startAt: 2000,
          endAt: 2000,
        } as any,
      ],
      repository,
    })

    const firstClient = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })
    await firstClient.client.session.update({ sessionID, title: "Persisted Rename" })

    const renamedClient = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })
    const renamed = await renamedClient.client.session.list()
    const renamedSession = renamed.data?.find((entry) => entry.id === sessionID)
    expect(renamedSession?.title).toBe("Persisted Rename")
    expect(renamedSession?.preview?.initialUserMessage).toBe("rename then delete me")
    expect(renamedSession?.preview?.latestMessage).toBe("ok")

    await renamedClient.client.session.delete({ sessionID })

    const afterDeleteClient = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })
    const afterDelete = await afterDeleteClient.client.session.list()
    expect(afterDelete.data?.some((entry) => entry.id === sessionID)).toBe(false)

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("does not bootstrap transcript-only legacy sessions: conversation files are the single history source", async () => {
    const { workDir, homeDir } = createTempProject()
    const sessionID = "legacy-session"
    const sessionDir = path.join(workDir, ".eidolon", "sessions", sessionID)
    fs.mkdirSync(path.join(sessionDir, "runtime_state"), { recursive: true })

    // The actor transcript format has been removed: no runtime code knows
    // this path anymore, so recreate the residual legacy file literally.
    const legacyActorDir = path.join(sessionDir, "actors", "primary__actor-main")
    fs.mkdirSync(legacyActorDir, { recursive: true })
    fs.writeFileSync(
      path.join(legacyActorDir, "transcript.txt"),
      "@delimiter: ----\n---- #user\nlegacy user\n---- #assistant\nlegacy assistant\n",
    )

    fs.writeFileSync(
      path.join(sessionDir, "runtime_state", "manifest.json"),
      JSON.stringify(
        {
          controlActorKey: "main",
          actorFiles: {
            main: "main.actor.json",
          },
        },
        null,
        2,
      ),
    )
    fs.writeFileSync(
      path.join(sessionDir, "runtime_state", "main.actor.json"),
      JSON.stringify(
        {
          key: "main",
          id: "actor-main",
          type: "primary",
          identity: null,
        },
        null,
        2,
      ),
    )

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        return ""
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(_handler: any) {
        return { unsubscribe() {} }
      },
    }))

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const messages = await sdk.client.session.messages({ sessionID })
    const texts = messages.data!.flatMap((entry) =>
      entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )

    // One-way recovery handoff (spec recovery-one-way-handoff): the
    // conversation files are the single history source. A transcript-only
    // legacy session no longer backfills conversation files from the
    // transcript array — its legacy content does not hydrate, and no
    // conversation history head appears.
    expect(texts).not.toContain("legacy user")
    expect(texts.some((text) => text.includes("legacy assistant"))).toBe(false)

    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    const historyIndex = await repository.loadHistoryIndex()
    expect(historyIndex.heads.main?.activeGenerationId).toBeUndefined()
    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("forks a persisted session after hydrating its history", async () => {
    const { workDir, homeDir } = createTempProject()
    const sessionID = "persisted-fork-session"
    const sessionDir = path.join(workDir, ".eidolon", "sessions", sessionID)
    fs.mkdirSync(sessionDir, { recursive: true })

    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    await bootstrapConversationHistoryFixture({
      sessionId: sessionID,
      actorKey: "main",
      actorId: "actor-main",
      messages: [
        {
          role: "user",
          content: "fork this persisted session",
          startAt: 1000,
          endAt: 1000,
        } as any,
        {
          role: "assistant",
          content: "forked history should survive",
          startAt: 1200,
          endAt: 1400,
        } as any,
      ],
      repository,
    })

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory: workDir,
    })

    const forked = await sdk.client.session.fork({ sessionID })
    const messages = await sdk.client.session.messages({ sessionID: forked.data!.id })
    const texts = messages.data!.flatMap((entry) =>
      entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )

    expect(forked.data!.id).not.toBe(sessionID)
    expect(forked.data!.materialized).toBe(true)
    expect(texts).toContain("fork this persisted session")
    expect(texts).toContain("forked history should survive")

    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })
})
