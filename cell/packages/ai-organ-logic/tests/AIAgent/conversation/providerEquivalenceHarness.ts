import fs from "node:fs"
import path from "node:path"

import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { buildRuntimeSemanticBase } from "@cell/ai-core-logic/stream/runtime/SemanticRuntimeSupport"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import {
  __setCompressionDepsForTest,
  buildProviderPromptForActorTurn,
  forceCompressActorHistory,
} from "@cell/ai-organ-logic/exec/AiAgentExecutor"
import {
  resolveTurnWorkContextForActor,
  setActorTaskPhase,
  setActorWorkMode,
} from "@cell/ai-organ-logic/runtime/ContextControlPlane"

import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  createInMemoryConversationPersistenceAdapter,
  ensureVmConversationDomainRuntime,
  getConversationVisibleMessagesFromVm,
  materializeConversationHistoryMessagesFromVm,
  materializeConversationRuntimeMessagesFromVm,
  messageAssemblyDerivation,
} from "../../../src/conversationCapsule/coreLogic"

/**
 * Provider equivalence harness (track refactor-ai-semantic-conversation-spine,
 * spec case single-in-memory-truth/equivalence-gate; recorded-golden form
 * since T4.3).
 *
 * The harness drives ONE scripted input sequence through the production
 * assembly: inputs are reduced through the semantic event flow
 * (messageAssemblyDerivation, i.e. the MessageHistoryGraph core) into the
 * conversation domain runtime, and every llm-turn boundary captures the
 * provider prompt the production buildProviderPromptForActorTurn ships
 * (sourced from the domain materialization — the only assembly since the
 * legacy raw-array path was deleted in T4.3).
 *
 * The raw `mirrorMessages` array is maintained exactly the way the executor
 * maintains its read-only compatibility mirror (drain pushes, tool-result
 * pushes, compaction array rewrite); it feeds the prompt-plan derivation and
 * the compaction entry, never the provider messages.
 *
 * The legacy reference lives on as recorded golden fixtures
 * (__fixtures__/provider_equivalence_golden.json): the gate compares the
 * domain materialization of every boundary against the snapshot the legacy
 * assembly produced for the same scripted inputs immediately before its
 * deletion.
 *
 * Intentional simplifications (documented, not hidden):
 *  - `applyCheapCompactionForActor` is not replayed at turn start; scenario
 *    payloads are far below every micro-compaction threshold so it is a
 *    no-op on the real path too.
 *  - the provider stream is scripted: each llm turn declares the assistant
 *    output instead of going through a mock SSE stream. The array push and
 *    the semantic events mirror what processStream + AgentEventGraph would
 *    produce for that output.
 */

// ---------------------------------------------------------------------------
// Scenario model
// ---------------------------------------------------------------------------

export type ScenarioToolCall = {
  id: string
  name: string
  argsJson: string
  resultText: string
  isError?: boolean
}

export type ScenarioStep =
  | { kind: "user_input"; text: string }
  | { kind: "llm_turn"; text: string; reasoning?: string; toolCalls?: ScenarioToolCall[] }
  | { kind: "set_work_mode"; workMode: "plan" | "build" }
  | { kind: "set_task_phase"; taskPhase: "normal" | "answer" }
  | { kind: "compact"; summaryText: string; ackText: string; keepTailCount: number }

export type ProviderEquivalenceScenario = {
  name: string
  /** Seeded as actor.systemPrompts[0]; rooted by the Stage-1 system-prompt stage. */
  systemPrompt: string
  steps: ScenarioStep[]
}

export type TurnBoundarySnapshot = {
  boundaryIndex: number
  /** "turn:<n>" for llm-turn boundaries, "final" for the trailing capture. */
  label: string
  /** Domain path: materialized provider context from the three domains. */
  domainProviderMessages: any[]
  /** Domain visible history (diagnostic aid, not part of the gate). */
  domainHistoryMessages: any[]
  /** Read-only conversation view projection (P7 mirror-parity surface). */
  domainVisibleMessages: any[]
  /** Legacy raw mirror content at this boundary (P7 parity reference). */
  mirrorMessages: any[]
  /** The build's declared source — structurally always the materialization. */
  promptSource: "domain_materialization"
  /** providerMessages the production build would send for this boundary. */
  productionProviderMessages: any[]
}

