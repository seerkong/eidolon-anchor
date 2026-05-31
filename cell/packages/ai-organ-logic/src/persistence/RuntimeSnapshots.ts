import {
  AI_AGENT_PLAN_APPROVAL_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_DECISIONS,
  AI_AGENT_COORDINATION_NAMES,
  AI_AGENT_SHUTDOWN_COORDINATION_KINDS,
  RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  ensureVmRuntimeContext,
  ensureVmSessionState,
  ensureVmRxData,
  getPendingDurableControlSignals,
  markDurableControlSignalConsumed,
  getControlActor,
  hydrateActor,
  hydrateVM,
  serializeActor,
  serializeVM,
  type AiAgentActor,
  type AiAgentVm,
  type RuntimeCallbacks,
  type RuntimeEffects,
  type RuntimeRegistries,
  type RuntimeSnapshotLoadResult,
  type RuntimeSnapshotManifest,
  type RuntimeSnapshotPersistedState,
  type RuntimeSnapshotFiber,
  type VmRecoveryReport,
} from "@cell/ai-core-logic"
import type { ActorTranscriptStore } from "@cell/ai-core-contract/runtime/ActorTranscript"
import type { AiRuntimeOuterCtx } from "@cell/ai-core-contract/runtime/AiRuntimeOuterCtx"
import type { McpManagerLike } from "@cell/ai-core-contract/runtime/McpManagerLike"
import type { RuntimeSnapshotRepositoryFactory } from "@cell/ai-core-contract/runtime/RuntimeSnapshotStore"
import type {
  ActorWorkContextData,
  ContinuationBaselineData,
} from "@cell/ai-core-contract/runtime/ContextControl"
import {
  bootstrapConversationHistoryFromMessages,
  loadConversationActorRawState,
  loadConversationHistoryMessages,
  loadConversationRuntimeMessages,
  loadConversationSessionRawState,
} from "@cell/ai-support"
import { aiAgentCooperativeStep } from "../exec/AiAgentExecutor"
import {
  ensureVmConversationDomainRuntime,
  injectConversationActorRawState,
  injectConversationSessionRawState,
} from "../conversation/ConversationDomainRuntime"
import {
  createAiAgentOrchestratorDriver,
  type AiAgentOrchestratorDriver,
} from "../OrchestratorDriver"
import type { DelegateRunMode } from "@cell/ai-organ-contract/agent/DelegateRunMode"
import type { ConversationPersistenceRepositoryFactory } from "@cell/ai-organ-contract/persistence/conversation/ConversationPersistence"
import type {
  CoordinationRecordsIndexSnapshot,
  DetachedActorsIndexSnapshot,
  MemberRosterIndexSnapshot,
  RuntimeDerivedIndexes,
  RuntimeDerivedIndexesStore,
} from "@cell/ai-organ-contract/persistence/RuntimeDerivedIndexes"
import {
  getDetachedActorRegistry,
  type DetachedActorKind,
  type DetachedActorRecord,
} from "../detached/DetachedActorRegistry"
import { normalizeAiAgentLane, type AiAgentLane } from "../lane/AiAgentLane"
import type { AiAgentWorkload } from "../lane/AiAgentWorkload"
import { getCoordinationEngine, type CoordinationRecord } from "../coordination/CoordinationEngine"
import { getMemberManager, type MemberRecord } from "../organization/MemberManager"

type PersistedCompletionBinding = {
  parentFiberId: string
  mode: DelegateRunMode
  toolCallId?: string
  taskId?: string
  taskKind?: DetachedActorKind
}

function failUnsupportedRuntimeSnapshot(reason: string): never {
  throw new Error(`unsupported_runtime_snapshot: ${reason}`)
}

function readPersistedCompletionBinding(
  fiberSnapshot: RuntimeSnapshotFiber,
): PersistedCompletionBinding | null {
  const completionBinding = (fiberSnapshot.metadata?.completionBinding ?? null) as PersistedCompletionBinding | null
  if (!completionBinding) return null
  if (completionBinding.mode !== "sync_wait" && completionBinding.mode !== "detached") {
    failUnsupportedRuntimeSnapshot(`fiber ${fiberSnapshot.fiberId} has unsupported completionBinding.mode`)
  }
  return completionBinding
}

function readPersistedWorkloadKind(
  fiberSnapshot: RuntimeSnapshotFiber,
): AiAgentWorkload {
  if (typeof fiberSnapshot.workloadKind !== "string" || fiberSnapshot.workloadKind.length === 0) {
    failUnsupportedRuntimeSnapshot(`fiber ${fiberSnapshot.fiberId} is missing workloadKind`)
  }
  return fiberSnapshot.workloadKind as AiAgentWorkload
}

type OrchestratorStateLike = {
  options: Record<string, unknown>
  fibers: Record<string, any>
  deadLetters: any[]
  sequence: number
}

const COOPERATIVE_EXEC_STATE_METADATA_KEY = "cooperativeExecState"

function cloneJsonValue<T>(value: T): T | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return undefined
  }
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

function asNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function parseOpSequence(opId: string): number {
  const parts = opId.split(":")
  const raw = parts[parts.length - 1]
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function normalizeCooperativeInflight(value: unknown): any | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const kind = typeof raw.kind === "string" ? raw.kind : ""
  const opId = typeof raw.opId === "string" ? raw.opId : ""
  if (!kind || !opId) return undefined
  if (kind === "compress") return { kind, opId }
  if (kind === "llm") {
    return {
      kind,
      opId,
      turn: asNonNegativeInteger(raw.turn, 0),
      tools: cloneJsonValue(asArray(raw.tools)) ?? [],
    }
  }
  if (kind === "tool") {
    return {
      kind,
      opId,
      funcName: typeof raw.funcName === "string" ? raw.funcName : "",
      toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : "",
      args: cloneJsonValue(raw.args) ?? {},
    }
  }
  if (kind === "questionnaire_parse") {
    return {
      kind,
      opId,
      questionnaireId: typeof raw.questionnaireId === "string" ? raw.questionnaireId : "",
      toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : "",
      rawText: typeof raw.rawText === "string" ? raw.rawText : "",
    }
  }
  return undefined
}

