import {
  AI_AGENT_PLAN_APPROVAL_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_DECISIONS,
  AI_AGENT_COORDINATION_NAMES,
  AI_AGENT_SHUTDOWN_COORDINATION_KINDS,
  RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  ensureVmRuntimeContext,
  ensureVmSessionState,
  ensureVmRxData,
  isRuntimeStorageFilesEnabled,
  isRuntimeStorageLogsEnabled,
  getPendingDurableControlSignals,
  markDurableControlSignalConsumed,
  getControlActor,
  collectQuestionnaireRowsForSnapshot,
  hydrateQuestionnaireRowsIntoRuntime,
  hydrateActor,
  hydrateVM,
  serializeActor,
  serializeVM,
  type AiAgentActor,
  type AiAgentVm,
  type RuntimeCallbacks,
  type RuntimeEffects,
  type RuntimeRegistries,
  type RuntimeSnapshotFiber,
  type VmRecoveryReport,
} from "@cell/ai-core-logic"
import { hasPendingAiAgentWakeMailbox } from "@cell/ai-core-logic/runtime/actor"
import type { AiRuntimeOuterCtx } from "@cell/ai-core-contract/runtime/AiRuntimeOuterCtx"
import type { McpManagerLike } from "@cell/ai-core-contract/runtime/McpManagerLike"
import type {
  ActorWorkContextData,
  ContinuationBaselineData,
} from "@cell/ai-core-contract/runtime/ContextControl"
import { TASK_PHASES, WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl"
import {
  loadConversationActorRawState,
  loadConversationSessionRawState,
} from "@cell/ai-support"
import {
  createRecoveryReadPort,
  assertConversationRecoverySourceComplete,
  type RuntimeRecoveryReadPort,
} from "./RecoveryReadPort"
import { aiAgentCooperativeStep } from "../exec/AiAgentExecutor"
import {
  bindActorConversationProjectionToVm,
  ensureVmConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  getConversationSessionRawStateFromVm,
  injectConversationActorRawState,
  injectConversationSessionRawState,
} from "../conversation/ConversationDomainRuntime"
import {
  createAiAgentOrchestratorDriver,
  type AiAgentOrchestratorDriver,
} from "../OrchestratorDriver"
import { createSessionDiagnosticsXnlLog } from "../runtime/SessionRuntimeXnlLogs"
import { restoreVmToolCallDomain, getVmToolCallDomain } from "../runtime/ToolCallDomainRuntime"
import type { ToolCallRecord } from "@cell/ai-core-contract/runtime/ToolCallDomain"
import type { DelegateRunMode } from "@cell/ai-organ-contract/agent/DelegateRunMode"
import type {
  CoordinationRecordsIndexSnapshot,
  DetachedActorsIndexSnapshot,
  MemberRosterIndexSnapshot,
  RuntimeDerivedIndexes,
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
import {
  classifyRealSessionRecovery,
  evaluateAiAgentRuntimeSnapshotSafepoint,
  rebuildEffectsFromLifecycleEvidence,
  type RealSessionRecoveryResult,
  type RuntimeSnapshotSafepointResult,
} from "@cell/ai-runtime-control-logic"
import {
  buildAiRuntimeInterruptedInflightFailedEvidence,
  coordinatorDerivation,
  decideAiRuntimePendingEffectsRecovery,
  recordAiRuntimeEffectLifecycleEvent,
  runFileStoreAiRuntimeConcreteCheckpoint,
} from "@cell/ai-runtime-control-composer"
import {
  readRealSessionDurableHeads,
  inferRuntimeControlCheckpointEffectEvidenceSequence,
  readRuntimeControlCohortCommitFile,
  readRuntimeControlEffectEvidence,
  readRuntimeControlEffectEvidenceThroughSequence,
  readRuntimeControlSessionUpgradeFile,
  type AiRuntimeEffectLifecycleEvent,
} from "@cell/ai-file-store-logic"
// P2 seam (track refactor-persistent-session-backplane): the pure-I/O
// persistence routing (snapshot repo access, derived-index read/write,
// conversation-persistence repo access, snapshot existence + deserialize-side
// shape validation, the injected support registry) lives in the dedicated
// @cell/ai-persistence-logic package, which has NO dependency on ai-organ-logic.
// This module keeps only the runtime-orchestration (gather-from / reconstruct-to
// the live runtime) and consumes the package below. configureRuntimePersistenceSupport
// is re-declared locally so the runtime-composition import path stays stable.
import {
  configureRuntimePersistenceSupport as configurePersistenceSupportIo,
  getRuntimePersistenceSupport,
  getRuntimeSnapshotRepository,
  hasRuntimeSnapshot as hasRuntimeSnapshotIo,
  writeDerivedIndexes,
  loadDerivedIndexes,
  getConversationPersistenceRepository as getConversationPersistenceRepositoryIo,
  assertSupportedSnapshotShape,
  DERIVED_INDEX_FILES,
  type RuntimePersistenceSupport,
} from "@cell/ai-persistence-logic"

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

export type RuntimeSnapshotSaveResult =
  | { status: "saved"; safepoint: RuntimeSnapshotSafepointResult }
  | { status: "skipped_non_safepoint"; safepoint: RuntimeSnapshotSafepointResult }
  | { status: "skipped_pending_effects"; safepoint: RuntimeSnapshotSafepointResult; pendingEffectIds: string[] }
  | { status: "skipped_storage_disabled"; safepoint: RuntimeSnapshotSafepointResult }

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
    // P8 single-writer pipeline: entries restored from a serialized
    // pendingAiGenerated never crossed THIS process's semantic event bus,
    // so the cooperative output handler must re-emit them on the bus for
    // the resident graph to commit. Stamp them now.
    pendingAiGenerated: (cloneJsonValue(asArray(raw.pendingAiGenerated)) ?? []).map((entry: any) =>
      entry && typeof entry === "object"
        ? { ...entry, replayedFromEffectEvidence: true }
        : entry,
    ),
    inflight: normalizeCooperativeInflight(raw.inflight),
    messageHistoryAttached: false,
    messageHistoryDetach: undefined,
  }
}