export type ScriptedAssemblyRun = {
  scenario: ProviderEquivalenceScenario
  snapshots: TurnBoundarySnapshot[]
  /** Final raw mirror message array (post-run state, for diagnostics). */
  finalMirrorMessages: any[]
}

// ---------------------------------------------------------------------------
// Normalized comparison
// ---------------------------------------------------------------------------

export type NormalizedToolCall = {
  id: string
  name: string
  arguments: unknown
}

export type NormalizedProviderMessage = {
  role: string
  content: string
  name?: string
  tool_call_id?: string
  tool_calls?: NormalizedToolCall[]
}

function coerceContentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (content === undefined || content === null) return ""
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function parseArgumentsValue(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {}
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function normalizeToolCalls(message: any): NormalizedToolCall[] | undefined {
  const raw = message?.tool_calls ?? message?.toolCalls ?? message?.rawToolCalls
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const normalized: NormalizedToolCall[] = []
  for (const toolCall of raw) {
    const fn = toolCall?.function && typeof toolCall.function === "object" ? toolCall.function : null
    const id = String(toolCall?.id ?? "")
    if (!id) continue
    normalized.push({
      id,
      name: String(fn?.name ?? toolCall?.name ?? ""),
      arguments: parseArgumentsValue(fn ? fn.arguments : toolCall?.arguments ?? toolCall?.input ?? {}),
    })
  }
  return normalized.length ? normalized : undefined
}

/**
 * Reduce a provider message to the fields the equivalence gate compares:
 * role / content / tool_calls / tool_call_id / name. Timestamp-ish fields
 * (startAt, endAt, occurredAt) and reasoning buffers are deliberately
 * outside the comparison surface.
 */
export function normalizeProviderMessageForComparison(message: any): NormalizedProviderMessage {
  const normalized: NormalizedProviderMessage = {
    role: String(message?.role ?? ""),
    content: coerceContentToText(message?.content),
  }
  if (typeof message?.name === "string" && message.name) normalized.name = message.name
  const toolCallId = message?.tool_call_id ?? message?.toolCallId
  if (typeof toolCallId === "string" && toolCallId) normalized.tool_call_id = toolCallId
  const toolCalls = normalizeToolCalls(message)
  if (toolCalls) normalized.tool_calls = toolCalls
  return normalized
}

export type ProviderMessageDiffEntry =
  | { op: "left_only"; leftIndex: number; message: NormalizedProviderMessage }
  | { op: "right_only"; rightIndex: number; message: NormalizedProviderMessage }

/**
 * Message-by-message comparison over the normalized projection. Returns an
 * LCS-aligned diff; an empty array means the sequences are equivalent.
 */
export function compareProviderMessageSequences(left: any[], right: any[]): ProviderMessageDiffEntry[] {
  const leftNormalized = left.map(normalizeProviderMessageForComparison)
  const rightNormalized = right.map(normalizeProviderMessageForComparison)
  const leftKeys = leftNormalized.map((message) => JSON.stringify(message))
  const rightKeys = rightNormalized.map((message) => JSON.stringify(message))

  // Standard LCS table (scenario sequences are tiny).
  const rows = leftKeys.length + 1
  const cols = rightKeys.length + 1
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = leftKeys.length - 1; i >= 0; i -= 1) {
    for (let j = rightKeys.length - 1; j >= 0; j -= 1) {
      table[i]![j] = leftKeys[i] === rightKeys[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const diff: ProviderMessageDiffEntry[] = []
  let i = 0
  let j = 0
  while (i < leftKeys.length && j < rightKeys.length) {
    if (leftKeys[i] === rightKeys[j]) {
      i += 1
      j += 1
      continue
    }
    if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      diff.push({ op: "left_only", leftIndex: i, message: leftNormalized[i]! })
      i += 1
    } else {
      diff.push({ op: "right_only", rightIndex: j, message: rightNormalized[j]! })
      j += 1
    }
  }
  while (i < leftKeys.length) {
    diff.push({ op: "left_only", leftIndex: i, message: leftNormalized[i]! })
    i += 1
  }
  while (j < rightKeys.length) {
    diff.push({ op: "right_only", rightIndex: j, message: rightNormalized[j]! })
    j += 1
  }
  return diff
}

const PROVIDER_CONTEXT_FACT_TAG = "eidolon-context-fact/v1\n"
const LEGACY_WORK_CONTEXT_PATTERN = /^<runtime_work_context>\n([\s\S]*)\n<\/runtime_work_context>$/

type WorkContextSemanticValue = {
  workMode: string
  taskPhase: string
}

export type ProviderContextFactWireValue = {
  namespace: string
  revision: number
  payload: Record<string, unknown>
}

type ProviderContextFactParseResult =
  | { kind: "not_fact" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; fact: ProviderContextFactWireValue }

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseProviderContextFactMessage(message: any): ProviderContextFactParseResult {
  const content = message?.content
  if (typeof content !== "string" || !content.startsWith(PROVIDER_CONTEXT_FACT_TAG)) {
    return { kind: "not_fact" }
  }
  if (String(message?.role ?? "") !== "user") {
    return { kind: "invalid", reason: "tagged provider context fact must use role user" }
  }
  const messageKeys = Object.keys(message as Record<string, unknown>)
    .filter((key) => message[key] !== undefined)
    .sort()
  if (messageKeys.length !== 2 || messageKeys[0] !== "content" || messageKeys[1] !== "role") {
    return { kind: "invalid", reason: "tagged provider context fact must use the exact role/content container" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content.slice(PROVIDER_CONTEXT_FACT_TAG.length))
  } catch {
    return { kind: "invalid", reason: "tagged provider context fact payload is not JSON" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "tagged provider context fact payload must be an object" }
  }
  const record = parsed as Record<string, unknown>
  if (!hasExactKeys(record, ["namespace", "payload", "revision"])) {
    return { kind: "invalid", reason: "tagged provider context fact has an invalid schema" }
  }
  if (typeof record.namespace !== "string" || !record.namespace) {
    return { kind: "invalid", reason: "tagged provider context fact namespace is invalid" }
  }
  if (!Number.isInteger(record.revision) || Number(record.revision) <= 0) {
    return { kind: "invalid", reason: "tagged provider context fact revision is invalid" }
  }
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    return { kind: "invalid", reason: "tagged provider context fact payload field is invalid" }
  }
  return {
    kind: "valid",
    fact: {
      namespace: record.namespace,
      revision: Number(record.revision),
      payload: record.payload as Record<string, unknown>,
    },
  }
}

function parseLegacyWorkContextOverlay(message: any): WorkContextSemanticValue | null {
  if (String(message?.role ?? "") !== "system" || typeof message?.content !== "string") return null
  const body = LEGACY_WORK_CONTEXT_PATTERN.exec(message.content)?.[1]
  if (!body) return null
  const workMode = /^work_mode:\s*(\S+)\s*$/m.exec(body)?.[1] ?? ""
  const taskPhase = /^task_phase:\s*(\S+)\s*$/m.exec(body)?.[1] ?? ""
  return workMode && taskPhase ? { workMode, taskPhase } : null
}

function workContextFromFact(fact: ProviderContextFactWireValue): WorkContextSemanticValue | null {
  if (fact.namespace !== "work-context") return null
  const workMode = typeof fact.payload.workMode === "string" ? fact.payload.workMode : ""
  const taskPhase = typeof fact.payload.taskPhase === "string" ? fact.payload.taskPhase : ""
  return workMode && taskPhase ? { workMode, taskPhase } : null
}

export type WorkContextMigrationComparison = {
  legacyWorkContext: WorkContextSemanticValue | null
  currentWorkContext: WorkContextSemanticValue | null
  currentFactRevisions: number[]
  stableMessageDiff: ProviderMessageDiffEntry[]
  violations: string[]
}

/**
 * Compare a pre-migration golden with current production output without
 * redefining strict provider-message equivalence. Exactly one legacy system
 * overlay is retired into runtime-only control state. It must not reappear as
 * a provider-visible fact; every other message remains on the strict
 * normalized comparison surface.
 */
export function compareAcrossWorkContextFactMigration(
  legacyMessages: any[],
  currentMessages: any[],
): WorkContextMigrationComparison {
  const legacyOverlays = legacyMessages.flatMap((message) => {
    const context = parseLegacyWorkContextOverlay(message)
    return context ? [{ message, context }] : []
  })
  const currentFacts = currentMessages.flatMap((message) => {
    const parsed = parseProviderContextFactMessage(message)
    if (parsed.kind !== "valid") return []
    const context = workContextFromFact(parsed.fact)
    return context ? [{ message, fact: parsed.fact, context }] : []
  })
  const violations: string[] = []
  if (legacyOverlays.length !== 1) {
    violations.push(`legacy sequence has ${legacyOverlays.length} work-context overlays, expected 1`)
  }
  if (currentFacts.length > 0) {
    violations.push("current sequence still exposes a work-context fact")
  }
  const legacyWorkContext = legacyOverlays.at(-1)?.context ?? null
  const currentWorkContext = null
  const legacyOverlayMessages = new Set(legacyOverlays.map((entry) => entry.message))
  const currentWorkFactMessages = new Set(currentFacts.map((entry) => entry.message))
  return {
    legacyWorkContext,
    currentWorkContext,
    currentFactRevisions: currentFacts.map((entry) => entry.fact.revision),
    stableMessageDiff: compareProviderMessageSequences(
      legacyMessages.filter((message) => !legacyOverlayMessages.has(message)),
      currentMessages.filter((message) => !currentWorkFactMessages.has(message)),
    ),
    violations,
  }
}

// ---------------------------------------------------------------------------
// Shape invariants of a provider message sequence
// ---------------------------------------------------------------------------

const VALID_PROVIDER_ROLES = new Set(["system", "user", "assistant", "tool"])

/**
 * Basic well-formedness of a provider prompt: leading system message, only
 * known roles, every tool message paired (by tool_call_id) with the
 * tool_calls of the assistant message that opens its adjacency group, and no
 * directly adjacent ordinary user messages. A valid machine-owned provider
 * context fact is a chronological user message and is the only exception.
 */
export function checkProviderMessageShapeInvariants(messages: any[]): string[] {
  const violations: string[] = []
  if (messages.length === 0) {
    return ["sequence is empty"]
  }
  if (String(messages[0]?.role ?? "") !== "system") {
    violations.push(`first message role is "${String(messages[0]?.role ?? "")}", expected "system"`)
  }
  let pendingToolCallIds = new Set<string>()
  let previousRole = ""
  let previousWasValidContextFact = false
  const latestContextFactRevisionByNamespace = new Map<string, number>()
  messages.forEach((message, index) => {
    const role = String(message?.role ?? "")
    const contextFact = parseProviderContextFactMessage(message)
    const isValidContextFact = contextFact.kind === "valid"
    if (!VALID_PROVIDER_ROLES.has(role)) {
      violations.push(`message[${index}] has invalid role "${role}"`)
    }
    if (contextFact.kind === "invalid") {
      violations.push(`message[${index}] ${contextFact.reason}`)
    }
    if (isValidContextFact) {
      const previousRevision = latestContextFactRevisionByNamespace.get(contextFact.fact.namespace) ?? 0
      if (contextFact.fact.revision <= previousRevision) {
        violations.push(
          `message[${index}] duplicates or reorders ${contextFact.fact.namespace} revision ${contextFact.fact.revision}`,
        )
      } else {
        latestContextFactRevisionByNamespace.set(contextFact.fact.namespace, contextFact.fact.revision)
      }
    }
    if (role === "user" && previousRole === "user" && !isValidContextFact && !previousWasValidContextFact) {
      violations.push(`message[${index}] is a user message directly after another user message`)
    }
    if (role === "assistant") {
      const toolCalls = normalizeToolCalls(message)
      pendingToolCallIds = new Set((toolCalls ?? []).map((toolCall) => toolCall.id))
    } else if (role === "tool") {
      const toolCallId = String(message?.tool_call_id ?? message?.toolCallId ?? "")
      if (!toolCallId) {
        violations.push(`message[${index}] is a tool message without tool_call_id`)
      } else if (!pendingToolCallIds.has(toolCallId)) {
        violations.push(`message[${index}] tool_call_id "${toolCallId}" has no opening assistant tool_call`)
      } else {
        pendingToolCallIds.delete(toolCallId)
      }
    } else {
      pendingToolCallIds = new Set()
    }
    previousRole = role
    previousWasValidContextFact = isValidContextFact
  })
  return violations
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

const HARNESS_SESSION_ID = "equivalence-harness-session"

type AssemblyState = ReturnType<typeof messageAssemblyDerivation.initializeAssemblyState>

type HarnessRuntime = {
  vm: AiAgentVm
  actor: AiAgentActor
  mirrorMessages: any[]
  tools: any[]
  llmAdapter: { type: "openai"; createStream: () => Promise<never> }
  model: string
  assemblyState: AssemblyState
  nextSemanticEvent: (eventType: SemanticEvent["event_type"], extra?: Record<string, unknown>) => SemanticEvent
}

function createHarnessRuntime(scenario: ProviderEquivalenceScenario): HarnessRuntime {
  const llmAdapter = {
    type: "openai" as const,
    async createStream(): Promise<never> {
      throw new Error("provider equivalence harness never calls the provider")
    },
  }
  const actor = createActor({
    key: "main",
    llmClient: llmAdapter,
    systemPrompts: [scenario.systemPrompt],
    modelConfig: { model: "equivalence-mock", inputLimit: 32_000 },
    callbacks: {
      buildToolset: () => [],
      processStream: async () => ({ role: "assistant", content: "" }),
    },
  })
  const vm = createVM({
    controlActorKey: "main",
    actors: { main: actor },
    registries: { toolRegistry: new ToolFuncRegistry() },
    options: { storage: { logs: false, files: false } },
    outerCtx: {
      metadata: {
        sessionId: HARNESS_SESSION_ID,
        sessionDir: HARNESS_SESSION_ID,
      },
      // P3 (refactor-persistent-session-backplane / `explicit-injection`):
      // explicit typed field, not the untyped `metadata` channel.
      conversationPersistenceRepositoryFactory: createInMemoryConversationPersistenceAdapter(),
    },
    effects: {},
  })
  ensureVmConversationDomainRuntime(vm)

  const semanticBase = buildRuntimeSemanticBase({ agentKey: actor.key, agentActorId: actor.id }, 1)
  let emittedAt = 1_000
  const nextSemanticEvent = (
    eventType: SemanticEvent["event_type"],
    extra: Record<string, unknown> = {},
  ): SemanticEvent => {
    emittedAt += 10
    return {
      ...semanticBase,
      ...extra,
      trace: { ...semanticBase.trace, emitted_at: emittedAt },
      event_type: eventType,
    } as SemanticEvent
  }

  return {
    vm,
    actor,
    mirrorMessages: [],
    tools: [],
    llmAdapter,
    model: "equivalence-mock",
    assemblyState: messageAssemblyDerivation.initializeAssemblyState(),
    nextSemanticEvent,
  }
}

/**
 * Mirror of the executor's MessageHistoryGraph committed-message subscription
 * (attachMessageHistory): every committed message is appended to the
 * conversation domain runtime, stamped with the message end time.
 */
function reduceSemanticEventIntoDomain(runtime: HarnessRuntime, event: SemanticEvent): void {
  const next = messageAssemblyDerivation.reduceSemanticEvent(runtime.assemblyState, event)
  runtime.assemblyState = next.state
  for (const committed of next.committed ?? []) {
    const message = committed.message as { startAt?: number; endAt?: number }
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm: runtime.vm,
      actorKey: runtime.actor.key,
      actorId: runtime.actor.id,
      message: committed.message,
      occurredAt:
        typeof message.endAt === "number"
          ? new Date(message.endAt).toISOString()
          : typeof message.startAt === "number"
            ? new Date(message.startAt).toISOString()
            : new Date(0).toISOString(),
    })
  }
}

