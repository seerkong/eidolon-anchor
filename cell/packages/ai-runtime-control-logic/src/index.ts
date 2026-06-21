import {
  createBlockedControlBarrier,
  createSafeControlBarrier,
  type MailboxWorkClass,
} from "depa-actor-control"
import {
  getPendingDurableControlSignals,
  type AiAgentActor,
  type AiAgentVm,
} from "@cell/ai-core-logic"
import {
  AI_AGENT_WAKE_MAILBOXES,
  type AiAgentWakeMailbox,
} from "@cell/ai-core-logic/runtime/actor"
import type {
  AiMailboxWorkClassification,
  AiTurnBarrierResult,
} from "@cell/ai-runtime-control-contract"

export * from "./engine"
export * from "./recoveryScanner"

export type RuntimeSnapshotSafepointBlockerReason =
  | "mandatory_continuation"
  | "pending_mailbox_work"

export type RuntimeSnapshotSafepointBlocker = {
  fiberId: string
  actorKey?: string
  actorId?: string
  status?: string
  phase?: string
  workClass?: MailboxWorkClass
  mailboxKinds?: AiAgentWakeMailbox[]
  reason: RuntimeSnapshotSafepointBlockerReason
}

export type RuntimeSnapshotSafepointResult = {
  safe: boolean
  blockers: RuntimeSnapshotSafepointBlocker[]
}

export type AiRuntimeInspection = {
  fibers?: Record<string, unknown>
  state?: {
    fibers?: Record<string, unknown>
  }
}

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

function hasMatchingToolResult(actor: AiAgentActor, toolCallId: string): boolean {
  if (!toolCallId) return false
  for (const message of actor.messages ?? []) {
    const messageToolCallId = String((message as any)?.tool_call_id ?? (message as any)?.toolCallId ?? "")
    if ((message as any)?.role === "tool" && messageToolCallId === toolCallId) {
      return true
    }
  }
  return false
}

function hasDurableToolOperationProof(vm: AiAgentVm, fiberId: string, toolCallId: string): boolean {
  const signals = [
    ...getPendingDurableControlSignals(vm.sessionState.controlSignals, { fiberId }),
    ...Object.values(vm.sessionState.controlSignals?.consumedTombstones ?? {}),
  ] as any[]
  return signals.some((signal) => {
    if (String(signal?.fiberId ?? "") !== fiberId) return false
    if (toolCallId && String(signal?.toolCallId ?? "") !== toolCallId) return false
    return String(signal?.mailboxKind ?? "") === "toolResult"
      || String(signal?.signalKind ?? "") === "async_completed"
  })
}

export function classifyAiSnapshotBlockingMailboxes(actor: AiAgentActor, execState: unknown): AiMailboxWorkClassification[] {
  const normalizedExecState = normalizeCooperativeExecState(execState)
  const blockers = new Map<AiAgentWakeMailbox, MailboxWorkClass>()
  const inflightOpId = typeof normalizedExecState?.inflight?.opId === "string" ? normalizedExecState.inflight.opId : ""
  if (inflightOpId) {
    const hasMatchingAsyncCompletion = (actor.peekMailbox("asyncCompletion") as any[]).some((entry) => {
      return entry && typeof entry === "object" && String(entry.opId ?? "") === inflightOpId
    })
    if (hasMatchingAsyncCompletion) {
      blockers.set("asyncCompletion", "mandatory_completion")
    }
  }

  const hasSyncChildDone = (actor.peekMailbox("childDone") as any[]).some((entry) => {
    return entry && typeof entry === "object" && entry.mode === "sync_wait"
  })
  if (hasSyncChildDone) {
    blockers.set("childDone", "mandatory_completion")
  }

  const hasBlockingControl = (actor.peekMailbox("control") as any[]).some((entry) => {
    if (!entry || typeof entry !== "object") return true
    const kind = String((entry as any).kind ?? "")
    return kind !== "questionnaire_pending"
  })
  if (hasBlockingControl) {
    blockers.set("control", "interrupt")
  }

  if ((actor.peekMailbox("toolResult") as any[]).length > 0) {
    blockers.set("toolResult", "mandatory_completion")
  }
  if ((actor.peekMailbox("asyncCompletion") as any[]).length > 0 && !blockers.has("asyncCompletion")) {
    blockers.set("asyncCompletion", "mandatory_completion")
  }
  if ((actor.peekMailbox("childDone") as any[]).length > 0 && !blockers.has("childDone")) {
    blockers.set("childDone", "low_priority_continuation")
  }
  if ((actor.peekMailbox("memberCoordination") as any[]).length > 0) {
    blockers.set("memberCoordination", "recoverable_input")
  }
  if ((actor.peekMailbox("humanInput") as any[]).length > 0) {
    blockers.set("humanInput", "recoverable_input")
  }
  if ((actor.peekMailbox("memberChatInbox") as any[]).length > 0) {
    blockers.set("memberChatInbox", "low_priority_continuation")
  }
  if ((actor.peekMailbox("heartbeat") as any[]).length > 0) {
    blockers.set("heartbeat", "timer_wake")
  }

  return AI_AGENT_WAKE_MAILBOXES
    .filter((mailboxKind) => blockers.has(mailboxKind))
    .map((mailboxKind) => ({
      mailboxKind,
      workClass: blockers.get(mailboxKind) ?? "recoverable_input",
      reason: "pending_mailbox_work",
    }))
}