function serializeCooperativeExecState(value: unknown): any | null {
  return normalizeCooperativeExecState(value)
}

type RuntimeControlRecoveryGate = {
  checkpoint: NonNullable<Awaited<ReturnType<typeof readRuntimeControlCohortCommitFile>>>
  effects: ReturnType<typeof rebuildEffectsFromLifecycleEvidence>
  result: RealSessionRecoveryResult
}

async function readRuntimeControlRecoveryGate(sessionDir: string): Promise<RuntimeControlRecoveryGate> {
  const upgrade = await readRuntimeControlSessionUpgradeFile({ sessionDir })
  if (!upgrade) {
    throw new Error("runtime_control_session_upgrade_required")
  }
  const checkpoint = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
  if (!checkpoint) {
    throw new Error("dirty_runtime_control_recovery:missing_checkpoint")
  }
  if (upgrade.checkpointCohortId !== checkpoint.cohortId || upgrade.checkpointMarker !== checkpoint.marker) {
    throw new Error("dirty_runtime_control_recovery:upgrade_checkpoint_mismatch")
  }
  const heads = await readRealSessionDurableHeads(sessionDir)
  const inferredEffectEvidenceSequence = typeof checkpoint.effectEvidenceSequence === "number"
    ? checkpoint.effectEvidenceSequence
    : await inferRuntimeControlCheckpointEffectEvidenceSequence({ sessionDir, checkpoint })
  const effectEvidence = typeof inferredEffectEvidenceSequence === "number"
    ? await readRuntimeControlEffectEvidenceThroughSequence({ sessionDir, sequence: inferredEffectEvidenceSequence })
    : []
  const effects = rebuildEffectsFromLifecycleEvidence(effectEvidence)
  const result = classifyRealSessionRecovery({
    heads: heads as any,
    commitMarkers: { checkpoint },
    effects,
  })
  if (result.classification === "dirty" || result.classification === "orphaned") {
    throw new Error(`dirty_runtime_control_recovery:${result.classification}`)
  }
  return { checkpoint, effects, result }
}

function assertPendingEffectsBelongToRecoveredInflight(params: {
  gate: RuntimeControlRecoveryGate
  fibers: RuntimeSnapshotFiber[]
}): void {
  const checkpointEffectIds = new Set(
    Object.entries(params.gate.effects)
      .filter(([effectId, effect]) => {
        const handlerKey = String(effect.handlerKey ?? "")
        return effectId.startsWith("runtime-checkpoint:")
          || handlerKey === "runtime_concrete_checkpoint_write"
      })
      .map(([effectId]) => effectId),
  )
  const decision = decideAiRuntimePendingEffectsRecovery({
    recovery: {
      ...params.gate.result,
      blockers: params.gate.result.blockers.filter((blocker) => {
        const effectId = typeof blocker.effectId === "string" ? blocker.effectId : ""
        return !effectId || !checkpointEffectIds.has(effectId)
      }),
    },
    recoveredInflights: params.fibers
      .map((fiber) => readPersistedCooperativeExecState(fiber)?.inflight)
      .filter((inflight) => typeof inflight?.opId === "string" && inflight.opId)
      .map((inflight) => ({
        kind: String(inflight.kind ?? ""),
        opId: String(inflight.opId),
        handlerKey: typeof inflight.funcName === "string" ? inflight.funcName : undefined,
        toolName: typeof inflight.funcName === "string" ? inflight.funcName : undefined,
      })),
  })
  if (!decision.recoverable) {
    throw new Error(`dirty_runtime_control_recovery:pending:${decision.danglingEffectIds.join(",")}`)
  }
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
  const mailbox = actor.peekMailbox("asyncCompletion") as any[]
  return mailbox.some((entry: any) => entry?.opId === opId)
}