function applyUserInputStep(runtime: HarnessRuntime, text: string): void {
  // Legacy path: drain pushes the raw user message (AiAgentExecutor drain).
  runtime.mirrorMessages.push({ role: "user", content: text })
  // Domain path: the same input as a semantic event through the assembly core.
  reduceSemanticEventIntoDomain(runtime, runtime.nextSemanticEvent("semantic_user_input", {
    text,
    input_source: "tui",
  }))
}

function applyLlmTurnOutputs(
  runtime: HarnessRuntime,
  step: Extract<ScenarioStep, { kind: "llm_turn" }>,
): void {
  const toolCalls = step.toolCalls ?? []

  // Legacy path: processStream output push + tool result pushes (openai branch).
  const assistantMessage: Record<string, unknown> = {
    role: "assistant",
    content: step.text,
  }
  if (step.reasoning) assistantMessage.reasoning_content = step.reasoning
  if (toolCalls.length) {
    assistantMessage.tool_calls = toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: { name: toolCall.name, arguments: toolCall.argsJson },
    }))
  }
  runtime.mirrorMessages.push(assistantMessage)
  for (const toolCall of toolCalls) {
    runtime.mirrorMessages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      name: toolCall.name,
      content: toolCall.resultText,
    })
  }

  // Domain path: the same provider turn as semantic events.
  if (step.reasoning) {
    reduceSemanticEventIntoDomain(runtime, runtime.nextSemanticEvent("semantic_think_start"))
    reduceSemanticEventIntoDomain(runtime, runtime.nextSemanticEvent("semantic_think_delta", { text: step.reasoning }))
    reduceSemanticEventIntoDomain(runtime, runtime.nextSemanticEvent("semantic_think_end"))
  }
  reduceSemanticEventIntoDomain(runtime, runtime.nextSemanticEvent("semantic_content_start"))
  reduceSemanticEventIntoDomain(runtime, runtime.nextSemanticEvent("semantic_content_delta", { text: step.text }))
  reduceSemanticEventIntoDomain(runtime, runtime.nextSemanticEvent("semantic_content_end"))
  if (toolCalls.length === 0) {
    reduceSemanticEventIntoDomain(runtime, runtime.nextSemanticEvent("semantic_turn_end", { reason: "no_tool_calls" }))
    return
  }
  for (const toolCall of toolCalls) {
    const payload = {
      tool_call_id: toolCall.id,
      tool_name: toolCall.name,
      arguments_text: toolCall.argsJson,
      protocol: "openai",
      call_kind: "json_function",
      raw_payload_text: "",
    }
    reduceSemanticEventIntoDomain(runtime, runtime.nextSemanticEvent("semantic_tool_call_planned", { tool_call: payload }))
    reduceSemanticEventIntoDomain(runtime, runtime.nextSemanticEvent("semantic_tool_call_start", { tool_call: payload }))
    reduceSemanticEventIntoDomain(runtime, runtime.nextSemanticEvent("semantic_tool_call_result", {
      tool_call: payload,
      output_text: toolCall.resultText,
      is_error: toolCall.isError === true,
    }))
  }
}

