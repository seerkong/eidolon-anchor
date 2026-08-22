import type { ProviderCallRecord, ProviderFailureKind } from "@cell/ai-core-contract/runtime/ProviderCallDomain"
import type { ToolCallRecord, ToolFailureKind } from "@cell/ai-core-contract/runtime/ToolCallDomain"
import type { LlmProviderRetryDiagnosticData } from "@cell/ai-organ-contract/llm/ProviderRuntime"

export type RuntimeTimingWindow = {
  startedAt: number
  endedAt: number
  callEntryLimit?: number
}

export type RuntimeProviderRetryFact = Pick<
  LlmProviderRetryDiagnosticData,
  "actorId" | "turnId" | "traceId" | "attemptNumber" | "retryCount" | "maxRetries"
> & Partial<LlmProviderRetryDiagnosticData>

export type RuntimeProviderTimingEntry = {
  providerCallId: string
  actorKey: string
  turnId: number
  status: ProviderCallRecord["status"]
  failureKind?: ProviderFailureKind
  terminalCause: "completed" | ProviderFailureKind | "unclassified_failure" | "observation_window_end"
  observedWaitMs: number
  observedGenerationMs: number
}

export type RuntimeToolTimingEntry = {
  toolCallId: string
  actorKey: string
  turnId: number
  toolName: string
  status: ToolCallRecord["status"]
  gateOutcome?: ToolCallRecord["gateOutcome"]
  failureKind?: ToolFailureKind
  terminalCause:
    | "completed"
    | "denied"
    | "deferred"
    | ToolFailureKind
    | "unclassified_failure"
    | "observation_window_end"
  observedDurationMs: number
}

export type RuntimeProviderRetryEntry = {
  actorId?: string
  turnId?: string
  traceId?: string
  attemptNumber: number
  retryCount: number
  maxRetries: number
  reason: RuntimeProviderRetryReason
  terminalCause: RuntimeProviderRetryTerminalCause
}

export type RuntimeProviderRetryReason =
  | "first_event_timeout_retryable"
  | "stream_timeout_retryable"
  | "transport_timeout_retryable"
  | "transport_error_retryable"
  | "provider_error_retryable"
  | "provider_error_non_retryable"
  | "responses_tool_context_recoverable"
  | "other"

export type RuntimeProviderRetryTerminalCause =
  | "retry_scheduled"
  | "retry_exhausted"
  | "retry_time_budget_exhausted"
  | "non_retryable"
  | "other"

export type RuntimeTimingProjection = {
  schemaVersion: 1
  sessionId: string
  window: {
    startedAt: number
    endedAt: number
    wallMs: number
  }
  attribution: {
    intervalMode: "exclusive_union"
    precedence: ["provider_generation", "provider_wait", "tool", "product_owned"]
    missingFirstTokenPolicy: "entire_provider_interval_is_wait"
  }
  /**
   * Mutually exclusive attribution. Precedence is provider generation,
   * provider wait, tool execution, then product-owned wall remainder.
   */
  components: {
    providerWaitMs: number
    providerGenerationMs: number
    toolMs: number
    productOwnedMs: number
  }
  counts: {
    providerCalls: number
    providerFailures: number
    providerOpen: number
    providerRetries: number
    toolCalls: number
    toolFailures: number
    toolDenied: number
    toolOpen: number
  }
  providerCalls: {
    entryLimit: number
    omittedCount: number
    entries: RuntimeProviderTimingEntry[]
  }
  toolCalls: {
    entryLimit: number
    omittedCount: number
    entries: RuntimeToolTimingEntry[]
  }
  retries: {
    entryLimit: number
    omittedCount: number
    entries: RuntimeProviderRetryEntry[]
  }
}

export type RuntimeTimingProjectionInput = RuntimeTimingWindow & {
  sessionId: string
  providerCalls: readonly ProviderCallRecord[]
  toolCalls: readonly ToolCallRecord[]
  providerRetries?: readonly RuntimeProviderRetryFact[]
}

type TimingClass = "providerGeneration" | "providerWait" | "tool"

type TimingInterval = {
  start: number
  end: number
  timingClass: TimingClass
}

const DEFAULT_CALL_ENTRY_LIMIT = 64
const MAX_CALL_ENTRY_LIMIT = 128

const TIMING_CLASS_PRECEDENCE: readonly TimingClass[] = [
  "providerGeneration",
  "providerWait",
  "tool",
]

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function normalizeWindow(startedAt: number, endedAt: number): { startedAt: number; endedAt: number } {
  const normalizedStart = finiteOr(startedAt, 0)
  return {
    startedAt: normalizedStart,
    endedAt: Math.max(normalizedStart, finiteOr(endedAt, normalizedStart)),
  }
}

function normalizeCallEntryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CALL_ENTRY_LIMIT
  return Math.max(0, Math.min(MAX_CALL_ENTRY_LIMIT, Math.floor(value)))
}

function clampInterval(
  start: number | undefined,
  end: number | undefined,
  window: { startedAt: number; endedAt: number },
): { start: number; end: number } | null {
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null
  }
  const clampedStart = Math.max(window.startedAt, start)
  const clampedEnd = Math.min(window.endedAt, end)
  return clampedEnd > clampedStart ? { start: clampedStart, end: clampedEnd } : null
}

function duration(interval: { start: number; end: number } | null): number {
  return interval ? interval.end - interval.start : 0
}

function providerEnd(record: ProviderCallRecord, windowEnd: number): number {
  return Number.isFinite(record.completedAt) ? record.completedAt! : windowEnd
}

function providerIntervals(
  record: ProviderCallRecord,
  window: { startedAt: number; endedAt: number },
): { wait: TimingInterval | null; generation: TimingInterval | null } {
  const end = providerEnd(record, window.endedAt)
  const firstTokenAt = record.firstTokenAt
  const validFirstToken =
    firstTokenAt !== undefined
    && Number.isFinite(firstTokenAt)
    && firstTokenAt >= record.startedAt
    && firstTokenAt <= end

  if (!validFirstToken) {
    const wait = clampInterval(record.startedAt, end, window)
    return {
      wait: wait ? { ...wait, timingClass: "providerWait" } : null,
      generation: null,
    }
  }

  const wait = clampInterval(record.startedAt, firstTokenAt, window)
  const generation = clampInterval(firstTokenAt, end, window)
  return {
    wait: wait ? { ...wait, timingClass: "providerWait" } : null,
    generation: generation ? { ...generation, timingClass: "providerGeneration" } : null,
  }
}

function toolInterval(
  record: ToolCallRecord,
  window: { startedAt: number; endedAt: number },
): TimingInterval | null {
  if (record.executedAt === undefined) return null
  const end = Number.isFinite(record.resultAt) ? record.resultAt! : window.endedAt
  const interval = clampInterval(record.executedAt, end, window)
  return interval ? { ...interval, timingClass: "tool" } : null
}

function lifecycleOverlapsWindow(
  start: number | undefined,
  end: number | undefined,
  window: { startedAt: number; endedAt: number },
): boolean {
  if (start === undefined || !Number.isFinite(start)) return false
  const resolvedEnd = end !== undefined && Number.isFinite(end) ? end : window.endedAt
  return start <= window.endedAt && resolvedEnd >= window.startedAt
}

function attributeExclusiveDurations(
  window: { startedAt: number; endedAt: number },
  intervals: readonly TimingInterval[],
): RuntimeTimingProjection["components"] {
  const boundaries = Array.from(new Set([
    window.startedAt,
    window.endedAt,
    ...intervals.flatMap((interval) => [interval.start, interval.end]),
  ])).sort((left, right) => left - right)
  const totals: Record<TimingClass, number> = {
    providerGeneration: 0,
    providerWait: 0,
    tool: 0,
  }

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index]!
    const end = boundaries[index + 1]!
    if (end <= start) continue
    const timingClass = TIMING_CLASS_PRECEDENCE.find((candidate) =>
      intervals.some((interval) => interval.timingClass === candidate && interval.start <= start && interval.end >= end),
    )
    if (timingClass) totals[timingClass] += end - start
  }

  const wallMs = window.endedAt - window.startedAt
  const attributedMs = totals.providerGeneration + totals.providerWait + totals.tool
  return {
    providerWaitMs: totals.providerWait,
    providerGenerationMs: totals.providerGeneration,
    toolMs: totals.tool,
    productOwnedMs: Math.max(0, wallMs - attributedMs),
  }
}

function providerTerminalCause(record: ProviderCallRecord): RuntimeProviderTimingEntry["terminalCause"] {
  if (record.status === "completed") return "completed"
  if (record.status === "failed") return record.failureKind ?? "unclassified_failure"
  return "observation_window_end"
}

function toolTerminalCause(record: ToolCallRecord): RuntimeToolTimingEntry["terminalCause"] {
  if (record.status === "completed") return "completed"
  if (record.status === "denied") return "denied"
  if (record.status === "deferred") return "deferred"
  if (record.status === "failed") return record.failureKind ?? "unclassified_failure"
  return "observation_window_end"
}

function compareText(left: string | undefined, right: string | undefined): number {
  const normalizedLeft = left ?? ""
  const normalizedRight = right ?? ""
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0
}

function projectRetryReason(value: string | undefined): RuntimeProviderRetryReason {
  switch (value) {
    case "first_event_timeout_retryable":
    case "stream_timeout_retryable":
    case "transport_timeout_retryable":
    case "transport_error_retryable":
    case "provider_error_retryable":
    case "provider_error_non_retryable":
    case "responses_tool_context_recoverable":
      return value
    default:
      return "other"
  }
}

