import type { LlmAdapter } from "@cell/ai-core-contract/LlmTypes";
import {
  applyConversationCompaction,
} from "@cell/ai-support";
import type { AiRuntimeEffectKind, AiRuntimeEffectLifecycleEvent } from "@cell/ai-runtime-control-contract";
import {
  createNoopPersistenceWritePort,
  type PersistenceEffectEvidenceEvent,
  type PersistenceWritePort,
} from "@cell/ai-core-contract/runtime/PersistencePorts";
import type {
  ConversationDomainEvent,
  ConversationHistoryIndexSnapshot,
  ConversationPromptIndexSnapshot,
  ConversationSessionIndexSnapshot,
} from "@cell/ai-organ-contract";
import type { ConversationPersistenceRepositoryFactory } from "@cell/ai-organ-contract/persistence/conversation/ConversationPersistence";
import {
  AI_AGENT_COORDINATION_DECISIONS,
  AI_AGENT_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_NAMES,
  AI_AGENT_COORDINATION_STATUSES,
  answerQuestionnaireRow,
  upsertPendingQuestionnaireRow,
} from "@cell/ai-core-logic";
import { MessageHistoryGraph } from "@cell/ai-core-logic/stream/MessageHistoryGraph";
import { buildRuntimeSemanticBase } from "@cell/ai-core-logic/stream/runtime/SemanticRuntimeSupport";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { TurnEvent, TurnStartReason, TurnState } from "@cell/ai-core-contract/runtime/TurnState";
import type { QuestionnaireRequestPayload } from "@cell/ai-core-contract/runtime/Questionnaire";
import type {
  CompactionPolicyContextData,
  CompactionPolicyDecisionData,
  PromptPlanData,
} from "@cell/ai-core-contract/runtime/ContextControl";
import { WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl";
import type { AgentLoopResult } from "@cell/ai-core-contract/types";
import { applyActorModelConfigControlSignals, hasPendingAiAgentWakeMailbox, type AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import {
  ensureVmRuntimeContext,
  ensureVmRxData,
  ensureVmSessionState,
  getControlActor,
  isRuntimeStorageFilesEnabled,
  isRuntimeStorageLogsEnabled,
  type AiAgentVm,
} from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import type { ToolFuncRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";
import { applyCheapCompactionPipeline, compressHistory } from "@cell/ai-organ-logic/compression/ContextCompressor";
import { estimateTokens, estimateUsageRatio } from "@cell/ai-organ-logic/compression/TokenEstimator";
import { parseQuestionnaireAnswer } from "@cell/ai-organ-logic/questionnaire/parseQuestionnaireAnswer";
import { TaskTreeManager } from "@cell/ai-organ-logic/plan/TaskTreeManager";
import {
  getLocalPermissionApprovalContext,
  getWorkspaceAccessGrantContext,
  isLocalPermissionApprovalAccepted,
  isLocalPermissionQuestionnairePendingOutput,
  replayLocalPermissionApprovedTool,
  replayWorkspaceAccessGrantApprovedTool,
} from "@cell/ai-organ-logic/permissions/LocalPermissionRuntime";
import { buildAutonomousHolonEnvelope, parseAutonomousHolonEnvelope } from "@cell/ai-organ-logic/organization/autonomousHolonEnvelope";
import { buildLeaderLedHolonEnvelope, parseLeaderLedHolonEnvelope } from "@cell/ai-organ-logic/organization/leaderLedHolonEnvelope";
import { normalizeDelegateRunMode } from "@cell/ai-organ-contract/agent/DelegateRunMode";
import {
  reduceConversationDomainEvent,
  type ConversationProjectionState,
} from "../conversation/ConversationDomainProjection";
import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  ensureVmConversationDomainRuntime,
  emitConversationDomainEvent,
  getConversationActorRawStateFromVm,
  getConversationVisibleMessagesFromVm,
  materializeConversationRuntimeMessagesFromVm,
  recordConversationTranscriptEvidenceInRuntime,
  rewriteActiveHistoryGenerationMessagesInConversationDomainRuntime,
  synchronizeConversationDomainActorFromPersistence,
} from "../conversation/ConversationDomainRuntime";
import {
  createInMemoryConversationPersistenceAdapter,
  messageAssemblyDerivation,
} from "../conversationCapsule/coreLogic";
import {
  advanceActorWorkContextAfterTool,
  buildCompactionPolicyContextForActor,
  decideCompactionPolicy,
  getActorContinuationBaseline,
  getActorWorkContext,
  buildPromptPlanForActorExecution,
  completeEstimationPromptMaterialization,
  recordPromptPlanForActorExecution,
  resetActorContinuationBaseline,
  resolveWorkModeToolGuidance,
  resolveTurnWorkContextForActor,
} from "../runtime/ContextControlPlane";
import { turnReducer } from "../runtime/TurnReducer";
import { ensureVmToolCallDomain, getVmToolCallDomain } from "../runtime/ToolCallDomainRuntime";
import type { ToolGateOutcome } from "@cell/ai-core-contract/runtime/ToolCallDomain";
import { ensureVmProviderCallDomain, getVmProviderCallDomain } from "../runtime/ProviderCallDomainRuntime";
import type { ProviderFailureKind, ToolSchemaSnapshot } from "@cell/ai-core-contract/runtime/ProviderCallDomain";
import { getCoordinationEngine } from "../coordination/CoordinationEngine";
import { getMemberManager } from "../organization/MemberManager";
import { getDetachedActorObservabilityStore } from "../detached/DetachedActorObservability";
import { getOrganizationManager } from "../organization/OrganizationManager";
import { normalizeOpenAIChatMessages } from "../llm/OpenAIChatHelpers";
import { accountThreadGoalUsage, getThreadGoal } from "../goals/ThreadGoalManager";
import { createSessionDiagnosticsXnlLog } from "../runtime/SessionRuntimeXnlLogs";

const isDebugEnabled = (): boolean => (globalThis as any)?.process?.env?.AI_LOOP_DEBUG === "1";

/**
 * Shared no-op write port for the storage-off / no-injection path (memory-only
 * profile, unit runtimes). Every enqueue is a silent no-op so a normal turn
 * completes without being blocked or failed by missing persistence
 * (behavior-delta `storage-not-live-gate` / `memory-only-completes`).
 */
const noopPersistenceWritePort: PersistenceWritePort = createNoopPersistenceWritePort();

type ProcessStreamFn = (vm: AiAgentVm, stream: any, options?: { signal?: AbortSignal }) => Promise<any>;

type CompressionDeps = {
  estimateUsageRatio: typeof estimateUsageRatio;
  compressHistory: typeof compressHistory;
};

let compressionDeps: CompressionDeps = {
  estimateUsageRatio,
  compressHistory,
};

function isAutonomousHolonActor(actor: AiAgentActor | undefined | null): boolean {
  return actor?.identity?.kind === "holon" && actor.identity.governance === "autonomous";
}

function isLeaderLedHolonActor(actor: AiAgentActor | undefined | null): boolean {
  return actor?.identity?.kind === "holon" && actor.identity.governance === "leader_led";
}

function getAutonomousHolonState(actor: AiAgentActor | undefined | null) {
  return actor && isAutonomousHolonActor(actor) && actor.holonState?.governance === "autonomous"
    ? actor.holonState
    : null;
}

function getLeaderLedHolonState(actor: AiAgentActor | undefined | null) {
  return actor && isLeaderLedHolonActor(actor) && actor.holonState?.governance === "leader_led"
    ? actor.holonState
    : null;
}

function isThinContext(messages: any[]): boolean {
  const nonSystem = messages.filter((m) => m && m.role !== "system");
  return nonSystem.length <= 6;
}

function classifyRuntimeControlToolEffectKind(toolName: string): AiRuntimeEffectKind {
  if (toolName === "bash" || toolName === "RunDetachedBash" || toolName === "DetachedBash") return "bash";
  if (toolName.startsWith("mcp__")) return "mcp_tool";
  if (toolName === "Questionnaire") return "questionnaire";
  return "tool_call";
}

function getRuntimeControlSessionDir(vm: AiAgentVm): string {
  const metadata = (vm.outerCtx?.metadata as Record<string, unknown> | undefined) ?? {};
  const sessionDir = metadata.sessionDir;
  return typeof sessionDir === "string" && sessionDir.trim() ? sessionDir : "";
}

/**
 * Resolve the explicitly-injected write-behind persistence port. P3
 * (refactor-persistent-session-backplane / `explicit-injection`): the port is a
 * typed `outerCtx` field, never an untyped `metadata` stash. Absent ⇒
 * memory-only profile, so we fall back to a no-op port (storage off ⇒ no
 * durable write, turn still completes).
 *
 * P4 non-fatal hardening: the port contract requires that a write failure
 * "must never interrupt or block the turn." The reference write-behind port
 * already routes async failures to `onError`, but a port impl COULD throw
 * SYNCHRONOUSLY at the enqueue site. Wrap the resolved port so any synchronous
 * throw from an enqueue method is caught + logged and never aborts the live
 * turn (behavior-delta `one-way-persistence-ports` / `write-behind-non-blocking`,
 * `storage-not-live-gate`).
 */
function getPersistenceWritePort(vm: AiAgentVm): PersistenceWritePort {
  const port = vm.outerCtx?.persistenceWritePort ?? noopPersistenceWritePort;
  const guard = (label: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      // Enqueue must be non-fatal: a throwing port never interrupts the turn.
      vm.effects.log?.("warn", `persistence write port ${label} threw (non-fatal)`, { error });
    }
  };
  return {
    writeSnapshot(input) {
      guard("writeSnapshot", () => port.writeSnapshot(input));
    },
    appendEffectEvidence(input) {
      guard("appendEffectEvidence", () => port.appendEffectEvidence(input));
    },
    persistCompaction(input) {
      guard("persistCompaction", () => port.persistCompaction(input));
    },
  };
}

/**
 * Enqueue one effect-evidence WAL append (append_only_journal) through the
 * injected write-behind port. Write-behind / fire-and-forget: the executor does
 * NOT await file I/O on the hot path, and a write failure is non-fatal (handled
 * inside the port). Returns void — no longer a Promise the live turn awaits.
 */
function appendRuntimeControlLifecycleEvidenceFromVm(
  vm: AiAgentVm,
  event: AiRuntimeEffectLifecycleEvent,
): void {
  if (!isRuntimeStorageFilesEnabled(vm)) return;
  const sessionDir = getRuntimeControlSessionDir(vm);
  if (!sessionDir) return;
  getPersistenceWritePort(vm).appendEffectEvidence({
    sessionDir,
    event: event as unknown as PersistenceEffectEvidenceEvent,
  });
}

function prepareMessagesForLlmAdapter(llmAdapter: LlmAdapter, messages: any[]): any[] {
  if (llmAdapter.type === "openai") {
    return normalizeOpenAIChatMessages(messages);
  }
  if (llmAdapter.type === "deepseek") {
    return normalizeOpenAIChatMessages(messages, { preserveReasoningContent: true });
  }
  return messages;
}

function buildIdentityBlockSystemMessage(actor: AiAgentActor): { role: "system"; content: string } | null {
  const id = actor.identity;
  if (!id || typeof id !== "object") return null;
  if (id.kind !== "member") return null;
  const memberId = String(id.memberId ?? "");
  const name = String((id as any).name ?? "");
  const role = String((id as any).role ?? "");
  const lane = String((id as any).lane ?? "");
  if (!memberId && !name && !role) return null;
  return {
    role: "system",
    content:
      "<identity_block>\n" +
      `member_id: ${memberId}\n` +
      `name: ${name}\n` +
      `role: ${role}\n` +
      `lane: ${lane}\n` +
      "</identity_block>",
  };
}

export function __setCompressionDepsForTest(deps: Partial<CompressionDeps> | null): void {
  if (!deps) {
    compressionDeps = {
      estimateUsageRatio,
      compressHistory,
    };
    return;
  }
  compressionDeps = {
    estimateUsageRatio: deps.estimateUsageRatio ?? estimateUsageRatio,
    compressHistory: deps.compressHistory ?? compressHistory,
  };
}

function getToolName(tool: any): string {
  return String(tool?.function?.name ?? tool?.name ?? "");
}

function isToolAllowed(actor: AiAgentActor, toolName: string): boolean {
  if (!toolName) return false;
  const disabled = new Set((actor.toolPolicy.computedDisabledTools ?? []).map((x) => String(x)));
  if (disabled.has(toolName)) return false;
  const allowed = (actor.toolPolicy.allowedTools ?? []).map((x) => String(x));
  if (allowed.length === 0) return true;
  return allowed.includes(toolName);
}

export type ProviderToolSchemaPolicy = "stable_surface" | "dynamic_work_mode_surface";

export function resolveProviderToolSchemaPolicy(actor: AiAgentActor): ProviderToolSchemaPolicy {
  return actor.modelConfig.capabilities?.cachePolicy?.stablePrefix === true
    ? "stable_surface"
    : "dynamic_work_mode_surface";
}

function dedupeToolSchemas(tools: any[]): any[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    const name = getToolName(tool);
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

export function resolveProviderToolsetForActor(actor: AiAgentActor, tools: any[]): any[] {
  const allowedTools = dedupeToolSchemas(tools.filter((tool) => isToolAllowed(actor, getToolName(tool))));
  if (resolveProviderToolSchemaPolicy(actor) === "stable_surface") {
    return [...allowedTools].sort((left, right) => getToolName(left).localeCompare(getToolName(right)));
  }
  const avoidUntilNeeded = new Set(resolveWorkModeToolGuidance(getActorWorkContext(actor)).avoidUntilNeeded);
  return allowedTools.filter((tool) => !avoidUntilNeeded.has(getToolName(tool)));
}

function logWorkModeToolExecutionAdvisory(vm: AiAgentVm, actor: AiAgentActor, toolName: string): void {
  const workContext = getActorWorkContext(actor);
  const guidance = resolveWorkModeToolGuidance(workContext);
  if (!guidance.avoidUntilNeeded.includes(toolName)) return;
  vm.effects.log?.("debug", "work mode advisory tool executed", {
    actorKey: actor.key,
    toolName,
    workMode: workContext.workMode,
    taskPhase: workContext.taskPhase,
    advisory: "avoid_until_needed",
  });
}

function readToolCommand(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const command = (args as { command?: unknown; cmd?: unknown }).command ?? (args as { cmd?: unknown }).cmd;
  return typeof command === "string" ? command : "";
}

function isDestructiveShellCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;
  return /(>|>>|\btee\b|\bmv\b|\bcp\b|\brm\b|\bmkdir\b|\bgit apply\b|\bsed\s+-i\b|\bperl\s+-pi\b|\btouch\b|\bchmod\b|\bchown\b|\binstall\b)/.test(normalized);
}

function resolvePlanModeToolBlockReason(toolName: string, args: unknown): string | null {
  const normalizedToolName = toolName.trim();
  if (["write", "edit", "multiedit", "apply_patch"].includes(normalizedToolName)) {
    return `write tool '${normalizedToolName}' is blocked in plan mode`;
  }
  if (normalizedToolName === "DetachedToolCall") {
    return "DetachedToolCall is blocked in plan mode because it can bypass direct write-tool checks";
  }
  if (normalizedToolName === "bash" || normalizedToolName === "RunDetachedBash" || normalizedToolName === "DetachedBash") {
    const command = readToolCommand(args);
    if (isDestructiveShellCommand(command)) {
      return `destructive shell command is blocked in plan mode: ${command}`;
    }
  }
  return null;
}

async function callToolWithWorkModeAdvisory(params: {
  toolRegistry: ToolFuncRegistryData;
  vm: AiAgentVm;
  actor: AiAgentActor;
  toolName: string;
  args: unknown;
  meta?: { toolCallId?: string; signal?: AbortSignal };
}): Promise<unknown> {
  const workContext = getActorWorkContext(params.actor);
  if (workContext.workMode === WORK_MODES.plan) {
    const blockReason = resolvePlanModeToolBlockReason(params.toolName, params.args);
    if (blockReason) {
      params.vm.effects.log?.("warn", "plan mode blocked tool execution", {
        actorKey: params.actor.key,
        toolName: params.toolName,
        blockReason,
      });
      return `Error: ${blockReason}`;
    }
  }
  logWorkModeToolExecutionAdvisory(params.vm, params.actor, params.toolName);
  return await ToolFuncRegistry.call(
    params.toolRegistry,
    params.toolName,
    params.vm,
    params.actor,
    params.args,
    params.meta,
  );
}

function isWebTool(toolName: string): boolean {
  return toolName === "webfetch" || toolName === "websearch";
}

function isGatedToolByPlanApproval(toolName: string): boolean {
  // Keep this list minimal + explicit.
  // NOTE: include indirect bypass tools so a worker can't avoid gating.
  return (
    toolName === "bash" ||
    toolName === "write" ||
    toolName === "edit" ||
    toolName === "RunDelegateActor" ||
    toolName === "RunDetachedBash" ||
    toolName === "DetachedBash" ||
    toolName === "DetachedToolCall"
  );
}

function isMemberActor(actor: AiAgentActor): boolean {
  return actor.identity?.kind === "member";
}

function isDelegateActor(actor: AiAgentActor): boolean {
  return (actor.type === "delegate" || actor.type === "detached") && actor.identity?.kind !== "member";
}

function isHistoryTrackedActor(actor: AiAgentActor): boolean {
  return actor.type === "primary" || actor.identity?.kind === "member";
}

function shouldCompressActorHistory(actor: AiAgentActor): boolean {
  return actor.type === "primary" || actor.identity?.kind === "member";
}

function resolveCompactionInputLimit(actor: AiAgentActor): number {
  const inputLimit = actor.modelConfig.inputLimit ?? 0;
  const compactionThreshold = actor.modelConfig.capabilities?.cachePolicy?.compactionThresholdTokens;
  if (compactionThreshold != null && compactionThreshold > 0 && compactionThreshold < (inputLimit || Number.MAX_SAFE_INTEGER)) {
    return compactionThreshold;
  }
  return inputLimit;
}

/**
 * Identity-block plan seed (P7 mirror elimination, spec case
 * single-in-memory-truth/mirror-eliminated): the prompt plan's system channel
 * is actor.systemPrompts plus — for thin conversations — the identity block.
 * No message array is consulted; conversation thinness is evaluated against
 * the read-only domain projection.
 */
function buildPromptPlanSeedMessages(vm: AiAgentVm, actor: AiAgentActor): any[] {
  const identityMsg = buildIdentityBlockSystemMessage(actor);
  if (!identityMsg) return [];
  const visible = getConversationVisibleMessagesFromVm({ vm, actorKey: actor.key });
  if (!isThinContext(visible as any[])) return [];
  return [identityMsg];
}

/**
 * Provider prompt build for an actor turn (track
 * refactor-ai-semantic-conversation-spine, spec cases
 * single-in-memory-truth/provider-context-from-materialize-only and
 * single-in-memory-truth/mirror-eliminated; the legacy raw-array assembly was
 * deleted in T4.3, the mirror system-channel read in P7).
 *
 * The provider messages are sourced EXCLUSIVELY from the conversation-domain
 * materialization (MaterializationDerivation over the three domains): the
 * build records the prompt request into the LLM Context domain (Stage-1
 * system prompt snapshot from actor.systemPrompts + identity block + fresh
 * work-context overlay), then materializes the provider context from the
 * domains and prepares it for the adapter. No message array is an input to
 * this build.
 */
export function buildProviderPromptForActorTurn(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  tools: any[];
  llmAdapter: LlmAdapter;
  model: string;
  /**
   * Record a prompt generation for this build (default true). Estimation-only
   * builds (compaction ratio gates) pass false to keep the prompt-domain
   * ledger at one generation per provider call.
   */
  recordPromptPlan?: boolean;
}): {
  promptPlan: PromptPlanData;
  executionMessages: any[];
  providerMessages: any[];
  promptSource: "domain_materialization";
  /** P5: prompt-domain generation id for this build (null for estimation-only builds). */
  promptGenerationId: string | null;
} {
  ensureVmConversationDomainRuntime(params.vm);
  const sessionId = typeof (params.vm.outerCtx?.metadata as any)?.sessionId === "string"
    ? String((params.vm.outerCtx?.metadata as any).sessionId)
    : "__unsessioned__";
  // Prompt-plan system channel: actor.systemPrompts (inside the plan builder)
  // plus the identity block seed — never a message array.
  const planMessages = buildPromptPlanSeedMessages(params.vm, params.actor);
  const recordedPlan = params.recordPromptPlan !== false
    ? recordPromptPlanForActorExecution({
        vm: params.vm,
        actor: params.actor,
        messages: planMessages,
        tools: params.tools,
        selectedModel: params.model,
      })
    : {
        promptGenerationId: null as string | null,
        promptPlan: buildPromptPlanForActorExecution({
          sessionId,
          actor: params.actor,
          messages: planMessages,
          tools: params.tools,
          selectedModel: params.model,
        }),
      };
  const promptPlan = recordedPlan.promptPlan;
  const promptGenerationId = recordedPlan.promptGenerationId;
  let executionMessages = materializeConversationRuntimeMessagesFromVm({
    vm: params.vm,
    actorKey: params.actor.key,
  });

  if (params.recordPromptPlan === false) {
    // Estimation-only build: nothing was recorded into the prompt domain, so
    // complete the Stage-1 prompts / work-context overlay purely when the
    // materialization does not carry them yet (first-turn ratio gates).
    executionMessages = completeEstimationPromptMaterialization({
      promptPlan,
      messages: executionMessages,
    });
  }
  return {
    promptPlan,
    executionMessages,
    providerMessages: prepareMessagesForLlmAdapter(params.llmAdapter, executionMessages),
    promptSource: "domain_materialization",
    promptGenerationId,
  };
}

function assertProviderPromptWithinInputLimit(params: {
  actor: AiAgentActor;
  providerMessages: any[];
  stage: string;
}): void {
  const inputLimit = params.actor.modelConfig.inputLimit ?? 0;
  if (inputLimit <= 0) return;
  const estimatedTokens = estimateTokens(params.providerMessages);
  if (estimatedTokens < inputLimit) return;
  throw new Error(
    `Context window preflight blocked ${params.stage}: estimated ${estimatedTokens} input tokens exceeds model limit ${inputLimit}. `
      + "Auto compaction did not reduce the prompt below the provider limit; compact the session or remove large tool outputs before continuing.",
  );
}

function estimateProviderRequestPromptTokens(params: {
  providerMessages: any[];
  tools?: any[];
}): number {
  const messageTokens = estimateTokens(params.providerMessages);
  const tools = Array.isArray(params.tools) ? params.tools : [];
  if (tools.length === 0) return messageTokens;
  return messageTokens + estimateTokens([{ role: "system", content: JSON.stringify(tools) }]);
}

function isPromptTooLongError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const lower = text.toLowerCase();
  return (
    lower.includes("prompt_too_long") ||
    lower.includes("too many tokens") ||
    lower.includes("maximum context length") ||
    lower.includes("context window") ||
    lower.includes("reduce the length of the messages") ||
    lower.includes("requested") && lower.includes("tokens") && lower.includes("maximum")
  );
}

function recordEstimatedProviderPromptUsage(vm: AiAgentVm, promptTokens: number): void {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return;
  const { privateRxData } = ensureVmRxData(vm);
  privateRxData.usage.set((previous) => ({
    ...previous,
    prompt_tokens: previous.prompt_tokens + promptTokens,
    total_tokens: previous.total_tokens + promptTokens,
    is_estimated: true,
  }));
}

function buildCheapCompactionPipelineOptions(vm: AiAgentVm, actor: AiAgentActor) {
  const sessionDir = typeof (vm.outerCtx?.metadata as any)?.sessionDir === "string"
    ? String((vm.outerCtx?.metadata as any).sessionDir)
    : "";
  const artifactDir = sessionDir && isRuntimeStorageFilesEnabled(vm)
    ? `${sessionDir}/artifacts/tool-results/${actor.key}`
    : null;
  return {
    artifactDir,
    toolResultBudgetBytes: 120_000,
    toolResultPersistThresholdBytes: 4_000,
    toolResultPreviewChars: 1_500,
    microKeepRecentToolResults: 6,
    microMinContentChars: 2_000,
    microPreviewChars: 900,
  };
}