async function applyCompactStep(
  runtime: HarnessRuntime,
  step: Extract<ScenarioStep, { kind: "compact" }>,
): Promise<void> {
  // Drive the REAL compaction entry (force path) with scripted deps. Since P7
  // the production path reads the domain visible projection and lands the
  // result only as a domain compaction command — no array is touched. The
  // legacy mirror rewrite is emulated below by the harness itself so the
  // parity gate keeps comparing the projection against true legacy behavior.
  __setCompressionDepsForTest({
    estimateUsageRatio: () => 0.9,
    compressHistory: async ({ messages }: { messages: any[] }) => {
      const tail = structuredClone(messages.slice(-step.keepTailCount))
      return [
        { role: "user", content: step.summaryText },
        { role: "assistant", content: step.ackText },
        ...tail,
      ]
    },
  })
  try {
    const result = await forceCompressActorHistory({
      vm: runtime.vm,
      actor: runtime.actor,
      trigger: "equivalence_harness",
    })
    if (!result.ok) {
      throw new Error(`equivalence harness compaction failed: ${result.error}`)
    }
    if (!result.compacted) {
      throw new Error("equivalence harness compaction did not run (ratio/policy gate)")
    }
  } finally {
    __setCompressionDepsForTest(null)
  }

  // Legacy mirror emulation: the pre-P7 executor rewrote the raw array in
  // place to [summary, ack, ...tail]; replay that here on the harness's
  // legacy mirror.
  const mirrorTail = structuredClone(runtime.mirrorMessages.slice(-step.keepTailCount))
  runtime.mirrorMessages.length = 0
  runtime.mirrorMessages.push(
    { role: "user", content: step.summaryText },
    { role: "assistant", content: step.ackText },
    ...mirrorTail,
  )
}

