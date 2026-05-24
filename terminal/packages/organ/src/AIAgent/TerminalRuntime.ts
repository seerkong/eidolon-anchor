import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildDomainRuntimeSemanticBase,
  type DomainMessageHistoryEvent,
  DomainRuntimeEventGraph,
  DomainRuntimeHistoryGraph,
  type DomainRuntimeVm,
} from "@cell/ai-core-logic"
import {
  createRuntimeLlmAdapter,
  emitRuntimeDirectSlashAssistantOutput,
  createShellRuntimeFacade,
  createShellRuntimePaths,
  ensureShellRuntimeSessionDir,
  extractProviderOptions,
  loadMcpServers,
  loadProviderConfig,
  MCPManager,
  processRuntimeIngressStream,
  recoverOrCreateShellRuntime,
  setDebug,
  getConversationActorRawStateFromVm,
  getConversationSessionRawStateFromVm,
  materializeConversationHistoryMessagesFromVm,
  materializeConversationRuntimeMessagesFromVm,
  type LlmAdapterType,
} from "@cell/ai-organ-logic"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import type { ChatMessage } from "@shared/composer"
import {
  assembleRuntimeCompositionProfile,
  type RuntimeCompositionContext as RuntimeAssemblyContext,
  type RuntimeCompositionFactory,
  type RuntimeCompositionResult as RuntimeAssemblyResult,
  type RuntimeCompositionSlashCommand as RuntimeSlashCommandDescriptor,
  type RuntimeCompositionSlashRuntime as RuntimeSlashRuntime,
} from "@cell/membrane/runtime-composition"
import { aiCodingRuntimeProfile } from "@cell/mod-profiles"
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import type { Agent } from "@terminal/core/AIAgent"
import type { TuiControl, TuiEvent, TuiMessageCategory } from "@terminal/core/AIAgent/TuiStreamEvents"
import type { ExecApprovalMode } from "../stream/ExecProtocolGraph"
import { SemanticTerminalRuntimeBridge } from "../stream/SemanticTerminalRuntimeBridge"

export type RuntimeBridgeNotification = {
  text: string
  category?: TuiMessageCategory
}

export type RuntimeBridgeHistoryEvent = DomainMessageHistoryEvent

export type TuiRuntimeBridge = {
  agents?: () => Promise<Agent[]>
  slashCommands?: RuntimeSlashCommandDescriptor[]
  slashRuntime?: RuntimeSlashRuntime | null
  injectRuntimeHint?: (text: string) => Promise<void>
  turn: (
    input: string,
    opts?: {
      timeoutSeconds?: number
      onChunk?: (chunk: string) => void | Promise<void>
      onControl?: (control: TuiControl) => void | Promise<void>
    },
  ) => Promise<string>
  abort: () => Promise<void>
  dispose: () => void
  subscribeNotifications: (handler: (notification: RuntimeBridgeNotification) => void) => { unsubscribe: () => void }
  subscribeHistoryEvents?: (handler: (event: RuntimeBridgeHistoryEvent) => void) => { unsubscribe: () => void }
  loadConversationState?: () => Promise<{
    activeActorKey: string | null
    session: ReturnType<typeof getConversationSessionRawStateFromVm>
    actor: ReturnType<typeof getConversationActorRawStateFromVm>
    historyMessages: ChatMessage[]
    runtimeMessages: ChatMessage[]
  } | null>
  loadConversationViews?: () => Promise<{
    activeActorKey: string | null
    historyMessages: ChatMessage[]
    runtimeMessages: ChatMessage[]
  } | null>
}

export type TuiRuntimeConfig = {
  workDir: string
  adapter?: string
  model?: string
  timeoutSeconds?: number
  debug?: boolean
  mcp?: boolean
  ephemeral?: boolean
  metadata?: Record<string, unknown>
}

type ExecRuntimeMetadataOptions = {
  workDir: string
  approvalMode: ExecApprovalMode
  additionalWritableRoots?: string[]
  ephemeral?: boolean
  metadata?: Record<string, unknown>
}

type RuntimeProjectionMode = "textual" | "content"