/**
 * Cheap tool-result compaction as a DOMAIN transform (track
 * refactor-ai-semantic-conversation-spine, tasks T4.3 + P7): the pipeline
 * runs over the committed messages of the ACTIVE history generation and the
 * rewritten generation is published back into the History domain — the next
 * materialization (the only provider assembly) picks it up. Since P7 there is
 * no message array side: actor.messages is a read-only projection of the
 * domains, so the domain rewrite IS the only write.
 */
function applyCheapCompactionForActor(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
}): void {
  if (!shouldCompressActorHistory(params.actor)) return;
  const pipelineOptions = buildCheapCompactionPipelineOptions(params.vm, params.actor);

  // Domain transform: rewrite the active history generation in the History
  // domain (provider truth).
  let domainStats: Record<string, unknown> | null = null;
  const domainRewrite = rewriteActiveHistoryGenerationMessagesInConversationDomainRuntime({
    vm: params.vm,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    reason: "cheap_tool_result_compaction",
    rewrite: (messages) => {
      const result = applyCheapCompactionPipeline(messages, pipelineOptions);
      if (!result.changed) return null;
      domainStats = result.stats as unknown as Record<string, unknown>;
      return result.messages;
    },
  });

  if (!domainRewrite.changed) return;
  params.vm.effects.log?.("debug", "cheap context compaction applied", {
    actorKey: params.actor.key,
    domainChanged: domainRewrite.changed,
    ...(domainStats ?? {}),
  });
}

function appendDetachedMessageForFiber(
  vm: AiAgentVm,
  fiberId: string,
  input: {
    role: "user" | "assistant" | "tool" | "system_event"
    kind: "message" | "tool_call" | "tool_result" | "error" | "status"
    text: string
    toolName?: string
    toolCallId?: string
  },
): void {
  const store = getDetachedActorObservabilityStore(vm)
  const taskId = store.getTaskIdForFiber(fiberId)
  if (!taskId) return
  store.appendMessage(taskId, input)
}

function assistantTextFromMessage(msg: any): string {
  const content = msg?.content
  if (typeof content === "string") return content
  if (content === undefined || content === null) return ""
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function getMemberId(actor: AiAgentActor): string | undefined {
  if (actor.identity?.kind === "member") return actor.identity.memberId
  return undefined
}

function isPlanApprovalSatisfied(status: unknown): boolean {
  return status === AI_AGENT_COORDINATION_STATUSES.approved || status === AI_AGENT_COORDINATION_STATUSES.completed;
}

function resolveNetworkAccess(vm: AiAgentVm): "enabled" | "disabled" | "unknown" {
  const fromVm = (vm.outerCtx?.metadata as any)?.sandbox_permissions;
  const fromGlobal = (globalThis as any)?.__sandbox_permissions;

  const raw =
    fromVm?.networkAccess ??
    fromVm?.network_access ??
    fromGlobal?.networkAccess ??
    fromGlobal?.network_access ??
    (globalThis as any)?.process?.env?.NETWORK_ACCESS;

  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "enabled") return "enabled";
  if (v === "disabled") return "disabled";
  return "unknown";
}

/**
 * Tool execution gate decision (ADT, data-oriented):
 *   allow  - tool may execute
 *   deny   - tool execution refused permanently for this turn; message must
 *            commit to the conversation history and the cooperative output
 *            handler treats the tool as having run (stopAfterTools, etc.
 *            apply)
 *   defer  - tool execution is paused awaiting an external coordination
 *            signal; message commits to history so the LLM sees the pause,
 *            but the cooperative loop must NOT consider the tool "run"
 *            (stopAfterTools does not apply); the actor stays in drain so
 *            future mailbox traffic (e.g. approval) can resume the tool
 *
 * This replaces three ad-hoc gate functions (each returning
 * `{ok}|{ok:false, error}`) plus a string-prefix check on the deny/defer
 * message. The decision shape is the single source of truth for whether
 * a tool actually executed (see {@link toolExecutionGateOutputText} and
 * the cooperative/streaming start_tool dispatch).
 */
export type ToolExecutionGateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: ToolExecutionDenyReason; message: string }
  | { kind: "defer"; reason: ToolExecutionDeferReason; message: string; waitingFor: ToolExecutionDeferWaitTarget };

export type ToolExecutionDenyReason = "tool_disabled" | "network_disabled";
export type ToolExecutionDeferReason = "plan_approval";
export type ToolExecutionDeferWaitTarget = {
  coordination: "plan_approval";
  request_id: string;
};

function toolExecutionGateDeny(reason: ToolExecutionDenyReason, message: string): ToolExecutionGateDecision {
  return { kind: "deny", reason, message };
}

function toolExecutionGateDefer(
  reason: ToolExecutionDeferReason,
  message: string,
  waitingFor: ToolExecutionDeferWaitTarget,
): ToolExecutionGateDecision {
  return { kind: "defer", reason, message, waitingFor };
}

/**
 * Evaluate every tool-execution gate for an actor/vm/tool triple as a
 * single command (DOP, command-message-boundary). Priority: deny first
 * (terminal), then defer (recoverable), then allow.
 */
function evaluateToolExecutionGates(
  vm: AiAgentVm,
  actor: AiAgentActor,
  toolName: string,
): ToolExecutionGateDecision {
  // tool-policy denial: a disabled tool is permanently refused for this
  // turn; stopAfterTools treats it as a real completion.
  if (!isToolAllowed(actor, toolName)) {
    return toolExecutionGateDeny(
      "tool_disabled",
      `Error: policy violation: tool '${toolName}' is disabled`,
    );
  }

  // plan-approval deferral: a member actor with a pending plan-review on
  // a gated tool must wait for approval. The tool will run later when the
  // approval arrives, so stopAfterTools must NOT apply (otherwise the
  // approval can never drive the real execution).
  if (isMemberActor(actor) && isGatedToolByPlanApproval(toolName)) {
    const requestId = actor.planApproval?.requestId;
    if (requestId) {
      const rec = getCoordinationEngine().get(vm, requestId);
      const status = rec?.status ?? actor.planApproval?.status;
      if (!isPlanApprovalSatisfied(status)) {
        return toolExecutionGateDefer(
          "plan_approval",
          `Error: policy violation: plan approval required for tool '${toolName}' (request_id=${requestId})`,
          { coordination: "plan_approval", request_id: requestId },
        );
      }
    }
  }

  // network-access denial: explicit per-tool-class block.
  if (isWebTool(toolName) && resolveNetworkAccess(vm) === "disabled") {
    return toolExecutionGateDeny(
      "network_disabled",
      `Error: policy violation: network access is disabled for tool '${toolName}'`,
    );
  }

  return { kind: "allow" };
}

/** Extract the message text a deny/defer decision wants written into the conversation history. */
function toolExecutionGateOutputText(decision: ToolExecutionGateDecision): string {
  return decision.kind === "allow" ? "" : decision.message;
}

function resolveLoopDeps(vm: AiAgentVm, actor: AiAgentActor): {
  llmAdapter: LlmAdapter;
  model: string;
  buildToolsetFn: () => any[];
  processStreamFn: ProcessStreamFn;
  toolRegistry: ToolFuncRegistryData;
  extraBody?: Record<string, unknown>;
} {
  const llmAdapter = actor.llmClient as LlmAdapter | null;
  if (!llmAdapter || typeof llmAdapter.createStream !== "function") {
    throw new Error("aiAgentLoopStreaming: actor.llmClient is missing or invalid");
  }

  const model = actor.modelConfig.model;
  if (!model) {
    throw new Error("aiAgentLoopStreaming: actor.modelConfig.model is required");
  }

  const toolRegistry = vm.registries.toolRegistry;
  if (!toolRegistry) {
    throw new Error("aiAgentLoopStreaming: runtime.registries.toolRegistry is required");
  }

  const buildToolsetFn = () => actor.callbacks.buildToolset(vm, actor);
  const processStreamFn: ProcessStreamFn = (localVm, stream, options) => actor.callbacks.processStream(localVm, actor, stream, options);

  const callbackExtraBody = vm.callbacks.resolveExtraBody?.(vm);
  const baseExtraBody: Record<string, unknown> = {};
  if (vm.options.reasoningSplit !== undefined) {
    baseExtraBody.reasoning_split = vm.options.reasoningSplit;
  }
  if (actor.modelConfig.reasoningEffort) {
    baseExtraBody.reasoning = { effort: actor.modelConfig.reasoningEffort };
  }

  let extraBody: Record<string, unknown> | undefined;
  if (Object.keys(baseExtraBody).length || (callbackExtraBody && typeof callbackExtraBody === "object")) {
    extraBody = {
      ...baseExtraBody,
      ...(callbackExtraBody && typeof callbackExtraBody === "object" ? callbackExtraBody : {}),
    };
    const callbackReasoning =
      callbackExtraBody && typeof callbackExtraBody === "object"
        ? (callbackExtraBody as Record<string, unknown>).reasoning
        : undefined;
    const baseReasoning = baseExtraBody.reasoning;
    if (
      baseReasoning &&
      callbackReasoning &&
      typeof baseReasoning === "object" &&
      typeof callbackReasoning === "object"
    ) {
      extraBody.reasoning = {
        ...(baseReasoning as Record<string, unknown>),
        ...(callbackReasoning as Record<string, unknown>),
      };
    }
  }

  return {
    llmAdapter,
    model,
    buildToolsetFn,
    processStreamFn,
    toolRegistry,
    extraBody,
  };
}

/**
 * T3.2 shared turn leaf: assemble reasoning/content parts onto an assistant
 * message for the anthropic/claude adapters. Identical leaf used by both the
 * streaming and cooperative drivers so reasoning projection has one owner.
 */
function assembleReasoningContentParts(llmAdapter: LlmAdapter, msg: any): void {
  if (llmAdapter.type === "anthropic" || llmAdapter.type === "claude") {
    if (!Array.isArray(msg.content_parts)) msg.content_parts = [];
    if (msg.reasoning_content && !msg.content_parts.find((p: any) => p?.type === "reasoning")) {
      msg.content_parts.push({ type: "reasoning", text: String(msg.reasoning_content) });
    }
    if (msg.content && !msg.content_parts.find((p: any) => p?.type === "text")) {
      msg.content_parts.push({ type: "text", text: String(msg.content) });
    }
  }
}

/**
 * T3.2 shared turn leaf: build the provider prompt for the current turn and
 * apply preflight over-limit reactive compaction. Both drivers call this
 * before firing the provider call so the prompt-build + preflight path has a
 * single owner. Returns the (possibly recompacted) prompt plan + messages.
 */
async function prepareProviderPromptForTurn(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  tools: any[];
  llmAdapter: LlmAdapter;
  model: string;
  processStreamFn: ProcessStreamFn;
  stage: string;
}): Promise<{ promptPlan: any; providerMessages: any[]; promptGenerationId: string | null }> {
  const { vm, actor, tools, llmAdapter, model, processStreamFn, stage } = params;
  let promptBuild = buildProviderPromptForActorTurn({ vm, actor, tools, llmAdapter, model });
  if ((actor.modelConfig.inputLimit ?? 0) > 0 && estimateTokens(promptBuild.providerMessages) >= (actor.modelConfig.inputLimit ?? 0)) {
    const compacted = await runReactiveCompaction({
      vm,
      actor,
      tools,
      llmAdapter,
      model,
      processStreamFn,
      promptPlan: promptBuild.promptPlan,
      reason: "preflight_over_limit",
    });
    if (compacted) {
      promptBuild = buildProviderPromptForActorTurn({ vm, actor, tools, llmAdapter, model });
    }
  }
  const { promptPlan, providerMessages, promptGenerationId } = promptBuild;
  assertProviderPromptWithinInputLimit({ actor, providerMessages, stage });
  return { promptPlan, providerMessages, promptGenerationId };
}

/**
 * T3.2 shared turn leaf: execute one provider completion (createStream +
 * reactive prompt-too-long retry + processStream + reasoning assembly). This
 * is the `await_provider_call` effect executor shared by both drivers; the
 * blocking streaming driver awaits it inline while the cooperative driver runs
 * it inside its async completion task. Lifecycle evidence (request/waiting/
 * result/failed) stays with each driver because their failure handling and
 * suspend ordering differ. Throws raw on unrecoverable provider error.
 */
// Stable session/actor key for openai-responses previous_response_id continuity.
// Mirrors the prompt-plan session-id derivation (vm.outerCtx.metadata.sessionId)
// scoped by actor.key, so each actor's server-side reasoning chain is isolated
// and never crosses sessions. Empty when neither is known -> continuity off.
function deriveTurnSessionKey(vm: AiAgentVm, actor: AiAgentActor): string | undefined {
  const sessionId = typeof (vm.outerCtx?.metadata as any)?.sessionId === "string"
    ? String((vm.outerCtx?.metadata as any).sessionId).trim()
    : "";
  const actorKey = typeof (actor as any)?.key === "string" ? String((actor as any).key).trim() : "";
  if (!sessionId && !actorKey) return undefined;
  return `${sessionId}/${actorKey}`;
}

async function streamProviderCompletion(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  tools: any[];
  llmAdapter: LlmAdapter;
  model: string;
  processStreamFn: ProcessStreamFn;
  extraBody?: Record<string, unknown>;
  promptPlan: any;
  providerMessages: any[];
  abortController: AbortController;
  retryStage: string;
}): Promise<{ msg: any }> {
  const { vm, actor, tools, llmAdapter, model, processStreamFn, extraBody, abortController, retryStage, promptPlan, providerMessages } = params;
  // Stable session/actor key for openai-responses previous_response_id continuity
  // (P2). Same derivation as the prompt-plan session id; scoped per actor so each
  // actor's reasoning chain stays isolated. Empty -> continuity disabled downstream.
  const turnSessionKey = deriveTurnSessionKey(vm, actor);
  let stream: AsyncIterable<any>;
  try {
    recordEstimatedProviderPromptUsage(
      vm,
      estimateProviderRequestPromptTokens({ providerMessages, tools }),
    );
    stream = (await llmAdapter.createStream({
      model,
      messages: providerMessages,
      tools,
      extraBody: {
        ...(extraBody ?? {}),
        prompt_plan: promptPlan,
        work_context: getActorWorkContext(actor),
      },
      signal: abortController.signal,
      sessionKey: turnSessionKey,
    })).stream;
  } catch (error) {
    if (abortController.signal.aborted || !isPromptTooLongError(error)) {
      throw error;
    }
    const compacted = await runReactiveCompaction({
      vm,
      actor,
      tools,
      llmAdapter,
      model,
      processStreamFn,
      promptPlan,
      reason: "provider_prompt_too_long",
    });
    if (!compacted) {
      throw error;
    }
    const retryPrompt = buildProviderPromptForActorTurn({ vm, actor, tools, llmAdapter, model });
    assertProviderPromptWithinInputLimit({
      actor,
      providerMessages: retryPrompt.providerMessages,
      stage: retryStage,
    });
    recordEstimatedProviderPromptUsage(
      vm,
      estimateProviderRequestPromptTokens({ providerMessages: retryPrompt.providerMessages, tools }),
    );
    stream = (await llmAdapter.createStream({
      model,
      messages: retryPrompt.providerMessages,
      tools,
      extraBody: {
        ...(extraBody ?? {}),
        prompt_plan: retryPrompt.promptPlan,
        work_context: getActorWorkContext(actor),
      },
      signal: abortController.signal,
      sessionKey: turnSessionKey,
    })).stream;
  }
  const msg = await processStreamFn(vm, stream, { signal: abortController.signal });
  assembleReasoningContentParts(llmAdapter, msg);
  return { msg };
}

/**
 * T3.2 shared turn leaf: resolve one tool call's output honoring its gate
 * decision (allow → run the tool; deny/defer → gate output text). This is the
 * compute core of the `dispatch_tool_call` effect; emit + lifecycle evidence
 * stay with each driver. Used by both the streaming and cooperative drivers.
 */
async function resolveToolCallOutput(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  toolRegistry: ToolFuncRegistryData;
  funcName: string;
  args: any;
  toolCallId: string;
  gateDecision: ToolExecutionGateDecision;
  signal?: AbortSignal;
}): Promise<{ resolvedOutput: unknown; outputText: string }> {
  const resolvedOutput =
    params.gateDecision.kind === "allow"
      ? await callToolWithWorkModeAdvisory({
          toolRegistry: params.toolRegistry,
          vm: params.vm,
          actor: params.actor,
          toolName: params.funcName,
          args: params.args,
          meta: { toolCallId: params.toolCallId, ...(params.signal ? { signal: params.signal } : {}) },
        })
      : toolExecutionGateOutputText(params.gateDecision);
  const outputText =
    typeof resolvedOutput === "string" ? resolvedOutput : resolvedOutput === undefined ? "" : JSON.stringify(resolvedOutput);
  return { resolvedOutput, outputText };
}

/**
 * P4: ToolCallDomain lifecycle tracking. These thin wrappers record the tool
 * call's facts into the per-vm ToolCallDomain as the turn proceeds (planned →
 * gate → result), making the domain the live single source of truth for tool
 * lifecycle. They are best-effort and never throw into the live turn: a domain
 * invariant violation (e.g. a duplicate tool_call_id, the root-cause defense
 * that replaces the retired supervisor) is swallowed here so it cannot crash
 * the turn — the invariant still holds in the domain (the duplicate write is
 * rejected and the first record preserved). Shared by the streaming and
 * cooperative tool paths.
 */
function trackToolCallPlanned(params: {
  vm: AiAgentVm;
  actorKey: string;
  turnId: number;
  toolCallId: string;
  funcName: string;
  args: unknown;
}): void {
  if (!params.toolCallId) return;
  const domain = ensureVmToolCallDomain(params.vm);
  // Re-dispatch (e.g. a deferred tool resumed after approval) or recovery
  // replay reuses the same tool_call_id — plan only once.
  if (domain.getRecord(params.toolCallId)) return;
  try {
    domain.planTool({
      toolCallId: params.toolCallId,
      actorKey: params.actorKey,
      turnId: params.turnId,
      funcName: params.funcName,
      args: params.args,
      at: Date.now(),
    });
  } catch {
    // best-effort
  }
}

function trackToolCallGate(vm: AiAgentVm, toolCallId: string, gateOutcome: ToolGateOutcome): void {
  if (!toolCallId) return;
  const domain = getVmToolCallDomain(vm);
  if (!domain || !domain.getRecord(toolCallId)) return;
  try {
    domain.recordGateDecision({ toolCallId, gateOutcome, at: Date.now() });
    if (gateOutcome === "allow") {
      domain.markExecuting({ toolCallId, at: Date.now() });
    }
  } catch {
    // best-effort
  }
}

function trackToolCallResult(vm: AiAgentVm, toolCallId: string, outputText: string, gateOutcome: ToolGateOutcome): void {
  if (!toolCallId) return;
  // Only the allow path actually executed and produces a domain result;
  // deny/defer records stay in their terminal/parked gate status.
  if (gateOutcome !== "allow") return;
  const domain = getVmToolCallDomain(vm);
  if (!domain || !domain.getRecord(toolCallId)) return;
  try {
    if (outputText.startsWith("Error:")) {
      domain.recordFailure({ toolCallId, failureKind: "tool_error", outputText, at: Date.now() });
    } else {
      domain.recordResult({ toolCallId, outputText, at: Date.now() });
    }
  } catch {
    // best-effort
  }
}

/**
 * P5: ProviderCallDomain lifecycle tracking. Thin best-effort wrappers that
 * record each provider call's request metadata + the streamed response split
 * into separate reasoning/content facts (decision 5) and an explicit failure
 * kind (decision 6) into the per-vm ProviderCallDomain. Never throw into the
 * live turn. Shared by the streaming and cooperative LLM paths.
 */
function hashToolSchema(tool: any): string {
  let json = "";
  try {
    json = JSON.stringify(tool ?? {});
  } catch {
    json = String(tool?.function?.name ?? "");
  }
  // djb2 — a stable short fingerprint; the full schema is intentionally not stored.
  let hash = 5381;
  for (let i = 0; i < json.length; i += 1) {
    hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function snapshotToolSchemas(tools: any[]): ToolSchemaSnapshot[] {
  return (tools ?? []).map((tool) => ({
    name: String(tool?.function?.name ?? tool?.name ?? ""),
    hash: hashToolSchema(tool),
  }));
}

function classifyProviderFailure(error: unknown, aborted: boolean): ProviderFailureKind {
  if (aborted) return "aborted_by_user";
  if (isPromptTooLongError(error)) return "prompt_too_long";
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (message.includes("rate limit") || message.includes("429")) return "provider_rate_limit";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("network") || message.includes("econn") || message.includes("fetch")) return "network_error";
  return "provider_invalid_response";
}

function trackProviderCallStarted(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  turnId: number;
  providerCallId: string;
  model: string;
  tools: any[];
  promptGenerationId?: string | null;
}): void {
  if (!params.providerCallId) return;
  const domain = ensureVmProviderCallDomain(params.vm);
  if (domain.getRecord(params.providerCallId)) return;
  const modelConfig = params.actor.modelConfig;
  const options = (modelConfig.options ?? {}) as Record<string, unknown>;
  try {
    domain.startProviderCall({
      providerCallId: params.providerCallId,
      actorKey: params.actor.key,
      turnId: params.turnId,
      modelRef: params.model,
      modelParams: {
        maxTokens: typeof modelConfig.maxOutputTokens === "number" ? modelConfig.maxOutputTokens : undefined,
        reasoningEffort: modelConfig.reasoningEffort,
        temperature: typeof options.temperature === "number" ? options.temperature : undefined,
        topP: typeof options.topP === "number" ? options.topP : undefined,
      },
      toolSchemas: snapshotToolSchemas(params.tools),
      promptGenerationRef: params.promptGenerationId ?? undefined,
      at: Date.now(),
    });
  } catch {
    // best-effort
  }
}

function trackProviderCallCompleted(vm: AiAgentVm, providerCallId: string, msg: any): void {
  if (!providerCallId) return;
  const domain = getVmProviderCallDomain(vm);
  if (!domain || !domain.getRecord(providerCallId)) return;
  const now = Date.now();
  try {
    const reasoning = msg?.reasoning_content;
    if (reasoning) {
      domain.appendReasoningSegment({ providerCallId, startAt: now, endAt: now, text: String(reasoning) });
    }
    const content = msg?.content;
    if (content) {
      domain.appendContentSegment({ providerCallId, startAt: now, endAt: now, text: String(content) });
    }
    const toolCalls = (msg?.tool_calls || msg?.toolCalls || []) as any[];
    const toolCallIds = toolCalls.map((tc) => String(tc?.id ?? "")).filter(Boolean);
    domain.completeProviderCall({ providerCallId, completedAt: now, toolCallIds });
  } catch {
    // best-effort
  }
}

function trackProviderCallFailed(vm: AiAgentVm, providerCallId: string, error: unknown, aborted: boolean): void {
  if (!providerCallId) return;
  const domain = getVmProviderCallDomain(vm);
  if (!domain || !domain.getRecord(providerCallId)) return;
  try {
    domain.failProviderCall({
      providerCallId,
      failureKind: classifyProviderFailure(error, aborted),
      rawError: error instanceof Error ? error.message : String(error ?? ""),
      at: Date.now(),
    });
  } catch {
    // best-effort
  }
}

function requireToolRegistry(vm: AiAgentVm): ToolFuncRegistryData {
  const toolRegistry = vm.registries.toolRegistry;
  if (!toolRegistry) {
    throw new Error("aiAgentLoopStreaming: runtime.registries.toolRegistry is required");
  }
  return toolRegistry;
}

function toEventActorRef(actor: AiAgentActor): { key: string; id: string } {
  return {
    key: actor.key,
    id: actor.id,
  };
}

function findLatestUserContentBeforeLatestAssistant(messages: any[]): string | null {
  let seenAssistant = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as any;
    const role = String(message?.role ?? "");
    if (!seenAssistant) {
      if (role === "assistant") {
        seenAssistant = true;
      }
      continue;
    }
    if (role !== "user") continue;
    return String(message?.content ?? "");
  }
  return null;
}