function captureTurnBoundary(runtime: HarnessRuntime, boundaryIndex: number, label: string): TurnBoundarySnapshot {
  // Mirror of the llm-turn preamble in aiAgentLoopStreaming/cooperative step:
  // work-context resolution, then the production provider prompt build (which
  // records the prompt plan into the LLM Context domain and sources the
  // provider messages from the domain materialization).
  resolveTurnWorkContextForActor({
    actor: runtime.actor,
    messages: runtime.mirrorMessages,
    sessionId: HARNESS_SESSION_ID,
    trigger: "turn_start",
  })
  const promptBuild = buildProviderPromptForActorTurn({
    vm: runtime.vm,
    actor: runtime.actor,
    tools: runtime.tools,
    llmAdapter: runtime.llmAdapter as any,
    model: runtime.model,
  })
  return {
    boundaryIndex,
    label,
    domainProviderMessages: structuredClone(
      materializeConversationRuntimeMessagesFromVm({ vm: runtime.vm, actorKey: runtime.actor.key }),
    ),
    domainHistoryMessages: structuredClone(
      materializeConversationHistoryMessagesFromVm({ vm: runtime.vm, actorKey: runtime.actor.key }),
    ),
    domainVisibleMessages: structuredClone(
      getConversationVisibleMessagesFromVm({ vm: runtime.vm, actorKey: runtime.actor.key }) as any[],
    ),
    mirrorMessages: structuredClone(runtime.mirrorMessages),
    promptSource: promptBuild.promptSource,
    productionProviderMessages: structuredClone(promptBuild.providerMessages),
  }
}