function normalizeCooperativeExecState(value: unknown): any | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const phase = typeof raw.phase === "string" ? raw.phase : ""
  if (!["drain", "compress", "start_llm", "wait_llm", "start_tool", "wait_tool", "wait_questionnaire_parse"].includes(phase)) {
    return null
  }
  return {
    phase,
    turn: asNonNegativeInteger(raw.turn, 0),
    tools: cloneJsonValue(asArray(raw.tools)) ?? [],
    toolCalls: cloneJsonValue(asArray(raw.toolCalls)) ?? [],
    toolIndex: asNonNegativeInteger(raw.toolIndex, 0),
    nextOpSeq: Math.max(1, asNonNegativeInteger(raw.nextOpSeq, 1)),
    pendingToolResults: cloneJsonValue(asArray(raw.pendingToolResults)) ?? [],
    pendingAiGenerated: cloneJsonValue(asArray(raw.pendingAiGenerated)) ?? [],
    inflight: normalizeCooperativeInflight(raw.inflight),
    messageHistoryAttached: false,
    messageHistoryDetach: undefined,
  }
}

function serializeCooperativeExecState(value: unknown): any | null {
  return normalizeCooperativeExecState(value)
}

function readPersistedCooperativeExecState(fiberSnapshot: RuntimeSnapshotFiber): any | null {
  return normalizeCooperativeExecState(fiberSnapshot.metadata?.[COOPERATIVE_EXEC_STATE_METADATA_KEY])
}

function hasPendingAiGeneratedForInflight(actor: AiAgentActor, execState: any | null): boolean {
  const opId = typeof execState?.inflight?.opId === "string" ? execState.inflight.opId : ""
  if (!opId) return false
  if (Array.isArray(execState?.pendingAiGenerated) && execState.pendingAiGenerated.some((entry: any) => entry?.opId === opId)) {
    return true
  }
  const mailbox = actor.peekMailbox("aiGenerated") as any[]
  return mailbox.some((entry: any) => entry?.opId === opId)
}

function recoverInterruptedCooperativeInflight(actor: AiAgentActor, execState: any | null): any | null {
  if (!execState?.inflight || hasPendingAiGeneratedForInflight(actor, execState)) return execState
  const inflight = execState.inflight

  if (inflight.kind === "tool") {
    const outputText = `Error: interrupted tool call '${inflight.funcName || "tool"}' did not produce a result before session recovery`
    return {
      ...execState,
      pendingAiGenerated: [
        ...(Array.isArray(execState.pendingAiGenerated) ? execState.pendingAiGenerated : []),
        {
          kind: "tool_done",
          opId: inflight.opId,
          funcName: inflight.funcName ?? "",
          toolCallId: inflight.toolCallId ?? "",
          args: cloneJsonValue(inflight.args) ?? {},
          output: outputText,
          outputText,
        },
      ],
    }
  }

  if (inflight.kind === "llm") {
    return { ...execState, phase: "start_llm", inflight: undefined }
  }

  if (inflight.kind === "compress") {
    return { ...execState, phase: "compress", inflight: undefined }
  }

  if (inflight.kind === "questionnaire_parse") {
    return {
      ...execState,
      phase: "drain",
      inflight: undefined,
      pendingToolResults: [
        {
          toolCallId: inflight.toolCallId ?? "",
          questionnaireId: inflight.questionnaireId ?? "",
          content: inflight.rawText ?? "",
        },
        ...(Array.isArray(execState.pendingToolResults) ? execState.pendingToolResults : []),
      ],
    }
  }

  return execState
}

function findLastAssistantToolCalls(actor: AiAgentActor): any[] {
  for (let i = actor.messages.length - 1; i >= 0; i--) {
    const message = actor.messages[i] as any
    if (message?.role !== "assistant") continue
    const toolCalls = message.tool_calls ?? message.toolCalls
    return Array.isArray(toolCalls) ? cloneJsonValue(toolCalls) ?? [] : []
  }
  return []
}

function inferCooperativeExecStateFromPendingAiGenerated(actor: AiAgentActor): any | null {
  const pending = actor.peekMailbox("aiGenerated") as any[]
  const event = pending.find((entry) => entry && typeof entry === "object" && typeof entry.kind === "string")
  if (!event) return null
  const opId = typeof event.opId === "string" ? event.opId : ""
  if (!opId) return null
  const nextOpSeq = Math.max(1, parseOpSequence(opId) + 1)
  const base = {
    turn: 0,
    tools: [],
    toolCalls: [] as any[],
    toolIndex: 0,
    nextOpSeq,
    pendingToolResults: [],
    pendingAiGenerated: [],
    messageHistoryAttached: false,
    messageHistoryDetach: undefined,
  }

  if (event.kind === "tool_done") {
    const toolCalls = findLastAssistantToolCalls(actor)
    const toolCallId = String(event.toolCallId ?? "")
    const toolIndex = Math.max(0, toolCalls.findIndex((toolCall) => String(toolCall?.id ?? "") === toolCallId))
    return {
      ...base,
      phase: "wait_tool",
      toolCalls,
      toolIndex,
      inflight: {
        kind: "tool",
        opId,
        funcName: String(event.funcName ?? ""),
        toolCallId,
        args: cloneJsonValue(event.args) ?? {},
      },
    }
  }

  if (event.kind === "llm_done") {
    return {
      ...base,
      phase: "wait_llm",
      inflight: { kind: "llm", opId, turn: 0, tools: [] },
    }
  }

  if (event.kind === "compress_done") {
    return {
      ...base,
      phase: "compress",
      inflight: { kind: "compress", opId },
    }
  }

  if (event.kind === "questionnaire_parsed") {
    return {
      ...base,
      phase: "wait_questionnaire_parse",
      inflight: {
        kind: "questionnaire_parse",
        opId,
        questionnaireId: String(event.questionnaireId ?? ""),
        toolCallId: String(event.toolCallId ?? ""),
        rawText: String(event.rawText ?? ""),
      },
    }
  }

  return null
}

function hasRecoveredMailboxWork(actor: AiAgentActor, execState: any | null): boolean {
  return actor.hasPending("aiGenerated")
    || actor.hasPending("control")
    || actor.hasPending("childDone")
    || actor.hasPending("coordination")
    || actor.hasPending("memberInbox")
    || actor.hasPending("heartbeatWake")
    || actor.hasPending("humanInput")
    || actor.hasPending("toolResult")
    || (Array.isArray(execState?.pendingAiGenerated) && execState.pendingAiGenerated.length > 0)
    || (Array.isArray(execState?.pendingToolResults) && execState.pendingToolResults.length > 0)
    || execState?.phase === "start_llm"
    || execState?.phase === "compress"
}