function findLatestAssignedTaskId(messages: any[]): string | null {
  const content = findLatestUserContentBeforeLatestAssistant(messages);
  if (!content) return null;
  const match = content.match(/TASK_ID=([^\n]+)/);
  return match?.[1] ?? null;
}

function resolveLeaderLedHolonLeaderRequest(messages: any[]): {
  routeId: string
  holonId: string
  leaderMemberId: string
} | null {
  const content = findLatestUserContentBeforeLatestAssistant(messages);
  if (!content) return null;
  const parsed = parseLeaderLedHolonEnvelope(content);
  if (!parsed || parsed.payload.kind !== "leader_request") {
    return null;
  }
  return {
    routeId: parsed.payload.routeId,
    holonId: parsed.payload.holonId,
    leaderMemberId: parsed.payload.leaderMemberId,
  };
}

function resolveAutonomousHolonMemberTask(messages: any[]): {
  taskId: string
  holonId: string
  replyMode: "final" | "none" | "stream"
} | null {
  const content = findLatestUserContentBeforeLatestAssistant(messages);
  if (!content) return null;
  const parsed = parseAutonomousHolonEnvelope(content);
  if (!parsed || parsed.payload.kind !== "member_task") {
    return null;
  }
  return {
    taskId: parsed.payload.taskId,
    holonId: parsed.payload.holonId,
    replyMode: parsed.payload.replyMode,
  };
}

function resolveOwnedBoardTask(vm: AiAgentVm, taskId: string): { ownerActorKey: string } | null {
  for (const candidate of Object.values(vm.actors)) {
    const state = getAutonomousHolonState(candidate);
    if (!state) continue;
    const ownerActorKey = state.taskOwnership?.[taskId];
    if (ownerActorKey) {
      return { ownerActorKey };
    }
  }

  return null;
}

function emitActorMailboxSignal(params: {
  vm: AiAgentVm
  actor: AiAgentActor
  mailboxKind: string
  payload: unknown
  signalKind?: "mailbox_enqueue" | "interrupt_requested"
  idempotencyKey: string
  createdAt?: number
}): void {
  const driver = ensureVmRuntimeContext(params.vm).driver as any;
  const fiberId = `${params.actor.key}:${params.actor.id}`;
  const now = params.createdAt ?? Date.now();
  if (driver?.emitFiberSignal) {
    driver.emitFiberSignal({
      fiberId,
      signalKind: params.signalKind ?? "mailbox_enqueue",
      mailbox: { kind: params.mailboxKind, payload: params.payload },
      idempotencyKey: params.idempotencyKey,
      createdAt: now,
    });
    return;
  }

  params.actor.send(params.mailboxKind as any, params.payload as any);
  driver?.resumeFiber?.(fiberId, now);
}

function settleOwnedBoardTaskFromMemberResult(vm: AiAgentVm, actor: AiAgentActor): void {
  const taskId = findLatestAssignedTaskId(actor.messages);
  if (!taskId) return;

  const ownedTask = resolveOwnedBoardTask(vm, taskId);
  if (!ownedTask || ownedTask.ownerActorKey !== actor.key) {
    return;
  }

  const controlActor = getControlActor(vm);
  if (!controlActor) return;

  try {
    TaskTreeManager.apply(controlActor.taskTree, {
      op: "update_status",
      task_id: taskId,
      status: "completed",
    });
  } catch {
    // Ignore tasks already settled or missing during recovery races.
  }
}

function relayMemberResultToLeaderLedHolon(vm: AiAgentVm, actor: AiAgentActor, text: string): boolean {
  if (actor.identity?.kind !== "member") return false;

  const request = resolveLeaderLedHolonLeaderRequest(actor.messages);
  if (!request) {
    return false;
  }

  const holonActor = vm.actors[getOrganizationManager().getHolonActorKey(request.holonId)];
  if (!isLeaderLedHolonActor(holonActor)) {
    return false;
  }

  const now = Date.now();
  const payload = {
    from: actor.identity.name || actor.key,
    text: buildLeaderLedHolonEnvelope({
      kind: "result",
      routeId: request.routeId,
      holonId: request.holonId,
      leaderMemberId: actor.identity.memberId,
      text,
    }),
    ts: now,
  } as any;

  emitActorMailboxSignal({
    vm,
    actor: holonActor,
    mailboxKind: "memberChatInbox",
    payload,
    idempotencyKey: `${holonActor.key}:${holonActor.id}:memberChatInbox:${now}:${actor.key}:leader_result`,
    createdAt: now,
  });
  drainLeaderLedHolonActorInbox(vm, holonActor);
  return true;
}

function relayLeaderLedHolonStageEventFromLeaderInbox(vm: AiAgentVm, actor: AiAgentActor, text: string): boolean {
  if (actor.identity?.kind !== "member") return false;

  const parsed = parseLeaderLedHolonEnvelope(text);
  if (!parsed || parsed.payload.kind !== "leader_request") {
    return false;
  }

  const holonActor = vm.actors[getOrganizationManager().getHolonActorKey(parsed.payload.holonId)];
  if (!isLeaderLedHolonActor(holonActor)) {
    return false;
  }

  const now = Date.now();
  const payload = {
    from: actor.identity.name || actor.key,
    text: buildLeaderLedHolonEnvelope({
      kind: "event",
      routeId: parsed.payload.routeId,
      holonId: parsed.payload.holonId,
      leaderMemberId: actor.identity.memberId,
      eventType: "leader_received",
      text: `${actor.identity.name} received holon route ${parsed.payload.routeId}`,
    }),
    ts: now,
  } as any;

  emitActorMailboxSignal({
    vm,
    actor: holonActor,
    mailboxKind: "memberChatInbox",
    payload,
    idempotencyKey: `${holonActor.key}:${holonActor.id}:memberChatInbox:${now}:${actor.key}:leader_received`,
    createdAt: now,
  });
  return true;
}

function relayMemberResultToAutonomousHolon(vm: AiAgentVm, actor: AiAgentActor, text: string): boolean {
  if (actor.identity?.kind !== "member") return false;

  const holonTask = resolveAutonomousHolonMemberTask(actor.messages);
  if (!holonTask) {
    return false;
  }

  const holonActor = vm.actors[getOrganizationManager().getHolonActorKey(holonTask.holonId)];
  if (!isAutonomousHolonActor(holonActor)) {
    return false;
  }

  const controlActor = getControlActor(vm);
  if (controlActor) {
    vm.eventBus?.emitQuote?.(
      { key: controlActor.key, id: controlActor.id },
      `Member ${actor.identity.name} finished:\n${text}`,
      "content",
    );
  }

  const now = Date.now();
  const payload = {
    from: actor.identity.name || actor.key,
    text: buildAutonomousHolonEnvelope({
      kind: "result",
      taskId: holonTask.taskId,
      holonId: holonTask.holonId,
      ownerMemberId: actor.identity.memberId,
      ownerActorKey: actor.key,
      ownerActorId: actor.id,
      text,
    }),
    ts: now,
  } as any;

  emitActorMailboxSignal({
    vm,
    actor: holonActor,
    mailboxKind: "memberChatInbox",
    payload,
    idempotencyKey: `${holonActor.key}:${holonActor.id}:memberChatInbox:${now}:${actor.key}:autonomous_result`,
    createdAt: now,
  });
  drainAutonomousHolonActorInbox(vm, holonActor);
  return true;
}

function routeLeaderLedHolonMessageToActor(params: {
  vm: AiAgentVm
  actorKey: string
  actorId: string
  from: string
  text: string
}): void {
  const target = params.vm.actors[params.actorKey];
  const driver = ensureVmRuntimeContext(params.vm).driver as any;
  if (!target || !driver) {
    return;
  }
  const now = Date.now();
  emitActorMailboxSignal({
    vm: params.vm,
    actor: target,
    mailboxKind: "memberChatInbox",
    payload: {
    from: params.from,
    text: params.text,
      ts: now,
    },
    idempotencyKey: `${params.actorKey}:${params.actorId}:memberChatInbox:${now}:${params.from}`,
    createdAt: now,
  });
}

function resolveAutonomousHolonTaskWaiters(
  vm: AiAgentVm,
  taskId: string,
  result: { status: string; resultText: string | null },
): void {
  const runtimeContext = ensureVmRuntimeContext(vm);
  runtimeContext.autonomousHolonTaskSignals.resolve?.(taskId, result);
}

function resolveLeaderLedHolonRouteWaiters(
  vm: AiAgentVm,
  routeId: string,
  result: { resultText: string | null },
): void {
  const runtimeContext = ensureVmRuntimeContext(vm);
  runtimeContext.leaderLedHolonRouteSignals.resolve?.(routeId, result);
}

function drainLeaderLedHolonActorInbox(vm: AiAgentVm, actor: AiAgentActor): void {
  const holonState = getLeaderLedHolonState(actor);
  if (!holonState) {
    return;
  }

  const members = getMemberManager();
  const now = Date.now();
  for (const payload of actor.drainMailbox("memberChatInbox" as any)) {
    const text = String((payload as any)?.text ?? "");
    const parsed = parseLeaderLedHolonEnvelope(text);
    if (!parsed) {
      continue;
    }

    if (parsed.payload.kind === "assign") {
      const leaderMemberId = holonState.leaderMemberId;
      const createdAt = holonState.routes[parsed.payload.routeId]?.createdAt ?? now;
      holonState.routes[parsed.payload.routeId] = {
        routeId: parsed.payload.routeId,
        initiatorActorKey: parsed.payload.initiatorActorKey,
        initiatorActorId: parsed.payload.initiatorActorId,
        leaderMemberId: leaderMemberId ?? "",
        replyMode: parsed.payload.replyMode,
        status: leaderMemberId ? "routed" : "failed",
        createdAt,
        updatedAt: now,
      };

      if (!leaderMemberId) {
        continue;
      }

      members.sendMessage({
        vm,
        to: leaderMemberId,
        from: holonState.name,
        text: buildLeaderLedHolonEnvelope({
          kind: "leader_request",
          routeId: parsed.payload.routeId,
          holonId: holonState.holonId,
          leaderMemberId,
          replyMode: parsed.payload.replyMode,
        }, parsed.payload.content),
      });
      continue;
    }

    if (parsed.payload.kind === "event") {
      const route = holonState.routes[parsed.payload.routeId];
      if (!route) {
        continue;
      }

      holonState.routes[parsed.payload.routeId] = {
        ...route,
        leaderMemberId: parsed.payload.leaderMemberId,
        status: route.status === "completed" ? route.status : "streaming",
        updatedAt: now,
        eventCount: (route.eventCount ?? 0) + 1,
        lastEventText: parsed.payload.text,
        lastEventAt: now,
      };

      if (route.replyMode === "stream") {
        routeLeaderLedHolonMessageToActor({
          vm,
          actorKey: route.initiatorActorKey,
          actorId: route.initiatorActorId,
          from: holonState.name,
          text: parsed.payload.text,
        });
      }
      continue;
    }

    if (parsed.payload.kind !== "result") {
      continue;
    }

    const route = holonState.routes[parsed.payload.routeId];
    if (!route) {
      continue;
    }

    holonState.routes[parsed.payload.routeId] = {
      ...route,
      leaderMemberId: parsed.payload.leaderMemberId,
      status: "completed",
      updatedAt: now,
      resultText: parsed.payload.text,
    };

    if (route.replyMode === "none") {
      resolveLeaderLedHolonRouteWaiters(vm, parsed.payload.routeId, {
        resultText: parsed.payload.text,
      });
      continue;
    }

    routeLeaderLedHolonMessageToActor({
      vm,
      actorKey: route.initiatorActorKey,
      actorId: route.initiatorActorId,
      from: holonState.name,
      text: parsed.payload.text,
    });
    resolveLeaderLedHolonRouteWaiters(vm, parsed.payload.routeId, {
      resultText: parsed.payload.text,
    });
  }
}

function drainAutonomousHolonActorInbox(vm: AiAgentVm, actor: AiAgentActor): void {
  const holonState = getAutonomousHolonState(actor);
  if (!holonState) {
    return;
  }

  const members = getMemberManager();
  const now = Date.now();
  for (const payload of actor.drainMailbox("memberChatInbox" as any)) {
    const text = String((payload as any)?.text ?? "");
    const parsed = parseAutonomousHolonEnvelope(text);
    if (!parsed) {
      continue;
    }

    if (parsed.payload.kind === "assign") {
      const collectiveMembers = holonState.memberIds
        .map((memberId) => members.getMember({ vm, memberId }))
        .filter(Boolean) as ReturnType<typeof members.getMember>[];
      const owner = collectiveMembers.find((member) => member?.lifecycleState === "active") ?? collectiveMembers[0] ?? null;
      const routeStatus = owner ? "routed" : "failed";

      holonState.tasks[parsed.payload.taskId] = {
        taskId: parsed.payload.taskId,
        initiatorActorKey: parsed.payload.initiatorActorKey,
        initiatorActorId: parsed.payload.initiatorActorId,
        replyMode: parsed.payload.replyMode,
        status: routeStatus,
        content: parsed.payload.content,
        createdAt: holonState.tasks[parsed.payload.taskId]?.createdAt ?? now,
        updatedAt: now,
        ownerActorKey: owner?.actorKey,
        ownerActorId: owner?.actorId,
        ownerMemberId: owner?.memberId,
      };
      if (owner?.actorKey) {
        holonState.taskOwnership[parsed.payload.taskId] = owner.actorKey;
      }

      if (!owner) {
        continue;
      }

      try {
        TaskTreeManager.apply(getControlActor(vm)!.taskTree, {
          op: "update_status",
          task_id: parsed.payload.taskId,
          status: "in_progress",
        });
      } catch {
        // Ignore stale or already-settled projections.
      }

      const taskText = buildAutonomousHolonEnvelope({
        kind: "member_task",
        taskId: parsed.payload.taskId,
        holonId: holonState.holonId,
        replyMode: parsed.payload.replyMode,
      }, `TASK_ID=${parsed.payload.taskId}\n${parsed.payload.content}`.trim());

      members.sendMessage({
        vm,
        to: owner.memberId,
        from: holonState.name,
        text: taskText,
      });
      members.markMemberActive({ vm, memberId: owner.memberId });

      vm.eventBus?.emitQuote?.(
        { key: actor.key, id: actor.id },
        `Holon assigned ${parsed.payload.taskId} to ${owner.name}${parsed.payload.content ? `:\n${parsed.payload.content}` : ""}`,
        "content",
      );
      vm.eventBus?.emitAutonomousHolonClaim?.(
        { key: actor.key, id: actor.id },
        { taskId: parsed.payload.taskId, memberId: owner.memberId },
      );
      vm.effects.orchestrationHistory?.appendEvent({
        stream: "autonomous_holon_event",
        kind: "autonomous_holon_claim",
        payload: {
          task_id: parsed.payload.taskId,
          member_id: owner.memberId,
        },
      });
      continue;
    }

    if (parsed.payload.kind !== "result") {
      continue;
    }

    const task = holonState.tasks[parsed.payload.taskId];
    const nextTask = {
      taskId: parsed.payload.taskId,
      initiatorActorKey: task?.initiatorActorKey ?? "",
      initiatorActorId: task?.initiatorActorId ?? "",
      replyMode: task?.replyMode ?? "none",
      status: "completed" as const,
      content: task?.content ?? "",
      createdAt: task?.createdAt ?? now,
      updatedAt: now,
      ownerActorKey: parsed.payload.ownerActorKey,
      ownerActorId: parsed.payload.ownerActorId,
      ownerMemberId: parsed.payload.ownerMemberId,
      resultText: parsed.payload.text,
    };
    holonState.tasks[parsed.payload.taskId] = nextTask;
    holonState.taskOwnership[parsed.payload.taskId] = parsed.payload.ownerActorKey;

    const controlActor = getControlActor(vm);
    if (controlActor) {
      try {
        TaskTreeManager.apply(controlActor.taskTree, {
          op: "update_status",
          task_id: parsed.payload.taskId,
          status: "completed",
        });
      } catch {
        // Ignore stale or already-settled projections.
      }

      const ownerName =
        members.getMember({ vm, memberId: parsed.payload.ownerMemberId })?.name
        ?? parsed.payload.ownerMemberId
      vm.eventBus?.emitQuote?.(
        { key: controlActor.key, id: controlActor.id },
        `Member ${ownerName} finished:\n${parsed.payload.text}`,
        "content",
      );
    }

    resolveAutonomousHolonTaskWaiters(vm, parsed.payload.taskId, {
      status: nextTask.status,
      resultText: nextTask.resultText ?? null,
    });
  }
}

function emitMemberResultToControl(vm: AiAgentVm, actor: AiAgentActor, messages: any[]): void {
  if (actor.identity?.kind !== "member") return;
  const controlActor = getControlActor(vm);
  if (!controlActor || controlActor === actor) return;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as any;
    if (message?.role !== "assistant") continue;
    const text = typeof message?.content === "string" ? message.content.trim() : "";
    if (!text) return;
    const completedAt =
      typeof message?.time?.completed === "number"
        ? message.time.completed
        : typeof message?.time?.created === "number"
          ? message.time.created
          : Date.now();
    if ((actor.lastMemberResultNotifiedAt ?? 0) >= completedAt) {
      return;
    }
    actor.lastMemberResultNotifiedAt = completedAt;
    const relayedToCollective = relayMemberResultToAutonomousHolon(vm, actor, text);
    if (!relayedToCollective) {
      settleOwnedBoardTaskFromMemberResult(vm, actor);
    }
    if (relayMemberResultToLeaderLedHolon(vm, actor, text)) {
      return;
    }
    const roster = ensureVmSessionState(vm).memberRoster
    for (const entry of Object.values(roster)) {
      if (entry.actorKey !== actor.key) continue
      if (entry.actorId !== actor.id) continue
      entry.lastActiveAt = Math.max(entry.lastActiveAt, completedAt)
      break
    }
    vm.eventBus?.emitQuote?.(
      { key: controlActor.key, id: controlActor.id },
      `Member ${actor.identity.name} finished:\n${text}`,
      "content",
    );
    return;
  }
}

async function drainActorMailboxes(
  vm: AiAgentVm,
  actor: AiAgentActor,
): Promise<{ stopReason: AgentLoopResult["stopReason"] | null }> {
  const eventBus = vm.eventBus;
  const eventActor = toEventActorRef(actor);

  drainChildDoneIntoMessages(vm, actor);
  drainMemberChatInboxIntoMessages(vm, actor);
  drainMemberCoordinationIntoMessages(vm, actor);
  if (actor.hasPending("humanInput")) {
    drainHumanInputIntoMessages(vm, actor);
    drainHeartbeatIntoMessages(vm, actor, { includeRuntimeInternalContext: false });
  } else {
    drainHeartbeatIntoMessages(vm, actor, { includeRuntimeInternalContext: true });
  }

  for (const toolResult of actor.drainMailbox("toolResult")) {
    const toolCallId = toolResult.toolCallId;
    const answer = toolResult.content;
    if (!toolCallId || answer === undefined || answer === null) {
      continue;
    }

    const rawText = String(answer);
    const questionnaireId = toolResult.questionnaireId || `q-${toolCallId}`;
    const request: QuestionnaireRequestPayload | undefined = actor.pendingQuestionnaires?.[questionnaireId];
    const llmAdapter = actor.llmClient as LlmAdapter | null;
    const model = actor.modelConfig.model;

    if (!request || !llmAdapter || typeof llmAdapter.createStream !== "function" || !model) {
      if (eventBus) {
        eventBus.emitQuestionnaireResult(eventActor, {
          questionnaireId,
          toolCallId,
          rawText,
          status: "invalid",
          answers: {},
          errors: ["missing questionnaire context"],
        });
      }
      continue;
    }

    const parsed = await parseQuestionnaireAnswer({
      llmAdapter,
      model,
      request,
      rawText,
    });

    if (eventBus) {
      eventBus.emitQuestionnaireResult(eventActor, {
        questionnaireId,
        toolCallId,
        rawText,
        status: parsed.status,
        answers: parsed.answers,
        errors: parsed.errors,
      });
    }

    if (parsed.status === "invalid") {
      const errors = (parsed.errors ?? []).filter(Boolean);
      const intro = errors.length
        ? `Your answer could not be parsed:\n${errors.map((e) => `- ${e}`).join("\n")}`
        : "Your answer could not be parsed. Please try again.";

      const clarification: QuestionnaireRequestPayload = {
        ...request,
        kind: "clarification",
        title: request.title || "Clarification",
        intro,
      };

      actor.pendingQuestionnaires[questionnaireId] = clarification;
      upsertPendingQuestionnaireRow({ vm, actor, request: clarification });
      actor.send("control", {
        kind: "questionnaire_pending",
        toolCallId,
        questionnaireId,
        suspendPolicy: clarification.suspendPolicy,
      });

      if (eventBus) {
        eventBus.emitQuestionnaireRequest(eventActor, clarification);
        eventBus.emitAgentTurnEnd(eventActor, "questionnaire_wait");
      }

      return { stopReason: "questionnaire_wait" };
    }

    delete actor.pendingQuestionnaires[questionnaireId];
    answerQuestionnaireRow({
      vm,
      questionnaireId,
      result: {
        questionnaireId,
        toolCallId,
        rawText,
        status: parsed.status,
        answers: parsed.answers,
        errors: parsed.errors,
      },
    });
    const localPermissionContext = getLocalPermissionApprovalContext(request);
    const workspaceAccessGrantContext = getWorkspaceAccessGrantContext(request);
    if (workspaceAccessGrantContext) {
      const toolRegistry = vm.registries.toolRegistry;
      const resolvedOutput =
        toolRegistry
          ? await replayWorkspaceAccessGrantApprovedTool({
              vm,
              actor,
              toolRegistry,
              request,
              toolCallId,
              answers: parsed.answers,
            })
          : "Error: runtime.registries.toolRegistry is required";
      const outputText =
        typeof resolvedOutput === "string" ? resolvedOutput : resolvedOutput === undefined ? "" : JSON.stringify(resolvedOutput);
      const suppress = shouldSuppressToolResultMessage(workspaceAccessGrantContext.toolName, outputText);
      // P8 single-writer pipeline: emit to the bus; the resident graph
      // commits to the domain. Suppressed results are excluded from both
      // emit and the domain.
      if (eventBus && !suppress) {
        const resultPayload =
          typeof resolvedOutput === "string"
            ? resolvedOutput
            : resolvedOutput === undefined
              ? ""
              : JSON.stringify(resolvedOutput);
        eventBus.emitToolCallResult(eventActor, workspaceAccessGrantContext.toolName, toolCallId, resultPayload, outputText.startsWith("Error:"));
      }
      continue;
    }
    if (localPermissionContext) {
      const toolRegistry = vm.registries.toolRegistry;
      const approved = isLocalPermissionApprovalAccepted(request, parsed.answers);
      const resolvedOutput =
        toolRegistry
          ? await replayLocalPermissionApprovedTool({
              vm,
              actor,
              toolRegistry,
              request,
              toolCallId,
              approved,
            })
          : "Error: runtime.registries.toolRegistry is required";
      const outputText =
        typeof resolvedOutput === "string" ? resolvedOutput : resolvedOutput === undefined ? "" : JSON.stringify(resolvedOutput);
      const suppress = shouldSuppressToolResultMessage(localPermissionContext.toolName, outputText);
      if (eventBus && !suppress) {
        const resultPayload =
          typeof resolvedOutput === "string"
            ? resolvedOutput
            : resolvedOutput === undefined
              ? ""
              : JSON.stringify(resolvedOutput);
        eventBus.emitToolCallResult(eventActor, localPermissionContext.toolName, toolCallId, resultPayload, outputText.startsWith("Error:"));
      }
      continue;
    }
    // Canonical questionnaire-answer commit: the JSON tool message (paired by
    // tool_call_id) goes through the unified tool-result channel so the array
    // mirror and the conversation domains stay in the same shape. The
    // semantic_questionnaire_result bus event remains a stream-level TUI
    // projection and does not commit a message (see MessageHistoryGraph).
    const questionnaireResultJson = JSON.stringify({
      questionnaireId,
      rawText,
      status: parsed.status,
      answers: parsed.answers,
      errors: parsed.errors ?? [],
    });
    appendConversationToolResultMessage({
      vm,
      actor,
      toolCallId,
      toolName: "Questionnaire",
      outputText: questionnaireResultJson,
    });
  }

  return { stopReason: null };
}