/**
 * Run one scripted scenario through the production (domain) assembly,
 * capturing a provider-message snapshot at every llm-turn boundary plus one
 * trailing "final" boundary (the prompt the NEXT turn would send).
 */
export async function runScriptedAssemblyScenario(
  scenario: ProviderEquivalenceScenario,
): Promise<ScriptedAssemblyRun> {
  const runtime = createHarnessRuntime(scenario)
  const snapshots: TurnBoundarySnapshot[] = []
  let turn = 0

  for (const step of scenario.steps) {
    switch (step.kind) {
      case "user_input": {
        applyUserInputStep(runtime, step.text)
        break
      }
      case "llm_turn": {
        turn += 1
        snapshots.push(captureTurnBoundary(runtime, snapshots.length, `turn:${turn}`))
        applyLlmTurnOutputs(runtime, step)
        break
      }
      case "set_work_mode": {
        setActorWorkMode({ actor: runtime.actor, workMode: step.workMode, source: "harness" })
        break
      }
      case "set_task_phase": {
        setActorTaskPhase({ actor: runtime.actor, taskPhase: step.taskPhase, source: "harness" })
        break
      }
      case "compact": {
        await applyCompactStep(runtime, step)
        break
      }
    }
  }

  snapshots.push(captureTurnBoundary(runtime, snapshots.length, "final"))
  return {
    scenario,
    snapshots,
    finalMirrorMessages: structuredClone(runtime.mirrorMessages),
  }
}

