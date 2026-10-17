import fs from "node:fs"
import { saveAiAgentRuntimeSnapshot, type RuntimeSnapshotSaveResult } from "@cell/ai-organ-logic/persistence/RuntimeSnapshots"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { getThreadGoal, updateThreadGoalStatus } from "@cell/ai-organ-logic/goals/ThreadGoalManager"
import type { ThreadGoalContinuationAdmission } from "@cell/ai-organ-logic/goals/ThreadGoalRuntime"
import { ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime"
import { extendActorRetirementFacetRegistry, requireActiveActor } from "@cell/ai-organ-logic/runtime/ActorRetirementFacet"
import { resolveEidolonGlobalRoot } from "@cell/ai-support/system-skill/SystemSkillInstaller"

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
  ensureHeartbeatSchedulerState,
  cancelHeartbeatSchedule,
  startHeartbeatSchedulerWorker,
  type DomainRuntimeVm,
  AgentRegistry,
} from "@cell/ai-core-logic"
import { applyActorModelConfigControlSignals, hasPendingAiAgentWakeMailbox, type AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import type { ConversationSessionForkRuntimeEffects } from "@cell/ai-organ-logic/conversation/ConversationSessionForkRuntime"
import type { ConversationSessionRewindRuntimeEffects } from "@cell/ai-organ-logic/conversation/ConversationSessionRewindRuntime"
import {
  createRuntimeLlmAdapter,
  createProviderDiagnosticsCollector,
  createDefaultRuntimeHookHandlers,
  defaultProviderConfigPath,
  emitRuntimeDirectSlashAssistantOutput,
  forceCompressActorHistory,
  ensureActorProviderContextEpochBeforeTransport,
  createShellRuntimeFacade,
  createShellRuntimePaths,
  bindWorkflowComponentToRuntime,
  createWorkflowComponentForRuntimeBinding,
  ensureShellRuntimeSessionDir,
  extractProviderOptions,
  isPersistedModelStillResolvable,
  loadMcpServers,
  loadProviderCatalog,
  loadProviderConfig,
  PROVIDER_CONFIG_FILE_NAME,
  MCPManager,
  processRuntimeIngressStream,
  activateActorProviderEpoch,
  resolveProviderEpochProfileId,
  recoverOrCreateShellRuntime,
  refreshProviderTransportMarkers,
  setDebug,
  validateProviderPromptInputModalities,
  getConversationActorRawStateFromVm,
  getConversationSessionRawStateFromVm,
  getVmProviderCallDomain,
  getVmToolCallDomain,
  materializeConversationHistoryMessagesFromVm,
  materializeConversationRuntimeMessagesFromVm,
  mergeResourceAgentConfigs,
  projectRuntimeTiming,
  readProviderCacheObservationProjection,
  readWorkflowPublicRuntimeEvidence,
  digestProviderContextClosedValue,
  createConversationSessionForkActorPort,
  createConversationSessionForkPort,
  createConversationSessionRewindActorPort,
  createConversationSessionRewindPort,
  ensureVmConversationDomainRuntime,
  synchronizeConversationDomainActorFromPersistence,
  runWorkflowNativeHostCommand,
  setActorWorkMode,
  type LlmAdapterType,
  type LlmProviderRuntime,
  type ProviderRequestObservationPort,
  type RuntimeTimingProjection,
  type RuntimeTimingWindow,
} from "@cell/ai-organ-logic"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import type { AdditionalWatchedProjection } from "@cell/ai-organ-logic/runtime/ShellRuntimeFacade"
import {
  normalizeInputContent,
  projectInputContentText,
  type ChatMessage,
  type InputContent,
  type InputContentPart,
  type InputFileReferenceContentPart,
} from "@shared/composer"
import type {
  AttachmentResolverPort,
  LlmProcessStreamOptions,
} from "@cell/ai-core-contract"
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
import { prepareEffectiveEidolonVfs } from "@cell/mod-ai-coding/builtin-vfs"
import { withEffectiveVfsLifetime } from "./EffectiveVfsLifetime"
import { createSessionWriterLeaseEffects } from "@cell/ai-runtime-host-support"
import type { ActorSurfaceProjectionData } from "@cell/ai-core-contract/runtime/ActorSurface"
import type { ActorModelConfig, AiAgentMailboxSchema } from "@cell/ai-core-contract/runtime/AiAgentActor"
import { WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl"
import type { AiAgentVmUsageData } from "@cell/ai-core-contract/runtime/AiAgentVm"
import type { ProviderCacheCostObservation } from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation"
import type { WorkflowPublicRuntimeEvidence } from "@cell/ai-organ-contract/workflow/WorkflowPublicRuntimeEvidence"
import type { HeartbeatSchedule, HeartbeatWakePayload } from "@cell/ai-core-contract/runtime/Heartbeat"
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import type { AiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver"
import type { AiAgentRuntimeCoordinator } from "@cell/ai-organ-logic/runtime/AiAgentRuntimeCoordinator"
import { createTextSessionPresentation, type SessionPresentation, type SessionPresentationFactory, type SessionControl, type SessionPresentationEvent, type SessionMessageCategory } from "./SessionRuntimePresentation"
import {
  loadRuntimeConfigFromVfs,
} from "@cell/ai-support"
import type {
  ConversationSessionForkCommand,
  ConversationSessionForkResult,
  ConversationSessionForkReceipt,
  ConversationSessionRewindCommand,
  ConversationSessionRewindResult,
  ConversationSessionRewindReceipt,
} from "@cell/ai-organ-contract"
import { readConversationForkCommitEvidence, readConversationRewindCommitEvidence, type ConversationCommitEvidence } from "@cell/ai-organ-logic/conversation/ConversationCommitEvidence"
import { ResourceVFSLoaderOps } from "@cell/symbiont-logic/resource/ResourceVFSLoader"
import { createLegacyResourceVfsProjectionFromReadPort } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"

export type RuntimeBridgeNotification = {
  text: string
  category?: SessionMessageCategory
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

export type ConversationForkInvocation = {
  actorId: string
  beforeSourceRead?: () => Promise<void>
  beforeCommit?: ConversationSessionForkRuntimeEffects["beforeCommit"]
}
export type ConversationRewindInvocation = {
  actorId: string
  beforeSourceRead?: () => Promise<void>
  beforeCommit?: ConversationSessionRewindRuntimeEffects["beforeCommit"]
}

export type SessionRuntimeBridge = {
  /** Binding descriptor produced by the shared profile composition path. */
  bindingDescriptor?: RuntimeCompositionBindingDescriptor
  agents?: () => Promise<SessionAgentDescription[]>
  slashCommands?: RuntimeSlashCommandDescriptor[]
  slashRuntime?: RuntimeSlashRuntime | null
  setActorActiveModel?: (target: {
    laneId?: string
    actorId?: string
    requestedBy?: string
  }, model: RuntimeActiveModelSelection) => Promise<ActorSurfaceProjectionData>
  turn: (
    input: InputContent,
    opts?: {
      timeoutSeconds?: number
      onChunk?: (chunk: string) => void | Promise<void>
      onControl?: (control: SessionControl) => void | Promise<void>
    },
  ) => Promise<string>
  resumeTurn?: (opts?: {
    timeoutSeconds?: number
    onChunk?: (chunk: string) => void | Promise<void>
    onControl?: (control: SessionControl) => void | Promise<void>
  }) => Promise<string>
  compact: (target?: { actorId: string; beforeCompact?: () => void }) => Promise<{
    ok: boolean; message: string; compaction?: { compacted: boolean; tokensBefore: number; messagesAfter: number }
  }>
  callTool: (name: string, input: unknown) => Promise<unknown>
  callWorkflowHostCommand: (name: string, input: unknown) => Promise<unknown>
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
  /** already_saved is only for a maintenance owner that just committed a quiet checkpoint. */
  dispose: (options?: { checkpoint?: "already_saved" }) => void | Promise<void>
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
  /** Conversation-owned durable fork command; surfaces never pass messages or paths. */
  forkConversationSession?: (
    command: ConversationSessionForkCommand,
    target?: ConversationForkInvocation,
  ) => Promise<ConversationSessionForkResult>
  /** Conversation-owned durable same-session rewind command. */
  rewindConversationSession?: (
    command: ConversationSessionRewindCommand,
    target?: ConversationRewindInvocation,
  ) => Promise<ConversationSessionRewindResult>
  /** Sanitized, read-only timing projection over existing runtime domains. */
  readTimingProjection?: (window: RuntimeTimingWindow) => RuntimeTimingProjection
  /** Sanitized, read-only cumulative usage projection for headless evidence. */
  readUsageProjection?: () => AiAgentVmUsageData
  /** Sanitized, read-only canonical provider cache observations. */
  readProviderCacheObservations?: () => readonly ProviderCacheCostObservation[]
  /** Sanitized, read-only Workflow execution and node Actor evidence. */
  readWorkflowExecutions?: () => readonly WorkflowPublicRuntimeEvidence[]
}

export type SessionRuntimeConfig = {
  workDir: string
  /** Trusted composition only: source configuration authority can differ from the tools' cwd. */
  configurationWorkDir?:string
  /** Explicit authority root for hosted instances and isolated test runtimes. */
  globalRoot?: string
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
  providerRequestObservationBindingFactory?: ProviderRequestObservationBindingFactory
  attachmentResolver?: AttachmentResolverPort
}

export type ProviderRequestObservationBindingContext = {
  sessionDir: string
  sessionId: string
  ephemeral: boolean
  storageFilesEnabled: boolean
}

export type ProviderRequestObservationBinding = {
  port: ProviderRequestObservationPort
  dispose: () => void
}

export type ProviderRequestObservationBindingFactory = (
  context: ProviderRequestObservationBindingContext,
) => ProviderRequestObservationBinding | null

type ExecRuntimeMetadataOptions = {
  workDir: string
  approvalMode: "default" | "full-auto" | "dangerous"
  additionalWritableRoots?: string[]
  ephemeral?: boolean
  metadata?: Record<string, unknown>
}


export type SessionAgentDescription = {
  name: string
  description?: string
  mode?: string
  permission?: unknown[]
  options?: Record<string, unknown>
}

export type SessionRuntimeReady = {
  vm: DomainRuntimeVm
  actor: AiAgentActor
  driver: AiAgentOrchestratorDriver
  mainFiberId: string
  coordinator: AiAgentRuntimeCoordinator
  eventBus: DomainRuntimeEventGraph
  sessionDir: string
  resolveActorModelConfig(modelRef?: string): AiAgentActor["modelConfig"]
  prepareActor(actor: AiAgentActor): Promise<void>
  validateActorInput(actor: AiAgentActor, input: InputContent): InputContentPart[]
  persistSnapshot(): Promise<void>
  /** Caller owns the coordinator lane; reports skipped checkpoints and never ticks execution. */
  checkpointWithoutExecution(): Promise<RuntimeSnapshotSaveResult>
  activateSessionMaterialization(): void
  conversationPersistence?: {
    readForkCommit(receipt: ConversationSessionForkReceipt): Promise<ConversationCommitEvidence<ConversationSessionForkReceipt>>
    readRewindCommit(receipt: ConversationSessionRewindReceipt): Promise<ConversationCommitEvidence<ConversationSessionRewindReceipt>>
    synchronizeActor(actorId: string, beforeRead: () => void): Promise<void>
  }
}

export type SessionRuntimeExtensionContext = Pick<SessionRuntimeReady, "vm" | "actor" | "driver" | "sessionDir" | "activateSessionMaterialization" | "persistSnapshot"> & {
  workDir: string
  workflowComponent: ReturnType<typeof createWorkflowComponentForRuntimeBinding>
}

export type SessionRuntimeAssemblyOptions = {
  sessionKey: string
  /** Trusted owner storage. Managed executions use their independent root, outside the Session directory. */
  ownedSessionDir?:string
  config: SessionRuntimeConfig
  /** Web serve --model is the initial default; explicit per-actor durable selections survive reopening. CLI run keeps its operator override semantics. */
  preserveRecoveredModel?: boolean
  /** Installs the shell execution policy before any background/recovered work starts. */
  requireExplicitGoalActivation?: boolean
  goalContinuationAdmission?: ThreadGoalContinuationAdmission
  presentationFactory?: SessionPresentationFactory
  additionalWatchedProjection?: AdditionalWatchedProjection
  onInitStatus?: RuntimeBridgeInitStatusHandler
  /** Capsule composition seam; never exported through HostPort or transport. */
  onRuntimeReady?: (runtime: SessionRuntimeReady) => void | Promise<void>
  openExtension?: (context: SessionRuntimeExtensionContext) => Promise<{ close(): void }>
  toolResources?: DomainRuntimeVm["effects"]["toolResources"]
  providerCollector?: SessionProviderCollector | null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function resolveRuntimeAuthorityRoot(workDir: string): string {
  return resolveEidolonGlobalRoot()
}

export function resolveRuntimeWorkflowRoots(workDir: string, authorityRoot: string): {
  globalRoot: string
  workspaceRoot: string
} {
  return {
    globalRoot: path.join(path.resolve(authorityRoot), "workflows"),
    workspaceRoot: path.join(path.resolve(workDir), ".eidolon", "workflows"),
  }
}

export function resolveRuntimeResourcePackageLayers(workDir: string, authorityRoot: string): Array<{
  id: "global" | "workspace"
  rootDir: string
}> {
  return [
    { id: "global", rootDir: path.join(path.resolve(authorityRoot), "resources") },
    { id: "workspace", rootDir: path.join(path.resolve(workDir), ".eidolon", "resources") },
  ]
}

export function normalizeSessionRuntimeMetadata(
  workDir: string,
  metadata?: Record<string, unknown>,
  globalRoot?: string,
): Record<string, unknown> {
  const normalized = isPlainRecord(metadata) ? { ...metadata } : {}

  // Platform defaults: the entry (TUI/CLI) may not pass metadata, so every
  // consumer below reads sensible per-OS defaults instead of falling back to
  // POSIX assumptions. Explicit values supplied by the caller are preserved.
  if (typeof normalized.platform !== "string" || !normalized.platform) {
    normalized.platform = process.platform
  }
  const existingSandboxPermissions = isPlainRecord(normalized.sandbox_permissions)
    ? { ...normalized.sandbox_permissions }
    : {}
  normalized.sandbox_permissions = {
    sandbox_mode: "workspace-write",
    network_access: "enabled",
    approval_policy: "full-auto",
    ...existingSandboxPermissions,
  }
  const existingExecProtocol = isPlainRecord(normalized.exec_protocol)
    ? { ...normalized.exec_protocol }
    : {}
  // exec_protocol.mode drives bash approval behaviour. Default to full-auto on
  // Windows only (so a metadata-less Windows entry can actually run bash when
  // the sandbox runner is absent); other platforms keep the interactive default
  // by not injecting a mode here — resolveExecProtocolPermissionMode falls back
  // to "interactive" when absent.
  const isWindows = process.platform === "win32"
  normalized.exec_protocol = {
    ...(isWindows ? { mode: "full-auto" } : {}),
    additional_writable_roots: existingExecProtocol.additional_writable_roots ?? [],
    ephemeral: existingExecProtocol.ephemeral ?? false,
    ...existingExecProtocol,
  }

  const localPermissions = isPlainRecord(normalized.local_permissions)
    ? { ...normalized.local_permissions }
    : isPlainRecord(normalized.localPermissions)
      ? { ...normalized.localPermissions }
      : {}

  const authorityRoot =
    globalRoot ? path.resolve(globalRoot)
    : typeof localPermissions.authority_root === "string" && localPermissions.authority_root.trim()
      ? localPermissions.authority_root
      : typeof localPermissions.authorityRoot === "string" && localPermissions.authorityRoot.trim()
        ? localPermissions.authorityRoot
        : resolveRuntimeAuthorityRoot(workDir)

  normalized.local_permissions = {
    ...localPermissions,
    authority_root: authorityRoot,
  }
  const aiWorkflow = isPlainRecord(normalized.aiWorkflow) ? { ...normalized.aiWorkflow } : {}
  const existingRoots = isPlainRecord(aiWorkflow.roots) ? { ...aiWorkflow.roots } : {}
  const defaultRoots = resolveRuntimeWorkflowRoots(workDir, authorityRoot)
  normalized.aiWorkflow = {
    ...aiWorkflow,
    roots: {
      ...existingRoots,
      globalRoot: typeof existingRoots.globalRoot === "string" ? existingRoots.globalRoot : defaultRoots.globalRoot,
      workspaceRoot: typeof existingRoots.workspaceRoot === "string" ? existingRoots.workspaceRoot : defaultRoots.workspaceRoot,
    },
  }
  const resourcePackages = isPlainRecord(normalized.resourcePackages)
    ? { ...normalized.resourcePackages }
    : {}
  const resourceLayers = Array.isArray(resourcePackages.layers)
    ? resourcePackages.layers.map((layer) => isPlainRecord(layer) ? { ...layer } : layer)
    : resolveRuntimeResourcePackageLayers(workDir, authorityRoot)
  normalized.resourcePackages = {
    ...resourcePackages,
    layers: resourceLayers,
  }

  // runtime-config.json: terminal constructs a ResourceVFS from the two
  // `.eidolon` roots (workDir takes precedence over home), parses it into
  // typed RuntimeConfig via ai-support, and injects it on metadata.runtimeConfig
  // for the cell executor to consume. Load failures silently fall back to the
  // embedded default config inside RuntimeConfigVfsLoader.
  try {
    const workRoot = path.join(path.resolve(workDir), ".eidolon")
    const homeRoot = authorityRoot
    const vfs = ResourceVFSLoaderOps.fromEidolonRoots([homeRoot, workRoot])
    normalized.runtimeConfig = loadRuntimeConfigFromVfs(vfs)
  } catch {
    // keep metadata without runtimeConfig; consumers fall back to defaults
  }
  return normalized
}

export function buildExecRuntimeMetadata(options: ExecRuntimeMetadataOptions): Record<string, unknown> {
  const metadata = normalizeSessionRuntimeMetadata(options.workDir, options.metadata)
  const sandboxPermissions = isPlainRecord(metadata.sandbox_permissions)
    ? { ...metadata.sandbox_permissions }
    : {}
  const execProtocol = isPlainRecord(metadata.exec_protocol)
    ? { ...metadata.exec_protocol }
    : {}

  metadata.sandbox_permissions = {
    ...sandboxPermissions,
    // `dangerous` and `full-auto` are unified trusted modes, so both run with
    // full filesystem access; only the prompting modes stay workspace-write.
    sandbox_mode:
      options.approvalMode === "dangerous" || options.approvalMode === "full-auto"
        ? "danger-full-access"
        : "workspace-write",
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

const shellRuntimeFacade = createShellRuntimeFacade()

export type SessionRuntimeBindingInput = {
  workDir: string
  entryType: RuntimeCompositionEntryType
  profileId?: string
  storage?: Partial<RuntimeCompositionStorageFlags>
  surfaceCapabilities?: readonly string[]
}

export type SessionRuntimeBinding = {
  profile: ReturnType<typeof resolveRuntimeProfileById>
  descriptor: RuntimeCompositionBindingDescriptor
}

export function resolveSessionRuntimeBindingFromConfig(config: SessionRuntimeConfig): SessionRuntimeBinding {
  return composeSessionRuntimeBinding({
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
export function composeSessionRuntimeBinding(input: SessionRuntimeBindingInput): SessionRuntimeBinding {
  const profile = resolveRuntimeProfileById(input.profileId ?? aiCodingRuntimeProfile.id)
  const descriptor = buildRuntimeCompositionBindingDescriptor({
    profile,
    context: {
      workDir: input.workDir,
      skillsDescription: "",
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

let llmAdapterFactoryOverride: null | ((adapterType: LlmAdapterType, workDir: string, overrides?: { apiKey?: string; baseUrl?: string; model?: string; options?: Record<string, unknown> }, runtime?: Partial<LlmProviderRuntime>) => Promise<any>) = null
let runtimeAssemblyFactoryOverride: null | RuntimeCompositionFactory = null

export type SessionProviderCollector = {
  onTurnPhase(phase: "request_send" | "response_complete"): void
  onCompaction(entry: { beforeMessageCount: number; afterMessageCount: number; reason: string }): void
}
const turnSemanticBridgeBySession = new Map<string, SessionPresentation>()
const notificationSemanticBridgeBySession = new Map<string, SessionPresentation>()
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

export function __setLlmAdapterFactoryForTest(factory: null | ((adapterType: LlmAdapterType, workDir: string, overrides?: { apiKey?: string; baseUrl?: string; model?: string; options?: Record<string, unknown> }, runtime?: Partial<LlmProviderRuntime>) => Promise<any>)) {
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

export function buildSystemMessages(prompt: string[]) {
  const isWindows = process.platform === "win32"
  const shellName = isWindows ? "cmd.exe" : process.platform === "darwin" ? "zsh" : "bash"
  const commandGuidance = isWindows
    ? "Use Windows commands: `dir` for `ls`, `type` for `cat`, `where` for `which`, `findstr` for `grep`. Run shell syntax via `cmd /c` or `powershell -Command`. Paths use backslashes (`E:\\dir\\file`)."
    : "Use POSIX commands: `ls`, `find`, `grep`, `pwd`. Paths use forward slashes (`/dir/file`)."
  const platformBlock = [
    `Current platform: ${process.platform} (${os.type()}).`,
    `Shell: ${shellName}.`,
    commandGuidance,
  ].join("\n")
  return [
    ...prompt.map((p) => ({ role: "system", content: p })),
    { role: "system", content: platformBlock },
  ]
}

function resolveExplicitRuntimeModelRef(model?: string): string | undefined {
  const normalized = String(model ?? "").trim()
  if (!normalized) return undefined
  const separatorIndex = normalized.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex >= normalized.length - 1) return undefined
  return normalized
}

export async function createSessionRuntimeAssembly(
  options: SessionRuntimeAssemblyOptions,
): Promise<SessionRuntimeBridge | null> {
  const { sessionKey } = options
  const shellRuntimeFacade = createShellRuntimeFacade({ additionalWatchedProjection: options.additionalWatchedProjection })
  const runtimeConfig = { ...options.config }
  const presentationFactory = options.presentationFactory ?? createTextSessionPresentation
  const currentProviderCollector = options.providerCollector
  const llmAdapterFactory = llmAdapterFactoryOverride
  const assemblyFactory = runtimeAssemblyFactoryOverride
  const paths = createShellRuntimePaths(runtimeConfig.workDir)
  const configurationWorkDir=runtimeConfig.configurationWorkDir??paths.WORKDIR,configurationPaths=createShellRuntimePaths(configurationWorkDir)
  const normalizedRuntimeMetadata = normalizeSessionRuntimeMetadata(paths.WORKDIR, runtimeConfig.metadata, runtimeConfig.globalRoot)
  const preparedEffectiveVfs = await prepareEffectiveEidolonVfs({
    homeEidolonRoot: String((normalizedRuntimeMetadata.local_permissions as Record<string, unknown>).authority_root),
    workspaceEidolonRoot: path.join(configurationWorkDir, ".eidolon"),
  })
  return withEffectiveVfsLifetime<SessionRuntimeBridge>(preparedEffectiveVfs, async () => {
  const resourcePackages = isPlainRecord(normalizedRuntimeMetadata.resourcePackages)
    ? normalizedRuntimeMetadata.resourcePackages
    : {}
  normalizedRuntimeMetadata.resourcePackages = {
    ...resourcePackages,
    effectiveVfs: () => preparedEffectiveVfs.materializer.read().readPort,
    effectiveVfsAuthoring: preparedEffectiveVfs.authoring,
  }
  normalizedRuntimeMetadata.runtimeConfig = loadRuntimeConfigFromVfs(
    (await createLegacyResourceVfsProjectionFromReadPort(preparedEffectiveVfs.effective.readPort)).vfs,
  )
  const runtimeBinding = resolveSessionRuntimeBindingFromConfig(runtimeConfig)
  const defaultRuntimeAssemblyFactory =
    assemblyFactory
    ?? ((context: RuntimeAssemblyContext) => assembleRuntimeCompositionProfile(runtimeBinding.profile, context))
  const bootstrapAssembly = defaultRuntimeAssemblyFactory({
    workDir: paths.WORKDIR,
    skillsDescription: "",
    loadedAgents: {},
    delegateAgentDescriptions: "",
  })
  const runtimeSupport = bootstrapAssembly.runtimeSupport
  if (!runtimeSupport) {
    throw new Error("Runtime unavailable: runtime profile did not provide runtime support descriptor")
  }
  const agentLoader = runtimeSupport.createAgentLoader(configurationPaths.AGENTS_DIR)
  const workflowComponent = createWorkflowComponentForRuntimeBinding({
    workDir: paths.WORKDIR,
    metadata: normalizedRuntimeMetadata,
  })
  const resourceAgentPlans = await workflowComponent.resourceRegistry.listStandaloneAgentExecutionPlans()
  const loadedAgents = mergeResourceAgentConfigs(agentLoader.getAgents(), resourceAgentPlans)
  const runtimeAssemblyFactory = defaultRuntimeAssemblyFactory
  const runtimeAssembly = runtimeAssemblyFactory({
    workDir: paths.WORKDIR,
    skillsDescription: "",
    loadedAgents,
    delegateAgentDescriptions: agentLoader.getDescriptions(),
  })
  const runtimeRegistries = runtimeAssembly.createRegistries({ includeInternalOnly: true })
  const runtimeAgents: SessionAgentDescription[] = Object.entries(runtimeAssembly.agentConfigs).map(([name, config]) => ({
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
    workDir: configurationWorkDir,
    globalRoot: runtimeConfig.globalRoot,
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
  refreshProviderTransportMarkers(modelConfig, configurationWorkDir, runtimeConfig.globalRoot)

  const adapterType = configuredAdapterType ?? modelConfig.adapter
  if (!adapterType) {
    throw new Error("LLM adapter unavailable: configure agent-present.json with a model present in llm-provider.json")
  }
  const sessionDir = runtimeConfig.ephemeral
    ? fs.mkdtempSync(path.join(os.tmpdir(), `eidolon-exec-${sessionKey}-`))
    : options.ownedSessionDir??ensureShellRuntimeSessionDir(paths.WORKDIR, sessionKey)
  if(options.ownedSessionDir&&(!path.isAbsolute(options.ownedSessionDir)||runtimeConfig.ephemeral))throw new Error('invalid_owned_session_directory')
  const usesSessionStorage = runtimeBinding.descriptor.storage.files || runtimeBinding.descriptor.storage.logs
  const writerLease = usesSessionStorage ? await createSessionWriterLeaseEffects().acquire(sessionDir) : null
  return withEffectiveVfsLifetime<SessionRuntimeBridge>({ dispose: () => writerLease?.release() }, async () => {
  const isEphemeralSession = runtimeConfig.ephemeral === true
  const persistSnapshots = runtimeConfig.ephemeral !== true
  let sessionMaterialized = isEphemeralSession || fs.existsSync(sessionDir)
  let providerRequestObservationBinding: ProviderRequestObservationBinding | null = null
  try {
    providerRequestObservationBinding = runtimeConfig.providerRequestObservationBindingFactory?.({
      sessionDir,
      sessionId: sessionKey,
      ephemeral: isEphemeralSession,
      storageFilesEnabled: runtimeBinding.descriptor.storage.files,
    }) ?? null
  } catch {
    providerRequestObservationBinding = null
  }

  const providerDiagnosticsCollector = createProviderDiagnosticsCollector()
  const providerObservationRuntime = {
    sessionId: sessionKey,
    diagnostics: providerDiagnosticsCollector.runtime,
    requestObservationPort: providerRequestObservationBinding?.port ?? null,
  }
  const llmAdapter = await createRuntimeLlmAdapter({
    adapterType,
    workDir: configurationWorkDir,
    defaults: buildAdapterDefaults(),
    useMock: USE_MOCK,
    overrides: {
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.baseUrl,
      model: modelConfig.model,
      options: modelConfig.options,
    },
    factoryOverride: llmAdapterFactory,
    runtime: providerObservationRuntime,
  })

  if (!llmAdapter) {
    try {
      providerRequestObservationBinding?.dispose()
    } catch {}
    if (isEphemeralSession) {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
    return null
  }

  let mcpManager: MCPManager | null = null
  if (runtimeConfig.mcp !== false) {
    const mcpServers = loadMcpServers(configurationPaths.MCP_DIR)
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

  const eventBus = new DomainRuntimeEventGraph()
  const toolRegistry = runtimeRegistries.toolRegistry
  const semanticRuntimeBridge = presentationFactory()
  const asyncSemanticRuntimeBridge = presentationFactory()
  turnSemanticBridgeBySession.set(sessionKey, semanticRuntimeBridge)
  notificationSemanticBridgeBySession.set(sessionKey, asyncSemanticRuntimeBridge)
  const actorCallbacks = {
    buildToolset: (currentVm: DomainRuntimeVm) => runtimeAssembly.buildToolset(currentVm),
    processStream: (currentVm: any, streamActor: any, stream: any, options?: LlmProcessStreamOptions) => {
      const reasoningDebug = currentVm.options?.storage?.reasoningDebug
      return processRuntimeIngressStream({
        stream,
        adapterType,
        llmAdapter: options?.llmAdapter,
        eventBus,
        actorMeta: {
          agentKey: streamActor.key,
          agentActorId: streamActor.id,
        },
        sessionDir,
        sessionId: sessionKey,
        storageLogsEnabled: isRuntimeStorageLogsEnabled(currentVm as DomainRuntimeVm),
        reasoningRetention: reasoningDebug
          ? {
              mode: "debug",
              maxCharacters: Math.max(0, Number(reasoningDebug.maxCharacters) || 0),
              expiresAt: Date.now() + Math.max(0, Number(reasoningDebug.ttlMs) || 0),
            }
          : undefined,
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
    sealCompletedProgress,
    effects: {
      orchestrationHistoryEffect,
    },
  } = await recoverOrCreateShellRuntime({
    workDir: paths.WORKDIR,
    sessionDir,
    sessionKey,
    llmClient: llmAdapter,
    profileSystemPrompt: {
      profileId: runtimeAssembly.profileId,
      systemPrompt: runtimeAssembly.systemPrompt,
    },
    modelConfig,
    eventBus,
    registries: runtimeRegistries,
    runtimeSupport,
    actorCallbacks,
    buildSystemMessages,
    mcpManager: (mcpManager ?? undefined) as any,
    outerCtxMetadata: normalizedRuntimeMetadata,
    storage: runtimeBinding.descriptor.storage,
  })
  if (options.toolResources) vm.effects.toolResources = options.toolResources
  bindWorkflowComponentToRuntime({ vm }, workflowComponent)
  const adapterStateByActor = new WeakMap<AiAgentActor, {
    adapterType: LlmAdapterType
    apiKey?: string
    baseUrl?: string
    model?: string
    optionsKey?: string
  }>()
  const pendingProviderEpochReason = new WeakMap<AiAgentActor, "initial_projection" | "model_control" | "recovery_rebuild">()
  const providerEpochReasonByActor = new WeakMap<AiAgentActor, "initial_projection" | "model_control" | "recovery_rebuild">()
  const recoveredProviderEpochReceiptByActor = new WeakMap<AiAgentActor, NonNullable<ReturnType<typeof getConversationActorRawStateFromVm>>["session"]["actorBindings"][string]["providerEpochReceiptV2"]>()
  const providerEpochActors = new Set<AiAgentActor>()
  let reassertProviderEpochsBeforeSnapshot: (() => Promise<void>) | null = null
  adapterStateByActor.set(actor, {
    adapterType,
    apiKey: modelConfig.apiKey,
    baseUrl: modelConfig.baseUrl,
    model: modelConfig.model,
    optionsKey: JSON.stringify(modelConfig.options ?? {}),
  })
  for (const runtimeActor of Object.values(vm.actors)) {
    const receipt = getConversationActorRawStateFromVm({
      vm,
      actorKey: runtimeActor.key,
      sessionId: sessionKey,
    })?.session.actorBindings[runtimeActor.key]?.providerEpochReceiptV2
    if (receipt) recoveredProviderEpochReceiptByActor.set(runtimeActor, receipt)
  }
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
  ensureVmRuntimeContext(vm).actorFacetRuntime = extendActorRetirementFacetRegistry(ensureVmRuntimeContext(vm).actorFacetRuntime)
  if (options.requireExplicitGoalActivation) {
    ensureVmRuntimeContext(vm).threadGoalRuntime.requireExplicitActivation = true
    if (getThreadGoal(vm)?.status === "active") updateThreadGoalStatus({ vm, status: "paused", suspensionReason: "runtime_restarted" })
    for (const runtimeActor of Object.values(vm.actors)) {
      runtimeActor.mailboxes.heartbeat = []
    }
    // Opening a Web workspace does not grant recovered schedules authority to execute.
    // New schedules created by subsequently admitted work still use the normal scheduler.
    for (const schedule of Object.values(ensureHeartbeatSchedulerState(vm).schedules)) {
      cancelHeartbeatSchedule(vm, { scheduleId: schedule.scheduleId, reason: 'web_runtime_restarted' })
    }
  }
  const runtimeCoordinator = shellRuntimeFacade.createRuntimeCoordinator({
    vm,
    driver,
    saveSnapshot: async () => {
      await reassertProviderEpochsBeforeSnapshot?.()
      await saveSnapshot()
    },
    sealCompletedProgress,
    hookDefinitions: runtimeAssembly.hookDefinitions,
    hookHandlers: createDefaultRuntimeHookHandlers({ goalContinuationAdmission: options.goalContinuationAdmission }),
  })
  const activateSessionMaterialization = () => {
    sessionMaterialized = true
  }
  const persistSnapshot = async () => {
    if (!persistSnapshots || !sessionMaterialized) return
    await runtimeCoordinator.saveSnapshot()
  }
  let sessionExtension: Awaited<ReturnType<NonNullable<SessionRuntimeAssemblyOptions["openExtension"]>>> | undefined
  let heartbeatWorker: ReturnType<typeof startHeartbeatSchedulerWorker> | undefined
  try {
  sessionExtension = await options.openExtension?.({
    vm, actor, driver, sessionDir, workDir: paths.WORKDIR,
    workflowComponent, activateSessionMaterialization, persistSnapshot,
  })
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
  heartbeatWorker = startHeartbeatSchedulerWorker(vm as any, {
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
        runtimeError: Error | null
        settled: boolean
        settledPromise: Promise<void>
        resolveSettled: () => void
      }
    | null = null
  const subscribeProjectionEvents = (
    bridge: SessionPresentation,
    handler: (event: SessionPresentationEvent) => void,
  ) => {
    return bridge.onEvent(handler)
  }
  let asyncNotificationCategory: SessionMessageCategory | undefined
  const asyncNotificationConsumer = subscribeProjectionEvents(asyncSemanticRuntimeBridge, (event: SessionPresentationEvent) => {
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
    const routing = shellRuntimeFacade.routeProjectionEvent({
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
      const runtimeError = new Error(message) as Error & { code?: string }
      if (typeof event.error.code === "string" && event.error.code) {
        runtimeError.code = event.error.code
      }
      activeTurn.runtimeError = runtimeError
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
  if (!options.requireExplicitGoalActivation && (recoveredHeartbeatFires.length > 0 || recoveredMailboxWorkFiberIds.length > 0)) {
    void runtimeCoordinator.enqueue(async () => {
      const now = Date.now()
      const fiberIds = new Set(recoveredMailboxWorkFiberIds)
      for (const fiberId of fiberIds) {
        driver.resumeFiber(fiberId, now)
      }
      await driver.tickUntilForegroundSettled({ now, maxTicks: 200 })
      await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 200 })
    }).catch(() => {})
  }

  const reviveFiberForInteractiveTurnIfNeeded = (fiberId: string) => {
    const status = driver.getState().fibers[fiberId]?.status
    if (status === "failed" || status === "cancelled") {
      driver.reviveFiber(fiberId, Date.now())
    }
  }

  const resolveConfiguredActorModelConfig = () => {
    return runtimeSupport.resolveActorModelConfig({
      workDir: configurationWorkDir,
      globalRoot: runtimeConfig.globalRoot,
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
      const projectCandidate = path.join(configurationWorkDir, ".eidolon", PROVIDER_CONFIG_FILE_NAME)
      const configPath = fs.existsSync(projectCandidate) ? projectCandidate : runtimeConfig.globalRoot ? path.join(runtimeConfig.globalRoot, PROVIDER_CONFIG_FILE_NAME) : defaultProviderConfigPath()
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
    refreshProviderTransportMarkers(targetActor.modelConfig, configurationWorkDir, runtimeConfig.globalRoot)
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
        workDir: configurationWorkDir,
        defaults: buildAdapterDefaults(),
        useMock: USE_MOCK,
        overrides: {
          apiKey: targetActor.modelConfig.apiKey,
          baseUrl: targetActor.modelConfig.baseUrl,
          model: targetActor.modelConfig.model,
          options: targetActor.modelConfig.options,
        },
        factoryOverride: llmAdapterFactory,
        runtime: providerObservationRuntime,
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

  // An explicitly supplied model is an operator recovery command, not a
  // fallback for creating a new actor.  A recovered actor normally retains
  // its persisted model config for continuity, but that must not make
  // `eidolon run --session ... --model provider/model` silently keep using
  // the failed provider/model.  Refreshing the adapter below makes this a
  // durable, provider-consistent switch before the next user turn.
  if (explicitRuntimeModelRef && !options.preserveRecoveredModel) {
    actor.modelConfig = resolveConfiguredActorModelConfig()
    pendingProviderEpochReason.set(actor, "model_control")
  }

  const activateProviderEpochForActor = async (targetActor: AiAgentActor) => {
    const reason = pendingProviderEpochReason.get(targetActor)
      ?? (targetActor === actor ? "recovery_rebuild" : "initial_projection")
    const activated = activateActorProviderEpoch({
      vm,
      actor: targetActor,
      sessionId: sessionKey,
      targetProviderId: String(targetActor.modelConfig.provider ?? ""),
      targetProfileId: resolveProviderEpochProfileId(
        targetActor.modelConfig,
        (targetActor.llmClient as any)?.runtime?.chatCompatibilityProfileId,
      ),
      reason,
    })
    pendingProviderEpochReason.delete(targetActor)
    providerEpochReasonByActor.set(targetActor, reason)
    recoveredProviderEpochReceiptByActor.set(targetActor, activated.receipt)
    providerEpochActors.add(targetActor)
    await ensureActorProviderContextEpochBeforeTransport({ vm, actor: targetActor })
    return activated
  }
  reassertProviderEpochsBeforeSnapshot = async () => {
    for (const targetActor of providerEpochActors) {
      activateActorProviderEpoch({
        vm,
        actor: targetActor,
        sessionId: sessionKey,
        targetProviderId: String(targetActor.modelConfig.provider ?? ""),
        targetProfileId: resolveProviderEpochProfileId(
          targetActor.modelConfig,
          (targetActor.llmClient as any)?.runtime?.chatCompatibilityProfileId,
        ),
        reason: providerEpochReasonByActor.get(targetActor) ?? "recovery_rebuild",
      })
      await ensureActorProviderContextEpochBeforeTransport({ vm, actor: targetActor })
    }
  }

  const runActorInteractiveTurn = async (targetActor: AiAgentActor, targetFiberId: string, params: {
    timeoutSeconds?: number
  } = {}) => {
    applyActorModelConfigControlSignals(targetActor)
    if (!targetActor.modelConfig.model || !isActorModelConfigResolvable(targetActor)) {
      targetActor.modelConfig = runtimeSupport.resolveActorModelConfig({
        workDir: configurationWorkDir,
        globalRoot: runtimeConfig.globalRoot,
        agentKey: targetActor.key,
        modelRef: targetActor === actor ? explicitRuntimeModelRef : undefined,
        strictModelRef: targetActor === actor && Boolean(explicitRuntimeModelRef),
        fallbackModelConfig,
      })
    }
    await refreshActorAdapterForModelConfig(targetActor)
    await activateProviderEpochForActor(targetActor)
    reviveFiberForInteractiveTurnIfNeeded(targetFiberId)
    const result = await runtimeCoordinator.runInteractiveTurn({
      mainFiberId: targetFiberId,
      timeoutMs: params.timeoutSeconds && params.timeoutSeconds > 0 ? params.timeoutSeconds * 1000 : undefined,
    })
    const targetFiber = driver.getState().fibers[targetFiberId]
    if (targetFiber?.status === "failed") {
      throw new Error(targetFiber.lastError || "runtime_actor_fiber_failed")
    }
    if (result.status === "timeout_unsettled") {
      throw new Error(`runtime_turn_unsettled:${result.reason || "unknown"}`)
    }
  }

  const runTurn = async (params: {
    timeoutSeconds?: number
  } = {}) => runActorInteractiveTurn(actor, mainFiberId, params)

  const resolveInputContent = async (input: InputContent): Promise<InputContentPart[]> => {
    const parts = normalizeInputContent(input)
    const resolved: InputContentPart[] = []
    for (const part of parts) {
      if (part.type !== "file_reference") {
        resolved.push(part)
        continue
      }
      if (!runtimeConfig.attachmentResolver) {
        throw new Error(`attachment_resolver_unavailable:${part.filename || "attachment"}`)
      }
      resolved.push(await runtimeConfig.attachmentResolver.resolve(part as InputFileReferenceContentPart))
    }
    return resolved
  }

  const validateActorInput = (targetActor: AiAgentActor, input: InputContent): InputContentPart[] => {
    requireActiveActor(targetActor)
    const resolved = normalizeInputContent(input)
    if (resolved.some(part => part.type === "file_reference")) throw new Error("input_file_reference_unresolved")
    validateProviderPromptInputModalities({
      vm,
      actor: targetActor,
      model: targetActor.modelConfig.model ?? "",
      messages: [{ role: "user", content: resolved }],
    })
    return resolved
  }
  const resolveAndValidateInputContent = async (input: InputContent): Promise<InputContentPart[]> => validateActorInput(actor, await resolveInputContent(input))

  const enqueueUserProvidedInput = (input: InputContent): InputContent => {
    const inputText = projectInputContentText(input)
    const expanded = slashRuntime?.resolveCommand(inputText) ?? null
    const normalizedInput: InputContent = expanded && expanded.kind === "prompt_expand" ? expanded.prompt : input
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
              content: projectInputContentText(normalizedInput),
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

  type BridgeTurnOptions = {
    timeoutSeconds?: number
    onChunk?: (chunk: string) => void | Promise<void>
    onControl?: (control: SessionControl) => void | Promise<void>
  }

  let chain: Promise<void> = Promise.resolve()
  const runProjectedTurn = (params: {
    input: InputContent
    opts?: BridgeTurnOptions
    enqueueInput: boolean
    allowDirectSlash: boolean
  }) => {
    if (activeTurn) {
      if (params.enqueueInput) {
        return resolveAndValidateInputContent(params.input).then((resolved) => {
          enqueueUserProvidedInput(resolved)
          void persistSnapshot()
          return ""
        })
      }
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
      const handleProjectionEvent = (event: SessionPresentationEvent): void | Promise<void> => {
        if (turnState.cancelled) return
        if (event.kind === "control") {
          return params.opts?.onControl?.(event.payload)
        }
        const chunk = String(event.payload)
        output += chunk
        return params.opts?.onChunk?.(chunk)
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
      const listener = subscribeProjectionEvents(semanticRuntimeBridge, (event: SessionPresentationEvent) => {
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
        if (params.allowDirectSlash) {
          const directOutput = await executeDirectSlashCommand(projectInputContentText(params.input))
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
        }
        if (params.enqueueInput) {
          enqueueUserProvidedInput(await resolveAndValidateInputContent(params.input))
        }
        const timeoutSeconds =
          params.opts?.timeoutSeconds !== undefined ? params.opts.timeoutSeconds : runtimeConfig.timeoutSeconds
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

  const turn = (
    input: InputContent,
    opts?: {
      timeoutSeconds?: number
      onChunk?: (chunk: string) => void | Promise<void>
      onControl?: (control: SessionControl) => void | Promise<void>
    },
  ) => {
    return runProjectedTurn({
      input,
      opts,
      enqueueInput: true,
      allowDirectSlash: true,
    })
  }

  const resumeTurn = (opts?: BridgeTurnOptions) => {
    return runProjectedTurn({
      input: "",
      opts,
      enqueueInput: false,
      allowDirectSlash: false,
    })
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
    await driver.tickUntilBlocked({ now, maxTicks: 20, maxWallMs: 250 })
    await persistSnapshot()
  }

  const compact: SessionRuntimeBridge["compact"] = async (target) => {
    const targetActor = target ? Object.values(vm.actors).find(candidate => candidate.id === target.actorId) : actor
    if (!targetActor) throw new Error("actor_not_found")
    if (target && targetActor !== actor && targetActor.type !== "interactive") throw new Error("actor_read_only")
    target?.beforeCompact?.()
    applyActorModelConfigControlSignals(targetActor)
    if (!targetActor.modelConfig.model || !isActorModelConfigResolvable(targetActor)) {
      targetActor.modelConfig = resolveConfiguredActorModelConfig()
    }
    await refreshActorAdapterForModelConfig(targetActor)
    target?.beforeCompact?.()
    const beforeMessageCount = targetActor.messages.length
    const result = await runtimeCoordinator.enqueue(async () => {
      target?.beforeCompact?.()
      const compressed = await forceCompressActorHistory({
        vm,
        actor: targetActor,
        trigger: "manual_compact",
      })
      if (!compressed.ok) return compressed
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
        compaction: { compacted: false, tokensBefore: result.tokensBefore, messagesAfter: result.messagesAfter },
      }
    }
    currentProviderCollector?.onCompaction({
      beforeMessageCount,
      afterMessageCount: result.messagesAfter,
      reason: "manual_compact",
    })
    return {
      ok: true,
      message: `Session compacted (${result.tokensBefore} estimated tokens -> ${result.messagesAfter} messages)`,
      compaction: { compacted: true, tokensBefore: result.tokensBefore, messagesAfter: result.messagesAfter },
    }
  }

  const callTool = async (name: string, input: unknown): Promise<unknown> => {
    const toolName = name.trim()
    if (!toolName) throw new Error("Native tool name is required")
    if (!ToolFuncRegistry.get(toolRegistry, toolName)) {
      throw new Error(`Unknown native tool: ${toolName}`)
    }
    return runtimeCoordinator.enqueue(async () => {
      const output = await ToolFuncRegistry.call(
        toolRegistry,
        toolName,
        vm,
        actor,
        input,
        { toolCallId: `terminal:${toolName}:${randomUUID()}` },
      )
      await runtimeCoordinator.saveSnapshot()
      return output
    })
  }

  const callWorkflowHostCommand = async (name: string, input: unknown): Promise<unknown> => {
    const toolName = name.trim()
    if (!toolName) throw new Error("Native Workflow host command name is required")
    return runtimeCoordinator.enqueue(async () => {
      const output = await runWorkflowNativeHostCommand({ vm, actor } as any, toolName, input)
      await runtimeCoordinator.saveSnapshot()
      return output
    })
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
    target: { laneId?: string; actorId?: string; requestedBy?: string },
    model: RuntimeActiveModelSelection,
  ): Promise<ActorSurfaceProjectionData> => {
    const modelRef = `${model.providerID}/${model.modelID}`
    const beforeProjection = buildActorSurfaceProjection(vm as any)
    const targetActorBeforeSignal = findActorForSurfaceProjection(beforeProjection, target) ?? actor
    const nextModelConfig = runtimeSupport.resolveActorModelConfig({
      workDir: configurationWorkDir,
      globalRoot: runtimeConfig.globalRoot,
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
      requestedBy: target.requestedBy ?? "terminal-tui",
      modelConfig: nextModelConfig,
    })
    const targetActor = findActorForSurfaceProjection(projection, target)
    if (targetActor) {
      applyActorModelConfigControlSignals(targetActor)
      pendingProviderEpochReason.set(targetActor, "model_control")
      await refreshActorAdapterForModelConfig(targetActor)
      await activateProviderEpochForActor(targetActor)
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
    const targetActor = findActorForSurfaceProjection(projection, target)
    if (!targetActor) return buildActorSurfaceProjection(vm as any)
    const targetFiberId = `${targetActor.key}:${targetActor.id}`
    await runActorInteractiveTurn(targetActor, targetFiberId, {
      timeoutSeconds: runtimeConfig.timeoutSeconds,
    })
    return buildActorSurfaceProjection(vm as any, {
      selectedLaneId: target.laneId ?? projection.selectedLaneId,
      selectedActorId: target.actorId ?? projection.selectedActorId,
    })
  }

  const cancelActorTurn = async (request: {
    actorId: string
    turnId?: string
  }) => {
    const projection = createDurableActorSurfaceFacade().cancelActorTurn(request)
    const actorLane = projection.actorLanes.find((lane) => lane.actorId === request.actorId)
    if (actorLane) {
      const now = Date.now()
      await driver.tickUntilBlocked({ now, maxTicks: 80, maxWallMs: 2_000 })
      await persistSnapshot()
    }
    return projection
  }

  const submitQuestionnaireResponse = async (questionnaireId: string, responseText: string) => {
    // The caller immediately continues the unblocked turn through resumeTurn().
    // Saving here would first run progressBeforeSnapshot(), which can consume
    // that continuation before the TUI has subscribed to its output.
    return createDurableActorSurfaceFacade().submitQuestionnaireResponse(questionnaireId, responseText)
  }

  const dispose = async (options?: { checkpoint?: "already_saved" }) => {
    let extensionCloseError: unknown
    try { sessionExtension?.close() } catch (error) { extensionCloseError = error }
    await Promise.all([heartbeatWorker?.shutdown(), runtimeCoordinator.shutdown()])
    if (options?.checkpoint !== "already_saved") await persistSnapshot()
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
    try {
      providerRequestObservationBinding?.dispose()
    } catch {}
    if (isEphemeralSession) {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
    if (extensionCloseError) throw extensionCloseError
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

  const readTimingProjection = (window: RuntimeTimingWindow): RuntimeTimingProjection => projectRuntimeTiming({
    ...window,
    sessionId: sessionKey,
    providerCalls: getVmProviderCallDomain(vm)?.getAllRecords() ?? [],
    toolCalls: getVmToolCallDomain(vm)?.getAllRecords() ?? [],
    providerRetries: providerDiagnosticsCollector.events.retry,
  })
  const readUsageProjection = (): AiAgentVmUsageData => {
    const { publicRxData } = ensureVmRxData(vm)
    return Object.freeze({ ...publicRxData.usage.get() })
  }
  const readProviderCacheObservations = (): readonly ProviderCacheCostObservation[] => (
    readProviderCacheObservationProjection(vm)
  )
  const readWorkflowExecutions = (): readonly WorkflowPublicRuntimeEvidence[] => (
    readWorkflowPublicRuntimeEvidence(vm)
  )

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

  const createActorConversationForkPort = (targetActor: AiAgentActor, invocation?: ConversationForkInvocation) => {
    const conversationSessionForkCommandPort = runtimeSupport.persistence.conversationPersistenceRepositoryFactory
      ? createConversationSessionForkPort({
        owner: { sessionId: sessionKey, actorKey: targetActor.key, actorId: targetActor.id },
        repositoryFactory: runtimeSupport.persistence.conversationPersistenceRepositoryFactory,
        resolveSessionDir: (targetSessionId) => targetSessionId===sessionKey?sessionDir:path.join(paths.WORKDIR, ".eidolon", "sessions", targetSessionId),
        createChildActorId: ({ command, actorKey, actorId }) => `actor-fork-${digestProviderContextClosedValue({
          sourceSessionId: command.sourceSessionId,
          targetSessionId: command.targetSessionId,
          actorKey,
          actorId,
        }).slice(7, 31)}`,
        runExclusive: async (_sourceSessionId, action) => await runtimeCoordinator.enqueue(action),
        beforeSourceRead: async () => {
          // Seal only already-completed Conversation progress. No VM snapshot or
          // surface projection participates in fork authority resolution.
          await sealCompletedProgress()
          await invocation?.beforeSourceRead?.()
        },
        beforeCommit: invocation?.beforeCommit,
      })
      : null
    return conversationSessionForkCommandPort
      ? createConversationSessionForkActorPort({
        identity: { sessionId: sessionKey, actorKey: targetActor.key, actorId: targetActor.id },
        port: conversationSessionForkCommandPort,
        senderId: "terminal-runtime-surface",
      })
      : null
  }

  const forkConversationSession = async (
    command: ConversationSessionForkCommand,
    target?: ConversationForkInvocation,
  ): Promise<ConversationSessionForkResult> => {
    if (command.sourceSessionId !== sessionKey) {
      return {
        status: "rejected",
        rejection: {
          code: "SOURCE_AUTHORITY_CHANGED",
          message: `fork source does not match owning Conversation runtime: ${command.sourceSessionId}`,
        },
      }
    }
    const targetActor = target ? Object.values(vm.actors).find(candidate => candidate.id === target.actorId) : actor
    if (!targetActor || (targetActor !== actor && targetActor.type !== "interactive")
      || (command.actorKey != null && command.actorKey !== targetActor.key)) {
      return { status: "rejected", rejection: { code: "SOURCE_ACTOR_NOT_FOUND", message: "fork requires its exact foreground Conversation Actor" } }
    }
    const conversationSessionForkPort = createActorConversationForkPort(targetActor, target)
    if (!conversationSessionForkPort) {
      return {
        status: "rejected",
        rejection: { code: "FORK_TRANSACTION_CONFLICT", message: "Conversation persistence capability is unavailable" },
      }
    }
    return await conversationSessionForkPort.fork(command)
  }

  const createActorConversationRewindPort = (targetActor: AiAgentActor, invocation?: ConversationRewindInvocation) => {
    const conversationSessionRewindCommandPort = runtimeSupport.persistence.conversationPersistenceRepositoryFactory
      ? createConversationSessionRewindPort({
        owner: { sessionId: sessionKey, actorKey: targetActor.key, actorId: targetActor.id },
        repositoryFactory: runtimeSupport.persistence.conversationPersistenceRepositoryFactory,
        resolveSessionDir: (targetSessionId) => path.join(paths.WORKDIR, ".eidolon", "sessions", targetSessionId),
        runExclusive: async (_sessionId, action) => await runtimeCoordinator.enqueue(action),
        beforeSourceRead: async () => { await sealCompletedProgress(); await invocation?.beforeSourceRead?.() },
        beforeCommit: invocation?.beforeCommit,
        afterCommit: async ({ repository }) => {
          await synchronizeConversationDomainActorFromPersistence({
            runtime: ensureVmConversationDomainRuntime(vm),
            sessionDir,
            actorKey: targetActor.key,
            repository,
          })
        },
      })
      : null
    return conversationSessionRewindCommandPort
      ? createConversationSessionRewindActorPort({
        identity: { sessionId: sessionKey, actorKey: targetActor.key, actorId: targetActor.id },
        port: conversationSessionRewindCommandPort,
        senderId: "terminal-runtime-surface",
      })
      : null
  }

  const rewindConversationSession = async (
    command: ConversationSessionRewindCommand,
    target?: ConversationRewindInvocation,
  ): Promise<ConversationSessionRewindResult> => {
    if (command.sessionId !== sessionKey) {
      return {
        status: "rejected",
        rejection: {
          code: "SOURCE_AUTHORITY_CHANGED",
          message: `rewind session does not match owning Conversation runtime: ${command.sessionId}`,
        },
      }
    }
    const targetActor = target ? Object.values(vm.actors).find(candidate => candidate.id === target.actorId) : actor
    if (!targetActor || (targetActor !== actor && targetActor.type !== "interactive")
      || (command.actorKey != null && command.actorKey !== targetActor.key)) {
      return { status: "rejected", rejection: { code: "ACTOR_NOT_FOUND", message: "rewind requires its exact foreground Conversation Actor" } }
    }
    const conversationSessionRewindPort = createActorConversationRewindPort(targetActor, target)
    if (!conversationSessionRewindPort) {
      return {
        status: "rejected",
        rejection: { code: "REWIND_TRANSACTION_CONFLICT", message: "Conversation persistence capability is unavailable" },
      }
    }
    return await conversationSessionRewindPort.rewind(command)
  }

  await options.onRuntimeReady?.({
    vm, actor, driver, mainFiberId, coordinator: runtimeCoordinator, eventBus, sessionDir,
    resolveActorModelConfig: (modelRef) => modelRef
      ? runtimeSupport.resolveActorModelConfig({ workDir: configurationWorkDir, globalRoot: runtimeConfig.globalRoot, agentKey: "main", modelRef,
        strictModelRef: true, fallbackModelConfig: actor.modelConfig })
      : { ...actor.modelConfig },
    prepareActor: async (targetActor) => {
      requireActiveActor(targetActor)
      applyActorModelConfigControlSignals(targetActor)
      await refreshActorAdapterForModelConfig(targetActor)
      await activateProviderEpochForActor(targetActor)
    },
    persistSnapshot,
    checkpointWithoutExecution: async () => {
      if (!persistSnapshots) throw new Error("checkpoint_storage_disabled")
      activateSessionMaterialization()
      return saveAiAgentRuntimeSnapshot({ sessionDir, sessionId: sessionKey, vm, driver })
    },
    activateSessionMaterialization,
    validateActorInput,
    ...(runtimeSupport.persistence.conversationPersistenceRepositoryFactory ? { conversationPersistence: {
      readForkCommit: (receipt: ConversationSessionForkReceipt) => readConversationForkCommitEvidence({
        repositoryFactory: runtimeSupport.persistence.conversationPersistenceRepositoryFactory!,
        resolveSessionDir: id => path.join(paths.WORKDIR, ".eidolon", "sessions", id),
      }, receipt),
      readRewindCommit: (receipt: ConversationSessionRewindReceipt) => readConversationRewindCommitEvidence({
        repositoryFactory: runtimeSupport.persistence.conversationPersistenceRepositoryFactory!,
        resolveSessionDir: id => path.join(paths.WORKDIR, ".eidolon", "sessions", id),
      }, receipt),
      synchronizeActor: (actorId: string, beforeRead: () => void) => runtimeCoordinator.enqueue(async () => {
        beforeRead()
        const targetActor = Object.values(vm.actors).find(candidate => candidate.id === actorId)
        if (!targetActor) throw new Error("actor_not_found")
        await synchronizeConversationDomainActorFromPersistence({
          runtime: ensureVmConversationDomainRuntime(vm), sessionDir, actorKey: targetActor.key,
          repository: runtimeSupport.persistence.conversationPersistenceRepositoryFactory!.createRepository(sessionDir),
        })
      }),
    } } : {}),
  })

  return {
    bindingDescriptor: runtimeBinding.descriptor,
    agents: async () => runtimeAgents,
    slashCommands: runtimeAssembly.slashCommands,
    slashRuntime,
    setActorActiveModel,
    turn,
    resumeTurn,
    compact,
    callTool,
    callWorkflowHostCommand,
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
    forkConversationSession,
    rewindConversationSession,
    readTimingProjection,
    readUsageProjection,
    readProviderCacheObservations,
    readWorkflowExecutions,
  }
  } catch (error) {
    try { sessionExtension?.close() } catch { /* Preserve the assembly failure. */ }
    await Promise.all([heartbeatWorker?.shutdown(), runtimeCoordinator.shutdown()])
    runtimeCoordinator.dispose()
    eventBus.dispose()
    providerRequestObservationBinding?.dispose()
    if (mcpManager) mcpManager.closeAll()
    throw error
  }
  })
  })
}