function drainChildDoneIntoMessages(vm: AiAgentVm, actor: AiAgentActor): void {
  for (const payload of actor.drainMailbox("childDone")) {
    const outputText = String((payload as any)?.outputText ?? "");
    const toolCallId = typeof (payload as any)?.toolCallId === "string" ? (payload as any).toolCallId : "";
    const mode = normalizeDelegateRunMode((payload as any)?.mode);
    const childActorKey = String((payload as any)?.childActorKey ?? "");

    if (mode === "sync_wait" && toolCallId) {
      appendConversationToolResultMessage({
        vm,
        actor,
        toolCallId,
        outputText,
      });
      continue;
    }

    appendConversationAssistantMessage({
      vm,
      actor,
      message: {
        role: "assistant",
        content: childActorKey ? `Delegate actor ${childActorKey} done:\n${outputText}` : `Delegate actor done:\n${outputText}`,
      },
    });
  }
}

function appendCoordinationHistory(
  vm: AiAgentVm,
  payload: { from: string; coordination: string; kind: string; requestId: string; status: string; decision?: string },
): void {
  vm.effects.orchestrationHistory?.appendEvent({
    stream: "coordination_event",
    kind: "coordination_ingest",
    payload: {
      from: payload.from,
      coordination: payload.coordination,
      coordination_kind: payload.kind,
      request_id: payload.requestId,
      status: payload.status,
      decision: payload.decision ?? null,
    },
  });
}

function emitCoordinationBusEvent(
  vm: AiAgentVm,
  actor: AiAgentActor,
  payload: { from: string; coordination: string; kind: string; requestId: string; status: string; decision?: string },
): void {
  vm.eventBus?.emitCoordinationEvent?.(
    { key: actor.key, id: actor.id },
    {
      from: payload.from,
      coordination: payload.coordination,
      kind: payload.kind,
      requestId: payload.requestId,
      status: payload.status,
      decision: payload.decision,
    },
  );
}

function drainMemberChatInboxIntoMessages(vm: AiAgentVm, actor: AiAgentActor): void {
  const members = getMemberManager();
  const coordinationEngine = getCoordinationEngine();

  for (const payload of actor.drainMailbox("memberChatInbox" as any)) {
    const from = String((payload as any)?.from ?? "");
    const text = String((payload as any)?.text ?? "");
    const ts = typeof (payload as any)?.ts === "number" ? (payload as any).ts : Date.now();
    if (!text) continue;

    if (coordinationEngine.parseEnvelopeText(text)) {
      actor.send("memberCoordination", { from, text, ts } as any);
      continue;
    }

    relayLeaderLedHolonStageEventFromLeaderInbox(vm, actor, text);

    const memberId = getMemberId(actor);
    if (memberId) {
      members.markMemberActive({ vm, memberId });
    }
    appendConversationUserInputMessage({
      vm,
      actor,
      text: from ? `Message from ${from}:\n${text}` : text,
    });
  }
}

function drainMemberCoordinationIntoMessages(vm: AiAgentVm, actor: AiAgentActor): void {
  const coordinationEngine = getCoordinationEngine();
  const members = getMemberManager();

  while (actor.hasPending("memberCoordination")) {
    for (const payload of actor.drainMailbox("memberCoordination" as any)) {
      const from = String((payload as any)?.from ?? "");
      const text = String((payload as any)?.text ?? "");
      const ts = typeof (payload as any)?.ts === "number" ? (payload as any).ts : Date.now();
      if (!text) continue;

      const coordination = coordinationEngine.ingestMemberInbox(vm, { from, text, ts }, { cache: false });
      if (!coordination.handled) {
        continue;
      }

      const inject = typeof coordination.injectText === "string" && coordination.injectText ? coordination.injectText : text;
      appendConversationUserInputMessage({ vm, actor, text: inject });

      if (coordination.coordination === AI_AGENT_COORDINATION_NAMES.planApproval) {
        actor.planApproval = {
          requestId: coordination.request_id,
          status: coordination.status,
          kind: coordination.kind as NonNullable<AiAgentActor["planApproval"]>["kind"],
          decision: coordination.decision,
          updatedAt: Date.now(),
        };
      }

      if (coordination.coordination === AI_AGENT_COORDINATION_NAMES.shutdown) {
        actor.shutdownCoordination = {
          requestId: coordination.request_id,
          status: coordination.status,
          kind: coordination.kind as NonNullable<AiAgentActor["shutdownCoordination"]>["kind"],
          decision: coordination.decision,
          updatedAt: Date.now(),
        };
      }

      appendCoordinationHistory(vm, {
        from,
        coordination: coordination.coordination,
        kind: coordination.kind,
        requestId: coordination.request_id,
        status: coordination.status,
        decision: coordination.decision,
      });
      emitCoordinationBusEvent(vm, actor, {
        from,
        coordination: coordination.coordination,
        kind: coordination.kind,
        requestId: coordination.request_id,
        status: coordination.status,
        decision: coordination.decision,
      });

      if (
        coordination.coordination === AI_AGENT_COORDINATION_NAMES.shutdown
        && coordination.kind === AI_AGENT_COORDINATION_KINDS.shutdownRequest
        && actor.identity?.kind === "member"
      ) {
        const responder = actor.identity.name || actor.key;
        const response = coordinationEngine.makeOutbound({
          coordination: AI_AGENT_COORDINATION_NAMES.shutdown,
          kind: AI_AGENT_COORDINATION_KINDS.shutdownResponse,
          request_id: coordination.request_id,
          payload: { decision: AI_AGENT_COORDINATION_DECISIONS.approve, reason: "shutting down" },
        });
        actor.send("memberCoordination", { from: responder, text: response.text, ts: Date.now() } as any);

        const member = members.findByActor({ vm, actorKey: actor.key, actorId: actor.id });
        if (member) {
          members.markMemberShutdownRequested({
            vm,
            memberId: member.memberId,
            requestId: coordination.request_id,
          });
        }
        continue;
      }

      if (
        coordination.coordination === AI_AGENT_COORDINATION_NAMES.shutdown
        && coordination.kind === AI_AGENT_COORDINATION_KINDS.shutdownResponse
        && actor.identity?.kind === "member"
      ) {
        actor.send("control", { kind: "shutdown_requested" } as any);
      }
    }
  }
}

function drainHeartbeatIntoMessages(vm: AiAgentVm, actor: AiAgentActor, options: { includeRuntimeInternalContext: boolean }): void {
  const deferred: any[] = [];
  for (const payload of actor.drainMailbox("heartbeat")) {
    if (payload?.heartbeatKind === "runtime_internal_context") {
      if (options.includeRuntimeInternalContext) {
        const text = String(payload.text ?? "");
        if (text) appendConversationUserInputMessage({ vm, actor, text });
      } else {
        deferred.push(payload);
      }
      continue;
    }
    const content = [
      `Heartbeat wake: ${payload.name}`,
      `Schedule: ${payload.scheduleId}`,
      `Kind: ${payload.kind}`,
      `Purpose: ${payload.description}`,
      `Message: ${payload.message}`,
      `Fire count: ${payload.fireCount}`,
      `Fired at: ${payload.firedAt}`,
      `Payload: ${JSON.stringify(payload.payload ?? {})}`,
    ].join("\n");
    appendConversationUserInputMessage({ vm, actor, text: content });
  }
  for (const payload of deferred) {
    actor.send("heartbeat", payload);
  }
}

function drainHumanInputIntoMessages(vm: AiAgentVm, actor: AiAgentActor): void {
  // P8 single-writer pipeline: vm.eventBus is the only conversation-event
  // transport. emitUserInput goes onto the bus and the resident
  // MessageHistoryGraph commits to the domain. Callers without a bus fail
  // fast inside the resident graph attachment (no fallback).
  const eventBus = vm.eventBus;
  ensureVmMessageHistoryGraphAttached(vm);
  const eventActor = toEventActorRef(actor);
  for (const payload of actor.drainMailbox("humanInput")) {
    const text = String(payload ?? "");
    if (!text) continue;
    eventBus?.emitUserInput(eventActor, text);
  }
}

function estimateGoalTokenUsage(messages: any[]): number {
  try {
    return estimateTokens(messages);
  } catch {
    return 0;
  }
}

function beginGoalTurn(vm: AiAgentVm, messages: any[]): void {
  const goal = getThreadGoal(vm);
  const runtime = ensureVmRuntimeContext(vm).threadGoalRuntime;
  runtime.continuationInFlight = false;
  if (!goal || goal.status !== "active") {
    runtime.activeGoalId = undefined;
    return;
  }
  const now = Date.now();
  runtime.activeGoalId = goal.goalId;
  runtime.turnSequence = (runtime.turnSequence ?? 0) + 1;
  runtime.turnStartedAt = now;
  runtime.lastAccountedAt = now;
  runtime.lastAccountedTokens = estimateGoalTokenUsage(messages);
}

function accountGoalProgress(vm: AiAgentVm, messages: any[]): void {
  const goal = getThreadGoal(vm);
  if (!goal || goal.status !== "active") return;
  const runtime = ensureVmRuntimeContext(vm).threadGoalRuntime;
  if (runtime.activeGoalId && runtime.activeGoalId !== goal.goalId) return;
  const now = Date.now();
  const currentTokens = estimateGoalTokenUsage(messages);
  const previousTokens = runtime.lastAccountedTokens ?? currentTokens;
  const previousAt = runtime.lastAccountedAt ?? now;
  accountThreadGoalUsage({
    vm,
    tokenDelta: Math.max(0, currentTokens - previousTokens),
    timeDeltaSeconds: Math.max(0, Math.floor((now - previousAt) / 1000)),
  });
  runtime.lastAccountedTokens = currentTokens;
  runtime.lastAccountedAt = now;
}

function emitVisibleAssistantError(vm: AiAgentVm, actor: AiAgentActor, message: string): void {
  const text = String(message ?? "").trim();
  if (!text) return;
  const eventBus = vm.eventBus;
  if (!eventBus) return;
  const eventActor = toEventActorRef(actor);
  eventBus.emitToolCallError(eventActor, [text], "content");
}

// ---------------------------------------------------------------------------
// Conversation-domain write channel (track refactor-ai-semantic-conversation-
// spine, spec cases single-in-memory-truth/writes-via-semantic-events and
// single-in-memory-truth/mirror-eliminated; T4.2 + P7).
//
// All conversation inputs reach the three domains through ONE commit chain:
// semantic events reduced by the message-assembly derivation
// (MessageHistoryGraph merge core) into committed messages appended to the
// History domain. Stream-borne channels (assistant output, user input and
// tool results emitted on the vm event bus) ride the attached
// MessageHistoryGraph; structured inputs that never touch the bus (childDone,
// member chat, coordination injections, heartbeats) are injected at the
// semantic level below — the exact chain the provider equivalence harness
// mirrors. There is NO message array side: `actor.messages` is a read-only
// frozen projection of the History domain (P7 mirror elimination).
// ---------------------------------------------------------------------------

type ConversationSemanticInjectionState = {
  assemblyState: ReturnType<typeof messageAssemblyDerivation.initializeAssemblyState>;
  lastEmittedAt: number;
};

function getConversationSemanticInjectionMap(vm: AiAgentVm): Record<string, ConversationSemanticInjectionState> {
  const runtimeContext = ensureVmRuntimeContext(vm) as unknown as Record<string, unknown>;
  if (!runtimeContext.conversationSemanticInjection) {
    runtimeContext.conversationSemanticInjection = {};
  }
  return runtimeContext.conversationSemanticInjection as Record<string, ConversationSemanticInjectionState>;
}

type InjectedSemanticEventInput = { event_type: SemanticEvent["event_type"] } & Record<string, unknown>;

/**
 * Dispatch semantic events for an actor onto the vm event bus (P8
 * single-writer pipeline, decisions.md decision 8): vm.eventBus is the only
 * conversation-event transport, and the vm-resident MessageHistoryGraph
 * (attached idempotently via {@link ensureVmMessageHistoryGraphAttached}) is
 * the only commit writer to the History domain.
 *
 * Fail-fast: a vm without an event bus is rejected explicitly — there is no
 * legacy reduce/append fallback. Callers that cannot supply a bus must fix
 * their composition (mock processStream callbacks in unit tests must emit
 * the matching semantic event sequence; the conversation runtime cannot
 * silently bypass the single writer).
 */
function injectSemanticEventsIntoConversationDomain(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  events: InjectedSemanticEventInput[];
}): void {
  if (params.events.length === 0) return;
  ensureVmConversationDomainRuntime(params.vm);
  ensureVmMessageHistoryGraphAttached(params.vm);
  const eventBus = params.vm.eventBus;
  if (!eventBus || typeof (eventBus as any).emit !== "function") {
    throw new Error(
      "conversation_single_writer_pipeline: vm.eventBus is required to dispatch semantic events; mock processStream callbacks must emit the matching event sequence (P8, spec single-writer-pipeline/eventbus-required)",
    );
  }
  const map = getConversationSemanticInjectionMap(params.vm);
  let lastEmittedAt = map[params.actor.key]?.lastEmittedAt ?? 0;
  const base = buildRuntimeSemanticBase({ agentKey: params.actor.key, agentActorId: params.actor.id }, 1);
  for (const extra of params.events) {
    const emittedAt = Math.max(Date.now(), lastEmittedAt + 1);
    lastEmittedAt = emittedAt;
    const event = {
      ...base,
      ...extra,
      trace: { ...base.trace, emitted_at: emittedAt },
    } as SemanticEvent;
    (eventBus as any).emit(event);
  }
  map[params.actor.key] = {
    assemblyState: map[params.actor.key]?.assemblyState
      ?? messageAssemblyDerivation.initializeAssemblyState(),
    lastEmittedAt,
  };
}

/**
 * Append a user-channel input as a domain write (P7: no array side exists).
 * When the input was already emitted on the semantic stream (emitUserInput)
 * and a committed-message graph is attached, the graph is the domain writer;
 * otherwise the input is injected at the semantic level here.
 */
function appendConversationUserInputMessage(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  text: string;
}): void {
  injectSemanticEventsIntoConversationDomain({
    vm: params.vm,
    actor: params.actor,
    events: [{ event_type: "semantic_user_input", text: params.text, input_source: "system" }],
  });
}

/**
 * Append a tool-result message as a domain write through the semantic
 * tool_call_result event, unless the result already reached the domains via
 * the attached committed-message graph (emitToolCallResult).
 */
function appendConversationToolResultMessage(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  toolCallId: string;
  toolName?: string;
  outputText: string;
  isError?: boolean;
}): void {
  injectSemanticEventsIntoConversationDomain({
    vm: params.vm,
    actor: params.actor,
    events: [
      {
        event_type: "semantic_tool_call_result",
        tool_call: {
          tool_call_id: params.toolCallId,
          tool_name: params.toolName ?? "",
          arguments_text: "",
          protocol: "openai",
          call_kind: "json_function",
          raw_payload_text: "",
        },
        output_text: params.outputText,
        is_error: params.isError === true,
      },
    ],
  });
}

/**
 * Append an assistant message produced by a provider turn (or a structured
 * assistant note such as an async childDone summary) as a domain write.
 * When the assistant content was streamed over the vm event bus and a
 * committed-message graph is attached, the graph commit is the domain write;
 * otherwise the message is injected as semantic content / tool-plan events
 * so the assembly derivation commits it.
 */
function appendConversationAssistantMessage(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  message: any;
}): void {
  const reasoning = typeof params.message?.reasoning_content === "string" ? params.message.reasoning_content : "";
  const content = typeof params.message?.content === "string"
    ? params.message.content
    : params.message?.content == null
      ? ""
      : (() => {
          try {
            return JSON.stringify(params.message.content);
          } catch {
            return String(params.message.content);
          }
        })();
  const rawToolCalls = Array.isArray(params.message?.tool_calls)
    ? params.message.tool_calls
    : Array.isArray(params.message?.toolCalls)
      ? params.message.toolCalls
      : [];
  const events: InjectedSemanticEventInput[] = [];
  if (reasoning) {
    events.push({ event_type: "semantic_think_start" });
    events.push({ event_type: "semantic_think_delta", text: reasoning });
    events.push({ event_type: "semantic_think_end" });
  }
  events.push({ event_type: "semantic_content_start" });
  if (content) events.push({ event_type: "semantic_content_delta", text: content });
  events.push({ event_type: "semantic_content_end" });
  for (const toolCall of rawToolCalls) {
    const fn = toolCall?.function && typeof toolCall.function === "object" ? toolCall.function : null;
    const argumentsText = typeof fn?.arguments === "string"
      ? fn.arguments
      : JSON.stringify(toolCall?.input ?? toolCall?.arguments ?? {});
    events.push({
      event_type: "semantic_tool_call_planned",
      tool_call: {
        tool_call_id: String(toolCall?.id ?? ""),
        tool_name: String(fn?.name ?? toolCall?.name ?? ""),
        arguments_text: argumentsText,
        protocol: "openai",
        call_kind: "json_function",
        raw_payload_text: "",
      },
    });
  }
  if (rawToolCalls.length === 0) {
    // No tool round follows: flush the committed assistant immediately. With
    // tool calls pending, the tool_call_result injections (or the next
    // drained input) flush it, mirroring the stream chain.
    events.push({ event_type: "semantic_turn_end", reason: "assistant_message_committed" });
  }
  injectSemanticEventsIntoConversationDomain({ vm: params.vm, actor: params.actor, events });
}

/**
 * Route actor SEED messages (delegate / detached fiber creation prompts)
 * into the conversation domains through the semantic injection chain (track
 * refactor-ai-semantic-conversation-spine, task T4.3). System messages are
 * deliberately skipped: they are rooted by the Stage-1 system-prompt snapshot
 * of the prompt plan (actor.systemPrompts), never by History-domain commits.
 * Without this seeding the child actor's first provider build would
 * materialize an empty conversation while the seed prompt only lived in the
 * raw array — the exact out-of-band write the deleted legacy fallback used to
 * paper over.
 */
export function seedConversationDomainFromActorSeedMessages(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  seedMessages: readonly any[];
}): void {
  const events: InjectedSemanticEventInput[] = [];
  for (const message of params.seedMessages) {
    const role = String(message?.role ?? "");
    if (role === "system") continue;
    const content = typeof message?.content === "string"
      ? message.content
      : message?.content == null
        ? ""
        : (() => {
            try {
              return JSON.stringify(message.content);
            } catch {
              return String(message.content);
            }
          })();
    if (role === "user") {
      events.push({ event_type: "semantic_user_input", text: content, input_source: "system" });
      continue;
    }
    if (role === "assistant") {
      const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
      if (reasoning) {
        events.push({ event_type: "semantic_think_start" });
        events.push({ event_type: "semantic_think_delta", text: reasoning });
        events.push({ event_type: "semantic_think_end" });
      }
      events.push({ event_type: "semantic_content_start" });
      if (content) events.push({ event_type: "semantic_content_delta", text: content });
      events.push({ event_type: "semantic_content_end" });
      const rawToolCalls = Array.isArray(message?.tool_calls)
        ? message.tool_calls
        : Array.isArray(message?.toolCalls)
          ? message.toolCalls
          : [];
      for (const toolCall of rawToolCalls) {
        const fn = toolCall?.function && typeof toolCall.function === "object" ? toolCall.function : null;
        const argumentsText = typeof fn?.arguments === "string"
          ? fn.arguments
          : JSON.stringify(toolCall?.input ?? toolCall?.arguments ?? {});
        events.push({
          event_type: "semantic_tool_call_planned",
          tool_call: {
            tool_call_id: String(toolCall?.id ?? ""),
            tool_name: String(fn?.name ?? toolCall?.name ?? ""),
            arguments_text: argumentsText,
            protocol: "openai",
            call_kind: "json_function",
            raw_payload_text: "",
          },
        });
      }
      if (rawToolCalls.length === 0) {
        // No tool round follows: flush immediately; with tool calls pending
        // the tool_call_result injections flush the committed assistant.
        events.push({ event_type: "semantic_turn_end", reason: "seed_assistant_message" });
      }
      continue;
    }
    if (role === "tool") {
      events.push({
        event_type: "semantic_tool_call_result",
        tool_call: {
          tool_call_id: String(message?.tool_call_id ?? message?.toolCallId ?? ""),
          tool_name: String(message?.name ?? ""),
          arguments_text: "",
          protocol: "openai",
          call_kind: "json_function",
          raw_payload_text: "",
        },
        output_text: content,
        is_error: false,
      });
    }
  }
  if (events.length > 0) {
    // The whole seed is already known: flush any assistant still pending
    // behind an unanswered tool round (idempotent when nothing is pending).
    events.push({ event_type: "semantic_turn_end", reason: "seed_flush" });
  }
  injectSemanticEventsIntoConversationDomain({ vm: params.vm, actor: params.actor, events });
}

/**
 * Loop-entry guard (track refactor-ai-semantic-conversation-spine, T4.3):
 * when an executor loop is entered with a pre-seeded message array while the
 * actor has NO conversation-domain history yet (fiber seed messages handed to
 * aiAgentLoopStreaming / the cooperative step directly), route the seed
 * through the semantic injection chain first. Recovered sessions hydrate the
 * domains before the loop and are skipped; delegate spawns already seeded at
 * creation are skipped for the same reason.
 */
function ensureConversationDomainSeededFromLoopMessages(
  vm: AiAgentVm,
  actor: AiAgentActor,
  messages: readonly any[],
): void {
  if (!Array.isArray(messages) || messages.length === 0) return;
  if (!messages.some((message) => String(message?.role ?? "") !== "system")) return;
  ensureVmConversationDomainRuntime(vm);
  const rawState = getConversationActorRawStateFromVm({ vm, actorKey: actor.key });
  if (rawState?.activeHistoryGeneration?.messages?.length) return;
  const injectionState = getConversationSemanticInjectionMap(vm)[actor.key];
  if (injectionState && injectionState.lastEmittedAt > 0) return;
  seedConversationDomainFromActorSeedMessages({ vm, actor, seedMessages: messages });
}

/**
 * Attach the MessageHistoryGraph as the single commit writer for this vm.
 *
 * P8 single-writer pipeline (decisions.md decision 8): the graph is attached
 * once per vm (idempotently) at conversation-runtime initialization and lives
 * for the vm's lifetime. Commit writes to the History domain are
 * actor-type-agnostic (every actor's events reach the domain); persistence
 * side effects (appendMessage, transcript evidence) remain gated by
 * `isHistoryTrackedActor` so delegate/detached actors do not write the
 * message-history file.
 *
 * Returns a detach function that — by design — is a no-op for the persistent
 * attachment; per-loop call sites kept the function shape for compatibility
 * during the migration but should call {@link ensureVmMessageHistoryGraphAttached}
 * and ignore the return value once P8.3 lands.
 */