function currentStartToolCallId(execState: any | null): string {
  const toolIndex = asNonNegativeInteger(execState?.toolIndex, 0)
  const toolCall = Array.isArray(execState?.toolCalls) ? execState.toolCalls[toolIndex] : null
  return String(toolCall?.id ?? toolCall?.toolCallId ?? "")
}

function isLiveAsyncWaitPhase(execState: any | null): boolean {
  if (!execState?.inflight?.opId) return false
  return execState.phase === "wait_llm"
    || execState.phase === "wait_tool"
    || execState.phase === "wait_questionnaire_parse"
    || execState.phase === "compress"
}

function isMandatoryRunnablePhase(execState: any | null): boolean {
  return execState?.phase === "start_llm"
}

export function evaluateAiAgentRuntimeSnapshotSafepoint(params: {
  vm: AiAgentVm
  inspected: AiRuntimeInspection
}): RuntimeSnapshotSafepointResult {
  const blockers: RuntimeSnapshotSafepointBlocker[] = []
  const fibers = params.inspected.fibers ?? {}
  const stateFibers = (params.inspected.state?.fibers ?? {}) as Record<string, any>

  for (const [fiberId, ctx] of Object.entries(fibers)) {
    const execState = normalizeCooperativeExecState((ctx as any)?.execState)
    const actor = (ctx as any)?.actor as AiAgentActor | undefined
    const record = stateFibers[fiberId] ?? {}
    const mailboxClassifications = actor ? classifyAiSnapshotBlockingMailboxes(actor, execState) : []
    if (
      isLiveAsyncWaitPhase(execState)
      || (
        isMandatoryRunnablePhase(execState)
        && (record.status === "ready" || record.status === "running")
      )
    ) {
      blockers.push({
        fiberId,
        actorKey: actor?.key ?? (ctx as any)?.actorKey,
        actorId: actor?.id ?? (ctx as any)?.actorId,
        status: typeof record.status === "string" ? record.status : undefined,
        phase: execState?.phase,
        workClass: "mandatory_completion",
        reason: "mandatory_continuation",
      })
    }
    if (
      mailboxClassifications.length > 0
      && (record.status === "ready" || record.status === "running")
    ) {
      blockers.push({
        fiberId,
        actorKey: actor?.key ?? (ctx as any)?.actorKey,
        actorId: actor?.id ?? (ctx as any)?.actorId,
        status: typeof record.status === "string" ? record.status : undefined,
        phase: execState?.phase ?? "mailbox",
        workClass: mailboxClassifications[0]?.workClass ?? "recoverable_input",
        mailboxKinds: mailboxClassifications.map((entry) => entry.mailboxKind as AiAgentWakeMailbox),
        reason: "pending_mailbox_work",
      })
    }

    if (execState?.phase !== "start_tool") continue

    const toolCalls = Array.isArray(execState.toolCalls) ? execState.toolCalls : []
    const toolIndex = asNonNegativeInteger(execState.toolIndex, 0)
    if (toolCalls.length > 0 && toolIndex >= toolCalls.length) {
      blockers.push({
        fiberId,
        actorKey: actor?.key ?? (ctx as any)?.actorKey,
        actorId: actor?.id ?? (ctx as any)?.actorId,
        status: typeof record.status === "string" ? record.status : undefined,
        phase: "start_tool",
        workClass: "mandatory_completion",
        reason: "mandatory_continuation",
      })
      continue
    }

    const toolCallId = currentStartToolCallId(execState)
    const hasToolResult = actor ? hasMatchingToolResult(actor, toolCallId) : false
    const hasDurableProof = hasDurableToolOperationProof(params.vm, fiberId, toolCallId)
    if (hasToolResult || hasDurableProof) continue

    blockers.push({
      fiberId,
      actorKey: actor?.key ?? (ctx as any)?.actorKey,
      actorId: actor?.id ?? (ctx as any)?.actorId,
      status: typeof record.status === "string" ? record.status : undefined,
      phase: "start_tool",
      workClass: "mandatory_completion",
      reason: "mandatory_continuation",
    })
  }

  return {
    safe: blockers.length === 0,
    blockers,
  }
}

export function evaluateAiTurnSnapshotBarrier(params: {
  vm: AiAgentVm
  inspected: AiRuntimeInspection
}): AiTurnBarrierResult {
  const safepoint = evaluateAiAgentRuntimeSnapshotSafepoint(params)
  if (safepoint.safe) {
    return createSafeControlBarrier({
      barrierId: "snapshot-save",
      purpose: "snapshot_save",
    }) as AiTurnBarrierResult
  }
  return createBlockedControlBarrier({
    barrierId: "snapshot-save",
    purpose: "snapshot_save",
    blockers: safepoint.blockers.map((blocker) => ({
      participantId: blocker.fiberId,
      workClass: blocker.workClass,
      phase: blocker.phase,
      reason: blocker.reason,
      fiberId: blocker.fiberId,
      actorKey: blocker.actorKey,
      actorId: blocker.actorId,
      status: blocker.status,
      mailboxKinds: blocker.mailboxKinds,
    })),
  }) as AiTurnBarrierResult
}


export * from "./engineCapsule/adapterRegistry"