// ---------------------------------------------------------------------------
// Built-in scenarios (the scripted input sequences of the equivalence gate)
// ---------------------------------------------------------------------------

export const SCENARIO_MULTI_TURN_TEXT: ProviderEquivalenceScenario = {
  name: "multi_turn_text",
  systemPrompt: "You are the equivalence harness primary agent.",
  steps: [
    { kind: "user_input", text: "Hello there. Please introduce yourself." },
    { kind: "llm_turn", text: "Hi, I am the harness agent.", reasoning: "greet briefly" },
    { kind: "user_input", text: "Summarize what this session is about." },
    { kind: "llm_turn", text: "This session verifies provider message assembly equivalence." },
  ],
}

export const SCENARIO_TOOL_ROUND: ProviderEquivalenceScenario = {
  name: "tool_round",
  systemPrompt: "You are the equivalence harness tool-using agent.",
  steps: [
    { kind: "user_input", text: "Read the project README and report its title." },
    {
      kind: "llm_turn",
      text: "Let me read the README first.",
      toolCalls: [
        {
          id: "tc-readme-1",
          name: "read_file",
          argsJson: '{"path":"README.md"}',
          resultText: "# Eidolon Anchor\nA runtime workbench.",
        },
      ],
    },
    { kind: "llm_turn", text: "The README title is `Eidolon Anchor`." },
  ],
}