function attachMessageHistory(vm: AiAgentVm): () => void {
  const eventBus = vm.eventBus;
  if (!eventBus) {
    // P8: vm.eventBus is required for the single-writer pipeline. Returning a
    // no-op preserves the legacy short-circuit for environments that never
    // exercise the conversation path (pure platform unit tests), but any real
    // conversation runtime will fail loudly downstream when graph commit is
    // expected and absent.
    return () => {};
  }
  const sessionDir = getRuntimeControlSessionDir(vm);
  const sessionMetadata = vm.outerCtx?.metadata as Record<string, unknown> | undefined;
  const sessionId = typeof sessionMetadata?.sessionId === "string" ? sessionMetadata.sessionId : undefined;
  const persistenceDiagnostics = createSessionDiagnosticsXnlLog({
    sessionDir: isRuntimeStorageLogsEnabled(vm) ? sessionDir : undefined,
  });

  const msgHistoryGraph = new MessageHistoryGraph();
  const historySub = msgHistoryGraph.onHistoryEvent((event) => {
    const actor = vm.actors[event.agentKey];
    // History persistence side effects are gated by actor type (P8 keeps the
    // legacy persistence gate decoupled from the commit-writes-to-domain path
    // which is unconditional below).
    if (!actor || !isHistoryTrackedActor(actor)) return;
    recordConversationTranscriptEvidenceInRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      transcriptRecord: {
        stream: event.stream,
        payload: event.payload,
        startAt: event.startAt,
        endAt: event.endAt,
      },
    });
  });
  const committedSub = msgHistoryGraph.onCommittedMessage((event) => {
    const actor = vm.actors[event.agentKey];
    if (!actor) return;
    // Commit-to-domain is unconditional: every actor's committed messages
    // reach the three domains. This is the single writer path P8 enforces.
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: event.message,
      occurredAt:
        typeof event.message.endAt === "number"
          ? new Date(event.message.endAt).toISOString()
          : typeof event.message.startAt === "number"
            ? new Date(event.message.startAt).toISOString()
            : new Date().toISOString(),
    });
    const actorRawState = getConversationActorRawStateFromVm({
      vm,
      actorKey: actor.key,
      sessionId,
    });
    persistenceDiagnostics.appendRuntimePersistenceEvent({
      eventType: "runtime_conversation_history_buffered",
      sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      status: "buffered",
      stream: event.stream,
      role: typeof (event.message as any)?.role === "string" ? (event.message as any).role : undefined,
      historyGenerationCount: actorRawState?.visibleHistoryGenerations.length ?? 0,
      messageCount: actorRawState?.visibleHistoryGenerations.reduce(
        (total, generation) => total + generation.messages.length,
        0,
      ) ?? 0,
    });
  });
  // Observability only (track warn-on-history-commit-anomalies): the single
  // writer surfaces structured, non-fatal anomalies at its invariant
  // boundaries (e.g. an orphaned tool result whose tool_call_id had no paired
  // assistant tool-call — the codex-adapter bug's signature). Record them
  // loudly so the same class of silent drop is a grep, not a multi-session
  // hunt. This does NOT change the commit flow, add a writer, or throw.
  const anomalySub = msgHistoryGraph.onAnomaly((event) => {
    console.warn(
      `[history-anomaly] reason=${event.reason} toolCallId=${event.toolCallId ?? "-"} ` +
        `agentKey=${event.agentKey} agentActorId=${event.agentActorId}`,
    );
  });
  const busSub = eventBus.addConsumer((event) => {
    msgHistoryGraph.consumeSemanticEvent(event);
  });

  // P8 single-writer pipeline: the graph is the ONLY commit writer for this
  // vm. There is no attachment counter — the per-vm resident attachment
  // owned by `ensureVmMessageHistoryGraphAttached` is the only attachment,
  // and the returned detach is invoked only at vm teardown.
  return () => {
    busSub.unsubscribe();
    historySub.unsubscribe();
    committedSub.unsubscribe();
    anomalySub.unsubscribe();
    msgHistoryGraph.dispose();
    void persistenceDiagnostics.flush().catch(() => {});
  };
}

/**
 * P8 single-writer pipeline (decisions.md decision 8): idempotently attach
 * the MessageHistoryGraph for the vm's lifetime. The first call performs the
 * attachment and caches the detach function in the runtime context;
 * subsequent calls are no-ops. The legacy per-loop attach call sites now
 * funnel through this — `isHistoryTrackedActor` no longer gates whether the
 * graph is attached, only which actor types trigger history persistence side
 * effects (see {@link attachMessageHistory} for that gate).
 */
function ensureVmMessageHistoryGraphAttached(vm: AiAgentVm): void {
  const runtimeContext = ensureVmRuntimeContext(vm) as unknown as Record<string, unknown>;
  if (runtimeContext.persistentMessageHistoryGraphDetach) return;
  const detach = attachMessageHistory(vm);
  runtimeContext.persistentMessageHistoryGraphDetach = detach;
}

function extractCompactionSummary(compressedMessages: any[]): string | null {
  const summary = String(compressedMessages[0]?.content ?? "").trim();
  return summary || null;
}

function extractCompactionAck(compressedMessages: any[]): string | null {
  const ack = String(compressedMessages[1]?.content ?? "").trim();
  return ack || null;
}

function cloneConversationProjectionState(params: {
  historyIndex: ConversationHistoryIndexSnapshot;
  promptIndex: ConversationPromptIndexSnapshot;
  sessionIndex: ConversationSessionIndexSnapshot;
}): ConversationProjectionState {
  return {
    historyIndex: JSON.parse(JSON.stringify(params.historyIndex)),
    promptIndex: JSON.parse(JSON.stringify(params.promptIndex)),
    sessionIndex: JSON.parse(JSON.stringify(params.sessionIndex)),
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

function projectConversationCompactionState(params: {
  baseState: ConversationProjectionState;
  sessionId: string;
  actorKey: string;
  actorId: string;
  occurredAt: string;
  previousHistoryGenerationId?: string | null;
  historyGenerationId: string;
  promptGenerationId: string;
}): ConversationProjectionState {
  const projected = cloneConversationProjectionState(params.baseState);
  const events: ConversationDomainEvent[] = [
    {
      type: "actor_history_generation_created",
      sessionId: params.sessionId,
      actorKey: params.actorKey,
      generationId: params.historyGenerationId,
      occurredAt: params.occurredAt,
    },
    ...(params.previousHistoryGenerationId
      ? [{
          type: "actor_history_generation_sealed" as const,
          sessionId: params.sessionId,
          actorKey: params.actorKey,
          generationId: params.previousHistoryGenerationId,
          occurredAt: params.occurredAt,
        }]
      : []),
    {
      type: "actor_history_head_moved",
      sessionId: params.sessionId,
      actorKey: params.actorKey,
      activeGenerationId: params.historyGenerationId,
      occurredAt: params.occurredAt,
    },
    {
      type: "actor_prompt_generation_created",
      sessionId: params.sessionId,
      actorKey: params.actorKey,
      promptGenerationId: params.promptGenerationId,
      occurredAt: params.occurredAt,
    },
    {
      type: "actor_prompt_head_moved",
      sessionId: params.sessionId,
      actorKey: params.actorKey,
      activePromptGenerationId: params.promptGenerationId,
      occurredAt: params.occurredAt,
    },
    {
      type: "local_conversation_session_head_selected",
      sessionId: params.sessionId,
      activeActorKey: params.actorKey,
      occurredAt: params.occurredAt,
    },
  ];

  for (const event of events) {
    reduceConversationDomainEvent(projected, event);
  }

  const historyHead = projected.historyIndex.heads[params.actorKey];
  if (historyHead) {
    historyHead.actorId = params.actorId;
  }
  const promptHead = projected.promptIndex.heads[params.actorKey];
  if (promptHead) {
    promptHead.actorId = params.actorId;
  }
  const actorBinding = projected.sessionIndex.session.actorBindings[params.actorKey];
  if (actorBinding) {
    actorBinding.actorId = params.actorId;
  }
  const historyManifest = projected.historyIndex.generations[params.historyGenerationId];
  if (historyManifest) {
    historyManifest.actorId = params.actorId;
  }
  const promptManifest = projected.promptIndex.generations[params.promptGenerationId];
  if (promptManifest) {
    promptManifest.actorId = params.actorId;
  }

  projected.historyIndex.lineages[params.historyGenerationId] = {
    ...projected.historyIndex.lineages[params.historyGenerationId],
    version: projected.historyIndex.version,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    generationId: params.historyGenerationId,
    parentGenerationId: params.previousHistoryGenerationId ?? null,
    rolledBackFromGenerationId: null,
    predecessorGenerationIds: uniqueStrings([params.previousHistoryGenerationId]),
    successorGenerationIds:
      projected.historyIndex.lineages[params.historyGenerationId]?.successorGenerationIds ?? [],
    forkGenerationIds:
      projected.historyIndex.lineages[params.historyGenerationId]?.forkGenerationIds ?? [],
    branchLabel: projected.historyIndex.lineages[params.historyGenerationId]?.branchLabel ?? null,
    updatedAt: params.occurredAt,
  };

  if (params.previousHistoryGenerationId) {
    const previousLineage = projected.historyIndex.lineages[params.previousHistoryGenerationId];
    if (previousLineage) {
      previousLineage.actorId = previousLineage.actorId || params.actorId;
      previousLineage.successorGenerationIds = uniqueStrings([
        ...previousLineage.successorGenerationIds,
        params.historyGenerationId,
      ]);
      previousLineage.updatedAt = params.occurredAt;
    }
  }

  return projected;
}

/**
 * Per-vm in-memory fallback persistence for conversation compaction. Since
 * T4.3 the domain materialization is the ONLY provider assembly, so a
 * compaction MUST land in the conversation domains even when the host did not
 * configure a persistence repository (memory-only profiles, unit runtimes):
 * the same generation/projection machinery runs against a vm-scoped
 * in-memory repository and the domains are synchronized from it.
 */
function getVmFallbackConversationPersistenceFactory(vm: AiAgentVm): ConversationPersistenceRepositoryFactory {
  const runtimeContext = ensureVmRuntimeContext(vm) as unknown as Record<string, unknown>;
  if (!runtimeContext.conversationCompactionFallbackPersistence) {
    runtimeContext.conversationCompactionFallbackPersistence = createInMemoryConversationPersistenceAdapter();
  }
  return runtimeContext.conversationCompactionFallbackPersistence as ConversationPersistenceRepositoryFactory;
}

async function persistConversationCompaction(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  compressedMessages: any[];
  policyContext: CompactionPolicyContextData;
  policyDecision: CompactionPolicyDecisionData;
  promptPlan?: PromptPlanData | null;
}): Promise<void> {
  const metadata = (params.vm.outerCtx?.metadata ?? {}) as Record<string, unknown>;
  const sessionDir = typeof metadata.sessionDir === "string" && metadata.sessionDir
    ? String(metadata.sessionDir)
    : typeof metadata.sessionId === "string" && metadata.sessionId
      ? String(metadata.sessionId)
      : "__unsessioned__";

  const summary = extractCompactionSummary(params.compressedMessages);
  if (!summary) {
    return;
  }

  // P3 (refactor-persistent-session-backplane / `explicit-injection`): the
  // conversation-persistence repository factory is now an explicitly-injected
  // typed `outerCtx` field, NOT an untyped `metadata` stash. The compaction's
  // index/generation reads + the domain-event emission below feed live
  // conversation-domain state (compute), so they stay awaited here; the
  // fire-and-forget durability signal goes to the write-behind port.
  const factory = params.vm.outerCtx?.conversationPersistenceRepositoryFactory;
  getPersistenceWritePort(params.vm).persistCompaction({
    sessionDir,
    sessionId:
      typeof metadata.sessionId === "string" && metadata.sessionId
        ? String(metadata.sessionId)
        : sessionDir,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    reason: params.policyDecision.reason,
  });
  const repository =
    factory?.createRepository(sessionDir)
    ?? getVmFallbackConversationPersistenceFactory(params.vm).createRepository(sessionDir);

  const historyIndex = await repository.loadHistoryIndex();
  const promptIndex = await repository.loadPromptIndex();
  const sessionIndex = await repository.loadSessionIndex();
  const previousHistoryGenerationId =
    sessionIndex.session.actorBindings[params.actor.key]?.historyHeadGenerationId
    ?? historyIndex.heads[params.actor.key]?.activeGenerationId
    ?? null;
  const occurredAt = new Date().toISOString();
  const continuationBaselineBefore = getActorContinuationBaseline(params.actor);
  const continuationBaselineAfter = resetActorContinuationBaseline({
    actor: params.actor,
    reason: `compaction:auto:${params.policyDecision.reason}`,
    occurredAt,
  });

  const { historyGenerationId, promptGenerationId } = await applyConversationCompaction({
    sessionDir,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    compressedMessages: params.compressedMessages,
    summary,
    acknowledgedSummary: extractCompactionAck(params.compressedMessages),
    occurredAt,
    metadata: {
      workContext: getActorWorkContext(params.actor),
      policyContext: params.policyContext,
      policyDecision: params.policyDecision,
      continuationBaselineBefore,
      continuationBaselineAfter,
      promptPlan: params.promptPlan ?? undefined,
    },
    repository,
  });

  const projected = projectConversationCompactionState({
    baseState: { historyIndex, promptIndex, sessionIndex },
    sessionId: sessionIndex.session.sessionId,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    occurredAt,
    previousHistoryGenerationId,
    historyGenerationId,
    promptGenerationId,
  });
  await repository.writeHistoryIndex(projected.historyIndex);
  await repository.writePromptIndex(projected.promptIndex);
  await repository.writeSessionIndex(projected.sessionIndex);

  const runtime = ensureVmConversationDomainRuntime(params.vm);
  // Domain events are keyed by the vm-resolved session id (metadata.sessionId
  // first, mirroring resolveSessionIdFromVm) so the in-memory domain state the
  // provider materialization reads is updated even when the persistence
  // sessionDir basename differs from the session id.
  const sessionId = typeof metadata.sessionId === "string" && metadata.sessionId
    ? String(metadata.sessionId)
    : sessionIndex.session.sessionId;
  const historyGeneration = await repository.loadHistoryGeneration(historyGenerationId);
  const promptGeneration = await repository.loadPromptGeneration(promptGenerationId);
  const nextHistoryHead = projected.historyIndex.heads[params.actor.key];
  const nextPromptHead = projected.promptIndex.heads[params.actor.key];
  const nextBinding = projected.sessionIndex.session.actorBindings[params.actor.key];
  const nextSelection = projected.sessionIndex.session.activeSelection;
  if (previousHistoryGenerationId) {
    const previousHistoryGeneration = await repository.loadHistoryGeneration(previousHistoryGenerationId);
    emitConversationDomainEvent(runtime, {
      type: "actor_history_generation_sealed",
      sessionId,
      actorKey: params.actor.key,
      generationId: previousHistoryGenerationId,
      generation:
        previousHistoryGeneration
          ? {
              ...previousHistoryGeneration,
              sealed: true,
              updatedAt: occurredAt,
            }
          : undefined,
      occurredAt,
    });
  }
  emitConversationDomainEvent(runtime, {
    type: "actor_history_generation_created",
    sessionId,
    actorKey: params.actor.key,
    generationId: historyGenerationId,
    generation: historyGeneration ?? undefined,
    occurredAt,
  });
  emitConversationDomainEvent(runtime, {
    type: "actor_history_head_moved",
    sessionId,
    actorKey: params.actor.key,
    activeGenerationId: historyGenerationId,
    head: nextHistoryHead,
    occurredAt,
  });
  emitConversationDomainEvent(runtime, {
    type: "actor_history_compaction_applied",
    sessionId,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    sourceGenerationIds: previousHistoryGenerationId ? [previousHistoryGenerationId] : [],
    targetGenerationId: historyGenerationId,
    summaryText: summary,
    artifactId: `${promptGenerationId}::artifact`,
    generation: historyGeneration ?? undefined,
    head: nextHistoryHead,
    occurredAt,
  });
  emitConversationDomainEvent(runtime, {
    type: "actor_prompt_generation_created",
    sessionId,
    actorKey: params.actor.key,
    promptGenerationId,
    generation: promptGeneration ?? undefined,
    occurredAt,
  });
  emitConversationDomainEvent(runtime, {
    type: "actor_prompt_basis_selected",
    sessionId,
    actorKey: params.actor.key,
    promptGenerationId,
    basisHistoryGenerationIds: uniqueStrings([previousHistoryGenerationId, historyGenerationId]),
    occurredAt,
  });
  emitConversationDomainEvent(runtime, {
    type: "actor_prompt_transform_applied",
    sessionId,
    actorKey: params.actor.key,
    promptGenerationId,
    transformId: `${promptGenerationId}::summary`,
    transformKind: "history_compaction_summary",
    payload: {
      summary,
      acknowledgedSummary: extractCompactionAck(params.compressedMessages),
      sourceHistoryGenerationId: previousHistoryGenerationId,
      targetHistoryGenerationId: historyGenerationId,
      workContext: getActorWorkContext(params.actor),
      policyContext: params.policyContext,
      policyDecision: params.policyDecision,
      continuationBaselineAfter,
    },
    transform:
      promptGeneration?.transforms.find((transform) => transform.transformId === `${promptGenerationId}::summary`)
      ?? undefined,
    occurredAt,
  });
  emitConversationDomainEvent(runtime, {
    type: "actor_prompt_head_moved",
    sessionId,
    actorKey: params.actor.key,
    activePromptGenerationId: promptGenerationId,
    head: nextPromptHead,
    occurredAt,
  });
  emitConversationDomainEvent(runtime, {
    type: "local_conversation_session_actor_bound",
    sessionId,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    historyHeadGenerationId: historyGenerationId,
    promptHeadGenerationId: promptGenerationId,
    binding: nextBinding,
    occurredAt,
  });
  emitConversationDomainEvent(runtime, {
    type: "local_conversation_session_active_selection_updated",
    sessionId,
    activeActorKey: params.actor.key,
    historyHeadGenerationId: historyGenerationId,
    promptHeadGenerationId: promptGenerationId,
    selection: nextSelection ?? undefined,
    occurredAt,
  });
  await synchronizeConversationDomainActorFromPersistence({
    runtime,
    sessionDir,
    actorKey: params.actor.key,
    repository,
  });
}

export type AiAgentLoopStage =
  | "dispatch:drain"
  | "dispatch:compress"
  | "dispatch:llm"
  | "pipeline:llm"
  | "pipeline:tool"
  | "dispatch:tool-output";

export type AiAgentLoopHooks = {
  beforeStage?: (event: {
    stage: AiAgentLoopStage;
    turn: number;
    vm: AiAgentVm;
    actor: AiAgentActor;
    messages: any[];
  }) => void | Promise<void>;
  afterStage?: (event: {
    stage: AiAgentLoopStage;
    turn: number;
    vm: AiAgentVm;
    actor: AiAgentActor;
    messages: any[];
  }) => void | Promise<void>;
};

let loopHooks: AiAgentLoopHooks = {};

export function __setLoopHooksForTest(hooks: AiAgentLoopHooks | null): void {
  loopHooks = hooks ?? {};
}

// T3.2: the streaming entry no longer uses createPipelineHandler /
// createDispatchHandler indirection — the ExecutorStage / LlmTurnPipeline /
// ToolCallPipeline / ToolOutputDispatch schema+state shapes have been removed.
// `ToolCallPipelineResult` is retained as the shared tool-effect result shape
// consumed by both the streaming driver and the cooperative step.
type ToolCallPipelineResult = {
  funcName: string;
  toolCallId: string;
  effectId: string;
  effectKind: AiRuntimeEffectKind;
  args: any;
  output: unknown;
  outputText: string;
  gateDecision: ToolExecutionGateDecision;
  /**
   * Gate-decision tag for the tool that produced this result.
   *  - "allow" : the tool's `run` actually executed
   *  - "deny"  : execution was permanently refused (tool_disabled / network_disabled);
   *              stopAfterTools still applies — there will be no later attempt
   *  - "defer" : execution was paused awaiting an external coordination
   *              (e.g. plan_approval); stopAfterTools MUST NOT apply, the
   *              real execution will happen on a later turn once the
   *              coordination resolves
   */
  gateOutcome: "allow" | "deny" | "defer";
  resultEvidence: AiRuntimeEffectLifecycleEvent;
};

function shouldSuppressToolResultMessage(funcName: string, outputText: string): boolean {
  if (funcName === "Questionnaire") {
    return true;
  }
  if (isLocalPermissionQuestionnairePendingOutput(outputText)) {
    return true;
  }
  return outputText === "WAIT_FOR_CHILD_DONE" || outputText.startsWith("STOP_AGENT");
}

async function runHookedStage(
  stage: AiAgentLoopStage,
  turn: number,
  vm: AiAgentVm,
  actor: AiAgentActor,
  messages: any[],
  run: () => Promise<void>,
): Promise<void> {
  const event = { stage, turn, vm, actor, messages };
  await loopHooks.beforeStage?.(event);
  try {
    await run();
  } finally {
    await loopHooks.afterStage?.(event);
  }
}

async function maybeCompressMessages(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  tools: any[];
  llmAdapter: LlmAdapter;
  model: string;
  processStreamFn: ProcessStreamFn;
  promptPlan?: PromptPlanData | null;
}): Promise<void> {
  const { vm, actor, llmAdapter, model } = params;
  applyCheapCompactionForActor({ vm, actor });
  resolveTurnWorkContextForActor({
    actor,
    messages: [...actor.messages],
    sessionId: typeof (vm.outerCtx?.metadata as any)?.sessionId === "string"
      ? String((vm.outerCtx?.metadata as any).sessionId)
      : undefined,
    trigger: "compress_gate",
  });
  if (!shouldCompressActorHistory(actor)) {
    return;
  }
  const inputLimit = actor.modelConfig.inputLimit ?? 0;
  const effectiveLimit = resolveCompactionInputLimit(actor);
  if (effectiveLimit <= 0) {
    return;
  }

  const promptBuild = buildProviderPromptForActorTurn({
    vm,
    actor,
    tools: params.tools,
    llmAdapter,
    model,
    recordPromptPlan: false,
  });
  const ratio = compressionDeps.estimateUsageRatio(promptBuild.providerMessages, effectiveLimit);
  if (ratio < 0.85) {
    return;
  }
  const tokensBefore = estimateTokens(promptBuild.providerMessages);
  const policyContext = buildCompactionPolicyContextForActor({
    actor,
    messages: promptBuild.providerMessages,
    trigger: "auto_threshold",
    mode: "auto",
    tokensBefore,
  });
  const policyDecision = decideCompactionPolicy(policyContext);
  if (policyDecision.decision === "skip") {
    return;
  }

  let compressedMessages: any[] | null = null;
  try {
    // P7: the summarization input is the domain visible projection (prelude +
    // active tail); no message array is read or rewritten — the domain
    // compaction command below is the only truth landing.
    compressedMessages = await compressionDeps.compressHistory({
      messages: [...getConversationVisibleMessagesFromVm({ vm, actorKey: actor.key })],
      llmAdapter,
      model,
      inputLimit,
      tokenBudget: Math.floor(effectiveLimit * 0.9),
      logger: {
        warn: (message: string, error?: unknown) =>
          vm.effects.log?.("warn", message, error === undefined ? undefined : { error }),
      },
    });
  } catch (error) {
    vm.effects.log?.("warn", "history compression failed", { error });
    compressedMessages = null;
  }

  if (!compressedMessages) {
    return;
  }

  try {
    await persistConversationCompaction({
      vm,
      actor,
      compressedMessages,
      policyContext,
      policyDecision,
      promptPlan: params.promptPlan ?? null,
    });
  } catch (error) {
    vm.effects.log?.("warn", "conversation compaction persistence failed", { error });
  }
}

async function runReactiveCompaction(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  tools: any[];
  llmAdapter: LlmAdapter;
  model: string;
  processStreamFn: ProcessStreamFn;
  promptPlan?: PromptPlanData | null;
  reason: "preflight_over_limit" | "provider_prompt_too_long";
}): Promise<boolean> {
  const { vm, actor, llmAdapter, model } = params;
  if (!shouldCompressActorHistory(actor)) {
    return false;
  }
  const inputLimit = actor.modelConfig.inputLimit ?? 0;
  const effectiveLimit = resolveCompactionInputLimit(actor);
  if (inputLimit <= 0 || effectiveLimit <= 0) {
    return false;
  }

  applyCheapCompactionForActor({ vm, actor });
  const promptBuild = buildProviderPromptForActorTurn({
    vm,
    actor,
    tools: params.tools,
    llmAdapter,
    model,
    recordPromptPlan: false,
  });
  const tokensBefore = estimateTokens(promptBuild.providerMessages);
  const policyContext = buildCompactionPolicyContextForActor({
    actor,
    messages: promptBuild.providerMessages,
    trigger: `reactive:${params.reason}`,
    mode: "auto",
    tokensBefore,
  });
  const policyDecision = decideCompactionPolicy(policyContext);
  if (policyDecision.decision === "skip") {
    return false;
  }

  let compressedMessages: any[] | null = null;
  try {
    // P7: summarization input is the domain visible projection; no array
    // read/rewrite — the domain compaction command is the only truth landing.
    compressedMessages = await compressionDeps.compressHistory({
      messages: [...getConversationVisibleMessagesFromVm({ vm, actorKey: actor.key })],
      llmAdapter,
      model,
      inputLimit,
      tokenBudget: Math.floor(effectiveLimit * 0.65),
      recentKeep: 5,
      logger: {
        warn: (message: string, error?: unknown) =>
          vm.effects.log?.("warn", message, error === undefined ? undefined : { error }),
      },
    });
  } catch (error) {
    vm.effects.log?.("warn", "reactive history compression failed", { error });
    compressedMessages = null;
  }

  if (!compressedMessages) {
    return false;
  }

  // Reactive path additionally cheap-compacts oversized tool results in the
  // summary tail before it becomes the compact generation (legacy behavior:
  // the rewritten array was cheap-compacted before persisting).
  const cheapResult = applyCheapCompactionPipeline(
    compressedMessages,
    buildCheapCompactionPipelineOptions(vm, actor),
  );
  const persistedMessages = cheapResult.changed ? cheapResult.messages : compressedMessages;
  try {
    await persistConversationCompaction({
      vm,
      actor,
      compressedMessages: persistedMessages,
      policyContext,
      policyDecision,
      promptPlan: params.promptPlan ?? promptBuild.promptPlan,
    });
  } catch (error) {
    vm.effects.log?.("warn", "conversation reactive compaction persistence failed", { error });
  }
  return true;
}