function isRecoverabilityCheckedWaitReason(waitingReason: unknown): boolean {
  return waitingReason === "external"
    || waitingReason === "idle_external"
    || waitingReason === "wait_llm_result"
    || waitingReason === "wait_tool_result"
    || waitingReason === "wait_compress_result"
    || waitingReason === "wait_questionnaire_parse"
    || waitingReason === null
    || waitingReason === undefined
}

function hasRecoverableDurableControlSignal(params: {
  vm: AiAgentVm
  fiberSnapshot: RuntimeSnapshotFiber
}): boolean {
  const actorKey = params.fiberSnapshot.actorKey
  if (!actorKey) return false
  const pending = getPendingDurableControlSignals(params.vm.sessionState.controlSignals, {
    actorKey,
    fiberId: params.fiberSnapshot.fiberId,
  })
  return pending.some((signal) => signal.signalClass === "wake" || signal.signalClass === "interrupt")
}

function hasRecoverableProtocolWait(actor: AiAgentActor | undefined, fiberSnapshot: RuntimeSnapshotFiber): boolean {
  if (!actor) return false
  const workloadKind = readPersistedWorkloadKind(fiberSnapshot)
  if (
    workloadKind === "member_turn"
    || workloadKind === "autonomous_holon_task"
    || workloadKind === "detached_delegate_task"
    || workloadKind === "detached_bash_task"
    || workloadKind === "detached_toolcall_task"
  ) {
    return true
  }

  if (actor.planApproval?.status === "pending" || actor.shutdownCoordination?.status === "pending") {
    return true
  }

  if (actor.detachedTask && !isTerminalFiberStatus(actor.detachedTask.status)) {
    return true
  }

  return false
}

function hasRecoverableSessionProtocolState(vm: AiAgentVm, fiberSnapshot: RuntimeSnapshotFiber): boolean {
  if (fiberSnapshot.actorKey !== vm.controlActorKey) return false
  const sessionState = ensureVmSessionState(vm)
  return Object.keys(sessionState.memberRoster).length > 0
    || Object.keys(sessionState.holons).length > 0
    || Object.keys(sessionState.detachedActors).length > 0
    || getCoordinationEngine().list(vm).some((record) => record.status === "pending")
}

function mailboxContainsPayload(actor: AiAgentActor, mailboxKind: keyof AiAgentActor["mailboxes"], payload: unknown): boolean {
  const entries = actor.peekMailbox(mailboxKind as any) as unknown[]
  return entries.some((entry) => {
    if (entry === payload) return true
    try {
      return JSON.stringify(entry) === JSON.stringify(payload)
    } catch {
      return false
    }
  })
}

function redeliverPendingDurableControlSignalsOnRecovery(params: {
  vm: AiAgentVm
  restoredFibers: Array<{ fiberId: string; actor: AiAgentActor }>
  now: number
}): Set<string> {
  const restoredFiberIds = new Set(params.restoredFibers.map((fiber) => fiber.fiberId))
  const schedulableFiberIds = new Set<string>()
  const pending = getPendingDurableControlSignals(params.vm.sessionState.controlSignals)
  if (!pending.length) return schedulableFiberIds

  const { privateRxData } = ensureVmRxData(params.vm)
  for (const signal of pending) {
    const actor = params.vm.actors[signal.actorKey]
    if (!actor) continue
    if (signal.fiberId && !restoredFiberIds.has(signal.fiberId)) continue

    if (signal.mailboxKind && signal.payload !== undefined && !mailboxContainsPayload(actor, signal.mailboxKind, signal.payload)) {
      actor.send(signal.mailboxKind as any, signal.payload as any)
    }
    markDurableControlSignalConsumed(params.vm.sessionState.controlSignals, signal.eventId)
    privateRxData.controlSignals.append({
      ...signal,
      delivery: "recovered",
    })

    if (signal.fiberId && (signal.signalClass === "wake" || signal.signalClass === "interrupt")) {
      schedulableFiberIds.add(signal.fiberId)
    }
  }

  return schedulableFiberIds
}

function assertRecoverableSuspendedFiberSnapshots(params: {
  vm: AiAgentVm
  fibers: Record<string, RuntimeSnapshotFiber>
}): void {
  for (const fiberSnapshot of Object.values(params.fibers)) {
    if (fiberSnapshot.status !== "suspended") continue
    const waitingReason = fiberSnapshot.waitingReason ?? fiberSnapshot.metadata?.waitingReason
    if (!isRecoverabilityCheckedWaitReason(waitingReason)) continue

    const actor = fiberSnapshot.actorKey ? params.vm.actors[fiberSnapshot.actorKey] : undefined
    const execState = readPersistedCooperativeExecState(fiberSnapshot)
    if (hasRecoverableProtocolWait(actor, fiberSnapshot)) continue
    if (hasRecoverableSessionProtocolState(params.vm, fiberSnapshot)) continue
    if (actor && hasRecoveredMailboxWork(actor, execState)) continue
    if (hasRecoverableDurableControlSignal({ vm: params.vm, fiberSnapshot })) continue

    throw new Error(
      [
        "unrecoverable_suspended_fiber",
        `fiberId=${fiberSnapshot.fiberId}`,
        `actorKey=${fiberSnapshot.actorKey ?? ""}`,
        `waitingReason=${String(waitingReason ?? "")}`,
        "missing recoverable mailbox work, cooperative exec state, or durable control signal",
      ].join(": "),
    )
  }
}

export type RuntimePersistenceSupport = {
  actorTranscriptStore: ActorTranscriptStore
  snapshotRepositoryFactory: RuntimeSnapshotRepositoryFactory<
    RuntimeSnapshotPersistedState,
    RuntimeSnapshotManifest,
    RuntimeSnapshotLoadResult
  >
  derivedIndexesStore: RuntimeDerivedIndexesStore
  conversationPersistenceRepositoryFactory?: ConversationPersistenceRepositoryFactory
}