export function buildPendingAiGeneratedFromCompletedEffect(
  execState: any | null,
  effectEvidence: AiRuntimeEffectLifecycleEvent[],
  toolCallDomain?: { getRecord(toolCallId: string): ToolCallRecord | undefined } | null,
): any | null {
  const inflight = execState?.inflight
  const opId = typeof inflight?.opId === "string" ? inflight.opId : ""
  if (!opId) return null
  for (let index = effectEvidence.length - 1; index >= 0; index -= 1) {
    const event = effectEvidence[index]
    if (event?.kind !== "result" || event.effectId !== opId) continue
    if (inflight.kind === "llm" && event.effectKind === "provider_completion") {
      return {
        kind: "llm_done",
        opId,
        msg: cloneJsonValue(event.payload) ?? { role: "assistant", content: "" },
        // Replayed from durable effect evidence: this result never crossed the
        // live semantic stream of THIS process, so the cooperative consumer
        // must perform the conversation-domain write itself (P7).
        replayedFromEffectEvidence: true,
      }
    }
    if (inflight.kind === "tool" && (event.effectKind === "tool_call" || event.effectKind === "bash" || event.effectKind === "mcp_tool" || event.effectKind === "questionnaire")) {
      const payload = (event.payload ?? {}) as Record<string, unknown>
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : inflight.toolCallId ?? ""
      // P4 / decision D3: the ToolCallDomain is the truth for the tool result;
      // the (link-only) effect evidence merely confirms the result exists. Read
      // the output text from the restored domain record, falling back to the
      // evidence payload for snapshots written before the payload was reduced.
      const record = toolCallId ? toolCallDomain?.getRecord(toolCallId) : undefined
      const domainOutputText =
        record && (record.status === "completed" || record.status === "failed") ? record.outputText ?? "" : undefined
      const outputText = domainOutputText ?? String(payload.outputText ?? payload.output ?? "")
      return {
        kind: "tool_done",
        replayedFromEffectEvidence: true,
        opId,
        funcName: inflight.funcName ?? "",
        toolCallId,
        args: cloneJsonValue(inflight.args) ?? {},
        output: domainOutputText ?? payload.output ?? payload.outputText ?? "",
        outputText,
      }
    }
  }
  return null
}

type RecoveredCooperativeInflight = {
  execState: any | null
  recoveryEvidence: AiRuntimeEffectLifecycleEvent[]
}

