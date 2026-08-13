import type { ProviderCallRecord } from "@cell/ai-core-contract/runtime/ProviderCallDomain"
import type { ToolCallRecord } from "@cell/ai-core-contract/runtime/ToolCallDomain"
import type { WorkflowAuthoringAuditEntry } from "../authoring/WorkflowAuthoringSessionStore"

export type WorkflowAuthoringTelemetryInput = {
  actorKey: string
  startedAt: number
  publishedAt?: number
  providerCalls: readonly ProviderCallRecord[]
  toolCalls: readonly ToolCallRecord[]
  authoringAudit: readonly WorkflowAuthoringAuditEntry[]
}

export type WorkflowAuthoringTurnTelemetry = {
  providerCallId: string
  turnId: number
  status: ProviderCallRecord["status"]
  providerWaitMs: number
  generationMs: number
  toolDurationMs: number
  toolCallCount: number
  inputPayloadBytes: number
  outputPayloadBytes: number
  reasoningDeltaCount: number
  reasoningCharacterCount: number
}

export type WorkflowAuthoringTelemetry = {
  actorKey: string
  completionCount: number
  failedProviderCallCount: number
  providerWaitMs: number
  generationMs: number
  toolDurationMs: number
  inputPayloadBytes: number
  outputPayloadBytes: number
  reasoningDeltaCount: number
  reasoningCharacterCount: number
  totalMs: number
  firstMutation?: { elapsedMs: number; operation: string; revision?: string }
  publication?: { elapsedMs: number }
  turns: WorkflowAuthoringTurnTelemetry[]
}

const MUTATION_OPERATIONS = new Set(["write", "edit", "patch", "delete"])

function nonNegativeDuration(start: number | undefined, end: number | undefined): number {
  if (start === undefined || end === undefined) return 0
  return Math.max(0, end - start)
}

function byteLength(value: unknown): number {
  if (value === undefined) return 0
  const source = typeof value === "string" ? value : JSON.stringify(value)
  return new TextEncoder().encode(source).byteLength
}

function auditTimestamp(entry: WorkflowAuthoringAuditEntry): number | undefined {
  const value = Date.parse(entry.at)
  return Number.isFinite(value) ? value : undefined
}

function isWorkMutation(entry: WorkflowAuthoringAuditEntry): boolean {
  if (!MUTATION_OPERATIONS.has(entry.operation)) return false
  const path = typeof entry.detail.path === "string" ? entry.detail.path : undefined
  return path === undefined || path === "/work" || path.startsWith("/work/")
}

export function projectWorkflowAuthoringTelemetry(
  input: WorkflowAuthoringTelemetryInput,
): WorkflowAuthoringTelemetry {
  const providers = input.providerCalls
    .filter((record) => record.actorKey === input.actorKey)
    .sort((left, right) => left.turnId - right.turnId || left.startedAt - right.startedAt)
  const tools = input.toolCalls.filter((record) => record.actorKey === input.actorKey)

  const turns = providers.map((provider): WorkflowAuthoringTurnTelemetry => {
    const turnTools = tools.filter((record) => record.turnId === provider.turnId)
    return {
      providerCallId: provider.providerCallId,
      turnId: provider.turnId,
      status: provider.status,
      providerWaitMs: nonNegativeDuration(provider.startedAt, provider.firstTokenAt),
      generationMs: nonNegativeDuration(provider.firstTokenAt, provider.completedAt),
      toolDurationMs: sum(turnTools.map((record) => nonNegativeDuration(record.executedAt, record.resultAt))),
      toolCallCount: turnTools.length,
      inputPayloadBytes: sum(turnTools.map((record) => byteLength(record.args))),
      outputPayloadBytes: sum(turnTools.map((record) => byteLength(record.outputText))),
      reasoningDeltaCount: provider.reasoning?.segments.length ?? 0,
      reasoningCharacterCount: provider.reasoning?.text.length ?? 0,
    }
  })

  const firstMutationEntry = input.authoringAudit
    .filter(isWorkMutation)
    .map((entry) => ({ entry, at: auditTimestamp(entry) }))
    .filter((item): item is { entry: WorkflowAuthoringAuditEntry; at: number } => item.at !== undefined)
    .sort((left, right) => left.at - right.at)[0]
  const publicationEntry = input.authoringAudit
    .filter((entry) => entry.operation === "publish")
    .map((entry) => auditTimestamp(entry))
    .filter((at): at is number => at !== undefined)
    .sort((left, right) => left - right)[0]
  const terminalAt = input.publishedAt
    ?? publicationEntry
    ?? Math.max(input.startedAt, ...providers.map((record) => record.completedAt ?? record.startedAt))

  return {
    actorKey: input.actorKey,
    completionCount: providers.filter((record) => record.status === "completed" || record.status === "failed").length,
    failedProviderCallCount: providers.filter((record) => record.status === "failed").length,
    providerWaitMs: sum(turns.map((turn) => turn.providerWaitMs)),
    generationMs: sum(turns.map((turn) => turn.generationMs)),
    toolDurationMs: sum(turns.map((turn) => turn.toolDurationMs)),
    inputPayloadBytes: sum(turns.map((turn) => turn.inputPayloadBytes)),
    outputPayloadBytes: sum(turns.map((turn) => turn.outputPayloadBytes)),
    reasoningDeltaCount: sum(turns.map((turn) => turn.reasoningDeltaCount)),
    reasoningCharacterCount: sum(turns.map((turn) => turn.reasoningCharacterCount)),
    totalMs: Math.max(0, terminalAt - input.startedAt),
    firstMutation: firstMutationEntry
      ? {
          elapsedMs: Math.max(0, firstMutationEntry.at - input.startedAt),
          operation: firstMutationEntry.entry.operation,
          revision: typeof firstMutationEntry.entry.detail.revision === "string"
            ? firstMutationEntry.entry.detail.revision
            : undefined,
        }
      : undefined,
    publication: publicationEntry === undefined
      ? undefined
      : { elapsedMs: Math.max(0, publicationEntry - input.startedAt) },
    turns,
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
