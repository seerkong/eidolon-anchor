import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildActorSurfaceProjection,
  buildDomainRuntimeSemanticBase,
  createActorSurfaceFacade,
  type DomainMessageHistoryEvent,
  DomainRuntimeEventGraph,
  DomainRuntimeHistoryGraph,
  ensureVmRxData,
  isRuntimeStorageLogsEnabled,
  recoverHeartbeatSchedules,
  startHeartbeatSchedulerWorker,
  type DomainRuntimeVm,
} from "@cell/ai-core-logic"
import { applyActorModelConfigControlSignals, hasPendingAiAgentWakeMailbox, type AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import {
  createRuntimeLlmAdapter,
  createDefaultRuntimeHookHandlers,
  defaultProviderConfigPath,
  emitRuntimeDirectSlashAssistantOutput,
  forceCompressActorHistory,
  createShellRuntimeFacade,
  createShellRuntimePaths,
  ensureShellRuntimeSessionDir,
  extractProviderOptions,
  isPersistedModelStillResolvable,
  loadMcpServers,
  loadProviderCatalog,
  loadProviderConfig,
  PROVIDER_CONFIG_FILE_NAME,
  MCPManager,
  processRuntimeIngressStream,
  recoverOrCreateShellRuntime,
  refreshProviderTransportMarkers,
  setDebug,
  getConversationActorRawStateFromVm,
  getConversationSessionRawStateFromVm,
  materializeConversationHistoryMessagesFromVm,
  materializeConversationRuntimeMessagesFromVm,
  setActorWorkMode,
  type LlmAdapterType,
} from "@cell/ai-organ-logic"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import type { ChatMessage } from "@shared/composer"
import {
  assembleRuntimeCompositionProfile,
  buildRuntimeCompositionBindingDescriptor,
  type RuntimeCompositionBindingDescriptor,
  type RuntimeCompositionContext as RuntimeAssemblyContext,
  type RuntimeCompositionEntryType,
  type RuntimeCompositionFactory,
  type RuntimeCompositionResult as RuntimeAssemblyResult,
  type RuntimeCompositionSlashCommand as RuntimeSlashCommandDescriptor,
  type RuntimeCompositionSlashRuntime as RuntimeSlashRuntime,
  type RuntimeCompositionStorageFlags,
} from "@cell/membrane/runtime-composition"
import { aiCodingRuntimeProfile, resolveRuntimeProfileById } from "@cell/mod-profiles"
import type { ActorSurfaceProjectionData } from "@cell/ai-core-contract/runtime/ActorSurface"
import type { ActorModelConfig, AiAgentMailboxSchema } from "@cell/ai-core-contract/runtime/AiAgentActor"
import { WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl"
import type { AiAgentVmUsageData } from "@cell/ai-core-contract/runtime/AiAgentVm"
import type { HeartbeatSchedule, HeartbeatWakePayload } from "@cell/ai-core-contract/runtime/Heartbeat"
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import type { AiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver"
import type { AiAgentRuntimeCoordinator } from "@cell/ai-organ-logic/runtime/AiAgentRuntimeCoordinator"
import type { Agent } from "@terminal/core/AIAgent"
import type { TuiControl, TuiEvent, TuiMessageCategory } from "@terminal/core/AIAgent/TuiStreamEvents"
import type { ExecApprovalMode } from "../stream/ExecProtocolGraph"
import { SemanticTerminalRuntimeBridge } from "../stream/SemanticTerminalRuntimeBridge"

export type RuntimeBridgeNotification = {
  text: string
  category?: TuiMessageCategory
}

export type RuntimeActiveModelSelection = {
  providerID: string
  modelID: string
}

export type RuntimeBridgeHistoryEvent = DomainMessageHistoryEvent

export type RuntimeBridgeInitStatus = {
  phase: "mcp"
  status: "starting" | "connecting" | "connected" | "failed" | "completed"
  serverName?: string
  serverIndex?: number
  serverTotal?: number
  message: string
}

type RuntimeBridgeInitStatusHandler = (status: RuntimeBridgeInitStatus) => void

export type TuiRuntimeBridge = {
  /** Binding descriptor produced by the shared profile composition path. */
  bindingDescriptor?: RuntimeCompositionBindingDescriptor
  agents?: () => Promise<Agent[]>
  slashCommands?: RuntimeSlashCommandDescriptor[]
  slashRuntime?: RuntimeSlashRuntime | null
  injectRuntimeHint?: (text: string) => Promise<void>
  setActorActiveModel?: (target: {
    laneId?: string
    actorId?: string
  }, model: RuntimeActiveModelSelection) => Promise<ActorSurfaceProjectionData>
  turn: (
    input: string,
    opts?: {
      timeoutSeconds?: number
      onChunk?: (chunk: string) => void | Promise<void>
      onControl?: (control: TuiControl) => void | Promise<void>
    },
  ) => Promise<string>
  compact: () => Promise<{ ok: boolean; message: string }>
  getActorSurface?: (options?: {
    selectedLaneId?: string
    selectedActorId?: string
  }) => Promise<ActorSurfaceProjectionData>
  selectActorSurfaceTarget?: (target: {
    laneId?: string
    actorId?: string
  }) => Promise<ActorSurfaceProjectionData>
  sendActorHumanMessage?: (target: {
    laneId?: string
    actorId?: string
  }, text: string) => Promise<ActorSurfaceProjectionData>
  cancelActorTurn?: (request: {
    actorId: string
    turnId?: string
  }) => Promise<ActorSurfaceProjectionData>
  submitQuestionnaireResponse?: (questionnaireId: string, responseText: string) => Promise<{
    status: "submitted" | "not_pending" | "owner_missing"
    projection: ActorSurfaceProjectionData
  }>
  abort: () => Promise<void>
  dispose: () => void
  subscribeNotifications: (handler: (notification: RuntimeBridgeNotification) => void) => { unsubscribe: () => void }
  subscribeUsage?: (handler: (usage: AiAgentVmUsageData) => void) => { unsubscribe: () => void }
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
  loadActorConversationMessages?: (target: {
    laneId?: string
    actorId?: string
    limit?: number
  }) => Promise<{
    actorKey: string | null
    messages: ChatMessage[]
  }>
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
  /** Runtime profile selected by the entry; defaults to ai-coding. */
  profileId?: string
  /** Surface kind of the entry; defaults to headless. */
  entryType?: RuntimeCompositionEntryType
  /** Storage capability flags; defaults to persistent (logs and files enabled). */
  storage?: Partial<RuntimeCompositionStorageFlags>
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

const LLM_ADAPTER_TYPE = process.env.LLM_ADAPTER ? (process.env.LLM_ADAPTER.toLowerCase() as LlmAdapterType) : undefined
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || ""
const OPENAI_MODEL = process.env.OPENAI_MODEL || ""
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ""
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || ""
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || ""
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ""
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || ""
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || ""
const USE_MOCK = process.env.MOCK_OPENAI === "1"

const SKILLS_DESCRIPTION = "(动态加载；每轮从 .eidolon/skills 重新读取)"
const shellRuntimeFacade = createShellRuntimeFacade()

export type TerminalRuntimeBindingInput = {
  workDir: string
  entryType: RuntimeCompositionEntryType
  profileId?: string
  storage?: Partial<RuntimeCompositionStorageFlags>
  surfaceCapabilities?: readonly string[]
}

export type TerminalRuntimeBinding = {
  profile: ReturnType<typeof resolveRuntimeProfileById>
  descriptor: RuntimeCompositionBindingDescriptor
}

export function resolveTerminalRuntimeBindingFromConfig(config: TuiRuntimeConfig): TerminalRuntimeBinding {
  return composeTerminalRuntimeBinding({
    workDir: config.workDir,
    entryType: config.entryType ?? "headless",
    profileId: config.profileId,
    storage: config.storage,
  })
}

/**
 * Shared composition entry for CLI, TUI, and headless surfaces. Entries select
 * a profile, an entry type, storage flags, and surface capabilities; the
 * profile decides everything else. Storage defaults to persistent (logs and
 * files enabled).
 */
export function composeTerminalRuntimeBinding(input: TerminalRuntimeBindingInput): TerminalRuntimeBinding {
  const profile = resolveRuntimeProfileById(input.profileId ?? aiCodingRuntimeProfile.id)
  const descriptor = buildRuntimeCompositionBindingDescriptor({
    profile,
    context: {
      workDir: input.workDir,
      skillsDescription: SKILLS_DESCRIPTION,
      loadedAgents: {},
      delegateAgentDescriptions: "",
    },
    entryType: input.entryType,
    storage: {
      logs: input.storage?.logs !== false,
      files: input.storage?.files !== false,
    },
    surfaceCapabilities: input.surfaceCapabilities,
  })
  return { profile, descriptor }
}

let llmAdapterFactoryOverride: null | ((adapterType: LlmAdapterType, workDir: string, overrides?: { apiKey?: string; baseUrl?: string; model?: string; options?: Record<string, unknown> }) => Promise<any>) = null
let runtimeAssemblyFactoryOverride: null | RuntimeCompositionFactory = null

// ProviderCollector registry — set via configureProviderCollector()
let currentProviderCollector: import("../observability/ProviderCollector").ProviderCollector | null = null

export function configureProviderCollector(
  collector: import("../observability/ProviderCollector").ProviderCollector | null,
): void {
  currentProviderCollector = collector
}
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

export async function drainHeartbeatFiredSchedules(params: {
  fired: HeartbeatSchedule[]
  driver: Pick<AiAgentOrchestratorDriver, "tickUntilBlocked" | "tickUntilBackgroundSettled">
  runtimeCoordinator: Pick<AiAgentRuntimeCoordinator, "enqueue">
  maxWallMs?: number
}): Promise<void> {
  if (params.fired.length === 0) return
  await params.runtimeCoordinator.enqueue(async () => {
    const now = Date.now()
    await params.driver.tickUntilBlocked({
      now,
      maxTicks: 200,
      maxWallMs: params.maxWallMs ?? 120_000,
    })
    await params.driver.tickUntilBackgroundSettled({
      now: Date.now(),
      maxTicks: 20,
      maxWallMs: 250,
    })
  }).catch(() => {})
}

export function __setLlmAdapterFactoryForTest(factory: null | ((adapterType: LlmAdapterType, workDir: string, overrides?: { apiKey?: string; baseUrl?: string; model?: string; options?: Record<string, unknown> }) => Promise<any>)) {
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

function resolveLlmAdapterType(cliAdapter?: string): LlmAdapterType | undefined {
  if (cliAdapter) {
    const normalized = cliAdapter.toLowerCase().replace(/-/g, "_")
    if (normalized === "openai" || normalized === "anthropic" || normalized === "codex" || normalized === "claude" || normalized === "deepseek" || normalized === "deep_seek") {
      return (normalized === "deep_seek" ? "deepseek" : normalized) as LlmAdapterType
    }
  }
  return LLM_ADAPTER_TYPE
}

function getProviderIdForAdapter(adapterType: LlmAdapterType): string {
  return adapterType === "anthropic"
    ? "anthropic"
    : adapterType === "claude"
      ? "claude"
      : adapterType === "codex"
        ? "codex"
        : adapterType === "deepseek"
          ? "deepseek"
          : "openai"
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

function buildAdapterDefaults() {
  return {
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
  }
}

function buildSystemMessages(prompt: string[]) {
  return prompt.map((p) => ({ role: "system", content: p }))
}

function resolveExplicitRuntimeModelRef(model?: string): string | undefined {
  const normalized = String(model ?? "").trim()
  if (!normalized) return undefined
  const separatorIndex = normalized.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex >= normalized.length - 1) return undefined
  return normalized
}

async function createRuntimeBridge(
  sessionKey: string,
  projection: RuntimeProjectionMode = "textual",
  options?: { onInitStatus?: RuntimeBridgeInitStatusHandler },
): Promise<TuiRuntimeBridge | null> {
  const paths = createShellRuntimePaths(runtimeConfig.workDir)
  const runtimeBinding = resolveTerminalRuntimeBindingFromConfig(runtimeConfig)
  const defaultRuntimeAssemblyFactory =
    runtimeAssemblyFactoryOverride
    ?? ((context: RuntimeAssemblyContext) => assembleRuntimeCompositionProfile(runtimeBinding.profile, context))
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

  const explicitRuntimeModelRef = resolveExplicitRuntimeModelRef(runtimeConfig.model)
  const configuredAdapterType = resolveLlmAdapterType(runtimeConfig.adapter)
  const fallbackModelConfig: ActorModelConfig = configuredAdapterType
    ? (() => {
      const baseConfig = getConfigForAdapter(configuredAdapterType)
      const provider = getProviderIdForAdapter(configuredAdapterType)
      return {
        model: runtimeConfig.model && !explicitRuntimeModelRef ? runtimeConfig.model : baseConfig.model,
        provider,
        adapter: configuredAdapterType,
        baseUrl: baseConfig.baseUrl,
        apiKey: baseConfig.apiKey,
      }
    })()
    : {}

  const modelConfig = runtimeSupport.resolveActorModelConfig({
    workDir: paths.WORKDIR,
    agentKey: "main",
    modelRef: explicitRuntimeModelRef,
    strictModelRef: Boolean(explicitRuntimeModelRef),
    fallbackModelConfig,
    fallbackOverrideKeys: runtimeConfig.model && !explicitRuntimeModelRef ? ["model"] : [],
  })

  // A recovered session reuses its PERSISTED modelConfig, which may predate the
  // provider's Responses-WebSocket-v2 transport config. Gap-fill the transport
  // markers from the current catalog keyed by the session's actual provider name
  // so continuity activates without re-resolving the whole (frozen) config.
  refreshProviderTransportMarkers(modelConfig, paths.WORKDIR)

  const adapterType = configuredAdapterType ?? modelConfig.adapter
  if (!adapterType) {
    throw new Error("LLM adapter unavailable: configure agent-present.json with a model present in llm-provider.json")
  }
  const llmAdapter = await createRuntimeLlmAdapter({
    adapterType,
    workDir: paths.WORKDIR,
    defaults: buildAdapterDefaults(),
    useMock: USE_MOCK,
    overrides: {
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.baseUrl,
      model: modelConfig.model,
      options: modelConfig.options,
    },
    factoryOverride: llmAdapterFactoryOverride,
  })

  if (!llmAdapter) {
    return null
  }

  let mcpManager: MCPManager | null = null
  if (runtimeConfig.mcp !== false) {
    const mcpServers = loadMcpServers(paths.MCP_DIR)
    const mcpServerNames = Object.keys(mcpServers)
    if (mcpServerNames.length > 0) {
      options?.onInitStatus?.({
        phase: "mcp",
        status: "starting",
        serverTotal: mcpServerNames.length,
        message: `正在初始化 MCP (${mcpServerNames.length} 个服务)...`,
      })
      mcpManager = new MCPManager(mcpServers)
      let connectedCount = 0
      for (const [index, name] of mcpServerNames.entries()) {
        options?.onInitStatus?.({
          phase: "mcp",
          status: "connecting",
          serverName: name,
          serverIndex: index + 1,
          serverTotal: mcpServerNames.length,
          message: `正在连接 MCP ${index + 1}/${mcpServerNames.length}: ${name}`,
        })
        const connected = await mcpManager.connectServer(name)
        if (connected) connectedCount += 1
        options?.onInitStatus?.({
          phase: "mcp",
          status: connected ? "connected" : "failed",
          serverName: name,
          serverIndex: index + 1,
          serverTotal: mcpServerNames.length,
          message: connected
            ? `MCP 已连接 ${index + 1}/${mcpServerNames.length}: ${name}`
            : `MCP 连接失败 ${index + 1}/${mcpServerNames.length}: ${name}`,
        })
      }
      options?.onInitStatus?.({
        phase: "mcp",
        status: "completed",
        serverTotal: mcpServerNames.length,
        message: `MCP 初始化完成 ${connectedCount}/${mcpServerNames.length}`,
      })
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
    processStream: (currentVm: any, streamActor: any, stream: any, options?: { signal?: AbortSignal }) => {
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
        sessionDir,
        sessionId: sessionKey,
        storageLogsEnabled: isRuntimeStorageLogsEnabled(currentVm as DomainRuntimeVm),
        signal: options?.signal,
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
    storage: runtimeBinding.descriptor.storage,
  })
  const adapterStateByActor = new WeakMap<AiAgentActor, {
    adapterType: LlmAdapterType
    apiKey?: string
    baseUrl?: string
    model?: string
    optionsKey?: string
  }>()
  adapterStateByActor.set(actor, {
    adapterType,
    apiKey: modelConfig.apiKey,
    baseUrl: modelConfig.baseUrl,
    model: modelConfig.model,
    optionsKey: JSON.stringify(modelConfig.options ?? {}),
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
    // P3: production does NOT inject `sealCompletedProgress` — the coordinator's
    // default no-op leaves the timeout path non-sealing. Live wiring is deferred
    // to the follow-up that ships the recovery-gate forward-only relay (enabling
    // the seal earlier regresses settled-then-timeout recovery to `dirty`). See
    // codument/tracks/harden-runtime-session-robustness/analysis/findings.md P3.
    hookDefinitions: runtimeAssembly.hookDefinitions,
    hookHandlers: createDefaultRuntimeHookHandlers(),
  })
  const activateSessionMaterialization = () => {
    sessionMaterialized = true
  }
  const persistSnapshot = async () => {
    if (!persistSnapshots || !sessionMaterialized) return
    await runtimeCoordinator.saveSnapshot().catch(() => {})
  }
  const emitHeartbeatWakeSignal = (event: { schedule: HeartbeatSchedule; wake: HeartbeatWakePayload }) => {
    const fiberId = `${event.schedule.targetActorKey}:${event.schedule.targetActorId}`
    driver.emitFiberSignal({
      fiberId,
      signalKind: "mailbox_enqueue",
      mailbox: { kind: "heartbeat", payload: event.wake },
      idempotencyKey: `${fiberId}:heartbeat:${event.schedule.scheduleId}:${event.wake.fireCount}`,
      createdAt: Date.parse(event.wake.firedAt),
    })
  }
  const recoveredHeartbeatFires: HeartbeatSchedule[] = []
  recoverHeartbeatSchedules(vm as any, {
    now: Date.now(),
    deliver: emitHeartbeatWakeSignal,
    onRecoveredFire: (schedule) => {
      recoveredHeartbeatFires.push(schedule)
    },
  })
  const heartbeatWorker = startHeartbeatSchedulerWorker(vm as any, {
    intervalMs: 1000,
    deliver: emitHeartbeatWakeSignal,
    afterTick: async (fired) => {
      if (fired.length === 0) return
      await drainHeartbeatFiredSchedules({
        fired,
        driver,
        runtimeCoordinator,
        maxWallMs: runtimeConfig.timeoutSeconds && runtimeConfig.timeoutSeconds > 0
          ? runtimeConfig.timeoutSeconds * 1000
          : 120_000,
      })
    },
  })
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
    const workModeOutput = executeWorkModeSlashCommand(input)
    if (workModeOutput !== null) return workModeOutput

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

  function executeWorkModeSlashCommand(input: string): string | null {
    const match = input.trim().match(/^\/work-mode(?:\s+(\S+))?\s*$/)
    if (!match) return null
    const value = match[1]
    if (value !== WORK_MODES.build && value !== WORK_MODES.plan) {
      return "Usage: /work-mode build | /work-mode plan"
    }
    const next = setActorWorkMode({
      actor,
      workMode: value,
      source: "slash_command",
      occurredAt: new Date().toISOString(),
    })
    return `work_mode: ${next.workMode}`
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

  const getRecoveredMailboxWorkFiberIds = () => {
    const runtime = driver.inspectRuntime()
    const fiberIds: string[] = []
    for (const fiber of Object.values(runtime.fibers) as any[]) {
      const fiberActor = fiber?.actor
      if (!fiberActor) continue
      const hasWork = hasPendingAiAgentWakeMailbox(fiberActor)
        || ((fiber.execState?.pendingAiGenerated?.length ?? 0) > 0)
        || ((fiber.execState?.pendingToolResults?.length ?? 0) > 0)
      if (hasWork && typeof fiber.fiberId === "string") {
        fiberIds.push(fiber.fiberId)
      }
    }
    return fiberIds
  }

  runtimeCoordinator.startBackgroundPump()
  const recoveredMailboxWorkFiberIds = getRecoveredMailboxWorkFiberIds()
  if (recoveredHeartbeatFires.length > 0 || recoveredMailboxWorkFiberIds.length > 0) {
    void runtimeCoordinator.enqueue(async () => {
      const now = Date.now()
      const fiberIds = new Set(recoveredMailboxWorkFiberIds)
      for (const fiberId of fiberIds) {
        driver.resumeFiber(fiberId, now)
      }
      await driver.tickUntilForegroundSettled({ now, maxTicks: 200 }).catch(() => {})
      await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 200 }).catch(() => {})
    }).catch(() => {})
  }

  const reviveMainFiberForInteractiveTurnIfNeeded = () => {
    const status = driver.getState().fibers[mainFiberId]?.status
    if (status === "failed" || status === "cancelled") {
      driver.reviveFiber(mainFiberId, Date.now())
    }
  }

  const resolveConfiguredActorModelConfig = () => {
    return runtimeSupport.resolveActorModelConfig({
      workDir: paths.WORKDIR,
      agentKey: "main",
      modelRef: explicitRuntimeModelRef,
      strictModelRef: Boolean(explicitRuntimeModelRef),
      fallbackModelConfig,
      fallbackOverrideKeys: runtimeConfig.model && !explicitRuntimeModelRef ? ["model"] : [],
    })
  }

  // Load the CURRENT providers catalog using the same project-or-home resolution
  // that `runtimeSupport.resolveActorModelConfig` uses internally (project
  // `.eidolon/llm-provider.json` takes precedence over the home default). Returns
  // null on any error so callers fall back safely (treating the persisted model
  // as unresolvable -> re-resolve the default preset).
  const resolveCurrentProviderCatalog = () => {
    try {
      const projectCandidate = path.join(paths.WORKDIR, ".eidolon", PROVIDER_CONFIG_FILE_NAME)
      const configPath = fs.existsSync(projectCandidate) ? projectCandidate : defaultProviderConfigPath()
      return loadProviderCatalog(configPath)
    } catch {
      return null
    }
  }

  // Recovery-time guard (requirement `recovery-model-config-validation`): a
  // recovered actor carries a persisted modelConfig. If its provider/model is no
  // longer resolvable in the current config, fall back to the default preset;
  // otherwise preserve the still-resolvable persisted model.
  const isActorModelConfigResolvable = (targetActor: AiAgentActor) =>
    isPersistedModelStillResolvable(targetActor.modelConfig, resolveCurrentProviderCatalog())

  const refreshActorAdapterForModelConfig = async (targetActor: AiAgentActor) => {
    // A recovered actor reuses its PERSISTED modelConfig, which may predate the
    // provider's Responses-WebSocket-v2 transport config. Gap-fill the transport
    // markers from the current catalog keyed by the actor's actual provider name
    // so continuity activates without re-resolving the whole (frozen) config.
    refreshProviderTransportMarkers(targetActor.modelConfig, paths.WORKDIR)
    const nextAdapterType = targetActor.modelConfig.adapter || adapterType
    const previousAdapterState = adapterStateByActor.get(targetActor)

    const currentType = (targetActor.llmClient as any)?.type
    const currentAdapterType =
      currentType === "openai" || currentType === "anthropic" || currentType === "claude" || currentType === "codex" || currentType === "deepseek"
        ? (currentType as LlmAdapterType)
        : adapterType

    const shouldRefreshAdapter =
      currentAdapterType !== nextAdapterType ||
      !targetActor.llmClient ||
      previousAdapterState?.adapterType !== nextAdapterType ||
      previousAdapterState?.apiKey !== targetActor.modelConfig.apiKey ||
      previousAdapterState?.baseUrl !== targetActor.modelConfig.baseUrl ||
      previousAdapterState?.model !== targetActor.modelConfig.model ||
      previousAdapterState?.optionsKey !== JSON.stringify(targetActor.modelConfig.options ?? {})

    if (shouldRefreshAdapter) {
      const refreshed = await createRuntimeLlmAdapter({
        adapterType: nextAdapterType,
        workDir: paths.WORKDIR,
        defaults: buildAdapterDefaults(),
        useMock: USE_MOCK,
        overrides: {
          apiKey: targetActor.modelConfig.apiKey,
          baseUrl: targetActor.modelConfig.baseUrl,
          model: targetActor.modelConfig.model,
          options: targetActor.modelConfig.options,
        },
        factoryOverride: llmAdapterFactoryOverride,
      })
      if (refreshed) {
        targetActor.llmClient = refreshed
        adapterStateByActor.set(targetActor, {
          adapterType: nextAdapterType,
          apiKey: targetActor.modelConfig.apiKey,
          baseUrl: targetActor.modelConfig.baseUrl,
          model: targetActor.modelConfig.model,
          optionsKey: JSON.stringify(targetActor.modelConfig.options ?? {}),
        })
      }
    }
  }

  const runTurn = async (params: {
    timeoutSeconds?: number
  } = {}) => {
    applyActorModelConfigControlSignals(actor)
    if (!actor.modelConfig.model || !isActorModelConfigResolvable(actor)) {
      actor.modelConfig = resolveConfiguredActorModelConfig()
    }
    await refreshActorAdapterForModelConfig(actor)
    reviveMainFiberForInteractiveTurnIfNeeded()
    const result = await runtimeCoordinator.runInteractiveTurn({
      mainFiberId,
      timeoutMs: params.timeoutSeconds && params.timeoutSeconds > 0 ? params.timeoutSeconds * 1000 : undefined,
    })
    if (result.status === "timeout_unsettled") {
      throw new Error(`runtime_turn_unsettled:${result.reason || "unknown"}`)
    }
  }

  const enqueueUserProvidedInput = (input: string): string => {
    const expanded = slashRuntime?.resolveCommand(input) ?? null
    const normalizedInput = expanded && expanded.kind === "prompt_expand" ? expanded.prompt : input
    const now = Date.now()

    activateSessionMaterialization()
    if (actor.hasPending("control")) {
      let pending: Extract<AiAgentMailboxSchema["control"], { kind: "questionnaire_pending" }> | null = null
      const rest: AiAgentMailboxSchema["control"][] = []
      for (const entry of actor.drainMailbox("control")) {
        if (!pending && entry.kind === "questionnaire_pending" && typeof entry.toolCallId === "string") {
          pending = entry
          continue
        }
        rest.push(entry)
      }
      for (const entry of rest) {
        actor.send("control", entry)
      }
      if (pending?.toolCallId) {
        driver.emitFiberSignal({
          fiberId: mainFiberId,
          signalKind: "mailbox_enqueue",
          mailbox: {
            kind: "toolResult",
            payload: {
              toolCallId: pending.toolCallId,
              questionnaireId: pending.questionnaireId,
              content: normalizedInput,
            },
          },
          toolCallId: pending.toolCallId,
          idempotencyKey: `${mainFiberId}:toolResult:${pending.toolCallId}:${now}`,
          createdAt: now,
        })
        return normalizedInput
      }
    }

    driver.emitFiberSignal({
      fiberId: mainFiberId,
      signalKind: "mailbox_enqueue",
      mailbox: { kind: "humanInput", payload: normalizedInput },
      idempotencyKey: `${mainFiberId}:humanInput:${now}`,
      createdAt: now,
    })
    return normalizedInput
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
    if (activeTurn) {
      enqueueUserProvidedInput(input)
      void persistSnapshot()
      return Promise.resolve("")
    }

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
      currentProviderCollector?.onTurnPhase("request_send")
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
            actor: { key: actor.key, id: actor.id, type: actor.type },
            text: directOutput,
          })
          await eventChain
          if (eventChainError) throw eventChainError
          return output
        }
        enqueueUserProvidedInput(input)
        const timeoutSeconds =
          opts?.timeoutSeconds !== undefined ? opts.timeoutSeconds : runtimeConfig.timeoutSeconds
        await runTurn({ timeoutSeconds })
        await eventChain
        if (eventChainError) throw eventChainError
        if (turnState.runtimeError) {
          throw turnState.runtimeError
        }
      } finally {
        turnState.resolveSettled()
        if (activeTurn === turnState) activeTurn = null
        currentProviderCollector?.onTurnPhase("response_complete")
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
    const abortActorRuntime = (targetActor: any) => {
      targetActor?.llmAbortController?.abort()
      targetActor.llmAbortController = null
    }
    const abortActorInflight = (targetActor: any) => {
      for (const fiber of Object.values(driver.inspectRuntime().fibers) as any[]) {
        if (fiber?.actor !== targetActor) continue
        const abortController = fiber?.execState?.inflight?.abortController
        if (abortController && typeof abortController.abort === "function") {
          abortController.abort()
        }
      }
    }
    const now = Date.now()
    activateSessionMaterialization()
    abortActorRuntime(actor)
    abortActorInflight(actor)
    driver.emitFiberSignal({
      fiberId: mainFiberId,
      signalKind: "interrupt_requested",
      mailbox: { kind: "control", payload: { kind: "cancel_requested" } as any },
      idempotencyKey: `${mainFiberId}:cancel:${now}`,
      createdAt: now,
    })
    driver.settleInterruptedFiber({
      fiberId: mainFiberId,
      now,
      reason: "idle_external" as any,
      controlKinds: ["cancel_requested"],
    })
    for (const childActor of Object.values(vm.actors)) {
      if (!childActor || childActor === actor) continue
      if (childActor.type !== "delegate") continue
      abortActorRuntime(childActor)
      abortActorInflight(childActor)
      const childFiberId = `${childActor.key}:${childActor.id}`
      driver.emitFiberSignal({
        fiberId: childFiberId,
        signalKind: "interrupt_requested",
        mailbox: { kind: "control", payload: { kind: "shutdown_requested" } as any },
        idempotencyKey: `${childFiberId}:shutdown:${now}`,
        createdAt: now,
      })
      driver.settleInterruptedFiber({
        fiberId: childFiberId,
        now,
        reason: "cancel_requested" as any,
        controlKinds: [],
      })
      driver.resumeFiber(childFiberId, now)
    }
    await driver.tickUntilBlocked({ now, maxTicks: 20, maxWallMs: 250 }).catch(() => {})
    await persistSnapshot()
  }

  const compact = async () => {
    applyActorModelConfigControlSignals(actor)
    if (!actor.modelConfig.model || !isActorModelConfigResolvable(actor)) {
      actor.modelConfig = resolveConfiguredActorModelConfig()
    }
    await refreshActorAdapterForModelConfig(actor)
    const result = await runtimeCoordinator.enqueue(async () => {
      const compressed = await forceCompressActorHistory({
        vm,
        actor,
        trigger: "manual_compact",
      })
      await persistSnapshot()
      return compressed
    })
    if (!result.ok) {
      return { ok: false, message: result.error }
    }
    if (!result.compacted) {
      return {
        ok: true,
        message: `Session already compact enough (${result.tokensBefore} estimated tokens, ${result.messagesAfter} messages)`,
      }
    }
    currentProviderCollector?.onCompaction({
      beforeMessageCount: actor.messages.length,
      afterMessageCount: result.messagesAfter,
      reason: "manual_compact",
    })
    return {
      ok: true,
      message: `Session compacted (${result.tokensBefore} estimated tokens -> ${result.messagesAfter} messages)`,
    }
  }

  const createDurableActorSurfaceFacade = () => createActorSurfaceFacade(vm as any, {
    emitFiberSignal: (input) => {
      driver.emitFiberSignal({
        fiberId: input.fiberId,
        signalKind: input.signalKind,
        mailbox: input.mailbox as any,
        toolCallId: input.toolCallId,
        idempotencyKey: input.idempotencyKey,
        createdAt: input.createdAt,
      })
    },
  })

  const findActorForSurfaceProjection = (projection: ActorSurfaceProjectionData, target?: {
    actorId?: string
    laneId?: string
  }): AiAgentActor | null => {
    const actorId = target?.actorId ?? projection.selectedActorId
    if (actorId) {
      const byId = Object.values(vm.actors).find((candidate: any) => candidate?.id === actorId)
      if (byId) return byId as AiAgentActor
    }
    const laneId = target?.laneId ?? projection.selectedLaneId
    const lane = projection.conversationLanes.find((candidate) => candidate.laneId === laneId)
    if (lane?.actorId) {
      const byLane = Object.values(vm.actors).find((candidate: any) => candidate?.id === lane.actorId)
      if (byLane) return byLane as AiAgentActor
    }
    return actor
  }

  const setActorActiveModel = async (
    target: { laneId?: string; actorId?: string },
    model: RuntimeActiveModelSelection,
  ): Promise<ActorSurfaceProjectionData> => {
    const modelRef = `${model.providerID}/${model.modelID}`
    const beforeProjection = buildActorSurfaceProjection(vm as any)
    const targetActorBeforeSignal = findActorForSurfaceProjection(beforeProjection, target) ?? actor
    const nextModelConfig = runtimeSupport.resolveActorModelConfig({
      workDir: paths.WORKDIR,
      agentKey: targetActorBeforeSignal.key,
      modelRef,
      strictModelRef: true,
      fallbackModelConfig: targetActorBeforeSignal.modelConfig?.model
        ? targetActorBeforeSignal.modelConfig
        : fallbackModelConfig,
    })
    const projection = createDurableActorSurfaceFacade().setActorModelConfig({
      laneId: target.laneId,
      actorId: target.actorId,
      modelRef,
      source: "user-explicit",
      requestedBy: "terminal-tui",
      modelConfig: nextModelConfig,
    })
    const targetActor = findActorForSurfaceProjection(projection, target)
    if (targetActor) {
      applyActorModelConfigControlSignals(targetActor)
      await refreshActorAdapterForModelConfig(targetActor)
    }
    await persistSnapshot()
    return projection
  }

  const getActorSurface = async (options?: {
    selectedLaneId?: string
    selectedActorId?: string
  }) => buildActorSurfaceProjection(vm as any, options)

  const selectActorSurfaceTarget = async (target: {
    laneId?: string
    actorId?: string
  }) => createDurableActorSurfaceFacade().selectActorSurfaceTarget(target)

  const sendActorHumanMessage = async (target: {
    laneId?: string
    actorId?: string
  }, text: string) => {
    const projection = createDurableActorSurfaceFacade().sendActorHumanMessage(target, text)
    const actorId = target.actorId ?? projection.selectedActorId
    const laneId = target.laneId ?? projection.selectedLaneId
    const actorLane = projection.actorLanes.find((lane) => lane.actorId === actorId)
      ?? projection.actorLanes.find((lane) => lane.actorId === projection.conversationLanes.find((lane) => lane.laneId === laneId)?.actorId)
    if (actorLane) {
      const now = Date.now()
      await driver.tickUntilForegroundSettled({ now, maxTicks: 20, maxWallMs: 250 }).catch(() => {})
      await driver.tickUntilBackgroundSettled({ now, maxTicks: 20, maxWallMs: 250 }).catch(() => {})
      await persistSnapshot()
    }
    return projection
  }

  const cancelActorTurn = async (request: {
    actorId: string
    turnId?: string
  }) => {
    const projection = createDurableActorSurfaceFacade().cancelActorTurn(request)
    const actorLane = projection.actorLanes.find((lane) => lane.actorId === request.actorId)
    if (actorLane) {
      const now = Date.now()
      await driver.tickUntilBlocked({ now, maxTicks: 80, maxWallMs: 2_000 }).catch(() => {})
      await persistSnapshot()
    }
    return projection
  }

  const submitQuestionnaireResponse = async (questionnaireId: string, responseText: string) => {
    const before = buildActorSurfaceProjection(vm as any)
    const pending = before.questionnaireSurface.find((item) => item.questionnaireId === questionnaireId)
    const result = createDurableActorSurfaceFacade().submitQuestionnaireResponse(questionnaireId, responseText)
    if (result.status === "submitted" && pending?.ownerActorKey && pending.ownerActorId) {
      const now = Date.now()
      await driver.tickUntilBlocked({ now, maxTicks: 160, maxWallMs: 5_000 }).catch(() => {})
      await persistSnapshot()
    }
    return result
  }

  const dispose = () => {
    void persistSnapshot()
    heartbeatWorker.dispose()
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
  const subscribeUsage = (handler: (usage: AiAgentVmUsageData) => void) => {
    const { publicRxData } = ensureVmRxData(vm)
    return publicRxData.usage.subscribe(handler)
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

  const loadActorConversationMessages = async (target: {
    laneId?: string
    actorId?: string
    limit?: number
  }) => {
    const projection = buildActorSurfaceProjection(vm as any)
    const actorLane = target.actorId
      ? projection.actorLanes.find((lane) => lane.actorId === target.actorId)
      : undefined
    const conversationLane = target.laneId
      ? projection.conversationLanes.find((lane) => lane.laneId === target.laneId)
      : undefined
    const selectedActorLane = projection.selectedActorId
      ? projection.actorLanes.find((lane) => lane.actorId === projection.selectedActorId)
      : undefined
    const selectedConversationLane = projection.selectedLaneId
      ? projection.conversationLanes.find((lane) => lane.laneId === projection.selectedLaneId)
      : undefined
    const hasExplicitTarget = Boolean(target.actorId || target.laneId)
    const actorKey =
      actorLane?.actorKey
      ?? conversationLane?.actorKey
      ?? (!hasExplicitTarget ? selectedActorLane?.actorKey : undefined)
      ?? (!hasExplicitTarget ? selectedConversationLane?.actorKey : undefined)
      ?? null
    if (!actorKey) {
      return { actorKey: null, messages: [] }
    }
    const messages = materializeConversationHistoryMessagesFromVm({ vm, actorKey })
    const limit = Number.isFinite(target.limit) && target.limit && target.limit > 0
      ? Math.floor(target.limit)
      : undefined
    return {
      actorKey,
      messages: limit ? messages.slice(-limit) : messages,
    }
  }

  const injectRuntimeHint = async (text: string) => {
    const normalized = String(text ?? "").trim()
    if (!normalized) return
    activateSessionMaterialization()
    if (activeTurn) {
      const now = Date.now()
      actor.send("humanInput", `Runtime hint:\n${normalized}`)
      driver.resumeFiber(mainFiberId, now)
      return
    }
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
    bindingDescriptor: runtimeBinding.descriptor,
    agents: async () => runtimeAgents,
    slashCommands: runtimeAssembly.slashCommands,
    slashRuntime,
    injectRuntimeHint,
    setActorActiveModel,
    turn,
    compact,
    getActorSurface,
    selectActorSurfaceTarget,
    sendActorHumanMessage,
    cancelActorTurn,
    submitQuestionnaireResponse,
    abort,
    dispose,
    subscribeNotifications,
    subscribeUsage,
    subscribeHistoryEvents,
    loadConversationState,
    loadConversationViews,
    loadActorConversationMessages,
  }
}

const sessionRuntimePromises = new Map<string, Promise<TuiRuntimeBridge | null>>()

function runtimeCacheKey(sessionKey: string, projection: RuntimeProjectionMode): string {
  return `${projection}:${sessionKey}`
}

async function getRuntimeBridge(
  sessionKey: string,
  projection: RuntimeProjectionMode,
  options?: { onInitStatus?: RuntimeBridgeInitStatusHandler },
) {
  const cacheKey = runtimeCacheKey(sessionKey, projection)
  const existing = sessionRuntimePromises.get(cacheKey)
  if (existing) {
    return existing
  }

  const created = createRuntimeBridge(sessionKey, projection, options)
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

export async function getTuiRuntimeBridge(sessionKey: string, options?: { onInitStatus?: RuntimeBridgeInitStatusHandler }) {
  return getRuntimeBridge(sessionKey, "content", options)
}

export async function getTextualRuntimeBridge(sessionKey: string, options?: { onInitStatus?: RuntimeBridgeInitStatusHandler }) {
  return getRuntimeBridge(sessionKey, "textual", options)
}

export async function disposeTuiRuntimeBridge(sessionKey: string) {
  await disposeRuntimeBridge(sessionKey, "content")
}

export async function disposeTextualRuntimeBridge(sessionKey: string) {
  await disposeRuntimeBridge(sessionKey, "textual")
}

export function configureTuiRuntime(config: TuiRuntimeConfig) {
  const pendingRuntimes = [...sessionRuntimePromises.values()]
  runtimeConfig.workDir = config.workDir
  runtimeConfig.adapter = config.adapter
  runtimeConfig.model = config.model
  runtimeConfig.timeoutSeconds = config.timeoutSeconds
  runtimeConfig.debug = config.debug
  runtimeConfig.mcp = config.mcp
  runtimeConfig.ephemeral = config.ephemeral === true
  runtimeConfig.profileId = config.profileId
  runtimeConfig.entryType = config.entryType
  runtimeConfig.storage = config.storage
  runtimeConfig.metadata = normalizeTerminalRuntimeMetadata(config.workDir, config.metadata)
  sessionRuntimePromises.clear()
  for (const runtimePromise of pendingRuntimes) {
    void runtimePromise.then((runtime) => runtime?.dispose()).catch(() => {})
  }
}

export type TerminalRuntimeBridge = TuiRuntimeBridge
export type TerminalRuntimeConfig = TuiRuntimeConfig

export const getSessionRuntimeBridge = getTuiRuntimeBridge
export const disposeSessionRuntimeBridge = disposeTuiRuntimeBridge
export const configureSessionRuntime = configureTuiRuntime
export const getTerminalRuntimeBridge = getTextualRuntimeBridge
export const disposeTerminalRuntimeBridge = disposeTextualRuntimeBridge
export const configureTerminalRuntime = configureTuiRuntime