function projectRetryTerminalCause(value: string | undefined): RuntimeProviderRetryTerminalCause {
  switch (value) {
    case "retry_scheduled":
    case "retry_exhausted":
    case "retry_time_budget_exhausted":
    case "non_retryable":
      return value
    default:
      return "other"
  }
}

function boundLatest<T>(entries: readonly T[], entryLimit: number): { omittedCount: number; entries: T[] } {
  if (entryLimit === 0) return { omittedCount: entries.length, entries: [] }
  const bounded = entries.slice(Math.max(0, entries.length - entryLimit))
  return { omittedCount: entries.length - bounded.length, entries: bounded }
}

export function projectRuntimeTiming(input: RuntimeTimingProjectionInput): RuntimeTimingProjection {
  const window = normalizeWindow(input.startedAt, input.endedAt)
  const entryLimit = normalizeCallEntryLimit(input.callEntryLimit)
  const providers = input.providerCalls
    .filter((record) => lifecycleOverlapsWindow(record.startedAt, record.completedAt, window))
    .slice()
    .sort((left, right) => left.startedAt - right.startedAt || compareText(left.providerCallId, right.providerCallId))
  const tools = input.toolCalls
    .filter((record) => lifecycleOverlapsWindow(record.plannedAt, record.resultAt, window))
    .slice()
    .sort((left, right) => left.plannedAt - right.plannedAt || compareText(left.toolCallId, right.toolCallId))
  const retries = (input.providerRetries ?? [])
    .map((retry): RuntimeProviderRetryEntry => ({
      actorId: retry.actorId,
      turnId: retry.turnId,
      traceId: retry.traceId,
      attemptNumber: retry.attemptNumber,
      retryCount: retry.retryCount,
      maxRetries: retry.maxRetries,
      reason: projectRetryReason(retry.classificationReason),
      terminalCause: projectRetryTerminalCause(retry.terminationReason),
    }))
    .sort((left, right) =>
      compareText(left.actorId, right.actorId)
      || compareText(left.turnId, right.turnId)
      || left.attemptNumber - right.attemptNumber
      || compareText(left.traceId, right.traceId),
    )

  const intervals: TimingInterval[] = []
  const providerEntries = providers.map((record): RuntimeProviderTimingEntry => {
    const providerTiming = providerIntervals(record, window)
    if (providerTiming.wait) intervals.push(providerTiming.wait)
    if (providerTiming.generation) intervals.push(providerTiming.generation)
    return {
      providerCallId: record.providerCallId,
      actorKey: record.actorKey,
      turnId: record.turnId,
      status: record.status,
      failureKind: record.failureKind,
      terminalCause: providerTerminalCause(record),
      observedWaitMs: duration(providerTiming.wait),
      observedGenerationMs: duration(providerTiming.generation),
    }
  })
  const toolEntries = tools.map((record): RuntimeToolTimingEntry => {
    const timing = toolInterval(record, window)
    if (timing) intervals.push(timing)
    return {
      toolCallId: record.toolCallId,
      actorKey: record.actorKey,
      turnId: record.turnId,
      toolName: record.funcName,
      status: record.status,
      gateOutcome: record.gateOutcome,
      failureKind: record.failureKind,
      terminalCause: toolTerminalCause(record),
      observedDurationMs: duration(timing),
    }
  })

  const boundedProviders = boundLatest(providerEntries, entryLimit)
  const boundedTools = boundLatest(toolEntries, entryLimit)
  const boundedRetries = boundLatest(retries, entryLimit)
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    window: {
      ...window,
      wallMs: window.endedAt - window.startedAt,
    },
    attribution: {
      intervalMode: "exclusive_union",
      precedence: ["provider_generation", "provider_wait", "tool", "product_owned"],
      missingFirstTokenPolicy: "entire_provider_interval_is_wait",
    },
    components: attributeExclusiveDurations(window, intervals),
    counts: {
      providerCalls: providers.length,
      providerFailures: providers.filter((record) => record.status === "failed").length,
      providerOpen: providers.filter((record) => record.status === "started" || record.status === "streaming").length,
      providerRetries: retries.length,
      toolCalls: tools.length,
      toolFailures: tools.filter((record) => record.status === "failed").length,
      toolDenied: tools.filter((record) => record.status === "denied").length,
      toolOpen: tools.filter((record) =>
        record.status !== "completed" && record.status !== "failed" && record.status !== "denied",
      ).length,
    },
    providerCalls: { entryLimit, ...boundedProviders },
    toolCalls: { entryLimit, ...boundedTools },
    retries: { entryLimit, ...boundedRetries },
  }
}