function recoverInterruptedCooperativeInflight(
  actor: AiAgentActor,
  execState: any | null,
  effectEvidence: AiRuntimeEffectLifecycleEvent[],
  toolCallDomain?: { getRecord(toolCallId: string): ToolCallRecord | undefined } | null,
): RecoveredCooperativeInflight {
  if (!execState?.inflight || hasPendingAiGeneratedForInflight(actor, execState)) {
    return { execState, recoveryEvidence: [] }
  }
  const inflight = execState.inflight
  const completed = buildPendingAiGeneratedFromCompletedEffect(execState, effectEvidence, toolCallDomain)
  if (completed) {
    return {
      execState: {
        ...execState,
        pendingAiGenerated: [
          ...(Array.isArray(execState.pendingAiGenerated) ? execState.pendingAiGenerated : []),
          completed,
        ],
      },
      recoveryEvidence: [],
    }
  }

  if (inflight.kind === "tool") {
    const outputText = `Error: interrupted tool call '${inflight.funcName || "tool"}' did not produce a result before session recovery`
    const failedEvidence = buildAiRuntimeInterruptedInflightFailedEvidence({
      inflight: {
        kind: "tool",
        opId: String(inflight.opId ?? ""),
        handlerKey: String(inflight.funcName ?? ""),
        toolName: String(inflight.funcName ?? ""),
      },
      error: outputText,
    })
    return {
      execState: {
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
            // P8: never crossed the live semantic stream; the cooperative
            // output handler must re-emit on the bus for the graph to commit.
            replayedFromEffectEvidence: true,
          },
        ],
      },
      recoveryEvidence: failedEvidence ? [failedEvidence] : [],
    }
  }

  if (inflight.kind === "llm") {
    const outputText = `Error: interrupted LLM request '${inflight.opId || "llm"}' did not produce a result before session recovery`
    const failedEvidence = buildAiRuntimeInterruptedInflightFailedEvidence({
      inflight: {
        kind: "llm",
        opId: String(inflight.opId ?? ""),
        handlerKey: "llm:recovery",
      },
      error: outputText,
    })
    return {
      execState: { ...execState, phase: "start_llm", inflight: undefined },
      recoveryEvidence: failedEvidence ? [failedEvidence] : [],
    }
  }

  if (inflight.kind === "compress") {
    return { execState: { ...execState, phase: "compress", inflight: undefined }, recoveryEvidence: [] }
  }

  if (inflight.kind === "questionnaire_parse") {
    return {
      execState: {
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
      },
      recoveryEvidence: [],
    }
  }

  return { execState, recoveryEvidence: [] }
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
  const pending = actor.peekMailbox("asyncCompletion") as any[]
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
  return hasPendingAiAgentWakeMailbox(actor)
    || (Array.isArray(execState?.pendingAiGenerated) && execState.pendingAiGenerated.length > 0)
    || (Array.isArray(execState?.pendingToolResults) && execState.pendingToolResults.length > 0)
    || execState?.phase === "start_llm"
    || execState?.phase === "compress"
}