let configuredRuntimePersistenceSupport: RuntimePersistenceSupport | null = null

function getRuntimePersistenceSupport(): RuntimePersistenceSupport {
  if (configuredRuntimePersistenceSupport) {
    return configuredRuntimePersistenceSupport
  }
  throw new Error("runtime persistence support is not configured")
}

export function configureRuntimePersistenceSupport(support: RuntimePersistenceSupport): void {
  configuredRuntimePersistenceSupport = support
}

function assertSupportedSnapshotShape(loaded: { manifest: Record<string, unknown>; vm: Record<string, unknown> }): void {
  if (typeof loaded.manifest.controlActorKey !== "string" || !loaded.manifest.controlActorKey) {
    throw new Error("invalid_runtime_snapshot: manifest is missing controlActorKey")
  }
  if (typeof loaded.vm.controlActorKey !== "string" || !loaded.vm.controlActorKey) {
    throw new Error("invalid_runtime_snapshot: vm is missing controlActorKey")
  }
}

export type RecoverAiAgentRuntimeParams = {
  sessionDir: string
  sessionId: string
  llmClient?: object | null
  eventBus?: AiAgentVm["eventBus"]
  registries?: Partial<RuntimeRegistries>
  callbacks?: RuntimeCallbacks
  effects?: RuntimeEffects
  outerCtx?: AiRuntimeOuterCtx
  mcpManager?: McpManagerLike
  actorCallbacks?: Partial<AiAgentActor.ActorCallbacks>
}

export type RecoverAiAgentRuntimeResult = {
  vm: AiAgentVm
  controlActor: AiAgentActor
  driver: AiAgentOrchestratorDriver
  indexes: RuntimeDerivedIndexes
  recoveryReport: VmRecoveryReport
}

const DERIVED_INDEX_FILES = [
  "indexes/memberRoster.json",
  "indexes/detachedActors.json",
  "indexes/coordinationRecords.json",
] as const

function getRuntimeSnapshotRepository(sessionDir: string) {
  return getRuntimePersistenceSupport().snapshotRepositoryFactory.createRuntimeSnapshotRepository(sessionDir)
}

export async function hasRuntimeSnapshot(sessionDir: string): Promise<boolean> {
  const manifest = await getRuntimeSnapshotRepository(sessionDir).readManifest()
  return !!manifest
}