export const SCENARIO_WORK_CONTEXT_OVERLAY: ProviderEquivalenceScenario = {
  name: "work_context_overlay",
  systemPrompt: "You are the equivalence harness planning agent.",
  steps: [
    { kind: "user_input", text: "Plan the conversation spine refactor." },
    { kind: "set_work_mode", workMode: "plan" },
    { kind: "llm_turn", text: "Here is the read-only plan: inspect, contract, switch." },
    { kind: "set_work_mode", workMode: "build" },
    { kind: "user_input", text: "Now execute step one." },
    { kind: "llm_turn", text: "Executing step one of the plan." },
  ],
}

export const SCENARIO_COMPACTION_FOLLOW_UP: ProviderEquivalenceScenario = {
  name: "compaction_follow_up",
  systemPrompt: "You are the equivalence harness long-session agent.",
  steps: [
    { kind: "user_input", text: "Investigate the duplicate-message incident." },
    { kind: "llm_turn", text: "I inspected the executor drain path and found candidate causes." },
    { kind: "user_input", text: "Keep digging into the history rebuild." },
    { kind: "llm_turn", text: "The rebuild path reads both the array and the domain ledger." },
    {
      kind: "compact",
      summaryText: "Summary: the incident stems from dual truth between array and domains.",
      ackText: "Acknowledged. Continuing from the compacted context.",
      keepTailCount: 2,
    },
    { kind: "user_input", text: "Given the compacted context, what is next?" },
    { kind: "llm_turn", text: "Next: route provider builds through the domain materialization." },
  ],
}

export const BUILTIN_SCENARIOS: ProviderEquivalenceScenario[] = [
  SCENARIO_MULTI_TURN_TEXT,
  SCENARIO_TOOL_ROUND,
  SCENARIO_WORK_CONTEXT_OVERLAY,
  SCENARIO_COMPACTION_FOLLOW_UP,
]

// ---------------------------------------------------------------------------
// Recorded golden snapshots (legacy assembly output, captured pre-deletion)
// ---------------------------------------------------------------------------

export type GoldenBoundarySnapshot = {
  label: string
  providerMessages: any[]
}

export type ProviderEquivalenceGolden = {
  recordedAt: string
  source: string
  scenarios: Record<string, GoldenBoundarySnapshot[]>
}

/**
 * Load the golden providerMessages snapshots recorded from the legacy
 * raw-array assembly immediately before T4.3 deleted it (see
 * __fixtures__/record_golden.ts). These fixtures are the long-term regression
 * reference of the equivalence gate: the domain materialization of every
 * scripted boundary must stay equivalent to them.
 */
export function loadProviderEquivalenceGolden(): ProviderEquivalenceGolden {
  const fixturePath = path.join(import.meta.dir, "__fixtures__", "provider_equivalence_golden.json")
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ProviderEquivalenceGolden
}