export async function forceCompressActorHistory(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  llmAdapter?: LlmAdapter;
  model?: string;
  processStreamFn?: ProcessStreamFn;
  tools?: any[];
  trigger?: string;
}): Promise<{ ok: true; tokensBefore: number; messagesAfter: number; compacted: boolean } | { ok: false; error: string }> {
  try {
    const deps = resolveLoopDeps(params.vm, params.actor);
    const llmAdapter = params.llmAdapter ?? deps.llmAdapter;
    const model = params.model ?? deps.model;
    applyCheapCompactionForActor({ vm: params.vm, actor: params.actor });
    resolveTurnWorkContextForActor({
      actor: params.actor,
      messages: [...params.actor.messages],
      sessionId: typeof (params.vm.outerCtx?.metadata as any)?.sessionId === "string"
        ? String((params.vm.outerCtx?.metadata as any).sessionId)
        : undefined,
      trigger: params.trigger ?? "manual_compact",
    });
    const tools = resolveProviderToolsetForActor(params.actor, params.tools ?? deps.buildToolsetFn());
    const inputLimit = params.actor.modelConfig.inputLimit ?? 0;
    const effectiveLimit = resolveCompactionInputLimit(params.actor);
    if (!shouldCompressActorHistory(params.actor)) {
      return { ok: false, error: "actor history compression is not enabled for this actor" };
    }
    if (inputLimit <= 0 || effectiveLimit <= 0) {
      return { ok: false, error: "model input limit is not configured" };
    }
    const promptBuild = buildProviderPromptForActorTurn({
      vm: params.vm,
      actor: params.actor,
      tools,
      llmAdapter,
      model,
      recordPromptPlan: false,
    });
    const tokensBefore = estimateTokens(promptBuild.providerMessages);
    const ratio = compressionDeps.estimateUsageRatio(promptBuild.providerMessages, effectiveLimit);
    if (ratio < 0.85) {
      return { ok: true, tokensBefore, messagesAfter: params.actor.messages.length, compacted: false };
    }
    const policyContext = buildCompactionPolicyContextForActor({
      actor: params.actor,
      messages: promptBuild.providerMessages,
      trigger: params.trigger ?? "manual_compact",
      mode: "manual",
      tokensBefore,
    });
    const policyDecision = decideCompactionPolicy(policyContext);
    if (policyDecision.decision === "skip") {
      return { ok: true, tokensBefore, messagesAfter: params.actor.messages.length, compacted: false };
    }
    // P7: summarization input is the domain visible projection; no array
    // read/rewrite — the domain compaction command is the only truth landing.
    const compressedMessages = await compressionDeps.compressHistory({
      messages: [...getConversationVisibleMessagesFromVm({ vm: params.vm, actorKey: params.actor.key })],
      llmAdapter,
      model,
      inputLimit,
      tokenBudget: Math.floor(effectiveLimit * 0.9),
      logger: {
        warn: (message: string, error?: unknown) =>
          params.vm.effects.log?.("warn", message, error === undefined ? undefined : { error }),
      },
    });
    if (!compressedMessages) {
      return { ok: false, error: "history compression did not produce a smaller summary" };
    }
    await persistConversationCompaction({
      vm: params.vm,
      actor: params.actor,
      compressedMessages,
      policyContext,
      policyDecision,
      promptPlan: promptBuild.promptPlan,
    });
    return { ok: true, tokensBefore, messagesAfter: compressedMessages.length, compacted: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function consumeControlSignals(actor: AiAgentActor): { cancelRequested: boolean; shutdownRequested: boolean } {
  applyActorModelConfigControlSignals(actor)
  const entries = actor.drainMailbox("control") as any[]
  let cancelRequested = false
  let shutdownRequested = false
  for (const entry of entries) {
    if (entry?.kind === "cancel_requested") {
      cancelRequested = true
      continue
    }
    if (entry?.kind === "shutdown_requested") {
      shutdownRequested = true
      continue
    }
    actor.send("control", entry as any)
  }
  if ((cancelRequested || shutdownRequested) && actor.llmAbortController) {
    actor.llmAbortController.abort()
    actor.llmAbortController = null
  }
  return { cancelRequested, shutdownRequested }
}

function abortInflightCooperativeWork(state: AiAgentCooperativeExecState | undefined): void {
  const abortController = (state?.inflight as any)?.abortController;
  if (abortController && typeof abortController.abort === "function") {
    abortController.abort();
  }
}

function resetCooperativeStateAfterCancel(state: AiAgentCooperativeExecState): void {
  abortInflightCooperativeWork(state);
  state.phase = "drain";
  state.tools = [];
  state.toolCalls = [];
  state.toolIndex = 0;
  state.pendingToolResults = [];
  state.pendingAiGenerated = [];
  state.turnState = { kind: "drain", turn: state.turn };
  state.inflight = undefined;
}

function wasInflightClearedByInterrupt(
  state: AiAgentCooperativeExecState,
  kind: "llm" | "tool" | "compress" | "questionnaire_parse",
  opId: string,
): boolean {
  return state.phase === "drain" || state.inflight?.kind !== kind || state.inflight?.opId !== opId;
}

function findQuestionnairePendingControl(
  actor: AiAgentActor,
  toolCallId: string,
): {
  toolCallId: string;
  questionnaireId: string;
  suspendPolicy: "pause_all" | "continue_others";
} | null {
  const entries = actor.peekMailbox("control") as any[];
  const found = entries.find(
    (e: any) =>
      e?.kind === "questionnaire_pending" &&
      typeof e?.toolCallId === "string" &&
      e.toolCallId === toolCallId &&
      typeof e?.questionnaireId === "string" &&
      e.questionnaireId,
  ) as any;
  if (!found) {
    return null;
  }
  return {
    toolCallId: String(found.toolCallId),
    questionnaireId: String(found.questionnaireId),
    suspendPolicy: found.suspendPolicy === "continue_others" ? "continue_others" : "pause_all",
  };
}

function classifyToolOutput(params: {
  actor: AiAgentActor;
  funcName: string;
  toolCallId: string;
  outputText: string;
}): "questionnaire_wait" | "child_wait" | "stop_agent" | "continue" {
  // Questionnaire wait is signaled by pending control state, not by tool output strings.
  if (findQuestionnairePendingControl(params.actor, params.toolCallId)) {
    return "questionnaire_wait";
  }
  if (params.outputText === "WAIT_FOR_CHILD_DONE") {
    return "child_wait";
  }
  if (params.outputText.startsWith("STOP_AGENT")) {
    return "stop_agent";
  }
  return "continue";
}

function normalizeQuestionnaireRequestArgs(args: unknown, toolCallId: string): any {
  const raw = (args && typeof args === "object" ? (args as any) : {}) as any;
  const questionnaireId = typeof raw.questionnaireId === "string" && raw.questionnaireId ? raw.questionnaireId : `q-${toolCallId}`;

  const kindRaw = typeof raw.kind === "string" ? raw.kind : "freeform";
  const kind = kindRaw === "clarification" || kindRaw === "approval" || kindRaw === "freeform" || kindRaw === "form" ? kindRaw : "freeform";

  const suspendRaw = typeof raw.suspendPolicy === "string" ? raw.suspendPolicy : "pause_all";
  const suspendPolicy = suspendRaw === "continue_others" ? "continue_others" : "pause_all";

  const title = typeof raw.title === "string" && raw.title ? raw.title : undefined;
  const intro = typeof raw.intro === "string" && raw.intro ? raw.intro : undefined;

  const questions = Array.isArray(raw.questions) ? raw.questions : [];
  const normalizedQuestions = questions
    .map((q: any, idx: number) => {
      const id = typeof q?.id === "string" && q.id ? q.id : `q${idx + 1}`;
      const prompt = typeof q?.prompt === "string" ? q.prompt : "";
      const type = typeof q?.type === "string" ? q.type : "text";
      const required = typeof q?.required === "boolean" ? q.required : undefined;
      const choices = Array.isArray(q?.choices) ? q.choices : undefined;
      const def = q?.default;
      const helpText = typeof q?.helpText === "string" ? q.helpText : undefined;
      return { id, prompt, type, required, choices, default: def, helpText };
    })
    .filter((q: any) => q.prompt);

  if (normalizedQuestions.length === 0) {
    const fallbackPrompt = intro || title || "User input required";
    normalizedQuestions.push({ id: "q1", prompt: fallbackPrompt, type: "text" });
  }

  return {
    questionnaireId,
    toolCallId,
    kind,
    title,
    intro,
    suspendPolicy,
    questions: normalizedQuestions,
  };
}

export async function aiAgentLoopStreaming({
  vm,
  actor,
  messages,
}: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  /** Seed input only (one-time domain hydration); NOT live working state. */
  messages: readonly any[];
}): Promise<AgentLoopResult> {
  ensureConversationDomainSeededFromLoopMessages(vm, actor, messages);
  const { llmAdapter, model, buildToolsetFn, processStreamFn, toolRegistry, extraBody } = resolveLoopDeps(vm, actor);
  let tools = resolveProviderToolsetForActor(actor, buildToolsetFn());
  const eventBus = vm.eventBus;
  const eventActor = toEventActorRef(actor);
  const stopAfterFirstTool = actor.ctrlOptions.stopAfterFirstTool || vm.options.stopAfterFirstTool === true;
  const stopAfterTools = actor.ctrlOptions.stopAfterTools.length
    ? actor.ctrlOptions.stopAfterTools
    : (vm.options.stopAfterTools ?? []);
  const exitAfterToolResult = actor.ctrlOptions.exitAfterToolResult || vm.options.exitAfterToolResult === true;
  const maxIterations =
    typeof vm.options.maxIterations === "number" && vm.options.maxIterations > 0
      ? vm.options.maxIterations
      : undefined;
  let turn = 0;
  let turnState: TurnState = { kind: "drain", turn: 0 };
  const applyStreamingTurnEvent = (event: TurnEvent) => {
    const result = turnReducer(turnState, event);
    turnState = result.state;
    return result;
  };

  // P8 single-writer pipeline: graph is attached once per vm and lives for
  // the vm's lifetime. The legacy `isHistoryTrackedActor` gate on attach has
  // been removed — delegate / detached actor commits also flow through the
  // graph; persistence side effects are gated inside the graph handler.
  ensureVmMessageHistoryGraphAttached(vm);
  const detachMessageHistory = () => {};

  // T3.2 unified phase machine: the streaming entry drives the same
  // `turnReducer` as the cooperative step. The blocking driver awaits each
  // turn effect inline through the shared leaf executors
  // (`prepareProviderPromptForTurn` / `streamProviderCompletion` /
  // `resolveToolCallOutput`); the only difference from cooperative is the
  // mailbox owner. The legacy createPipelineHandler / createDispatchHandler
  // indirection (llmTurnPipeline / toolCallPipeline / toolOutputDispatch /
  // stageDispatch) has been removed — these closures are the inlined effect
  // executors invoked by the reducer-driven loop below.

  // `await_provider_call` effect executor (blocking). Returns the assistant
  // message; throws on unrecoverable provider error after recording failed
  // lifecycle evidence.
  const runProviderCallEffect = async (): Promise<any> => {
    applyCheapCompactionForActor({ vm, actor });
    const sessionId = typeof (vm.outerCtx?.metadata as any)?.sessionId === "string"
      ? String((vm.outerCtx?.metadata as any).sessionId)
      : undefined;
    resolveTurnWorkContextForActor({
      actor,
      messages: [...actor.messages],
      sessionId,
      trigger: "turn_start",
    });
    const { promptPlan, providerMessages, promptGenerationId } = await prepareProviderPromptForTurn({
      vm,
      actor,
      tools,
      llmAdapter,
      model,
      processStreamFn,
      stage: "streaming llm turn",
    });
    const abortController = new AbortController();
    const effectId = `llm:${actor.key}:${turn}`;
    trackProviderCallStarted({ vm, actor, turnId: turn, providerCallId: effectId, model, tools, promptGenerationId });
    appendRuntimeControlLifecycleEvidenceFromVm(vm, {
      kind: "request",
      effectKind: "provider_completion",
      effectId,
      handlerKey: `llm:${llmAdapter.type}`,
      idempotencyKey: `${actor.key}:${turn}:provider_completion`,
      sourceCommandId: effectId,
      payload: {
        actorKey: actor.key,
        actorId: actor.id,
        model,
        turn,
      },
    });
    appendRuntimeControlLifecycleEvidenceFromVm(vm, {
      kind: "waiting",
      effectKind: "provider_completion",
      effectId,
      handlerKey: `llm:${llmAdapter.type}`,
      idempotencyKey: `${actor.key}:${turn}:provider_completion`,
      waitReason: "wait_llm_result",
    });
    actor.llmAbortController = abortController;
    try {
      const { msg } = await streamProviderCompletion({
        vm,
        actor,
        tools,
        llmAdapter,
        model,
        processStreamFn,
        extraBody,
        promptPlan,
        providerMessages,
        abortController,
        retryStage: "streaming llm turn reactive retry",
      });
      trackProviderCallCompleted(vm, effectId, msg);
      appendRuntimeControlLifecycleEvidenceFromVm(vm, {
        kind: "result",
        effectKind: "provider_completion",
        effectId,
        handlerKey: `llm:${llmAdapter.type}`,
        resultId: `${effectId}:result`,
        payload: msg,
      });
      return msg;
    } catch (error) {
      trackProviderCallFailed(vm, effectId, error, abortController.signal.aborted);
      appendRuntimeControlLifecycleEvidenceFromVm(vm, {
        kind: "failed",
        effectKind: "provider_completion",
        effectId,
        handlerKey: `llm:${llmAdapter.type}`,
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
      throw error;
    } finally {
      if (actor.llmAbortController === abortController) actor.llmAbortController = null;
    }
  };

  // `dispatch_tool_call` effect executor (blocking). Records request/waiting +
  // result/failed lifecycle evidence, emits the tool-call start/result on the
  // bus, and resolves the gate-honoring output via the shared leaf.
  const runToolCallEffect = async (tc: any): Promise<ToolCallPipelineResult> => {
    const funcName = tc.function?.name || "";
    let args: any = {};
    try {
      args = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      args = {};
    }
    const prettyArgs = JSON.stringify(args, null, 2);
    const toolCallId = tc.id || "";
    const effectId = `tool:${actor.key}:${turn}:${toolCallId || funcName}`;
    const effectKind = classifyRuntimeControlToolEffectKind(funcName);
    appendRuntimeControlLifecycleEvidenceFromVm(vm, {
      kind: "request",
      effectKind,
      effectId,
      handlerKey: funcName,
      idempotencyKey: `${actor.key}:${turn}:${toolCallId || funcName}:tool`,
      sourceCommandId: effectId,
      payload: { toolCallId }, // P4/D3: link-only — args/output live in ToolCallDomain
    });
    appendRuntimeControlLifecycleEvidenceFromVm(vm, {
      kind: "waiting",
      effectKind,
      effectId,
      handlerKey: funcName,
      idempotencyKey: `${actor.key}:${turn}:${toolCallId || funcName}:tool`,
      waitReason: "wait_tool_result",
    });

    if (eventBus) {
      eventBus.emitToolCallStart(eventActor, funcName, toolCallId, prettyArgs);
    }

    trackToolCallPlanned({ vm, actorKey: actor.key, turnId: turn, toolCallId, funcName, args });
    const gateDecision = evaluateToolExecutionGates(vm, actor, funcName);
    trackToolCallGate(vm, toolCallId, gateDecision.kind);
    const { resolvedOutput, outputText } = await resolveToolCallOutput({
      vm,
      actor,
      toolRegistry,
      funcName,
      args,
      toolCallId,
      gateDecision,
    });
    trackToolCallResult(vm, toolCallId, outputText, gateDecision.kind);
    const result: ToolCallPipelineResult = {
      funcName,
      toolCallId,
      effectId,
      effectKind,
      args,
      output: resolvedOutput,
      outputText,
      gateDecision,
      gateOutcome: gateDecision.kind,
      resultEvidence: outputText.startsWith("Error:")
        ? {
            kind: "failed",
            effectKind,
            effectId,
            handlerKey: funcName,
            error: outputText,
            retryable: false,
          }
        : {
            kind: "result",
            effectKind,
            effectId,
            handlerKey: funcName,
            resultId: `${effectId}:result`,
            payload: { toolCallId }, // P4/D3: link-only — output lives in ToolCallDomain
          },
    };

    const suppress = shouldSuppressToolResultMessage(String(funcName ?? ""), String(outputText ?? ""));
    // P8 single-writer pipeline: emit-only. The resident graph commits the
    // tool-result event from the bus. Suppressed results stay out of both the
    // bus and the domain.
    if (eventBus && !suppress) {
      const resultPayload = typeof resolvedOutput === "string" ? resolvedOutput : resolvedOutput === undefined ? "" : JSON.stringify(resolvedOutput);
      eventBus.emitToolCallResult(eventActor, funcName, toolCallId, resultPayload, outputText.startsWith("Error:"));
    }

    advanceActorWorkContextAfterTool({
      actor,
      toolName: String(funcName ?? ""),
      args,
    });

    return result;
  };

  // Tool-output routing (questionnaire_wait / child_wait / stop_agent /
  // continue). Appends the tool result evidence and returns the loop stop
  // reason, or null to continue the tool loop.
  const runToolOutputStage = async (result: ToolCallPipelineResult): Promise<AgentLoopResult["stopReason"] | null> => {
    const classification = classifyToolOutput({
      actor,
      funcName: result.funcName,
      toolCallId: result.toolCallId,
      outputText: result.outputText,
    });
    if (classification === "questionnaire_wait") {
      const pending = findQuestionnairePendingControl(actor, result.toolCallId);
      const pendingId = pending?.questionnaireId;
      const stored = pendingId ? (actor.pendingQuestionnaires as any)?.[pendingId] : undefined;
      const req = stored ?? normalizeQuestionnaireRequestArgs(result.args, result.toolCallId);

      // Backstop: if a custom Questionnaire tool didn't mark pending, do it here.
      if (!pendingId) {
        actor.pendingQuestionnaires[req.questionnaireId] = req;
        upsertPendingQuestionnaireRow({ vm, actor, request: req });
        actor.send("control", {
          kind: "questionnaire_pending",
          toolCallId: req.toolCallId,
          questionnaireId: req.questionnaireId,
          suspendPolicy: req.suspendPolicy,
        });
      }

      // If the tool already emitted QuestionnaireRequest, do not duplicate.
      if (!stored) {
        eventBus?.emitQuestionnaireRequest(eventActor, req);
      }
      appendRuntimeControlLifecycleEvidenceFromVm(vm, {
        kind: "waiting",
        effectKind: result.effectKind,
        effectId: result.effectId,
        handlerKey: result.funcName,
        idempotencyKey: `${actor.key}:${result.toolCallId || result.funcName}:questionnaire`,
        waitReason: mapQuestionnaireKindToWait(req.kind),
        payload: {
          toolCallId: req.toolCallId,
          questionnaireId: req.questionnaireId,
          suspendPolicy: req.suspendPolicy,
        },
      });
      eventBus?.emitAgentTurnEnd(eventActor, "questionnaire_wait");
      return "questionnaire_wait";
    }
    if (classification === "child_wait") {
      appendRuntimeControlLifecycleEvidenceFromVm(vm, result.resultEvidence);
      if (eventBus) {
        eventBus.emitAgentTurnEnd(eventActor, "child_wait");
      }
      return "child_wait";
    }
    if (classification === "stop_agent") {
      appendRuntimeControlLifecycleEvidenceFromVm(vm, result.resultEvidence);
      if (eventBus) {
        eventBus.emitAgentTurnEnd(eventActor, "stop_agent");
      }
      return "stop_agent";
    }
    appendRuntimeControlLifecycleEvidenceFromVm(vm, result.resultEvidence);
    return null;
  };

  const stopWith = (reason: AgentLoopResult["stopReason"]): AgentLoopResult => {
    if (isDebugEnabled()) {
      console.log(`[ai-loop] stop_reason=${reason}`);
    }
    if (reason !== "questionnaire_wait" && reason !== "child_wait" && reason !== "stop_agent" && eventBus) {
      eventBus.emitAgentTurnEnd(eventActor, reason);
    }
    return { messages: [...actor.messages], stopReason: reason };
  };

  try {
    while (true) {
      const startTurnResult = applyStreamingTurnEvent({ kind: "start_llm_requested", reason: turn === 0 ? "fresh" : "tool_continuation" });
      turn = startTurnResult.state.kind === "start_llm" ? startTurnResult.state.turn : turn + 1;

      // dispatch:drain — drain the streaming mailbox; a drained control signal
      // can terminate the turn before any provider call.
      let drainStopReason: AgentLoopResult["stopReason"] | null = null;
      await runHookedStage("dispatch:drain", turn, vm, actor, [...actor.messages], async () => {
        const drained = await drainActorMailboxes(vm, actor);
        if (drained.stopReason) {
          drainStopReason = drained.stopReason;
        }
      });

      if (drainStopReason) {
        return stopWith(drainStopReason);
      }

      resolveTurnWorkContextForActor({
        actor,
        messages: [...actor.messages],
        sessionId: typeof (vm.outerCtx?.metadata as any)?.sessionId === "string"
          ? String((vm.outerCtx?.metadata as any).sessionId)
          : undefined,
        trigger: "turn_start",
      });
      tools = resolveProviderToolsetForActor(actor, buildToolsetFn());

      // dispatch:compress
      await runHookedStage("dispatch:compress", turn, vm, actor, [...actor.messages], async () => {
        await maybeCompressMessages({ vm, actor, tools, llmAdapter, model, processStreamFn });
      });

      if (eventBus) {
        eventBus.emitAgentTurnStart(eventActor, turn);
      }
      beginGoalTurn(vm, [...actor.messages]);
      applyStreamingTurnEvent({ kind: "provider_call_started", opId: `llm:${actor.key}:${turn}`, providerCallId: `llm:${actor.key}:${turn}` });

      // dispatch:llm > pipeline:llm — the await_provider_call effect.
      let assistantMsg: any = null;
      try {
        await runHookedStage("dispatch:llm", turn, vm, actor, [...actor.messages], async () => {
          await runHookedStage("pipeline:llm", turn, vm, actor, [...actor.messages], async () => {
            assistantMsg = await runProviderCallEffect();
          });
        });
      } catch (error) {
        applyStreamingTurnEvent({
          kind: "provider_failed",
          opId: `llm:${actor.key}:${turn}`,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const toolCalls = assistantMsg?.tool_calls || assistantMsg?.toolCalls || [];
      applyStreamingTurnEvent({
        kind: "provider_completed",
        opId: `llm:${actor.key}:${turn}`,
        hasToolCalls: Boolean(toolCalls?.length),
      });
      if (!toolCalls || !toolCalls.length) {
        emitMemberResultToControl(vm, actor, [...actor.messages]);
        accountGoalProgress(vm, [...actor.messages]);
        return stopWith("no_tool_calls");
      }

      for (const tc of toolCalls) {
        const funcName = String(tc?.function?.name ?? "");
        const toolCallId = String(tc?.id ?? "");
        let args: unknown = {};
        try {
          args = JSON.parse(tc?.function?.arguments || "{}");
        } catch {
          args = {};
        }
        applyStreamingTurnEvent({ kind: "tool_call_selected", toolCallId, funcName, args });

        // pipeline:tool — the dispatch_tool_call effect.
        let toolEffect: ToolCallPipelineResult | null = null;
        await runHookedStage("pipeline:tool", turn, vm, actor, [...actor.messages], async () => {
          toolEffect = await runToolCallEffect(tc);
        });

        const toolResult = toolEffect as ToolCallPipelineResult | null;
        if (!toolResult) {
          continue;
        }
        applyStreamingTurnEvent({
          kind: "tool_gate_decided",
          opId: toolResult.effectId,
          gateDecision: toolResult.gateDecision,
        });
        applyStreamingTurnEvent({ kind: "tool_completed", opId: toolResult.effectId });

        // dispatch:tool-output
        let outputStopReason: AgentLoopResult["stopReason"] | null = null;
        await runHookedStage("dispatch:tool-output", turn, vm, actor, [...actor.messages], async () => {
          outputStopReason = await runToolOutputStage(toolResult);
        });

        if (outputStopReason) {
          accountGoalProgress(vm, [...actor.messages]);
          return stopWith(outputStopReason);
        }

        if (stopAfterFirstTool) {
          accountGoalProgress(vm, [...actor.messages]);
          return stopWith("stop_after_tool");
        }

        if (
          stopAfterTools.length
          && stopAfterTools.includes(toolResult.funcName)
          // A deferred tool didn't actually execute (e.g. paused on
          // plan_approval) — stopAfterTools applies to "the tool ran once",
          // so defer must not satisfy it. allow and deny both did reach a
          // terminal outcome for this turn.
          && toolResult.gateOutcome !== "defer"
        ) {
          accountGoalProgress(vm, [...actor.messages]);
          return stopWith("stop_after_tool");
        }
        accountGoalProgress(vm, [...actor.messages]);
      }

      if (exitAfterToolResult) {
        accountGoalProgress(vm, [...actor.messages]);
        return stopWith("exit_after_tool_result");
      }

      if (maxIterations !== undefined && turn >= maxIterations) {
        accountGoalProgress(vm, [...actor.messages]);
        return stopWith("max_iterations");
      }

      if (isDebugEnabled()) {
        console.log("[ai-loop] continue");
      }

      tools = resolveProviderToolsetForActor(actor, buildToolsetFn());
    }
  } finally {
    detachMessageHistory();
  }
}

type CooperativeAiGeneratedEvent =
  | { kind: "llm_done"; opId: string; msg: any }
  | {
      kind: "compress_done";
      opId: string;
      compressedMessages: any[] | null;
      policyContext?: CompactionPolicyContextData;
      policyDecision?: CompactionPolicyDecisionData;
    }
  | {
      kind: "tool_done";
      opId: string;
      funcName: string;
      toolCallId: string;
      args: any;
      output: unknown;
      outputText: string;
      /**
       * Gate-decision tag carried through the asyncCompletion mailbox so
       * the cooperative output handler can distinguish:
       *   - "allow" : the tool's `run` actually executed
       *   - "deny"  : execution was permanently refused; stopAfterTools
       *               still applies
       *   - "defer" : execution paused awaiting external coordination
       *               (e.g. plan_approval); stopAfterTools MUST NOT
       *               apply, the real execution will happen on a later
       *               turn once the coordination resolves
       * Undefined entries (recovered from older serialized state) default
       * to "allow" at the consumer site for backward compatibility.
       */
      gateOutcome?: "allow" | "deny" | "defer";
    }
  | {
      kind: "questionnaire_parsed";
      opId: string;
      questionnaireId: string;
      toolCallId: string;
      rawText: string;
      parsed: any;
    };

export type AiAgentCooperativeExecState = {
  phase:
    | "drain"
    | "compress"
    | "start_llm"
    | "wait_llm"
    | "start_tool"
    | "wait_tool"
    | "wait_questionnaire_parse";
  turn: number;
  tools: any[];
  toolCalls: any[];
  toolIndex: number;
  nextOpSeq: number;
  pendingToolResults: Array<{ toolCallId: string; questionnaireId?: string; content: string }>;
  pendingAiGenerated: CooperativeAiGeneratedEvent[];
  turnState?: TurnState;
  inflight?:
    | { kind: "compress"; opId: string }
    | { kind: "llm"; opId: string; turn: number; tools: any[]; abortController?: AbortController }
    | { kind: "tool"; opId: string; funcName: string; toolCallId: string; args: any; abortController?: AbortController }
    | {
        kind: "questionnaire_parse";
        opId: string;
        questionnaireId: string;
        toolCallId: string;
        rawText: string;
      };
  messageHistoryAttached: boolean;
  messageHistoryDetach?: () => void;
};

export type AiAgentFiberStepOutcome =
  | { kind: "yield" }
  | {
      kind: "suspend";
      reason:
        | "tool_result"
        | "child_done"
        | "external"
        | "idle_external"
        | "wait_llm_result"
        | "wait_tool_result"
        | "wait_compress_result"
        | "wait_questionnaire_parse"
        | "human_clarification"
        | "human_approval"
        | "human_answer";
      suspendPolicy?: "continue_others" | "pause_all";
    }
  | { kind: "complete" }
  | { kind: "cancel"; reason: string; propagateToChildren?: boolean }
  | { kind: "fail"; error: string };

function ensureCooperativeState(state: AiAgentCooperativeExecState | undefined, vm: AiAgentVm, actor: AiAgentActor): AiAgentCooperativeExecState {
  // P8 single-writer pipeline: graph is attached once per vm (idempotent);
  // the per-cooperative-state attached flag is preserved for shape
  // compatibility but no longer drives attach/detach lifecycle.
  void actor;
  ensureVmMessageHistoryGraphAttached(vm);
  if (state) {
    state.messageHistoryAttached = true;
    state.messageHistoryDetach = () => {};
    state.turnState = state.turnState ?? projectCooperativeLegacyTurnState(state);
    return state;
  }
  return {
    phase: "drain",
    turn: 0,
    tools: [],
    toolCalls: [],
    toolIndex: 0,
    nextOpSeq: 1,
    pendingToolResults: [],
    pendingAiGenerated: [],
    turnState: { kind: "drain", turn: 0 },
    inflight: undefined,
    messageHistoryAttached: true,
    messageHistoryDetach: () => {},
  };
}

function projectCooperativeLegacyTurnState(state: AiAgentCooperativeExecState): TurnState {
  if (state.inflight?.kind === "llm") {
    return {
      kind: "wait_llm",
      turn: state.inflight.turn,
      opId: state.inflight.opId,
      providerCallId: state.inflight.opId,
    };
  }
  if (state.inflight?.kind === "tool") {
    return {
      kind: "wait_tool",
      turn: state.turn,
      opId: state.inflight.opId,
      toolCallId: state.inflight.toolCallId,
      funcName: state.inflight.funcName,
      gateDecision: { kind: "allow" },
    };
  }
  if (state.inflight?.kind === "questionnaire_parse") {
    return {
      kind: "wait_questionnaire_parse",
      turn: state.turn,
      opId: state.inflight.opId,
      toolCallId: state.inflight.toolCallId,
      questionnaireId: state.inflight.questionnaireId,
      rawText: state.inflight.rawText,
    };
  }
  if (state.inflight?.kind === "compress") {
    return { kind: "wait_compress", turn: state.turn, opId: state.inflight.opId, reason: "token_threshold" };
  }
  if (state.phase === "start_llm") {
    return { kind: "start_llm", turn: Math.max(1, state.turn + 1), reason: nextCooperativeTurnStartReason(state) };
  }
  if (state.phase === "start_tool") {
    const toolCall = state.toolCalls[state.toolIndex];
    const toolCallId = String(toolCall?.id ?? "");
    const funcName = String(toolCall?.function?.name ?? "");
    let args: unknown = {};
    try {
      args = JSON.parse(toolCall?.function?.arguments || "{}");
    } catch {
      args = {};
    }
    return { kind: "start_tool", turn: state.turn, toolCallId, funcName, args };
  }
  return { kind: "drain", turn: state.turn };
}

function nextCooperativeTurnStartReason(state: AiAgentCooperativeExecState): TurnStartReason {
  return state.turn === 0 ? "fresh" : "tool_continuation";
}

function applyCooperativeTurnEvent(state: AiAgentCooperativeExecState, event: TurnEvent): ReturnType<typeof turnReducer> {
  const result = turnReducer(state.turnState ?? projectCooperativeLegacyTurnState(state), event);
  state.turnState = result.state;
  return result;
}

function detachCooperativeHistory(state: AiAgentCooperativeExecState): void {
  // P8 single-writer pipeline: detach is a no-op (graph is vm-resident).
  // The function is retained as a compat surface for call sites that signal
  // "step boundary" via this call; P8.4 will remove it entirely.
  state.messageHistoryDetach = undefined;
  state.messageHistoryAttached = false;
}

function pumpAsyncCompletionMailbox(actor: AiAgentActor, state: AiAgentCooperativeExecState): void {
  const drained = actor.drainMailbox("asyncCompletion") as any[];
  for (const entry of drained) {
    if (entry && typeof entry === "object" && typeof (entry as any).kind === "string") {
      state.pendingAiGenerated.push(entry as CooperativeAiGeneratedEvent);
    }
  }
}

function takePendingEvent<TKind extends CooperativeAiGeneratedEvent["kind"]>(
  state: AiAgentCooperativeExecState,
  kind: TKind,
  opId: string,
): Extract<CooperativeAiGeneratedEvent, { kind: TKind }> | null {
  const idx = state.pendingAiGenerated.findIndex((e) => e?.kind === kind && (e as any).opId === opId);
  if (idx < 0) return null;
  const [ev] = state.pendingAiGenerated.splice(idx, 1);
  return (ev as any) ?? null;
}

function registerCooperativeAsyncTask(vm: AiAgentVm, task: Promise<unknown>): void {
  const orchestrator = ensureVmRuntimeContext(vm).currentOrchestrator as any;
  if (typeof orchestrator?.registerBackgroundTask === "function") {
    orchestrator.registerBackgroundTask(task);
  }
}

function mapQuestionnaireKindToWait(kind: unknown): "human_clarification" | "human_approval" | "human_answer" {
  if (kind === "clarification") return "human_clarification";
  if (kind === "approval") return "human_approval";
  return "human_answer";
}

function normalizeSuspendPolicy(value: unknown): "continue_others" | "pause_all" {
  return value === "continue_others" ? "continue_others" : "pause_all";
}

function latestNonSystemMessageRole(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = String(messages[i]?.role ?? "");
    if (role && role !== "system") return role;
  }
  return "";
}

export async function aiAgentCooperativeStep(params: {
  fiberId: string;
  vm: AiAgentVm;
  actor: AiAgentActor;
  /** Seed input only (one-time domain hydration); NOT live working state. */
  messages: readonly any[];
  state?: AiAgentCooperativeExecState;
  setState: (state: AiAgentCooperativeExecState) => void;
  resumeFiber: (fiberId: string) => void;
  emitFiberSignal?: (input: {
    fiberId: string;
    signalKind: "async_completed" | "mailbox_enqueue" | "interrupt_requested" | "resume_requested" | "suspend_recorded" | "late_completion_ignored";
    mailbox?: { kind: "asyncCompletion"; payload: CooperativeAiGeneratedEvent };
    opId?: string;
    toolCallId?: string;
    idempotencyKey?: string;
  }) => void;
}): Promise<AiAgentFiberStepOutcome> {
  const { fiberId, vm, actor, messages } = params;
  const eventBus = vm.eventBus;
  const eventActor = toEventActorRef(actor);

  ensureConversationDomainSeededFromLoopMessages(vm, actor, messages);
  const state = ensureCooperativeState(params.state, vm, actor);
  pumpAsyncCompletionMailbox(actor, state);

  const emitAiGeneratedCompletion = (input: {
    opId: string;
    event: CooperativeAiGeneratedEvent;
    toolCallId?: string;
  }) => {
    if (!state.inflight || state.inflight.opId !== input.opId) {
      params.emitFiberSignal?.({
        fiberId,
        signalKind: "late_completion_ignored",
        opId: input.opId,
        toolCallId: input.toolCallId,
        idempotencyKey: `${fiberId}:${input.opId}:late_completion_ignored`,
      });
      return;
    }

    if (params.emitFiberSignal) {
      params.emitFiberSignal({
        fiberId,
        signalKind: "async_completed",
        mailbox: { kind: "asyncCompletion", payload: input.event },
        opId: input.opId,
        toolCallId: input.toolCallId,
        idempotencyKey: `${fiberId}:${input.opId}:asyncCompletion`,
      });
      return;
    }

    actor.send("asyncCompletion", input.event as any);
    params.resumeFiber(fiberId);
  };

  const { cancelRequested, shutdownRequested } = consumeControlSignals(actor);
  if (shutdownRequested) {
    eventBus?.emitAgentTurnEnd(eventActor, "shutdown_requested");
    resetCooperativeStateAfterCancel(state);
    params.setState(state);
    detachCooperativeHistory(state);
    return { kind: "cancel", reason: "shutdown_requested", propagateToChildren: true };
  }
  if (cancelRequested) {
    eventBus?.emitAgentTurnEnd(eventActor, "cancelled");
    resetCooperativeStateAfterCancel(state);
    params.setState(state);
    return { kind: "suspend", reason: "idle_external" };
  }

  if (isAutonomousHolonActor(actor)) {
    drainAutonomousHolonActorInbox(vm, actor);
    params.setState(state);
    return { kind: "suspend", reason: "idle_external" };
  }

  if (isLeaderLedHolonActor(actor)) {
    drainLeaderLedHolonActorInbox(vm, actor);
    params.setState(state);
    return { kind: "suspend", reason: "idle_external" };
  }

  const stopAfterFirstTool = actor.ctrlOptions.stopAfterFirstTool || vm.options.stopAfterFirstTool === true;
  const stopAfterTools = actor.ctrlOptions.stopAfterTools.length
    ? actor.ctrlOptions.stopAfterTools
    : (vm.options.stopAfterTools ?? []);
  const exitAfterToolResult = actor.ctrlOptions.exitAfterToolResult || vm.options.exitAfterToolResult === true;
  const maxIterations =
    typeof vm.options.maxIterations === "number" && vm.options.maxIterations > 0 ? vm.options.maxIterations : undefined;

  try {
    if (state.phase === "drain") {
      const hadMailboxWork =
        actor.hasPending("childDone") ||
        actor.hasPending("memberCoordination") ||
        actor.hasPending("memberChatInbox") ||
        actor.hasPending("heartbeat") ||
        actor.hasPending("humanInput") ||
        actor.hasPending("toolResult");

      drainChildDoneIntoMessages(vm, actor);
      drainMemberChatInboxIntoMessages(vm, actor);
      drainMemberCoordinationIntoMessages(vm, actor);
      if (actor.hasPending("humanInput")) {
        drainHumanInputIntoMessages(vm, actor);
        drainHeartbeatIntoMessages(vm, actor, { includeRuntimeInternalContext: false });
      } else {
        drainHeartbeatIntoMessages(vm, actor, { includeRuntimeInternalContext: true });
      }

      const toolResults = actor.drainMailbox("toolResult") as any[];
      for (const toolResult of toolResults) {
        const toolCallId = String(toolResult?.toolCallId ?? "");
        const content = toolResult?.content;
        if (!toolCallId || content === undefined || content === null) {
          continue;
        }
        state.pendingToolResults.push({
          toolCallId,
          questionnaireId: typeof toolResult?.questionnaireId === "string" ? toolResult.questionnaireId : undefined,
          content: String(content),
        });
      }

      const pendingQuestionnaire = (actor.peekMailbox("control") as any[]).find(
        (entry: any) =>
          entry?.kind === "questionnaire_pending" &&
          typeof entry?.toolCallId === "string" &&
          typeof entry?.questionnaireId === "string",
      ) as
        | {
            toolCallId: string
            questionnaireId: string
            suspendPolicy: "pause_all" | "continue_others"
          }
        | undefined

      if (!hadMailboxWork && state.pendingToolResults.length === 0 && pendingQuestionnaire) {
        const request = actor.pendingQuestionnaires?.[pendingQuestionnaire.questionnaireId]
        params.setState(state)
        return {
          kind: "suspend",
          reason: mapQuestionnaireKindToWait(request?.kind),
          suspendPolicy: normalizeSuspendPolicy(pendingQuestionnaire.suspendPolicy),
        }
      }

      const hasSeedMessages =
        state.turn === 0 &&
        actor.messages.some((message: any) => {
          const role = String(message?.role ?? "")
          return role !== "" && role !== "system"
        })

      if (!hadMailboxWork && state.pendingToolResults.length === 0 && !hasSeedMessages) {
        const latestRole = latestNonSystemMessageRole([...actor.messages]);
        const shouldResumeAfterRecoveredToolMessage =
          latestRole === "tool" &&
          !stopAfterFirstTool &&
          !exitAfterToolResult &&
          stopAfterTools.length === 0 &&
          (maxIterations === undefined || state.turn < maxIterations);
        const shouldResumeAfterRecoveredUserMessage =
          latestRole === "user" && actor.recovery?.restoredFromSnapshot === true;
        if (shouldResumeAfterRecoveredToolMessage || shouldResumeAfterRecoveredUserMessage) {
          state.phase = "start_llm";
          params.setState(state);
          return { kind: "yield" };
        }

        params.setState(state);
        return { kind: "suspend", reason: "idle_external" };
      }

      // If we have a questionnaire answer to parse, kick off parsing asynchronously and suspend.
      if (!state.inflight && state.pendingToolResults.length) {
        const next = state.pendingToolResults.shift()!;
        const toolCallId = next.toolCallId;
        const rawText = String(next.content);
        const questionnaireId = next.questionnaireId || `q-${toolCallId}`;
        const request: QuestionnaireRequestPayload | undefined = actor.pendingQuestionnaires?.[questionnaireId];
        const llmAdapter = actor.llmClient as LlmAdapter | null;
        const model = actor.modelConfig.model;

        if (!request || !llmAdapter || typeof (llmAdapter as any).createStream !== "function" || !model) {
          eventBus?.emitQuestionnaireResult(eventActor, {
            questionnaireId,
            toolCallId,
            rawText,
            status: "invalid",
            answers: {},
            errors: ["missing questionnaire context"],
          });

          // Continue draining on next step.
          state.phase = "drain";
          params.setState(state);
          return { kind: "yield" };
        }

        const opId = `qparse:${fiberId}:${state.nextOpSeq++}`;
        state.inflight = { kind: "questionnaire_parse", opId, questionnaireId, toolCallId, rawText };
        state.phase = "wait_questionnaire_parse";
        params.setState(state);

        void (async () => {
          try {
            const parsed = await parseQuestionnaireAnswer({ llmAdapter, model, request, rawText });
            emitAiGeneratedCompletion({
              opId,
              toolCallId,
              event: {
                kind: "questionnaire_parsed",
                opId,
                questionnaireId,
                toolCallId,
                rawText,
                parsed,
              },
            });
          } catch (error) {
            emitAiGeneratedCompletion({
              opId,
              toolCallId,
              event: {
                kind: "questionnaire_parsed",
                opId,
                questionnaireId,
                toolCallId,
                rawText,
                parsed: { status: "invalid", answers: {}, errors: [error instanceof Error ? error.message : String(error)] },
              },
            });
          }
        })();

        return { kind: "suspend", reason: "wait_questionnaire_parse" };
      }

      state.phase = "compress";
      params.setState(state);
      return { kind: "yield" };
    }

    if (state.phase === "wait_questionnaire_parse") {
      if (!state.inflight || state.inflight.kind !== "questionnaire_parse") {
        state.phase = "drain";
        params.setState(state);
        return { kind: "yield" };
      }

      const inflight = state.inflight;
      const ev = takePendingEvent(state, "questionnaire_parsed", inflight.opId);
      if (!ev) {
        params.setState(state);
        return { kind: "suspend", reason: "wait_questionnaire_parse" };
      }

      state.inflight = undefined;
      const parsed = (ev as any).parsed;
      const questionnaireId = inflight.questionnaireId;
      const toolCallId = inflight.toolCallId;
      const rawText = inflight.rawText;
      const request: QuestionnaireRequestPayload | undefined = actor.pendingQuestionnaires?.[questionnaireId];

      eventBus?.emitQuestionnaireResult(eventActor, {
        questionnaireId,
        toolCallId,
        rawText,
        status: parsed?.status,
        answers: parsed?.answers ?? {},
        errors: parsed?.errors,
      });

      if (!request || parsed?.status === "invalid") {
        const errors = Array.isArray(parsed?.errors) ? parsed.errors.map((e: any) => String(e)).filter(Boolean) : [];
        const intro = errors.length
          ? `Your answer could not be parsed:\n${errors.map((e: string) => `- ${e}`).join("\n")}`
          : "Your answer could not be parsed. Please try again.";

        const clarification: QuestionnaireRequestPayload = {
          ...(request ?? {
            questionnaireId,
            toolCallId,
            kind: "clarification",
            suspendPolicy: "pause_all",
            title: "Clarification",
            intro,
            questions: [{ id: "q1", prompt: intro, type: "text" }],
          }),
          kind: "clarification",
          title: (request as any)?.title || "Clarification",
          intro,
        } as any;

        actor.pendingQuestionnaires[questionnaireId] = clarification;
        upsertPendingQuestionnaireRow({ vm, actor, request: clarification });
        actor.send("control", {
          kind: "questionnaire_pending",
          toolCallId,
          questionnaireId,
          suspendPolicy: clarification.suspendPolicy,
        });
        eventBus?.emitQuestionnaireRequest(eventActor, clarification);
        eventBus?.emitAgentTurnEnd(eventActor, "questionnaire_wait");

        state.phase = "drain";
        params.setState(state);
        return {
          kind: "suspend",
          reason: mapQuestionnaireKindToWait(clarification.kind),
          suspendPolicy: normalizeSuspendPolicy(clarification.suspendPolicy),
        };
      }

      delete actor.pendingQuestionnaires[questionnaireId];
      answerQuestionnaireRow({
        vm,
        questionnaireId,
        result: {
          questionnaireId,
          toolCallId,
          rawText,
          status: parsed?.status,
          answers: parsed?.answers ?? {},
          errors: parsed?.errors,
        },
      });
      const workspaceAccessGrantContext = getWorkspaceAccessGrantContext(request);
      if (workspaceAccessGrantContext) {
        const toolRegistry = vm.registries.toolRegistry;
        const resolvedOutput =
          toolRegistry
            ? await replayWorkspaceAccessGrantApprovedTool({
                vm,
                actor,
                toolRegistry,
                request,
                toolCallId,
                answers: parsed.answers,
              })
            : "Error: runtime.registries.toolRegistry is required";
        const outputText =
          typeof resolvedOutput === "string" ? resolvedOutput : resolvedOutput === undefined ? "" : JSON.stringify(resolvedOutput);
        const suppress = shouldSuppressToolResultMessage(workspaceAccessGrantContext.toolName, outputText);
        if (eventBus && !suppress) {
          const resultPayload =
            typeof resolvedOutput === "string"
              ? resolvedOutput
              : resolvedOutput === undefined
                ? ""
                : JSON.stringify(resolvedOutput);
          eventBus.emitToolCallResult(eventActor, workspaceAccessGrantContext.toolName, toolCallId, resultPayload, outputText.startsWith("Error:"));
        }

        state.phase = "compress";
        params.setState(state);
        return { kind: "yield" };
      }
      const localPermissionContext = getLocalPermissionApprovalContext(request);
      if (localPermissionContext) {
        const toolRegistry = vm.registries.toolRegistry;
        const approved = isLocalPermissionApprovalAccepted(request, parsed?.answers);
        const resolvedOutput =
          toolRegistry
            ? await replayLocalPermissionApprovedTool({
                vm,
                actor,
                toolRegistry,
                request,
                toolCallId,
                approved,
              })
            : "Error: runtime.registries.toolRegistry is required";
        const outputText =
          typeof resolvedOutput === "string" ? resolvedOutput : resolvedOutput === undefined ? "" : JSON.stringify(resolvedOutput);
        const suppress = shouldSuppressToolResultMessage(localPermissionContext.toolName, outputText);
        if (eventBus && !suppress) {
          const resultPayload =
            typeof resolvedOutput === "string"
              ? resolvedOutput
              : resolvedOutput === undefined
                ? ""
                : JSON.stringify(resolvedOutput);
          eventBus.emitToolCallResult(eventActor, localPermissionContext.toolName, toolCallId, resultPayload, outputText.startsWith("Error:"));
        }

        state.phase = "compress";
        params.setState(state);
        return { kind: "yield" };
      }
      // Canonical questionnaire-answer commit (see the streaming-loop
      // counterpart): JSON tool message through the unified tool-result
      // channel so the array mirror and the domains share one shape.
      const questionnaireResultJson = JSON.stringify({
        questionnaireId,
        rawText,
        status: parsed.status,
        answers: parsed.answers,
        errors: parsed.errors ?? [],
      });
      appendConversationToolResultMessage({
        vm,
        actor,
        toolCallId,
        toolName: "Questionnaire",
        outputText: questionnaireResultJson,
      });

      state.phase = "compress";
      params.setState(state);
      return { kind: "yield" };
    }

    if (state.phase === "compress") {
      if (state.inflight?.kind === "compress") {
        const ev = takePendingEvent(state, "compress_done", state.inflight.opId);
        if (!ev) {
          params.setState(state);
          return { kind: "suspend", reason: "wait_compress_result" };
        }

        state.inflight = undefined;
        const compressedMessages = (ev as any).compressedMessages as any[] | null;
        if (Array.isArray(compressedMessages) && compressedMessages.length) {
          // P7: no array rewrite — the domain compaction command below is the
          // only truth landing; the next materialization picks it up.
          try {
            await persistConversationCompaction({
              vm,
              actor,
              compressedMessages,
              policyContext:
                ((ev as any).policyContext as CompactionPolicyContextData | undefined)
                ?? buildCompactionPolicyContextForActor({
                  actor,
                  messages: compressedMessages,
                  trigger: "auto_threshold",
                  mode: "auto",
                  tokensBefore: estimateTokens(compressedMessages),
                }),
              policyDecision:
                ((ev as any).policyDecision as CompactionPolicyDecisionData | undefined)
                ?? decideCompactionPolicy(
                  buildCompactionPolicyContextForActor({
                    actor,
                    messages: compressedMessages,
                    trigger: "auto_threshold",
                    mode: "auto",
                    tokensBefore: estimateTokens(compressedMessages),
                  }),
                ),
            });
          } catch (error) {
            vm.effects.log?.("warn", "conversation compaction persistence failed", { error });
          }
        }

        state.phase = "start_llm";
        params.setState(state);
        return { kind: "yield" };
      }

      applyCheapCompactionForActor({ vm, actor });

      if (!shouldCompressActorHistory(actor)) {
        state.phase = "start_llm";
        params.setState(state);
        return { kind: "yield" };
      }

      const inputLimit = actor.modelConfig.inputLimit ?? 0;
      const effectiveLimit = resolveCompactionInputLimit(actor);
      if (effectiveLimit <= 0) {
        state.phase = "start_llm";
        params.setState(state);
        return { kind: "yield" };
      }

      const { llmAdapter, model, buildToolsetFn, processStreamFn } = resolveLoopDeps(vm, actor);
      resolveTurnWorkContextForActor({
        actor,
        messages: [...actor.messages],
        sessionId: typeof (vm.outerCtx?.metadata as any)?.sessionId === "string"
          ? String((vm.outerCtx?.metadata as any).sessionId)
          : undefined,
        trigger: "compress_gate",
      });
      const toolsForPrompt = resolveProviderToolsetForActor(actor, buildToolsetFn());
      const promptBuild = buildProviderPromptForActorTurn({
        vm,
        actor,
        tools: toolsForPrompt,
        llmAdapter,
        model,
        recordPromptPlan: false,
      });
      const ratio = compressionDeps.estimateUsageRatio(promptBuild.providerMessages, effectiveLimit);
      if (ratio < 0.85) {
        state.phase = "start_llm";
        params.setState(state);
        return { kind: "yield" };
      }
      const tokensBefore = estimateTokens(promptBuild.providerMessages);
      const policyContext = buildCompactionPolicyContextForActor({
        actor,
        messages: promptBuild.providerMessages,
        trigger: "auto_threshold",
        mode: "auto",
        tokensBefore,
      });
      const policyDecision = decideCompactionPolicy(policyContext);
      if (policyDecision.decision === "skip") {
        state.phase = "start_llm";
        params.setState(state);
        return { kind: "yield" };
      }

      const opId = `compress:${fiberId}:${state.nextOpSeq++}`;
      state.inflight = { kind: "compress", opId };
      params.setState(state);

      const task = (async () => {
        let compressedMessages: any[] | null = null;
        try {
          // P7: summarization input is the domain visible projection.
          compressedMessages = await compressionDeps.compressHistory({
            messages: [...getConversationVisibleMessagesFromVm({ vm, actorKey: actor.key })],
            llmAdapter,
            model,
            inputLimit,
            tokenBudget: Math.floor(effectiveLimit * 0.9),
            logger: {
              warn: (message: string, error?: unknown) =>
                vm.effects.log?.("warn", message, error === undefined ? undefined : { error }),
            },
          });
        } catch (error) {
          vm.effects.log?.("warn", "history compression failed", { error });
          compressedMessages = null;
        } finally {
          emitAiGeneratedCompletion({
            opId,
            event: {
              kind: "compress_done",
              opId,
              compressedMessages,
              policyContext,
              policyDecision,
            },
          });
        }
      })();
      registerCooperativeAsyncTask(vm, task);

      return { kind: "suspend", reason: "wait_compress_result" };
    }

    if (state.phase === "start_llm") {
      if (hasPendingAiAgentWakeMailbox(actor)) {
        state.phase = "drain";
        state.turnState = { kind: "drain", turn: state.turn };
        params.setState(state);
        return { kind: "yield" };
      }
      if (state.turnState.kind !== "start_llm") {
        applyCooperativeTurnEvent(state, {
          kind: "start_llm_requested",
          reason: nextCooperativeTurnStartReason(state),
        });
      }

      const { llmAdapter, model, buildToolsetFn, processStreamFn, extraBody } = resolveLoopDeps(vm, actor);
      const sessionId = typeof (vm.outerCtx?.metadata as any)?.sessionId === "string"
        ? String((vm.outerCtx?.metadata as any).sessionId)
        : "__unsessioned__";
      applyCheapCompactionForActor({ vm, actor });
      resolveTurnWorkContextForActor({
        actor,
        messages: [...actor.messages],
        sessionId,
        trigger: "turn_start",
      });
      const tools = resolveProviderToolsetForActor(actor, buildToolsetFn());
      // T3.2 shared turn leaf: prompt build + preflight over-limit compaction.
      const { promptPlan, providerMessages, promptGenerationId } = await prepareProviderPromptForTurn({
        vm,
        actor,
        tools,
        llmAdapter,
        model,
        processStreamFn,
        stage: "cooperative llm turn",
      });

      const turn = state.turnState.kind === "start_llm" ? state.turnState.turn : state.turn + 1;
      state.turn = turn;
      eventBus?.emitAgentTurnStart(eventActor, turn);
      beginGoalTurn(vm, [...actor.messages]);

      const opId = `llm:${fiberId}:${state.nextOpSeq++}`;
      const abortController = new AbortController();
      trackProviderCallStarted({ vm, actor, turnId: turn, providerCallId: opId, model, tools, promptGenerationId });
      applyCooperativeTurnEvent(state, { kind: "provider_call_started", opId, providerCallId: opId });
      state.inflight = { kind: "llm", opId, turn, tools, abortController };
      state.tools = tools;
      state.toolCalls = [];
      state.toolIndex = 0;
      state.phase = "wait_llm";
      params.setState(state);
      appendRuntimeControlLifecycleEvidenceFromVm(vm, {
        kind: "request",
        effectKind: "provider_completion",
        effectId: opId,
        handlerKey: `llm:${llmAdapter.type}`,
        idempotencyKey: `${fiberId}:${opId}:provider_completion`,
        sourceCommandId: opId,
        payload: {
          actorKey: actor.key,
          actorId: actor.id,
          model,
          turn,
        },
      });
      appendRuntimeControlLifecycleEvidenceFromVm(vm, {
        kind: "waiting",
        effectKind: "provider_completion",
        effectId: opId,
        handlerKey: `llm:${llmAdapter.type}`,
        idempotencyKey: `${fiberId}:${opId}:provider_completion`,
        waitReason: "wait_llm_result",
      });

      const task = (async () => {
        actor.llmAbortController = abortController;
        try {
          // T3.2 shared turn leaf: createStream + reactive prompt-too-long
          // retry + processStream + reasoning assembly. The cooperative driver
          // runs it inside this async completion task and emits llm_done once
          // it resolves; the streaming driver awaits the same leaf inline.
          const { msg } = await streamProviderCompletion({
            vm,
            actor,
            tools,
            llmAdapter,
            model,
            processStreamFn,
            extraBody,
            promptPlan,
            providerMessages,
            abortController,
            retryStage: "cooperative llm turn reactive retry",
          });
          if (abortController.signal.aborted) {
            return;
          }
          trackProviderCallCompleted(vm, opId, msg);
          emitAiGeneratedCompletion({
            opId,
            event: { kind: "llm_done", opId, msg },
          });
          appendRuntimeControlLifecycleEvidenceFromVm(vm, {
            kind: "result",
            effectKind: "provider_completion",
            effectId: opId,
            handlerKey: `llm:${llmAdapter.type}`,
            resultId: `${opId}:llm_done`,
            payload: msg,
          });
        } catch (error) {
          if (abortController.signal.aborted) {
            return;
          }
          trackProviderCallFailed(vm, opId, error, false);
          const message = `Error: ${error instanceof Error ? error.message : String(error)}`;
          emitVisibleAssistantError(vm, actor, message);
          appendRuntimeControlLifecycleEvidenceFromVm(vm, {
            kind: "failed",
            effectKind: "provider_completion",
            effectId: opId,
            handlerKey: `llm:${llmAdapter.type}`,
            error: message,
            retryable: false,
          });
          emitAiGeneratedCompletion({
            opId,
            event: {
              kind: "llm_done",
              opId,
              msg: { role: "assistant", content: message },
            },
          });
        } finally {
          if (actor.llmAbortController === abortController) actor.llmAbortController = null;
        }
      })();
      registerCooperativeAsyncTask(vm, task);

      if (wasInflightClearedByInterrupt(state, "llm", opId)) {
        params.setState(state);
        return { kind: "suspend", reason: "idle_external" };
      }
      return { kind: "suspend", reason: "wait_llm_result" };
    }

    if (state.phase === "wait_llm") {
      if (!state.inflight || state.inflight.kind !== "llm") {
        state.phase = "start_llm";
        params.setState(state);
        return { kind: "yield" };
      }

      const inflight = state.inflight;
      const ev = takePendingEvent(state, "llm_done", inflight.opId);
      if (!ev) {
        params.setState(state);
        return { kind: "suspend", reason: "wait_llm_result" };
      }

      state.inflight = undefined;
      const msg = (ev as any).msg;
      // P8 single-writer pipeline: a live cooperative llm turn streamed
      // over the vm event bus and the resident MessageHistoryGraph committed
      // it to the domains. A result REPLAYED from durable effect evidence
      // never crossed this process's stream, so we re-emit the equivalent
      // semantic envelope on the bus for the graph to commit. There is no
      // local-reduction fallback.
      if ((ev as any).replayedFromEffectEvidence) {
        appendConversationAssistantMessage({ vm, actor, message: msg });
      }
      appendDetachedMessageForFiber(vm, fiberId, {
        role: "assistant",
        kind: "message",
        text: assistantTextFromMessage(msg),
      });
      accountGoalProgress(vm, [...actor.messages]);
      const toolCalls = msg?.tool_calls || msg?.toolCalls || [];
      state.toolCalls = Array.isArray(toolCalls) ? toolCalls : [];
      state.toolIndex = 0;
      applyCooperativeTurnEvent(state, {
        kind: "provider_completed",
        opId: inflight.opId,
        hasToolCalls: state.toolCalls.length > 0,
      });

      if (!state.toolCalls.length) {
        emitMemberResultToControl(vm, actor, [...actor.messages]);
        if (eventBus) {
          eventBus.emitAgentTurnEnd(eventActor, "no_tool_calls");
        }
        state.phase = "drain";
        params.setState(state);
        if (isDelegateActor(actor)) {
          detachCooperativeHistory(state);
          return { kind: "complete" };
        }
        return { kind: "suspend", reason: "idle_external" };
      }

      state.phase = "start_tool";
      params.setState(state);
      return { kind: "yield" };
    }

    if (state.phase === "start_tool") {
      const toolCalls = state.toolCalls;
      if (!toolCalls.length || state.toolIndex >= toolCalls.length) {
        if (exitAfterToolResult) {
          eventBus?.emitAgentTurnEnd(eventActor, "exit_after_tool_result");
          state.phase = "drain";
          params.setState(state);
          if (isDelegateActor(actor)) {
            detachCooperativeHistory(state);
            return { kind: "complete" };
          }
          return { kind: "suspend", reason: "idle_external" };
        }
        if (maxIterations !== undefined && state.turn >= maxIterations) {
          eventBus?.emitAgentTurnEnd(eventActor, "max_iterations");
          state.phase = "drain";
          params.setState(state);
          return { kind: "suspend", reason: "idle_external" };
        }

        // next turn
        state.phase = "start_llm";
        params.setState(state);
        return { kind: "yield" };
      }

      const toolRegistry = requireToolRegistry(vm);
      const tc = toolCalls[state.toolIndex];
      const funcName = tc?.function?.name || "";
      const toolCallId = tc?.id || "";
      let args: any = {};
      try {
        args = JSON.parse(tc?.function?.arguments || "{}");
      } catch {
        args = {};
      }

      if (eventBus) {
        eventBus.emitToolCallStart(eventActor, funcName, toolCallId, JSON.stringify(args, null, 2));
      }
      appendDetachedMessageForFiber(vm, fiberId, {
        role: "tool",
        kind: "tool_call",
        text: JSON.stringify(args),
        toolName: funcName,
        toolCallId,
      });

      const opId = `tool:${fiberId}:${state.nextOpSeq++}`;
      const abortController = new AbortController();
      applyCooperativeTurnEvent(state, { kind: "tool_call_selected", toolCallId, funcName, args });
      trackToolCallPlanned({ vm, actorKey: actor.key, turnId: state.turn, toolCallId, funcName, args });
      const gateDecision = evaluateToolExecutionGates(vm, actor, funcName);
      trackToolCallGate(vm, toolCallId, gateDecision.kind);
      applyCooperativeTurnEvent(state, { kind: "tool_gate_decided", opId, gateDecision });
      state.inflight = { kind: "tool", opId, funcName, toolCallId, args, abortController };
      state.phase = "wait_tool";
      params.setState(state);
      const toolEffectKind = classifyRuntimeControlToolEffectKind(funcName);
      appendRuntimeControlLifecycleEvidenceFromVm(vm, {
        kind: "request",
        effectKind: toolEffectKind,
        effectId: opId,
        handlerKey: funcName,
        idempotencyKey: `${fiberId}:${opId}:tool`,
        sourceCommandId: opId,
        payload: { toolCallId }, // P4/D3: link-only — args/output live in ToolCallDomain
      });
      appendRuntimeControlLifecycleEvidenceFromVm(vm, {
        kind: "waiting",
        effectKind: toolEffectKind,
        effectId: opId,
        handlerKey: funcName,
        idempotencyKey: `${fiberId}:${opId}:tool`,
        waitReason: "wait_tool_result",
      });

      const task = (async () => {
        try {
          // T3.2 shared turn leaf: gate-resolved tool output. The cooperative
          // driver runs it inside this async task; the streaming driver awaits
          // the same leaf inline.
          const { resolvedOutput, outputText } = await resolveToolCallOutput({
            vm,
            actor,
            toolRegistry,
            funcName,
            args,
            toolCallId,
            gateDecision,
            signal: abortController.signal,
          });
          if (abortController.signal.aborted) return;
          trackToolCallResult(vm, toolCallId, outputText, gateDecision.kind);
          const suppress = shouldSuppressToolResultMessage(funcName, outputText);
          if (eventBus && !suppress) {
            const resultPayload =
              typeof resolvedOutput === "string"
                ? resolvedOutput
                : resolvedOutput === undefined
                  ? ""
                  : JSON.stringify(resolvedOutput);
            eventBus.emitToolCallResult(eventActor, funcName, toolCallId, resultPayload, outputText.startsWith("Error:"));
          }
          emitAiGeneratedCompletion({
            opId,
            toolCallId,
            event: {
              kind: "tool_done",
              opId,
              funcName,
              toolCallId,
              args,
              output: resolvedOutput,
              outputText,
              gateOutcome: gateDecision.kind,
            },
          });
          appendRuntimeControlLifecycleEvidenceFromVm(vm, {
            kind: "result",
            effectKind: toolEffectKind,
            effectId: opId,
            handlerKey: funcName,
            resultId: `${opId}:tool_done`,
            payload: { toolCallId }, // P4/D3: link-only — output lives in ToolCallDomain
          });
        } catch (error) {
          if (abortController.signal.aborted) return;
          const outputText = `Error: ${error instanceof Error ? error.message : String(error)}`;
          if (eventBus) {
            eventBus.emitToolCallResult(eventActor, funcName, toolCallId, outputText, true);
          }
          appendRuntimeControlLifecycleEvidenceFromVm(vm, {
            kind: "failed",
            effectKind: toolEffectKind,
            effectId: opId,
            handlerKey: funcName,
            error: outputText,
            retryable: false,
          });
          emitAiGeneratedCompletion({
            opId,
            toolCallId,
            event: {
              kind: "tool_done",
              opId,
              funcName,
              toolCallId,
              args,
              output: outputText,
              outputText,
              // Catch branch: the tool actually ran (the allow path) and
              // threw. Deny/defer never enter the await, so they never
              // reach this catch.
              gateOutcome: "allow",
            },
          });
        }
      })();
      registerCooperativeAsyncTask(vm, task);

      if (wasInflightClearedByInterrupt(state, "tool", opId)) {
        params.setState(state);
        return { kind: "suspend", reason: "idle_external" };
      }
      return { kind: "suspend", reason: "wait_tool_result" };
    }

    if (state.phase === "wait_tool") {
      if (!state.inflight || state.inflight.kind !== "tool") {
        state.phase = "start_tool";
        params.setState(state);
        return { kind: "yield" };
      }

      const inflight = state.inflight;
      const ev = takePendingEvent(state, "tool_done", inflight.opId);
      if (!ev) {
        params.setState(state);
        return { kind: "suspend", reason: "wait_tool_result" };
      }

      state.inflight = undefined;
      applyCooperativeTurnEvent(state, { kind: "tool_completed", opId: inflight.opId });
      const { llmAdapter } = resolveLoopDeps(vm, actor);
      const outputText = String((ev as any).outputText ?? "");
      const funcName = String((ev as any).funcName ?? "");
      const suppress = shouldSuppressToolResultMessage(funcName, outputText);
      appendDetachedMessageForFiber(vm, fiberId, {
        role: "tool",
        kind: outputText.startsWith("Error:") ? "error" : "tool_result",
        text: outputText,
        toolName: funcName,
        toolCallId: String((ev as any).toolCallId ?? ""),
      });

      // P8 single-writer pipeline: a live cooperative tool task already
      // emitted the result on the bus and the resident graph committed it.
      // A result REPLAYED from durable effect evidence did not cross this
      // process's stream, so we re-emit on the bus here for the graph to
      // commit. Suppressed results stay out of both the bus and the domain.
      if (!suppress && (ev as any).replayedFromEffectEvidence) {
        const toolName = (llmAdapter.type === "anthropic" || llmAdapter.type === "claude")
          ? String((ev as any).funcName ?? "")
          : funcName;
        appendConversationToolResultMessage({
          vm,
          actor,
          toolCallId: String((ev as any).toolCallId ?? ""),
          toolName,
          outputText,
          isError: outputText.startsWith("Error:"),
        });
      }
      advanceActorWorkContextAfterTool({
        actor,
        toolName: funcName,
        args: (ev as any).args,
      });
      accountGoalProgress(vm, [...actor.messages]);

      const toolCallId = String((ev as any).toolCallId ?? "");
      const pending = findQuestionnairePendingControl(actor, toolCallId);
      if (pending) {
        const stored = (actor.pendingQuestionnaires as any)?.[pending.questionnaireId];
        const req = stored ?? normalizeQuestionnaireRequestArgs((ev as any).args, toolCallId);

        // Backstop: if a custom Questionnaire tool didn't mark pending, do it here.
        if (!stored) {
          actor.pendingQuestionnaires[req.questionnaireId] = req;
          upsertPendingQuestionnaireRow({ vm, actor, request: req });
          actor.send("control", {
            kind: "questionnaire_pending",
            toolCallId: req.toolCallId,
            questionnaireId: req.questionnaireId,
            suspendPolicy: req.suspendPolicy,
          });
          eventBus?.emitQuestionnaireRequest(eventActor, req);
        }

        appendRuntimeControlLifecycleEvidenceFromVm(vm, {
          kind: "waiting",
          effectKind: "questionnaire",
          effectId: inflight.opId,
          handlerKey: funcName,
          idempotencyKey: `${fiberId}:${inflight.opId}:questionnaire`,
          waitReason: mapQuestionnaireKindToWait(req.kind),
          payload: {
            toolCallId,
            questionnaireId: req.questionnaireId,
            suspendPolicy: req.suspendPolicy,
          },
        });
        eventBus?.emitAgentTurnEnd(eventActor, "questionnaire_wait");
        state.phase = "drain";
        params.setState(state);
        return {
          kind: "suspend",
          reason: mapQuestionnaireKindToWait(req.kind),
          suspendPolicy: normalizeSuspendPolicy(req.suspendPolicy),
        };
      }

      const classification = classifyToolOutput({ actor, funcName, toolCallId, outputText });

      if (classification === "child_wait") {
        eventBus?.emitAgentTurnEnd(eventActor, "child_wait");
        state.phase = "drain";
        params.setState(state);
        return { kind: "suspend", reason: "child_done" };
      }

      if (classification === "stop_agent") {
        eventBus?.emitAgentTurnEnd(eventActor, "stop_agent");
        detachCooperativeHistory(state);
        state.phase = "drain";
        params.setState(state);
        return { kind: "complete" };
      }

      if (stopAfterFirstTool) {
        eventBus?.emitAgentTurnEnd(eventActor, "stop_after_tool");
        state.phase = "drain";
        params.setState(state);
        if (isDelegateActor(actor)) {
          detachCooperativeHistory(state);
          return { kind: "complete" };
        }
        return { kind: "suspend", reason: "idle_external" };
      }

      const evGateOutcome = (ev as any).gateOutcome as "allow" | "deny" | "defer" | undefined;
      if (
        stopAfterTools.length
        && stopAfterTools.includes(String((ev as any).funcName ?? ""))
        // Deferred tools (e.g. paused on plan_approval) didn't actually
        // run — they will execute on a later turn once the coordination
        // resolves, so they must NOT satisfy stopAfterTools. Fall back to
        // drain so the cooperative loop can pick up the incoming mailbox
        // signal (approval) and re-dispatch the tool.
        && evGateOutcome !== "defer"
      ) {
        eventBus?.emitAgentTurnEnd(eventActor, "stop_after_tool");
        state.phase = "drain";
        params.setState(state);
        if (isDelegateActor(actor)) {
          detachCooperativeHistory(state);
          return { kind: "complete" };
        }
        return { kind: "suspend", reason: "idle_external" };
      }

      state.toolIndex += 1;
      state.phase = "start_tool";
      params.setState(state);
      return { kind: "yield" };
    }

    state.phase = "drain";
    params.setState(state);
    return { kind: "yield" };
  } catch (error) {
    detachCooperativeHistory(state);
    const message = error instanceof Error ? error.message : String(error);
    params.setState(state);
    return { kind: "fail", error: message };
  }
}