const runtimeConfig: TuiRuntimeConfig = {
  workDir: process.cwd(),
  mcp: true,
  ephemeral: false,
  metadata: undefined,
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function resolveRuntimeAuthorityRoot(workDir: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
  return path.join(path.resolve(home), ".eidolon")
}

export function normalizeTerminalRuntimeMetadata(
  workDir: string,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = isPlainRecord(metadata) ? { ...metadata } : {}
  const localPermissions = isPlainRecord(normalized.local_permissions)
    ? { ...normalized.local_permissions }
    : isPlainRecord(normalized.localPermissions)
      ? { ...normalized.localPermissions }
      : {}

  const authorityRoot =
    typeof localPermissions.authority_root === "string" && localPermissions.authority_root.trim()
      ? localPermissions.authority_root
      : typeof localPermissions.authorityRoot === "string" && localPermissions.authorityRoot.trim()
        ? localPermissions.authorityRoot
        : resolveRuntimeAuthorityRoot(workDir)

  normalized.local_permissions = {
    ...localPermissions,
    authority_root: authorityRoot,
  }
  return normalized
}

export function buildExecRuntimeMetadata(options: ExecRuntimeMetadataOptions): Record<string, unknown> {
  const metadata = normalizeTerminalRuntimeMetadata(options.workDir, options.metadata)
  const sandboxPermissions = isPlainRecord(metadata.sandbox_permissions)
    ? { ...metadata.sandbox_permissions }
    : {}
  const execProtocol = isPlainRecord(metadata.exec_protocol)
    ? { ...metadata.exec_protocol }
    : {}

  metadata.sandbox_permissions = {
    ...sandboxPermissions,
    sandbox_mode: options.approvalMode === "dangerous" ? "danger-full-access" : "workspace-write",
    network_access: "enabled",
    approval_policy: "never",
  }
  metadata.exec_protocol = {
    ...execProtocol,
    mode: options.approvalMode,
    additional_writable_roots: [...(options.additionalWritableRoots ?? [])],
    ephemeral: options.ephemeral === true,
  }
  return metadata
}

const LLM_ADAPTER_TYPE = (process.env.LLM_ADAPTER || "openai").toLowerCase() as LlmAdapterType
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o"
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ""
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929"
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ""
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1"
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat"
const USE_MOCK = process.env.MOCK_OPENAI === "1"

const SKILLS_DESCRIPTION = "(dynamic; reloaded from .eidolon/skills each turn)"
const shellRuntimeFacade = createShellRuntimeFacade()

let llmAdapterFactoryOverride: null | ((adapterType: LlmAdapterType, workDir: string, overrides?: { apiKey?: string; baseUrl?: string }) => Promise<any>) = null
let runtimeAssemblyFactoryOverride: null | RuntimeCompositionFactory = null
const turnSemanticBridgeBySession = new Map<string, SemanticTerminalRuntimeBridge>()
const notificationSemanticBridgeBySession = new Map<string, SemanticTerminalRuntimeBridge>()
const runtimeCoordinationEmitterBySession = new Map<
  string,
  (payload: {
    from?: string
    coordination: string
    kind: string
    requestId: string
    status: string
    decision?: string
  }) => void
>()
const runtimeInboxInjectorBySession = new Map<
  string,
  (payload: { from: string; text: string; ts?: number; defer?: boolean }) => Promise<void>
>()
const runtimeDetachedDoneEmitterBySession = new Map<
  string,
  (payload: {
    taskId: string
    kind: "delegate" | "bash" | "tool_call"
    status: "completed" | "failed" | "cancelled"
    toolCallId?: string
    childFiberId?: string
    childActorKey?: string
    childActorId?: string
    outputText?: string
    error?: string
  }) => void
>()

export function __setLlmAdapterFactoryForTest(factory: null | ((adapterType: LlmAdapterType, workDir: string, overrides?: { apiKey?: string; baseUrl?: string }) => Promise<any>)) {
  llmAdapterFactoryOverride = factory
}

export function __setRuntimeAssemblyFactoryForTest(
  factory: null | RuntimeCompositionFactory,
) {
  runtimeAssemblyFactoryOverride = factory
}

function emitRuntimeCoordinationEventForTest(
  sessionKey: string,
  payload: {
    from?: string
    coordination: string
    kind: string
    requestId: string
    status: string
    decision?: string
  },
): boolean {
  const emit = runtimeCoordinationEmitterBySession.get(sessionKey)
  if (!emit) {
    return false
  }
  emit(payload)
  return true
}

export async function __sendRuntimeMemberInboxForTest(
  sessionKey: string,
  payload: { from: string; text: string; ts?: number; defer?: boolean },
): Promise<boolean> {
  const injector = runtimeInboxInjectorBySession.get(sessionKey)
  if (!injector) {
    return false
  }
  await injector(payload)
  return true
}

export async function __sendRuntimeCoordinationForTest(params: {
  sessionKey: string
  from: string
  coordination: "plan_approval" | "shutdown"
  kind: string
  payload: Record<string, unknown>
  requestId?: string
  defer?: boolean
  visibleNow?: boolean
}): Promise<boolean> {
  const coordination = params.coordination
  if (params.visibleNow) {
    return emitRuntimeCoordinationEventForTest(params.sessionKey, {
      from: params.from,
      coordination,
      kind:
        coordination === "plan_approval" && params.kind === "plan_request"
          ? "plan_approval_request"
          : coordination === "plan_approval" && params.kind === "plan_review"
            ? "plan_approval_result"
            : params.kind,
      requestId: params.requestId ?? `req_${Date.now()}`,
      status:
        coordination === "plan_approval"
          ? String(params.payload.plan ?? params.payload.feedback ?? "")
          : String(params.payload.reason ?? ""),
      decision:
        typeof params.payload.decision === "string"
          ? params.payload.decision
          : undefined,
    })
  }

  const outbound = shellRuntimeFacade.buildCoordinationOutbound({
    coordination,
    kind: params.kind,
    requestId: params.requestId,
    payload: params.payload,
  })

  return await __sendRuntimeMemberInboxForTest(params.sessionKey, {
    from: params.from,
    text: outbound.text,
    defer: params.defer,
  })
}

export function __emitRuntimeDetachedActorDoneForTest(
  sessionKey: string,
  payload: {
    taskId: string
    kind: "delegate" | "bash" | "tool_call"
    status: "completed" | "failed" | "cancelled"
    toolCallId?: string
    childFiberId?: string
    childActorKey?: string
    childActorId?: string
    outputText?: string
    error?: string
  },
): boolean {
  const emitter = runtimeDetachedDoneEmitterBySession.get(sessionKey)
  if (!emitter) {
    return false
  }
  emitter(payload)
  return true
}

export function __emitAsyncRuntimeDetachedActorDoneForTest(
  sessionKey: string,
  payload: {
    taskId: string
    kind: "delegate" | "bash" | "tool_call"
    status: "completed" | "failed" | "cancelled"
    toolCallId?: string
    childFiberId?: string
    childActorKey?: string
    childActorId?: string
    outputText?: string
    error?: string
  },
): boolean {
  const bridge = notificationSemanticBridgeBySession.get(sessionKey)
  if (!bridge) {
    return false
  }
  bridge.consumeSemanticEvent({
    ...buildDomainRuntimeSemanticBase({ agentKey: "main", agentActorId: "main" }, Date.now()),
    event_type: "semantic_background_result",
    background_result: {
      task_id: payload.taskId,
      status: payload.status,
      result_text: payload.outputText || payload.error || "",
    },
  })
  return true
}

function resolveTuiEventRouting(params: {
  vm: DomainRuntimeVm
  controlActor: { key: string; id: string }
  event: SemanticEvent
}): { visibleInTurn: boolean; notifyAsync: boolean } {
  return shellRuntimeFacade.routeProjectionEvent(params)
}

function resolveLlmAdapterType(cliAdapter?: string): LlmAdapterType {
  if (cliAdapter) {
    const normalized = cliAdapter.toLowerCase().replace(/-/g, "_")
    if (normalized === "openai" || normalized === "anthropic" || normalized === "codex" || normalized === "claude" || normalized === "deepseek" || normalized === "deep_seek") {
      return (normalized === "deep_seek" ? "deepseek" : normalized) as LlmAdapterType
    }
  }
  return LLM_ADAPTER_TYPE
}

function getConfigForAdapter(adapterType: LlmAdapterType) {
  if (adapterType === "anthropic" || adapterType === "claude") {
    return {
      apiKey: ANTHROPIC_API_KEY,
      baseUrl: ANTHROPIC_BASE_URL,
      model: ANTHROPIC_MODEL,
    }
  }
  if (adapterType === "deepseek") {
    return {
      apiKey: DEEPSEEK_API_KEY,
      baseUrl: DEEPSEEK_BASE_URL,
      model: DEEPSEEK_MODEL,
    }
  }
  return {
    apiKey: OPENAI_API_KEY,
    baseUrl: OPENAI_BASE_URL,
    model: OPENAI_MODEL,
  }
}

function buildSystemMessages(prompt: string[]) {
  return prompt.map((p) => ({ role: "system", content: p }))
}

async function createRuntimeBridge(
  sessionKey = "default",
  projection: RuntimeProjectionMode = "textual",
): Promise<TuiRuntimeBridge | null> {
  const paths = createShellRuntimePaths(runtimeConfig.workDir)
  const defaultRuntimeAssemblyFactory =
    runtimeAssemblyFactoryOverride
    ?? ((context: RuntimeAssemblyContext) => assembleRuntimeCompositionProfile(aiCodingRuntimeProfile, context))
  const bootstrapAssembly = defaultRuntimeAssemblyFactory({
    workDir: paths.WORKDIR,
    skillsDescription: SKILLS_DESCRIPTION,
    loadedAgents: {},
    delegateAgentDescriptions: "",
  })
  const runtimeSupport = bootstrapAssembly.runtimeSupport
  if (!runtimeSupport) {
    throw new Error("Runtime unavailable: runtime profile did not provide runtime support descriptor")
  }
  const agentLoader = runtimeSupport.createAgentLoader(paths.AGENTS_DIR)
  const runtimeAssemblyFactory = defaultRuntimeAssemblyFactory
  const runtimeAssembly = runtimeAssemblyFactory({
    workDir: paths.WORKDIR,
    skillsDescription: SKILLS_DESCRIPTION,
    loadedAgents: agentLoader.getAgents(),
    delegateAgentDescriptions: agentLoader.getDescriptions(),
  })
  const runtimeRegistries = runtimeAssembly.createRegistries({ includeInternalOnly: true })
  const runtimeAgents: Agent[] = Object.entries(runtimeAssembly.agentConfigs).map(([name, config]) => ({
    name,
    description: config.description,
    mode: "primary",
    permission: [],
    options: {},
  }))
  const slashCommandsByNamespace = new Map(
    runtimeAssembly.slashCommands.map((command) => [command.namespace, command] as const),
  )
  const enabledSlashNamespaces = new Set(
    runtimeAssembly.slashCommandSurfaces.map((surface) => surface.replace(/^\//, "")),
  )
  const slashRuntime = runtimeAssembly.createSlashRuntime(runtimeAssembly.slashCommands)

  setDebug(Boolean(runtimeConfig.debug))

  const baseAdapterType = resolveLlmAdapterType(runtimeConfig.adapter)
  const baseConfig = getConfigForAdapter(baseAdapterType)
  const baseModel = runtimeConfig.model || baseConfig.model
  const baseProviderConfig = await loadProviderConfig(baseAdapterType, paths.WORKDIR)
  const baseProviderId =
    baseAdapterType === "anthropic"
      ? "anthropic"
      : baseAdapterType === "claude"
        ? "claude"
        : baseAdapterType === "codex"
          ? "codex"
          : baseAdapterType === "deepseek"
            ? "deepseek"
            : "openai"
  const baseProviderOptions = extractProviderOptions(baseProviderConfig, baseProviderId)

  const fallbackModelConfig = {
    model: baseModel,
    provider: baseProviderId,
    adapter: baseAdapterType,
    baseUrl: baseProviderOptions.baseURL || baseConfig.baseUrl,
    apiKey: baseProviderOptions.apiKey || baseConfig.apiKey,
  }

  const modelConfig = runtimeSupport.resolveActorModelConfig({
    workDir: paths.WORKDIR,
    agentKey: "main",
    fallbackModelConfig,
    fallbackOverrideKeys: runtimeConfig.model ? ["model"] : [],
  })

  const adapterType = runtimeConfig.adapter ? baseAdapterType : modelConfig.adapter || baseAdapterType
  const llmAdapter = await createRuntimeLlmAdapter({
    adapterType,
    workDir: paths.WORKDIR,
    defaults: {
      openai: {
        apiKey: OPENAI_API_KEY,
        baseUrl: OPENAI_BASE_URL,
        model: OPENAI_MODEL,
      },
      anthropic: {
        apiKey: ANTHROPIC_API_KEY,
        baseUrl: ANTHROPIC_BASE_URL,
        model: ANTHROPIC_MODEL,
      },
      deepseek: {
        apiKey: DEEPSEEK_API_KEY,
        baseUrl: DEEPSEEK_BASE_URL,
        model: DEEPSEEK_MODEL,
      },
    },
    useMock: USE_MOCK,
    overrides: {
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.baseUrl,
    },
    factoryOverride: llmAdapterFactoryOverride,
  })

  if (!llmAdapter) {
    return null
  }

  let mcpManager: MCPManager | null = null
  if (runtimeConfig.mcp !== false) {
    const mcpServers = loadMcpServers(paths.MCP_DIR)
    if (Object.keys(mcpServers).length > 0) {
      mcpManager = new MCPManager(mcpServers)
      for (const name of Object.keys(mcpServers)) {
        await mcpManager.connectServer(name)
      }
    }
  }

  const sessionDir = runtimeConfig.ephemeral
    ? fs.mkdtempSync(path.join(os.tmpdir(), `eidolon-exec-${sessionKey}-`))
    : ensureShellRuntimeSessionDir(paths.WORKDIR, sessionKey)
  const isEphemeralSession = runtimeConfig.ephemeral === true
  const persistSnapshots = runtimeConfig.ephemeral !== true
  let sessionMaterialized = isEphemeralSession || fs.existsSync(sessionDir)

  const eventBus = new DomainRuntimeEventGraph()
  const toolRegistry = runtimeRegistries.toolRegistry
  const semanticRuntimeBridge = new SemanticTerminalRuntimeBridge()
  const asyncSemanticRuntimeBridge = new SemanticTerminalRuntimeBridge()
  turnSemanticBridgeBySession.set(sessionKey, semanticRuntimeBridge)
  notificationSemanticBridgeBySession.set(sessionKey, asyncSemanticRuntimeBridge)
  const actorCallbacks = {
    buildToolset: (currentVm: DomainRuntimeVm) => runtimeAssembly.buildToolset(currentVm),
    processStream: (_runtime: any, streamActor: any, stream: any) => {
      const currentType = (actor.llmClient as any)?.type
      const streamAdapterType =
        currentType === "openai" || currentType === "anthropic" || currentType === "claude" || currentType === "codex" || currentType === "deepseek"
          ? (currentType as LlmAdapterType)
          : adapterType
      return processRuntimeIngressStream({
        stream,
        adapterType: streamAdapterType,
        eventBus,
        actorMeta: {
          agentKey: streamActor.key,
          agentActorId: streamActor.id,
        },
      })
    },
  }
  const {
    actor,
    vm,
    driver,
    mainFiberId,
    saveSnapshot,
    effects: {
      messageHistoryEffect,
      orchestrationHistoryEffect,
    },
  } = await recoverOrCreateShellRuntime({
    workDir: paths.WORKDIR,
    sessionDir,
    sessionKey,
    llmClient: llmAdapter,
    systemPrompt: runtimeAssembly.systemPrompt,
    modelConfig,
    eventBus,
    registries: runtimeRegistries,
    runtimeSupport,
    actorCallbacks,
    buildSystemMessages,
    mcpManager: (mcpManager ?? undefined) as any,
    outerCtxMetadata: runtimeConfig.metadata,
  })
  runtimeCoordinationEmitterBySession.set(sessionKey, (payload) => {
    shellRuntimeFacade.emitCoordinationEvent({
      eventBus,
      controlActor: { key: actor.key, id: actor.id },
      payload: {
        from: payload.from,
        coordination: payload.coordination,
        kind: payload.kind,
        requestId: payload.requestId,
        status: payload.status,
        decision: payload.decision,
      },
    })
  })
  const runtimeCoordinator = shellRuntimeFacade.createRuntimeCoordinator({
    vm,
    driver,
    saveSnapshot,
  })
  const activateSessionMaterialization = () => {
    sessionMaterialized = true
  }
  const persistSnapshot = async () => {
    if (!persistSnapshots || !sessionMaterialized) return
    await runtimeCoordinator.saveSnapshot().catch(() => {})
  }
  runtimeInboxInjectorBySession.set(sessionKey, async (payload) => {
    await runtimeCoordinator.deliverMemberInbox({
      actor,
      mainFiberId,
      payload,
      foregroundMaxTicks: 20,
      foregroundMaxWallMs: 200,
    })
  })
  runtimeDetachedDoneEmitterBySession.set(sessionKey, (payload) => {
    shellRuntimeFacade.emitDetachedActorDone({
      eventBus,
      controlActor: { key: actor.key, id: actor.id },
      payload: {
        taskId: payload.taskId,
        kind: payload.kind,
        status: payload.status,
        toolCallId: payload.toolCallId,
        childFiberId: payload.childFiberId,
        childActorKey: payload.childActorKey,
        childActorId: payload.childActorId,
        outputText: payload.outputText,
        error: payload.error,
      },
    })
  })
  async function executeDirectSlashCommand(input: string): Promise<string | null> {
    const resolved = slashRuntime?.resolveCommand(input) ?? null
    if (!resolved || resolved.kind !== "direct_execute") return null
    if (!enabledSlashNamespaces.has(resolved.namespace)) return null
    const namespaceDescriptor = slashCommandsByNamespace.get(resolved.namespace)
    if (!namespaceDescriptor) return null
    const toolRegistry = vm.registries.toolRegistry
    if (!toolRegistry) {
      return "Error: tool registry unavailable"
    }
    if (resolved.action === "help") {
      return slashRuntime?.getNamespaceHelp(resolved.namespace) ?? null
    }

    const actionDescriptor = namespaceDescriptor.actions[resolved.action]
    if (!actionDescriptor) return null

    const payload = await ToolFuncRegistry.call(toolRegistry, actionDescriptor.toolName, vm, actor, resolved.args)
    return String(payload ?? "")
  }

  const notificationListeners = new Set<(notification: RuntimeBridgeNotification) => void>()
  const historyListeners = new Set<(event: RuntimeBridgeHistoryEvent) => void>()
  const runtimeHistoryGraph = new DomainRuntimeHistoryGraph()

  const emitNotification = (notification: RuntimeBridgeNotification) => {
    for (const listener of Array.from(notificationListeners)) listener(notification)
  }
  const emitHistoryEvent = (event: RuntimeBridgeHistoryEvent) => {
    for (const listener of Array.from(historyListeners)) listener(event)
  }
  const runtimeHistorySub = runtimeHistoryGraph.onHistoryEvent((event) => emitHistoryEvent(event))

  let activeTurn:
    | {
        cancelled: boolean
        settled: boolean
        settledPromise: Promise<void>
        resolveSettled: () => void
      }
    | null = null
  const subscribeProjectionEvents = (
    bridge: SemanticTerminalRuntimeBridge,
    handler: (event: TuiEvent) => void,
  ) => {
    return projection === "textual"
      ? bridge.onTextualEvent(handler)
      : bridge.onTuiEvent(handler)
  }
  let asyncNotificationCategory: TuiMessageCategory | undefined
  const asyncNotificationConsumer = subscribeProjectionEvents(asyncSemanticRuntimeBridge, (event: TuiEvent) => {
    if (activeTurn) return
    if (event.kind === "control") {
      asyncNotificationCategory = event.payload.category
      return
    }
    const text = String(event.payload ?? "")
    if (!text.trim()) return
    emitNotification({ text, category: asyncNotificationCategory })
  })

  const eventBusConsumer = eventBus.addConsumer((event) => {
    const routing = resolveTuiEventRouting({
      vm,
      controlActor: actor,
      event,
    })
    if (!routing.visibleInTurn) {
      return
    }
    semanticRuntimeBridge.consumeSemanticEvent(event)
    runtimeHistoryGraph.consumeSemanticEvent(event)
    if (event.event_type === "semantic_error" && activeTurn) {
      const message = event.error.message || event.error.detail_text || "runtime error"
      activeTurn.runtimeError = new Error(message)
    }
    if (!activeTurn && routing.notifyAsync) {
      asyncSemanticRuntimeBridge.consumeSemanticEvent(event)
    }
  })

  runtimeCoordinator.startBackgroundPump()

  const runTurn = async (timeoutSeconds?: number) => {
    const latestModelConfig = runtimeSupport.resolveActorModelConfig({
      workDir: paths.WORKDIR,
      agentKey: "main",
      fallbackModelConfig,
      fallbackOverrideKeys: runtimeConfig.model ? ["model"] : [],
    })
    const nextAdapterType = latestModelConfig.adapter || adapterType

    const currentType = (actor.llmClient as any)?.type
    const currentAdapterType =
      currentType === "openai" || currentType === "anthropic" || currentType === "claude" || currentType === "codex" || currentType === "deepseek"
        ? (currentType as LlmAdapterType)
        : adapterType

    const shouldRefreshAdapter =
      currentAdapterType !== nextAdapterType ||
      actor.modelConfig.apiKey !== latestModelConfig.apiKey ||
      actor.modelConfig.baseUrl !== latestModelConfig.baseUrl

    if (shouldRefreshAdapter) {
      const refreshed = await createRuntimeLlmAdapter({
        adapterType: nextAdapterType,
        workDir: paths.WORKDIR,
        defaults: {
          openai: {
            apiKey: OPENAI_API_KEY,
            baseUrl: OPENAI_BASE_URL,
            model: OPENAI_MODEL,
          },
          anthropic: {
            apiKey: ANTHROPIC_API_KEY,
            baseUrl: ANTHROPIC_BASE_URL,
            model: ANTHROPIC_MODEL,
          },
          deepseek: {
            apiKey: DEEPSEEK_API_KEY,
            baseUrl: DEEPSEEK_BASE_URL,
            model: DEEPSEEK_MODEL,
          },
        },
        useMock: USE_MOCK,
        overrides: {
          apiKey: latestModelConfig.apiKey,
          baseUrl: latestModelConfig.baseUrl,
        },
        factoryOverride: llmAdapterFactoryOverride,
      })
      if (refreshed) actor.llmClient = refreshed
    }

    actor.modelConfig = latestModelConfig
    await runtimeCoordinator.runInteractiveTurn({
      mainFiberId,
      timeoutMs: timeoutSeconds && timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
    })
  }

  let chain: Promise<void> = Promise.resolve()
  const turn = (
    input: string,
    opts?: {
      timeoutSeconds?: number
      onChunk?: (chunk: string) => void | Promise<void>
      onControl?: (control: TuiControl) => void | Promise<void>
    },
  ) => {
    let output = ""
    const execute = async () => {
      let resolveSettled = () => {}
      const turnState = {
        cancelled: false,
        runtimeError: null as Error | null,
        settled: false,
        settledPromise: new Promise<void>((resolve) => {
          resolveSettled = resolve
        }),
        resolveSettled: () => {
          if (turnState.settled) return
          turnState.settled = true
          resolveSettled()
        },
      }
      activeTurn = turnState
      let eventChain: Promise<void> = Promise.resolve()
      let eventChainPending = false
      let eventChainError: unknown = null
      const rememberEventChainError = (error: unknown) => {
        if (!eventChainError) eventChainError = error
      }
      const isPromiseLike = (value: unknown): value is PromiseLike<void> => {
        return !!value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function"
      }
      const handleProjectionEvent = (event: TuiEvent): void | Promise<void> => {
        if (turnState.cancelled) return
        if (event.kind === "control") {
          return opts?.onControl?.(event.payload)
        }
        const chunk = String(event.payload)
        output += chunk
        return opts?.onChunk?.(chunk)
      }
      const trackAsyncProjectionEvent = (promise: Promise<void>) => {
        eventChainPending = true
        const tracked = promise.catch(rememberEventChainError)
        eventChain = tracked
        void tracked.finally(() => {
          if (eventChain === tracked) {
            eventChainPending = false
          }
        })
      }
      const listener = subscribeProjectionEvents(semanticRuntimeBridge, (event: TuiEvent) => {
        if (eventChainPending) {
          trackAsyncProjectionEvent(eventChain.then(() => handleProjectionEvent(event)))
          return
        }

        try {
          const result = handleProjectionEvent(event)
          if (isPromiseLike(result)) {
            trackAsyncProjectionEvent(Promise.resolve(result))
          }
        } catch (error) {
          rememberEventChainError(error)
        }
      })
      try {
        const directOutput = await executeDirectSlashCommand(input)
        if (directOutput !== null) {
          activateSessionMaterialization()
          await persistSnapshot()
          emitRuntimeDirectSlashAssistantOutput({
            eventBus,
            messageHistoryEffect,
            actor: { key: actor.key, id: actor.id, type: actor.type },
            text: directOutput,
          })
          await eventChain
          if (eventChainError) throw eventChainError
          return output
        }
        const expanded = slashRuntime?.resolveCommand(input) ?? null
        const normalizedInput = expanded && expanded.kind === "prompt_expand" ? expanded.prompt : input
        activateSessionMaterialization()
        if (actor.hasPending("control")) {
          const pending = actor
            .drainMailbox("control")
            .find((entry: any) => entry?.kind === "questionnaire_pending" && typeof entry?.toolCallId === "string")
          if (pending?.toolCallId) {
            actor.send("toolResult", {
              toolCallId: pending.toolCallId,
              questionnaireId: pending.questionnaireId,
              content: normalizedInput,
            })
          } else {
            actor.send("humanInput", normalizedInput)
          }
        } else {
          actor.send("humanInput", normalizedInput)
        }
        const timeoutSeconds =
          opts?.timeoutSeconds !== undefined ? opts.timeoutSeconds : runtimeConfig.timeoutSeconds
        await runTurn(timeoutSeconds)
        await eventChain
        if (eventChainError) throw eventChainError
        if (turnState.runtimeError) {
          throw turnState.runtimeError
        }
      } finally {
        turnState.resolveSettled()
        if (activeTurn === turnState) activeTurn = null
        listener.unsubscribe()
      }
      return output
    }

    const queued = chain.then(() => execute(), () => execute())
    chain = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  const abort = async () => {
    const turnState = activeTurn
    if (turnState) {
      turnState.cancelled = true
    }
    actor.send("control", { kind: "cancel_requested" } as any)
    for (const childActor of Object.values(vm.actors)) {
      if (!childActor || childActor === actor) continue
      if (childActor.type !== "delegate") continue
      childActor.send("control", { kind: "shutdown_requested" } as any)
      driver.resumeFiber(`${childActor.key}:${childActor.id}`, Date.now())
    }
    const now = Date.now()
    driver.resumeFiber(mainFiberId, now)
    await driver.tickUntilForegroundSettled({ now, maxTicks: 20, maxWallMs: 250 }).catch(() => {})
    await turnState?.settledPromise
  }

  const dispose = () => {
    void persistSnapshot()
    runtimeCoordinator.dispose()
    eventBusConsumer.unsubscribe()
    runtimeCoordinationEmitterBySession.delete(sessionKey)
    asyncNotificationConsumer.unsubscribe()
    turnSemanticBridgeBySession.delete(sessionKey)
    notificationSemanticBridgeBySession.delete(sessionKey)
    runtimeInboxInjectorBySession.delete(sessionKey)
    runtimeDetachedDoneEmitterBySession.delete(sessionKey)
    runtimeHistorySub.unsubscribe()
    runtimeHistoryGraph.dispose()
    asyncSemanticRuntimeBridge.dispose()
    semanticRuntimeBridge.dispose()
    eventBus.complete()
    eventBus.dispose()
    if (mcpManager) mcpManager.closeAll()
    if (isEphemeralSession) {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  }

  const subscribeNotifications = (handler: (notification: RuntimeBridgeNotification) => void) => {
    notificationListeners.add(handler)
    return { unsubscribe: () => notificationListeners.delete(handler) }
  }
  const subscribeHistoryEvents = (handler: (event: RuntimeBridgeHistoryEvent) => void) => {
    historyListeners.add(handler)
    return { unsubscribe: () => historyListeners.delete(handler) }
  }

  const loadConversationViews = async () => {
    const state = await loadConversationState()
    if (!state) {
      return null
    }
    return {
      activeActorKey: state.activeActorKey,
      historyMessages: state.historyMessages,
      runtimeMessages: state.runtimeMessages,
    }
  }

  const loadConversationState = async () => {
    const session = getConversationSessionRawStateFromVm({ vm, sessionId: sessionKey })
    const activeActorKey =
      session?.activeActorKey
      ?? Object.keys(session?.actorBindings ?? {})[0]
      ?? actor.key
      ?? null
    if (!activeActorKey) {
      return null
    }
    return {
      activeActorKey,
      session,
      actor: getConversationActorRawStateFromVm({ vm, sessionId: sessionKey, actorKey: activeActorKey }),
      historyMessages: materializeConversationHistoryMessagesFromVm({ vm, actorKey: activeActorKey }),
      runtimeMessages: materializeConversationRuntimeMessagesFromVm({ vm, actorKey: activeActorKey }),
    }
  }

  const injectRuntimeHint = async (text: string) => {
    const normalized = String(text ?? "").trim()
    if (!normalized) return
    activateSessionMaterialization()
    await runtimeCoordinator.deliverMemberInbox({
      actor,
      mainFiberId,
      payload: {
        from: "",
        text: `Runtime hint:\n${normalized}`,
        ts: Date.now(),
      },
      foregroundMaxTicks: 20,
      foregroundMaxWallMs: 250,
    })
  }

  return {
    agents: async () => runtimeAgents,
    slashCommands: runtimeAssembly.slashCommands,
    slashRuntime,
    injectRuntimeHint,
    turn,
    abort,
    dispose,
    subscribeNotifications,
    subscribeHistoryEvents,
    loadConversationState,
    loadConversationViews,
  }
}

const sessionRuntimePromises = new Map<string, Promise<TuiRuntimeBridge | null>>()

function runtimeCacheKey(sessionKey: string, projection: RuntimeProjectionMode): string {
  return `${projection}:${sessionKey}`
}

async function getRuntimeBridge(sessionKey: string, projection: RuntimeProjectionMode) {
  const cacheKey = runtimeCacheKey(sessionKey, projection)
  const existing = sessionRuntimePromises.get(cacheKey)
  if (existing) {
    return existing
  }

  const created = createRuntimeBridge(sessionKey, projection)
  sessionRuntimePromises.set(cacheKey, created)
  return created
}

async function disposeRuntimeBridge(sessionKey: string, projection: RuntimeProjectionMode) {
  const cacheKey = runtimeCacheKey(sessionKey, projection)
  const runtimePromise = sessionRuntimePromises.get(cacheKey)
  sessionRuntimePromises.delete(cacheKey)
  if (!runtimePromise) {
    return
  }
  const runtime = await runtimePromise.catch(() => null)
  runtime?.dispose()
}

export async function getTuiRuntimeBridge(sessionKey = "default") {
  return getRuntimeBridge(sessionKey, "content")
}

export async function getTextualRuntimeBridge(sessionKey = "default") {
  return getRuntimeBridge(sessionKey, "textual")
}

export async function disposeTuiRuntimeBridge(sessionKey = "default") {
  await disposeRuntimeBridge(sessionKey, "content")
}

export async function disposeTextualRuntimeBridge(sessionKey = "default") {
  await disposeRuntimeBridge(sessionKey, "textual")
}

export function configureTuiRuntime(config: TuiRuntimeConfig) {
  runtimeConfig.workDir = config.workDir
  runtimeConfig.adapter = config.adapter
  runtimeConfig.model = config.model
  runtimeConfig.timeoutSeconds = config.timeoutSeconds
  runtimeConfig.debug = config.debug
  runtimeConfig.mcp = config.mcp
  runtimeConfig.ephemeral = config.ephemeral === true
  runtimeConfig.metadata = normalizeTerminalRuntimeMetadata(config.workDir, config.metadata)
  sessionRuntimePromises.clear()
}

export type TerminalRuntimeBridge = TuiRuntimeBridge
export type TerminalRuntimeConfig = TuiRuntimeConfig

export const getTerminalRuntimeBridge = getTextualRuntimeBridge
export const disposeTerminalRuntimeBridge = disposeTextualRuntimeBridge
export const configureTerminalRuntime = configureTuiRuntime