function isRecoverabilityCheckedWaitReason(waitingReason: unknown): boolean {
  return waitingReason === "external"
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

function messageContentEqualsPayload(content: unknown, payload: unknown): boolean {
  if (content === payload) return true
  if (typeof content === "string") return content === String(payload ?? "")
  if (!Array.isArray(content)) return false
  return content.some((part) => {
    if (typeof part === "string") return part === String(payload ?? "")
    if (!part || typeof part !== "object") return false
    const record = part as Record<string, unknown>
    return record.text === payload || record.content === payload
  })
}

function hasCommittedHumanInput(actor: AiAgentActor, payload: unknown): boolean {
  return actor.messages.some((message: any) => {
    return message?.role === "user" && messageContentEqualsPayload(message.content, payload)
  })
}

function removeOneMailboxPayload(actor: AiAgentActor, mailboxKind: keyof AiAgentActor["mailboxes"], payload: unknown): boolean {
  const entries = actor.drainMailbox(mailboxKind as any) as unknown[]
  let removed = false
  for (const entry of entries) {
    let matches = entry === payload
    if (!matches) {
      try {
        matches = JSON.stringify(entry) === JSON.stringify(payload)
      } catch {
        matches = false
      }
    }
    if (!removed && matches) {
      removed = true
      continue
    }
    actor.send(mailboxKind as any, entry as any)
  }
  return removed
}

function removeOneCommittedHumanInputMailboxPayload(actor: AiAgentActor): boolean {
  const entries = actor.peekMailbox("humanInput") as unknown[]
  const stalePayload = entries.find((entry) => hasCommittedHumanInput(actor, entry))
  if (stalePayload === undefined) return false
  return removeOneMailboxPayload(actor, "humanInput", stalePayload)
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

    let signalAlreadyCommitted = false
    if (signal.mailboxKind === "humanInput" && signal.payload !== undefined && hasCommittedHumanInput(actor, signal.payload)) {
      removeOneMailboxPayload(actor, signal.mailboxKind, signal.payload)
      signalAlreadyCommitted = true
    } else if (signal.mailboxKind === "humanInput" && signal.payload === undefined) {
      signalAlreadyCommitted = removeOneCommittedHumanInputMailboxPayload(actor)
    }

    if (
      !signalAlreadyCommitted
      && signal.mailboxKind
      && signal.payload !== undefined
      && !mailboxContainsPayload(actor, signal.mailboxKind, signal.payload)
    ) {
      actor.send(signal.mailboxKind as any, signal.payload as any)
    }
    markDurableControlSignalConsumed(params.vm.sessionState.controlSignals, signal.eventId)
    privateRxData.controlSignals.append({
      ...signal,
      delivery: "recovered",
    })

    if (!signalAlreadyCommitted && signal.fiberId && (signal.signalClass === "wake" || signal.signalClass === "interrupt")) {
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

// P2 seam: RuntimePersistenceSupport (the injected capability set) is owned by
// @cell/ai-persistence-logic. Re-export the type so the stable import path
// (@cell/ai-organ-logic/persistence/RuntimeSnapshots) keeps exposing it.
export type { RuntimePersistenceSupport }

// configureRuntimePersistenceSupport stays a local `export function` (the
// runtime-composition + surface-migration contract checks this exact
// declaration form) that delegates to the package-owned registry.
export function configureRuntimePersistenceSupport(support: RuntimePersistenceSupport): void {
  configurePersistenceSupportIo(support)
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
  /**
   * T4.2 (track refactor-persistent-session-backplane): the recovery→read port
   * that routes single-source conversation reads. Defaults to
   * `createRecoveryReadPort()` (the file-backed single-source loaders); callers
   * may inject an alternate single-source reader. Recovery NEVER mixes two
   * sources for the same fact regardless of the injected port.
   */
  recoveryReadPort?: RuntimeRecoveryReadPort
}

export type RecoverAiAgentRuntimeResult = {
  vm: AiAgentVm
  controlActor: AiAgentActor
  driver: AiAgentOrchestratorDriver
  indexes: RuntimeDerivedIndexes
  recoveryReport: VmRecoveryReport
}

// P2 seam: DERIVED_INDEX_FILES, getRuntimeSnapshotRepository and
// hasRuntimeSnapshot are pure I/O and live in @cell/ai-persistence-logic
// (imported above). hasRuntimeSnapshot is re-exported so the stable import path
// keeps the public function.
export { hasRuntimeSnapshotIo as hasRuntimeSnapshot }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeRecoveredWorkContext(value: unknown): ActorWorkContextData | null {
  if (!isRecord(value)) return null
  const rawWorkMode = typeof value.workMode === "string" ? value.workMode : ""
  const rawTaskPhase = typeof value.taskPhase === "string" ? value.taskPhase : ""
  const hasWorkMode = rawWorkMode.trim()
  const hasTaskPhase = rawTaskPhase.trim()
  if (!hasWorkMode && !hasTaskPhase) return null
  const workMode = rawWorkMode === WORK_MODES.plan ? WORK_MODES.plan : WORK_MODES.build
  const taskPhase = rawTaskPhase === TASK_PHASES.answer ? TASK_PHASES.answer : TASK_PHASES.normal
  return {
    workMode,
    taskPhase,
    workModeSource: rawWorkMode === workMode && typeof value.workModeSource === "string" ? value.workModeSource : "recovered_normalized",
    taskPhaseSource: rawTaskPhase === taskPhase && typeof value.taskPhaseSource === "string" ? value.taskPhaseSource : "recovered_normalized",
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

// Single recovery source (spec recovery-one-way-handoff / behavior-delta
// `no-multi-source-mixing`): the single-source assertion now lives next to the
// recovery read port in ./RecoveryReadPort and is imported above, so recovery
// and the read port share ONE definition (no second copy that could drift into
// a fallback).

function isTerminalFiberStatus(status: unknown): boolean {
  return status === "completed" || status === "cancelled" || status === "failed" || status === "dead_letter"
}

function isTerminalDetachedActorStatus(status: unknown): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"
}

function isDetachedActorWorkload(workload: unknown): boolean {
  return typeof workload === "string" && workload.startsWith("detached")
}

// P2 seam: writeDerivedIndexes / loadDerivedIndexes / getConversationPersistenceRepository
// are pure I/O and live in @cell/ai-persistence-logic (imported above).
// getConversationPersistenceRepository is re-exported so the stable import path
// keeps the public function.
export { getConversationPersistenceRepositoryIo as getConversationPersistenceRepository }

async function flushConversationRuntimeToPersistence(params: {
  sessionDir: string
  sessionId: string
  vm: AiAgentVm
}): Promise<void> {
  const diagnostics = createSessionDiagnosticsXnlLog({
    sessionDir: isRuntimeStorageLogsEnabled(params.vm) ? params.sessionDir : undefined,
  })
  const repository = getConversationPersistenceRepositoryIo(params.sessionDir)
  if (!repository) {
    diagnostics.appendRuntimePersistenceEvent({
      eventType: "runtime_conversation_flush",
      sessionId: params.sessionId,
      status: "skipped",
      reason: "missing_conversation_repository",
    })
    await diagnostics.flush().catch(() => {})
    return
  }

  const sessionRawState = getConversationSessionRawStateFromVm({
    vm: params.vm,
    sessionId: params.sessionId,
  })
  if (!sessionRawState) {
    diagnostics.appendRuntimePersistenceEvent({
      eventType: "runtime_conversation_flush",
      sessionId: params.sessionId,
      status: "skipped",
      reason: "missing_session_raw_state",
    })
    await diagnostics.flush().catch(() => {})
    return
  }

  const actorRawStates = Object.values(params.vm.actors)
    .map((actor) => getConversationActorRawStateFromVm({
      vm: params.vm,
      actorKey: actor.key,
      sessionId: params.sessionId,
    }))
    .filter((rawState): rawState is NonNullable<ReturnType<typeof getConversationActorRawStateFromVm>> => !!rawState)

  const historyGenerationCount = actorRawStates.reduce(
    (total, actorRawState) => total + actorRawState.visibleHistoryGenerations.length,
    0,
  )
  const promptGenerationCount = actorRawStates.reduce(
    (total, actorRawState) => total + (actorRawState.promptGeneration ? 1 : 0),
    0,
  )
  const messageCount = actorRawStates.reduce(
    (total, actorRawState) =>
      total + actorRawState.visibleHistoryGenerations.reduce(
        (actorTotal, generation) => actorTotal + generation.messages.length,
        0,
      ),
    0,
  )
  diagnostics.appendRuntimePersistenceEvent({
    eventType: "runtime_conversation_flush",
    sessionId: params.sessionId,
    status: "start",
    actorCount: actorRawStates.length,
    historyGenerationCount,
    promptGenerationCount,
    messageCount,
  })
  await Promise.all(
    actorRawStates.flatMap((actorRawState) => [
      ...actorRawState.visibleHistoryGenerations.map((generation) => repository.writeHistoryGeneration(generation)),
      ...(actorRawState.promptGeneration ? [repository.writePromptGeneration(actorRawState.promptGeneration)] : []),
    ]),
  )
  await repository.writeHistoryIndex(sessionRawState.historyIndex)
  await repository.writePromptIndex(sessionRawState.promptIndex)
  await repository.writeSessionIndex(sessionRawState.sessionIndex)
  diagnostics.appendRuntimePersistenceEvent({
    eventType: "runtime_conversation_flush",
    sessionId: params.sessionId,
    status: "saved",
    actorCount: actorRawStates.length,
    historyGenerationCount,
    promptGenerationCount,
    messageCount,
  })
  await diagnostics.flush().catch(() => {})
}

/**
 * P3 (track harden-runtime-session-robustness, requirement
 * `timed-out-turn-progress-persisted`): seal ONLY the completed conversation
 * progress already committed into the in-memory conversation domain, WITHOUT
 * snapshotting any VM/fiber/ToolCallDomain in-flight state. This is the public
 * entry the coordinator's timeout branch calls when a turn times out in
 * mandatory_continuation: the unsafe in-flight tool execution is left
 * un-snapshotted (the "don't snapshot unsafe tool-execution" invariant holds),
 * but the completed tool pairs the conversation domain already holds are flushed
 * so a subsequent continuation can relay from them rather than restart bare.
 *
 * NOTE (recovery consistency, decision D2 / Step 0): after this seal,
 * `conversation/history.index.json` advances PAST the last VM-snapshot
 * checkpoint marker. The current owned-checkpoint recovery gate rejects that
 * "conversation-ahead-of-snapshot" prefix as `dirty`
 * (`head_commit_sequence_mismatch` on the `conversation` head, which is
 * `requiredForCheckpoint: true`). Teaching the gate to tolerate a forward-only
 * conversation head is a LARGE change to the recovery invariant and is split to
 * a follow-up track — see analysis/findings.md "P3" section. Until then, the
 * seal still durably preserves completed progress on disk (no data loss).
 */
export async function sealCompletedConversationProgress(params: {
  sessionDir: string
  sessionId: string
  vm: AiAgentVm
}): Promise<void> {
  if (!isRuntimeStorageFilesEnabled(params.vm)) {
    return
  }
  await flushConversationRuntimeToPersistence({
    sessionDir: params.sessionDir,
    sessionId: params.sessionId,
    vm: params.vm,
  })
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
}): Promise<RuntimeSnapshotSaveResult> {
  const repository = getRuntimeSnapshotRepository(params.sessionDir)
  const inspected = params.driver.inspectRuntime()
  const safepoint = evaluateAiAgentRuntimeSnapshotSafepoint({ vm: params.vm, inspected })
  const gate = coordinatorDerivation.decideCheckpointAction({
    storageFilesEnabled: isRuntimeStorageFilesEnabled(params.vm),
    safepointSafe: safepoint.safe,
    pendingEffectIds: [],
  })
  if (gate.action === "skip" && gate.reason === "skipped_storage_disabled") {
    return { status: "skipped_storage_disabled", safepoint }
  }
  if (gate.action === "skip" && gate.reason === "skipped_non_safepoint") {
    return { status: "skipped_non_safepoint", safepoint }
  }

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
  const indexes = buildDerivedIndexes({
    vm: params.vm,
    driver: params.driver,
  })
  const questionnaires = collectQuestionnaireRowsForSnapshot(params.vm)

  const checkpointResult = await runFileStoreAiRuntimeConcreteCheckpoint({
    sessionDir: params.sessionDir,
    idempotencyKey: `runtime-checkpoint:${params.sessionId}`,
    writeConcreteCheckpoint: async () => {
      await flushConversationRuntimeToPersistence({
        sessionDir: params.sessionDir,
        sessionId: params.sessionId,
        vm: params.vm,
      })
      const manifest = await repository.writeSnapshot({
        vm: vmSnapshot,
        actors: actorSnapshots,
        questionnaires,
        fibers: fiberSnapshots,
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
      return { manifestVersion: manifest.version }
    },
  })
  if (checkpointResult.status === "skipped_pending_effects") {
    return {
      status: "skipped_pending_effects",
      safepoint,
      pendingEffectIds: checkpointResult.pendingEffectIds,
    }
  }
  return { status: "saved", safepoint }
}

export async function recoverAiAgentRuntime(params: RecoverAiAgentRuntimeParams): Promise<RecoverAiAgentRuntimeResult | null> {
  const recoveryGate = await readRuntimeControlRecoveryGate(params.sessionDir)
  const effectEvidence = await readRuntimeControlEffectEvidence(params.sessionDir)
  const repository = getRuntimeSnapshotRepository(params.sessionDir)
  const loaded = await repository.loadSnapshot()
  if (!loaded) {
    return null
  }
  assertPendingEffectsBelongToRecoveredInflight({
    gate: recoveryGate,
    fibers: Object.values(loaded.fibers),
  })
  assertSupportedSnapshotShape({
    manifest: loaded.manifest as Record<string, unknown>,
    vm: loaded.vm as Record<string, unknown>,
  })
  const cachedIndexes = await loadDerivedIndexes(params.sessionDir)

  const conversationRepository = getConversationPersistenceRepositoryIo(params.sessionDir)

  // T4.2 (track refactor-persistent-session-backplane, design line 12): recovery's
  // single-source reads go THROUGH the recovery→read port. The port wraps the
  // existing single-source conversation loaders and owns the declared-but-
  // unloadable hard-fail (no multi-source mixing). Behavior is equivalent to the
  // prior inline `loadConversationActorRawState` + assertion.
  const recoveryReadPort: RuntimeRecoveryReadPort = params.recoveryReadPort ?? createRecoveryReadPort()

  // One-way recovery handoff (spec recovery-one-way-handoff): the
  // conversation files are the single recovery source. Each actor's raw
  // state is loaded once here, hydrated into the in-memory three domains
  // below, and the actor message mirror is then PROJECTED from the domain
  // materialization — never the other way around (no bootstrap backfill,
  // no transcript fallback).
  const actorConversationRawStates = new Map<
    string,
    Awaited<ReturnType<typeof loadConversationActorRawState>>
  >()

  const actorEntries = await Promise.all(
    Object.values(loaded.actors).map(async (snapshot) => {
      // Single-source read via the read port: each conversation fact from its
      // single owner (the conversation files); a declared-but-unloadable head
      // hard-fails inside the port rather than degrading to a second source.
      const actorRawState = conversationRepository
        ? await recoveryReadPort.loadConversationSource({
            sessionDir: params.sessionDir,
            actorKey: snapshot.key,
          })
        : null
      actorConversationRawStates.set(snapshot.key, actorRawState)
      const actor = hydrateActor(snapshot, {
        llmClient: params.llmClient ?? null,
        callbacks: params.actorCallbacks,
        messages: [],
      })
      hydrateActorContextControlFromConversation({
        actor,
        actorRawState,
      })
      // P8 single-writer pipeline (decisions.md decision 8): asyncCompletion
      // entries carried over from a serialized mailbox snapshot never crossed
      // THIS process's semantic event bus — they have to flow through the
      // resident MessageHistoryGraph at consumption time. Stamp them as
      // replayed-from-effect-evidence so the cooperative output handler
      // re-emits the corresponding semantic envelope on the bus for the graph
      // to commit. peekMailbox returns a copy, so drain + re-send is the
      // only way to mutate the live queue.
      const recoveredAsync = actor.drainMailbox("asyncCompletion") as any[]
      for (const entry of recoveredAsync) {
        if (entry && typeof entry === "object") {
          ;(entry as any).replayedFromEffectEvidence = true
        }
        actor.send("asyncCompletion", entry as any)
      }
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
      },
      // P3 (refactor-persistent-session-backplane / `explicit-injection`): the
      // conversation-persistence repository factory is carried as an explicit
      // typed field, not stashed in the untyped `metadata` bag. Prefer the
      // caller-injected field; fall back to the configured support for direct
      // recovery callers that did not pre-thread it.
      conversationPersistenceRepositoryFactory:
        params.outerCtx?.conversationPersistenceRepositoryFactory
        ?? getRuntimePersistenceSupport().conversationPersistenceRepositoryFactory,
    },
    mcpManager: params.mcpManager,
  })
  hydrateQuestionnaireRowsIntoRuntime(vm, loaded.questionnaires)

  // P4: restore the ToolCallDomain from persisted records so interrupted-tool
  // recovery can rebuild the result from the domain (decision D3). Older
  // snapshots omit the field and restore to an empty domain (evidence fallback).
  restoreVmToolCallDomain(vm, (loaded.vm as { toolCallDomain?: ToolCallRecord[] }).toolCallDomain)

  // Hydrate the in-memory three domains once from the conversation files.
  // States are keyed by the vm-resolved session id (params.sessionId) so the
  // live materialization and the loop-entry seed guard both find the hydrated
  // domains; the loader keys by basename(sessionDir), which can differ.
  const conversationRuntime = ensureVmConversationDomainRuntime(vm)
  if (conversationRepository) {
    const sessionRawState = await loadConversationSessionRawState({
      sessionDir: params.sessionDir,
      repository: conversationRepository,
    })
    injectConversationSessionRawState(conversationRuntime, {
      ...sessionRawState,
      sessionId: params.sessionId,
    })
    for (const actor of Object.values(actors)) {
      const actorRawState = actorConversationRawStates.get(actor.key) ?? null
      if (actorRawState) {
        injectConversationActorRawState(conversationRuntime, {
          ...actorRawState,
          session: { ...actorRawState.session, sessionId: params.sessionId },
        })
      }
    }
  }

  // Switch point: the domains are hydrated; from here the conversation files
  // have exited the live path. `actor.messages` is a read-only projection of
  // the in-memory domains (P7 mirror elimination) — bind every recovered
  // actor's view to the conversation domain runtime; there is no array to
  // back-fill and no reverse direction.
  const conversationHydratedAt = Date.now()
  for (const actor of Object.values(actors)) {
    bindActorConversationProjectionToVm(vm, actor)
  }

  const controlActor = getControlActor(vm)
  if (!controlActor) {
    return null
  }

  const now = Date.now()
  const recoveryEvidence: AiRuntimeEffectLifecycleEvent[] = []
  const restoredFibers = Object.values(loaded.fibers)
    .map((fiberSnapshot) => {
      const actor = fiberSnapshot.actorKey ? actors[fiberSnapshot.actorKey] : undefined
      if (!actor) return null
      const recoveredInflight = recoverInterruptedCooperativeInflight(actor,
        readPersistedCooperativeExecState(fiberSnapshot)
          ?? inferCooperativeExecStateFromPendingAiGenerated(actor),
        effectEvidence,
        getVmToolCallDomain(vm),
      )
      recoveryEvidence.push(...recoveredInflight.recoveryEvidence)
      return {
        fiberId: fiberSnapshot.fiberId,
        vm,
        actor,
        messages: actor.messages,
        basePriority: typeof fiberSnapshot.metadata?.basePriority === "number" ? (fiberSnapshot.metadata.basePriority as number) : 1,
        lane: normalizeAiAgentLane(fiberSnapshot.lane) ?? undefined,
        workload: readPersistedWorkloadKind(fiberSnapshot),
        execState: recoveredInflight.execState ?? undefined,
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

  for (const event of recoveryEvidence) {
    await recordAiRuntimeEffectLifecycleEvent({
      sessionDir: params.sessionDir,
      event,
    })
  }

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
  }

  vm.recovery = {
    ...(vm.recovery ?? { restoredFromSnapshot: true }),
    restoredFromSnapshot: true,
    snapshotVersion: loaded.vm.version,
    restoredAt: recoveryReport.restoredAt,
    report: recoveryReport,
    // Explicit switch point marker: the one-time conversation-file -> domain
    // hydration is complete; live reads come from the in-memory domains only.
    conversationHydration: {
      completed: true,
      source: "conversation_files",
      hydratedAt: conversationHydratedAt,
    },
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