function buildActorTranscriptDescriptor(actor: Pick<AiAgentActor, "key" | "id" | "type" | "identity" | "agentName">) {
  return {
    agentKey: actor.key,
    actorId: actor.id,
    actorType: actor.type,
    identity: actor.identity,
    agentName: actor.agentName,
    memberName: actor.identity?.kind === "member" ? actor.identity.name : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeRecoveredWorkContext(value: unknown): ActorWorkContextData | null {
  if (!isRecord(value)) return null
  const workMode = typeof value.workMode === "string" ? value.workMode : ""
  const taskPhase = typeof value.taskPhase === "string" ? value.taskPhase : ""
  if (!workMode || !taskPhase) return null
  return {
    workMode,
    taskPhase,
    workModeSource: typeof value.workModeSource === "string" ? value.workModeSource : "recovered_prompt_truth",
    taskPhaseSource: typeof value.taskPhaseSource === "string" ? value.taskPhaseSource : "recovered_prompt_truth",
    workModeUpdatedAt: typeof value.workModeUpdatedAt === "string" ? value.workModeUpdatedAt : new Date(0).toISOString(),
    taskPhaseUpdatedAt: typeof value.taskPhaseUpdatedAt === "string" ? value.taskPhaseUpdatedAt : new Date(0).toISOString(),
    actorKey: typeof value.actorKey === "string" ? value.actorKey : undefined,
    actorId: typeof value.actorId === "string" ? value.actorId : undefined,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    lastTrigger: typeof value.lastTrigger === "string" ? value.lastTrigger : "recovered_prompt_truth",
  }
}

function normalizeRecoveredContinuationBaseline(value: unknown): ContinuationBaselineData | null {
  if (!isRecord(value)) return null
  const baselineEpoch = typeof value.baselineEpoch === "number"
    ? value.baselineEpoch
    : Number(value.baselineEpoch ?? NaN)
  if (!Number.isFinite(baselineEpoch)) return null
  return {
    baselineEpoch,
    lastResetReason: typeof value.lastResetReason === "string" ? value.lastResetReason : null,
    latestResponseId: typeof value.latestResponseId === "string" ? value.latestResponseId : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  }
}

function hydrateActorContextControlFromConversation(params: {
  actor: AiAgentActor
  actorRawState: Awaited<ReturnType<typeof loadConversationActorRawState>> | null
}): void {
  const metadata = params.actorRawState?.promptGeneration?.metadata
  if (!isRecord(metadata)) return
  const recoveredWorkContext = normalizeRecoveredWorkContext(metadata.workContext)
  if (recoveredWorkContext) {
    params.actor.workContext = {
      ...params.actor.workContext,
      ...recoveredWorkContext,
      actorKey: params.actor.key,
      actorId: params.actor.id,
    }
  }
  const recoveredBaseline =
    normalizeRecoveredContinuationBaseline(metadata.continuationBaselineAfter)
    ?? normalizeRecoveredContinuationBaseline(metadata.continuationBaselineBefore)
  if (recoveredBaseline) {
    params.actor.continuationBaseline = recoveredBaseline
  }
}

async function ensureActorTranscriptInitialized(params: {
  sessionDir: string
  actor: AiAgentActor
}): Promise<void> {
  const descriptor = buildActorTranscriptDescriptor(params.actor)
  await getRuntimePersistenceSupport().actorTranscriptStore.ensureInitialized({
    sessionDir: params.sessionDir,
    actor: descriptor,
    messages: params.actor.messages as any,
  })
}

function isTerminalFiberStatus(status: unknown): boolean {
  return status === "completed" || status === "cancelled" || status === "failed" || status === "dead_letter"
}

function isTerminalDetachedActorStatus(status: unknown): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"
}

function isDetachedActorWorkload(workload: unknown): boolean {
  return typeof workload === "string" && workload.startsWith("detached")
}

async function writeDerivedIndexes(sessionDir: string, indexes: RuntimeDerivedIndexes): Promise<void> {
  await getRuntimePersistenceSupport().derivedIndexesStore.write({
    sessionDir,
    indexes,
  })
}

async function loadDerivedIndexes(sessionDir: string): Promise<RuntimeDerivedIndexes> {
  return await getRuntimePersistenceSupport().derivedIndexesStore.load({ sessionDir })
}

export function getConversationPersistenceRepository(sessionDir: string) {
  return getRuntimePersistenceSupport().conversationPersistenceRepositoryFactory?.createRepository(sessionDir) ?? null
}

function getVmScopedMemberRecords(vm: AiAgentVm): MemberRecord[] {
  return getMemberManager().listRosterRecords({ vm })
}

function buildDerivedIndexes(params: {
  vm: AiAgentVm
  driver: AiAgentOrchestratorDriver
}): RuntimeDerivedIndexes {
  const nowIso = new Date().toISOString()
  const driverState = params.driver.getState()
  const rosterRecords = getVmScopedMemberRecords(params.vm)
  const memberRoster: MemberRosterIndexSnapshot = {
    version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    members: rosterRecords.map((record) => {
      const view = getMemberManager().getMemberView({ vm: params.vm, query: record.memberId })
      return {
        memberId: record.memberId,
        actorKey: record.actorKey,
        actorId: record.actorId,
        name: record.name,
        role: record.role,
        agentType: record.agentType,
        lane: record.lane,
        lifecycleState: record.lifecycleState,
        waitingReason: view?.waitingReason ?? null,
        shutdownRequestId: record.shutdownRequestId ?? null,
        lastActiveAt: record.lastActiveAt,
      }
    }),
    updatedAt: nowIso,
  }

  const detachedActors: DetachedActorsIndexSnapshot = {
    version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    tasks: getDetachedActorRegistry(params.vm).list().map((task) => {
      const fiber = task.childFiberId ? (driverState.fibers as any)?.[task.childFiberId] : null
      return {
        taskId: task.taskId,
        actorKey: task.childActorKey ?? null,
        fiberId: task.childFiberId ?? null,
        workloadKind: typeof fiber?.workload === "string" ? fiber.workload : task.kind,
        status: task.status,
        summary: task.outputText ?? null,
        startedAt: task.createdAt,
        endedAt: isTerminalDetachedActorStatus(task.status) ? task.updatedAt : null,
        error: task.error ?? null,
        toolCallId: task.toolCallId ?? null,
        parentFiberId: task.parentFiberId ?? null,
        childActorId: task.childActorId ?? null,
      }
    }),
    updatedAt: nowIso,
  }

  const coordinationRecords: CoordinationRecordsIndexSnapshot = {
    version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    records: getCoordinationEngine()
      .list(params.vm)
      .map((record) => ({
        requestId: record.request_id,
        coordination: record.coordination,
        kind: record.kind,
        actorKey:
          Object.values(params.vm.actors).find(
            (actor) => actor.planApproval?.requestId === record.request_id || actor.shutdownCoordination?.requestId === record.request_id,
          )?.key ?? null,
        status: record.status,
        decision: record.decision ?? null,
        updatedAt: record.updated_at,
      })),
    updatedAt: nowIso,
  }

  return { memberRoster, detachedActors, coordinationRecords }
}

function toPersistedFiberSnapshot(params: {
  fiberId: string
  ctx: ReturnType<AiAgentOrchestratorDriver["inspectRuntime"]>["fibers"][string]
  stateRecord: any
  completionBinding?: PersistedCompletionBinding
}): RuntimeSnapshotFiber {
  const createdAt = params.stateRecord?.createdAt ?? Date.now()
  const lastYieldAt = params.stateRecord?.updatedAt ?? Date.now()
  return {
    version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    fiberId: params.fiberId,
    actorKey: params.ctx.actor.key,
    actorId: params.ctx.actor.id,
    parentFiberId: params.stateRecord?.parentId,
    status: params.stateRecord?.status,
    lane: params.ctx.lane ?? params.stateRecord?.lane,
    workloadKind: params.ctx.workload,
    kind: params.ctx.kind ?? params.ctx.actor.type,
    waitingReason: params.stateRecord?.waitingReason ?? null,
    createdAt,
    lastRunAt: params.stateRecord?.status === "running" ? lastYieldAt : null,
    lastYieldAt,
    resumeMetadata: {
      kind: "safe_boundary",
      value: "after_mailbox_drain",
    },
    updatedAt: new Date(lastYieldAt).toISOString(),
    metadata: {
      basePriority: params.stateRecord?.basePriority ?? 1,
      waitingReason: params.stateRecord?.waitingReason ?? null,
      suspendPolicy: params.stateRecord?.suspendPolicy ?? null,
      createdAt: params.stateRecord?.createdAt ?? Date.now(),
      updatedAt: params.stateRecord?.updatedAt ?? Date.now(),
      order: params.stateRecord?.order ?? 0,
      age: params.stateRecord?.age ?? 0,
      attempts: params.stateRecord?.attempts ?? 0,
      maxAttempts: params.stateRecord?.maxAttempts ?? 0,
      lastError: params.stateRecord?.lastError ?? null,
      timeoutMs: params.stateRecord?.timeoutMs ?? null,
      timeoutAt: params.stateRecord?.timeoutAt ?? null,
      retryAt: params.stateRecord?.retryAt ?? null,
      completionBinding: params.completionBinding ?? null,
      [COOPERATIVE_EXEC_STATE_METADATA_KEY]: serializeCooperativeExecState(params.ctx.execState),
      resumeMetadata: {
        kind: "safe_boundary",
        value: "after_mailbox_drain",
      },
    },
  }
}

function createRecoveredFiberState(params: {
  fiberSnapshot: RuntimeSnapshotFiber
  now: number
}): any {
  const rawStatus = String(params.fiberSnapshot.status ?? "ready")
  const metadata = (params.fiberSnapshot.metadata ?? {}) as Record<string, unknown>
  const completionBinding = readPersistedCompletionBinding(params.fiberSnapshot)
  const workloadKind = readPersistedWorkloadKind(params.fiberSnapshot)
  const detachedActorInterrupted = !isTerminalFiberStatus(rawStatus) && (isDetachedActorWorkload(workloadKind) || completionBinding?.mode === "detached")
  const status = detachedActorInterrupted ? "suspended" : rawStatus === "running" ? "ready" : rawStatus
  const waitingReason = detachedActorInterrupted
    ? "interrupted"
    : typeof params.fiberSnapshot.waitingReason === "string"
      ? params.fiberSnapshot.waitingReason
      : typeof metadata.waitingReason === "string"
        ? metadata.waitingReason
      : undefined

  return {
    id: params.fiberSnapshot.fiberId,
    actorId: params.fiberSnapshot.fiberId,
    parentId: params.fiberSnapshot.parentFiberId,
    childIds: [] as string[],
    lane: normalizeAiAgentLane(params.fiberSnapshot.lane) ?? "interactive",
    status,
    basePriority: typeof metadata.basePriority === "number" ? metadata.basePriority : 1,
    age: typeof metadata.age === "number" ? metadata.age : 0,
    attempts: typeof metadata.attempts === "number" ? metadata.attempts : 0,
    maxAttempts: typeof metadata.maxAttempts === "number" ? metadata.maxAttempts : 0,
    step: isTerminalFiberStatus(status)
      ? undefined
      : { tag: "agent_step", payload: { fiberId: params.fiberSnapshot.fiberId } },
    waitingReason,
    suspendPolicy: typeof metadata.suspendPolicy === "string" ? metadata.suspendPolicy : undefined,
    timeoutMs: typeof metadata.timeoutMs === "number" ? metadata.timeoutMs : undefined,
    timeoutAt: undefined,
    retryAt: undefined,
    lastError: typeof metadata.lastError === "string" ? metadata.lastError : undefined,
    order: typeof metadata.order === "number" ? metadata.order : 0,
    createdAt:
      typeof params.fiberSnapshot.createdAt === "number"
        ? params.fiberSnapshot.createdAt
        : typeof metadata.createdAt === "number"
          ? metadata.createdAt
          : params.now,
    updatedAt:
      typeof params.fiberSnapshot.lastYieldAt === "number"
        ? params.fiberSnapshot.lastYieldAt
        : typeof metadata.updatedAt === "number"
          ? metadata.updatedAt
          : params.now,
  }
}

export async function saveAiAgentRuntimeSnapshot(params: {
  sessionDir: string
  sessionId: string
  vm: AiAgentVm
  driver: AiAgentOrchestratorDriver
}): Promise<void> {
  const repository = getRuntimeSnapshotRepository(params.sessionDir)
  const inspected = params.driver.inspectRuntime()

  await Promise.all(
    Object.values(params.vm.actors).map((actor) =>
      ensureActorTranscriptInitialized({
        sessionDir: params.sessionDir,
        actor,
      }),
    ),
  )

  const actorSnapshots = Object.fromEntries(
    Object.values(params.vm.actors).map((actor) => {
      return [actor.key, serializeActor(actor)]
    }),
  )

  const fiberSnapshots = Object.fromEntries(
    Object.entries(inspected.fibers).map(([fiberId, ctx]) => {
      const stateRecord = (inspected.state.fibers as any)?.[fiberId]
      const completionBinding = inspected.childDoneMap[fiberId]
      return [
        fiberId,
        toPersistedFiberSnapshot({
          fiberId,
          ctx,
          stateRecord,
          completionBinding,
        }),
      ]
    }),
  )
  assertRecoverableSuspendedFiberSnapshots({
    vm: params.vm,
    fibers: fiberSnapshots,
  })

  const vmSnapshot = serializeVM(params.vm)

  const manifest = await repository.writeSnapshot({
    vm: vmSnapshot,
    actors: actorSnapshots,
    fibers: fiberSnapshots,
  })

  const indexes = buildDerivedIndexes({
    vm: params.vm,
    driver: params.driver,
  })
  await writeDerivedIndexes(params.sessionDir, indexes)

  await repository.writeManifest({
    ...manifest,
    sessionId: params.sessionId,
    createdAt: manifest.createdAt,
    updatedAt: new Date().toISOString(),
    indexFiles: [
      "indexes/actors_by_key.json",
      "indexes/actors_by_id.json",
      "indexes/fibers_by_id.json",
      ...DERIVED_INDEX_FILES,
    ],
    derivedIndexFiles: [...DERIVED_INDEX_FILES],
  })
}

export async function recoverAiAgentRuntime(params: RecoverAiAgentRuntimeParams): Promise<RecoverAiAgentRuntimeResult | null> {
  const repository = getRuntimeSnapshotRepository(params.sessionDir)
  const loaded = await repository.loadSnapshot()
  if (!loaded) {
    return null
  }
  assertSupportedSnapshotShape({
    manifest: loaded.manifest as Record<string, unknown>,
    vm: loaded.vm as Record<string, unknown>,
  })

  const cachedIndexes = await loadDerivedIndexes(params.sessionDir)

  const actorTranscriptSources: VmRecoveryReport["actorTranscriptSources"] = {}
  const conversationRepository = getConversationPersistenceRepository(params.sessionDir)

  const actorEntries = await Promise.all(
    Object.values(loaded.actors).map(async (snapshot) => {
      const actorRawState = conversationRepository
        ? await loadConversationActorRawState({
            sessionDir: params.sessionDir,
            actorKey: snapshot.key,
            repository: conversationRepository,
          })
        : null
      const conversationMessages = conversationRepository
        ? await loadConversationRuntimeMessages({
            sessionDir: params.sessionDir,
            actorKey: snapshot.key,
            repository: conversationRepository,
          })
        : null
      const loadedMessages =
        conversationMessages && conversationMessages.source === "conversation"
          ? conversationMessages
          : await getRuntimePersistenceSupport().actorTranscriptStore.loadMessages({
              sessionDir: params.sessionDir,
              actor: {
                agentKey: snapshot.key,
                actorId: snapshot.id,
                actorType: snapshot.type,
                identity: snapshot.identity,
              },
            })
      actorTranscriptSources[snapshot.key] = {
        source: loadedMessages.source,
        path: loadedMessages.path,
      }
      if (conversationRepository && loadedMessages.source !== "conversation" && loadedMessages.messages.length > 0) {
        await bootstrapConversationHistoryFromMessages({
          sessionId: params.sessionId,
          actorKey: snapshot.key,
          actorId: snapshot.id,
          messages: loadedMessages.messages,
          transcriptPath: loadedMessages.path,
          repository: conversationRepository,
        })
      }
      const actor = hydrateActor(snapshot, {
        llmClient: params.llmClient ?? null,
        callbacks: params.actorCallbacks,
        messages: loadedMessages.messages,
      })
      hydrateActorContextControlFromConversation({
        actor,
        actorRawState,
      })
      return [
        snapshot.key,
        actor,
      ] as const
    }),
  )

  const actors = Object.fromEntries(actorEntries)

  const vm = hydrateVM(loaded.vm, actors, {
    eventBus: params.eventBus ?? null,
    registries: params.registries,
    callbacks: params.callbacks,
    effects: params.effects,
    outerCtx: {
      ...(params.outerCtx ?? {}),
      metadata: {
        ...((params.outerCtx?.metadata as Record<string, unknown> | undefined) ?? {}),
        sessionId: params.sessionId,
        sessionDir: params.sessionDir,
        conversationPersistenceRepositoryFactory: getRuntimePersistenceSupport().conversationPersistenceRepositoryFactory,
      },
    },
    mcpManager: params.mcpManager,
  })
  if (conversationRepository) {
    const conversationRuntime = ensureVmConversationDomainRuntime(vm)
    const sessionRawState = await loadConversationSessionRawState({
      sessionDir: params.sessionDir,
      repository: conversationRepository,
    })
    injectConversationSessionRawState(conversationRuntime, sessionRawState)
    for (const actor of Object.values(actors)) {
      const actorRawState = await loadConversationActorRawState({
        sessionDir: params.sessionDir,
        actorKey: actor.key,
        repository: conversationRepository,
      })
      if (actorRawState) {
        injectConversationActorRawState(conversationRuntime, actorRawState)
      }
    }
  }
  const controlActor = getControlActor(vm)
  if (!controlActor) {
    return null
  }

  const now = Date.now()
  const restoredFibers = Object.values(loaded.fibers)
    .map((fiberSnapshot) => {
      const actor = fiberSnapshot.actorKey ? actors[fiberSnapshot.actorKey] : undefined
      if (!actor) return null
      const execState = recoverInterruptedCooperativeInflight(actor,
        readPersistedCooperativeExecState(fiberSnapshot)
          ?? inferCooperativeExecStateFromPendingAiGenerated(actor),
      )
      return {
        fiberId: fiberSnapshot.fiberId,
        vm,
        actor,
        messages: actor.messages,
        basePriority: typeof fiberSnapshot.metadata?.basePriority === "number" ? (fiberSnapshot.metadata.basePriority as number) : 1,
        lane: normalizeAiAgentLane(fiberSnapshot.lane) ?? undefined,
        workload: readPersistedWorkloadKind(fiberSnapshot),
        execState: execState ?? undefined,
      }
    })
    .filter(Boolean) as Array<{
    fiberId: string
    vm: AiAgentVm
    actor: AiAgentActor
    messages: any[]
    basePriority: number
    lane?: AiAgentLane
    workload?: AiAgentWorkload
    execState?: any
  }>

  const recoveredControlSignalFiberIds = redeliverPendingDurableControlSignalsOnRecovery({
    vm,
    restoredFibers,
    now,
  })

  const restoredState = {
    options: {
      senderId: "__fiber_scheduler__",
      agingStep: 0,
      defaultSuspendPolicy: "continue_others",
      schedulerHooks: undefined,
      timeoutEnabled: false,
      defaultTimeoutMs: 0,
      retryEnabled: false,
      retryDelayMs: 0,
      retryBackoffMultiplier: 1,
      deadLetterEnabled: false,
    },
    fibers: Object.fromEntries(
      Object.values(loaded.fibers).map((fiberSnapshot) => [fiberSnapshot.fiberId, createRecoveredFiberState({ fiberSnapshot, now })]),
    ),
    deadLetters: [],
    sequence: restoredFibers.length,
  } as OrchestratorStateLike

  const restoredFibersMap = restoredState.fibers as Record<string, any>
  for (const fiber of restoredFibers) {
    const record = restoredFibersMap[fiber.fiberId]
    if (!record || (!hasRecoveredMailboxWork(fiber.actor, fiber.execState ?? null) && !recoveredControlSignalFiberIds.has(fiber.fiberId))) {
      continue
    }
    if (isTerminalFiberStatus(record.status) && record.status !== "failed") {
      continue
    }
    restoredFibersMap[fiber.fiberId] = {
      ...record,
      status: "ready",
      waitingReason: undefined,
      suspendPolicy: undefined,
      lastError: undefined,
      timeoutAt: undefined,
      retryAt: undefined,
      step: { tag: "agent_step", payload: { fiberId: fiber.fiberId } },
      updatedAt: now,
    }
  }
  for (const record of Object.values(restoredFibersMap) as any[]) {
    if (record.parentId && (restoredState.fibers as any)[record.parentId]) {
      const parent = (restoredState.fibers as any)[record.parentId]
      parent.childIds = Array.isArray(parent.childIds) ? [...parent.childIds, record.id] : [record.id]
    }
  }

  const restoredChildDoneMap = Object.fromEntries(
    Object.values(loaded.fibers)
      .map((fiberSnapshot) => {
        const completionBinding = readPersistedCompletionBinding(fiberSnapshot)
        return completionBinding
          ? [fiberSnapshot.fiberId, completionBinding]
          : null
      })
      .filter(Boolean) as Array<[string, PersistedCompletionBinding]>,
  )

  const driver = createAiAgentOrchestratorDriver({
    fibers: restoredFibers as any,
    runStep: async (ctx, helpers) => {
      return await aiAgentCooperativeStep({
        fiberId: ctx.fiberId,
        vm: ctx.vm,
        actor: ctx.actor,
        messages: ctx.messages,
        state: ctx.execState,
        setState: (next) => {
          ctx.execState = next
        },
        resumeFiber: helpers.resume,
        emitFiberSignal: helpers.emitFiberSignal,
      })
    },
    options: {
      agingStep: 0,
      defaultSuspendPolicy: "continue_others",
    },
    restore: {
      state: restoredState as any,
      childDoneMap: restoredChildDoneMap,
    },
  })
  ensureVmRuntimeContext(vm).driver = driver

  const members = getMemberManager()
  const restoredFiberByActorKey = new Map<string, (typeof restoredFibers)[number]>()
  for (const fiber of restoredFibers) {
    restoredFiberByActorKey.set(fiber.actor.key, fiber)
  }

  const restoredMembers = Object.values(actors)
    .filter((actor): actor is AiAgentActor & { identity: Extract<AiAgentActor["identity"], { kind: "member" }> } => actor.identity?.kind === "member")
    .map((actor) => {
      const identity = actor.identity!
      const fiber = restoredFiberByActorKey.get(actor.key)
      const fiberState = fiber ? (restoredState.fibers as any)?.[fiber.fiberId] : null
      const cached = cachedIndexes.memberRoster.members.find((entry) => entry.actorKey === actor.key || entry.actorId === actor.id)
      const lane = (identity.lane === "autonomous_holon" ? "autonomous_holon" : "member") as MemberRecord["lane"]
      const lifecycleState = (
        isTerminalFiberStatus(fiberState?.status)
        ? "exited"
        : actor.shutdownCoordination?.requestId
          ? "shutting_down"
          : cached?.lifecycleState === "shutting_down"
            ? "shutting_down"
            : "active"
      ) as MemberRecord["lifecycleState"]
      const record: MemberRecord = {
        memberId: identity.memberId,
        name: identity.name,
        role: identity.role as any,
        agentType: identity.agentType ?? cached?.agentType ?? "unknown",
        lane,
        fiberId: fiber?.fiberId ?? `${actor.key}:${actor.id}`,
        actorKey: actor.key,
        actorId: actor.id,
        createdAt: typeof fiberState?.createdAt === "number" ? fiberState.createdAt : cached?.lastActiveAt ?? now,
        lastActiveAt:
          typeof fiberState?.updatedAt === "number"
            ? fiberState.updatedAt
            : actor.lastMemberResultNotifiedAt ?? cached?.lastActiveAt ?? now,
        lifecycleState,
        shutdownRequestId: actor.shutdownCoordination?.requestId ?? cached?.shutdownRequestId ?? undefined,
        vm,
        actor,
        driver,
      }
      return record
    }) as MemberRecord[]
  members.replaceRecoveredRoster({ vm, records: restoredMembers as MemberRecord[] })

  const restoredTaskMap = new Map<string, DetachedActorRecord>()
  for (const persisted of Object.values(ensureVmSessionState(vm).detachedActors)) {
    restoredTaskMap.set(persisted.taskId, { ...persisted })
  }
  for (const fiberSnapshot of Object.values(loaded.fibers)) {
    const completionBinding = readPersistedCompletionBinding(fiberSnapshot)
    const workload = String(readPersistedWorkloadKind(fiberSnapshot))
    const isDetached = completionBinding?.mode === "detached" || isDetachedActorWorkload(workload)
    if (!isDetached) continue

    const cached = cachedIndexes.detachedActors.tasks.find((entry) => entry.fiberId === fiberSnapshot.fiberId || entry.taskId === completionBinding?.taskId)
    const taskId = completionBinding?.taskId ?? cached?.taskId ?? fiberSnapshot.fiberId
    const rawStatus = String(fiberSnapshot.status ?? "pending")
    const terminal = isTerminalDetachedActorStatus(rawStatus)
    restoredTaskMap.set(taskId, {
      taskId,
      kind:
        completionBinding?.taskKind ??
        (workload === "bash" || workload === "tool_call"
          ? (workload as any)
          : workload.includes("bash")
            ? "bash"
            : workload.includes("tool")
              ? "tool_call"
              : "delegate"),
      status: terminal ? (rawStatus as DetachedActorRecord["status"]) : "interrupted",
      createdAt: typeof fiberSnapshot.metadata?.createdAt === "number" ? (fiberSnapshot.metadata.createdAt as number) : cached?.startedAt ?? now,
      updatedAt: terminal
        ? typeof fiberSnapshot.metadata?.updatedAt === "number"
          ? (fiberSnapshot.metadata.updatedAt as number)
          : cached?.endedAt ?? now
        : now,
      toolCallId: completionBinding?.toolCallId ?? cached?.toolCallId ?? undefined,
      parentFiberId: completionBinding?.parentFiberId ?? cached?.parentFiberId ?? undefined,
      childFiberId: fiberSnapshot.fiberId,
      childActorKey: fiberSnapshot.actorKey ?? cached?.actorKey ?? undefined,
      childActorId: fiberSnapshot.actorId ?? cached?.childActorId ?? undefined,
      outputText: cached?.summary ?? undefined,
      error: cached?.error ?? undefined,
    })
  }

  getDetachedActorRegistry(vm).restoreAll(Array.from(restoredTaskMap.values()))

  const restoredCoordinationCache = cachedIndexes.coordinationRecords.records.map((record) => ({
    request_id: record.requestId,
    coordination: (record as { coordination?: string; protocol?: string }).coordination
      ?? (record as { coordination?: string; protocol?: string }).protocol
      ?? AI_AGENT_COORDINATION_NAMES.shutdown,
    kind: record.kind as CoordinationRecord["kind"],
    status: record.status as CoordinationRecord["status"],
    decision: typeof record.decision === "string" ? record.decision : undefined,
    created_at: record.updatedAt,
    updated_at: record.updatedAt,
  }))
  getCoordinationEngine().restoreAll(vm, restoredCoordinationCache)

  const indexes = buildDerivedIndexes({
    vm,
    driver,
  })
  await writeDerivedIndexes(params.sessionDir, indexes)

  const recoveryReport: VmRecoveryReport = {
    sessionId: params.sessionId,
    restoredAt: Date.now(),
    corruptions: loaded.corruptions,
    actorTranscriptSources,
  }

  vm.recovery = {
    ...(vm.recovery ?? { restoredFromSnapshot: true }),
    restoredFromSnapshot: true,
    snapshotVersion: loaded.vm.version,
    restoredAt: recoveryReport.restoredAt,
    report: recoveryReport,
  }

  const runtimeContext = ensureVmRuntimeContext(vm)
  runtimeContext.driver = driver
  runtimeContext.currentOrchestrator = null

  return {
    vm,
    controlActor,
    driver,
    indexes,
    recoveryReport,
  }
}
