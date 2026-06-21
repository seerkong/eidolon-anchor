import type {
  ActorWorkContextData,
  CompactionPolicyContextData,
  CompactionPolicyDecisionData,
  ContinuationBaselineData,
  PromptPlanData,
  PromptRoutingDecisionData,
  TaskPhase,
  WorkMode,
} from "@cell/ai-core-contract/runtime/ContextControl";
import { TASK_PHASES, WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl";
import type { ChatMessage } from "@shared/composer";
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import { createHash } from "node:crypto";
import {
  applyPromptTransformToConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  getVmConversationDomainRuntime,
  recordPromptRequestToConversationDomainRuntime,
} from "../conversation/ConversationDomainRuntime";

const DEFAULT_WORK_MODE: WorkMode = WORK_MODES.build;
const DEFAULT_TASK_PHASE: TaskPhase = TASK_PHASES.normal;
const PROMPT_PLAN_VERSION = 1;

function normalizeStableHashValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStableHashValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeStableHashValue(entry)]),
  );
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalizeStableHashValue(value))).digest("hex");
}

function stableToolSchemas(tools: any[]): unknown[] {
  return [...tools]
    .sort((left, right) =>
      String(left?.function?.name ?? left?.name ?? "").localeCompare(String(right?.function?.name ?? right?.name ?? "")))
    .map(normalizeStableHashValue);
}

function buildPromptPlanCacheProfile(params: {
  actor: AiAgentActor;
  systemPrompts: string[];
  tools: any[];
}): PromptPlanData["cacheProfile"] | undefined {
  const capabilities = params.actor.modelConfig.capabilities;
  const cachePolicy = capabilities?.cachePolicy;
  if (!cachePolicy?.stablePrefix) return undefined;
  return {
    providerFamily: capabilities.family,
    stablePrefixEnabled: true,
    providerManagedPrefixCache: cachePolicy.providerManagedPrefixCache,
    preferLateCompaction: cachePolicy.preferLateCompaction,
    stablePrefixSections: ["system", "tools"],
    stablePrefixHash: stableHash({
      family: capabilities.family,
      systemPrompts: params.systemPrompts,
      tools: stableToolSchemas(params.tools),
    }),
    compactionThresholdTokens: cachePolicy.compactionThresholdTokens,
  };
}

const TASK_PHASE_CONTROL_TOOL_NAME = "SetTaskPhase";

function defaultWorkContext(actor: AiAgentActor): ActorWorkContextData {
  const epoch = new Date(0).toISOString();
  return {
    workMode: DEFAULT_WORK_MODE,
    taskPhase: DEFAULT_TASK_PHASE,
    workModeSource: "default",
    taskPhaseSource: "default",
    workModeUpdatedAt: epoch,
    taskPhaseUpdatedAt: epoch,
    actorKey: actor.key,
    actorId: actor.id,
    lastTrigger: "default",
  };
}

function defaultContinuationBaseline(): ContinuationBaselineData {
  return {
    baselineEpoch: 0,
    lastResetReason: null,
    latestResponseId: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function latestUserText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message?.role ?? "") !== "user") continue;
    const text = String(message?.content ?? "").trim();
    if (text) return text;
  }
  return "";
}

function readRecentText(messages: Array<{ role?: string; content?: unknown }>): string {
  return messages.slice(-8).map((message) => String(message?.content ?? "")).join("\n").toLowerCase();
}

function countRecentToolEvidence(messages: Array<{ role?: string }>): number {
  return messages.slice(-8).filter((message) => String(message?.role ?? "") === "tool").length;
}

function resolveSessionId(vm: AiAgentVm): string {
  const sessionId = (vm.outerCtx?.metadata as Record<string, unknown> | undefined)?.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : "__unsessioned__";
}

function isToolMessage(message: ChatMessage | undefined): boolean {
  return String(message?.role ?? "") === "tool";
}

function findToolCallGroupStart(messages: ChatMessage[], index: number): number {
  let start = Math.max(0, Math.min(index, messages.length - 1));
  if (isToolMessage(messages[start])) {
    while (start > 0 && isToolMessage(messages[start - 1])) start -= 1;
    if (start > 0 && String(messages[start - 1]?.role ?? "") === "assistant") start -= 1;
    return start;
  }
  return start;
}

function findLateStatusOverlayInsertIndex(messages: ChatMessage[]): number {
  if (messages.length === 0) return 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role ?? "") === "user") return index;
  }
  return findToolCallGroupStart(messages, messages.length - 1);
}

function insertLateStatusOverlay(messages: ChatMessage[], overlay: string | null): ChatMessage[] {
  if (!overlay) return [...messages];
  const next = [...messages];
  const overlayMessage = { role: "system", content: overlay } as ChatMessage;
  const insertAt = findLateStatusOverlayInsertIndex(next);
  next.splice(insertAt, 0, overlayMessage);
  return next;
}

function normalizeSystemPromptText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function collectSystemPromptsForActorExecution(actor: AiAgentActor, messages: ChatMessage[]): string[] {
  const prompts: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const prompt = normalizeSystemPromptText(value);
    if (!prompt || seen.has(prompt)) return;
    seen.add(prompt);
    prompts.push(prompt);
  };

  for (const prompt of actor.systemPrompts ?? []) add(prompt);
  for (const message of messages) {
    if (String(message?.role ?? "") === "system") add(message?.content);
  }
  return prompts;
}

function materializeActorSystemPrompts(actor: AiAgentActor, messages: ChatMessage[]): ChatMessage[] {
  const existing = new Set(
    messages
      .filter((message) => String(message?.role ?? "") === "system")
      .map((message) => normalizeSystemPromptText(message?.content))
      .filter(Boolean),
  );
  const missing = (actor.systemPrompts ?? [])
    .map((prompt) => normalizeSystemPromptText(prompt))
    .filter((prompt) => prompt && !existing.has(prompt));
  if (missing.length === 0) return [...messages];
  return [
    ...missing.map((prompt) => ({ role: "system", content: prompt } as ChatMessage)),
    ...messages,
  ];
}

export function getActorWorkContext(actor: AiAgentActor): ActorWorkContextData {
  const current = actor.workContext ?? defaultWorkContext(actor);
  const normalized: ActorWorkContextData = {
    ...current,
    workMode: normalizeWorkMode(current.workMode),
    taskPhase: normalizeTaskPhase(current.taskPhase),
    actorKey: actor.key,
    actorId: actor.id,
  };
  if (
    !actor.workContext
    || actor.workContext.workMode !== normalized.workMode
    || actor.workContext.taskPhase !== normalized.taskPhase
    || actor.workContext.actorKey !== normalized.actorKey
    || actor.workContext.actorId !== normalized.actorId
  ) {
    actor.workContext = normalized;
  }
  return normalized;
}

export function normalizeWorkMode(value: unknown): WorkMode {
  return value === WORK_MODES.plan ? WORK_MODES.plan : WORK_MODES.build;
}

export function normalizeTaskPhase(value: unknown): TaskPhase {
  return value === TASK_PHASES.answer ? TASK_PHASES.answer : TASK_PHASES.normal;
}

export function setActorWorkMode(params: {
  actor: AiAgentActor;
  workMode: unknown;
  source?: string;
  occurredAt?: string;
  trigger?: string;
}): ActorWorkContextData {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const current = getActorWorkContext(params.actor);
  const workMode = normalizeWorkMode(params.workMode);
  const next: ActorWorkContextData = {
    ...current,
    workMode,
    workModeSource: params.source ?? "manual",
    workModeUpdatedAt: workMode === current.workMode ? current.workModeUpdatedAt : occurredAt,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    lastTrigger: params.trigger ?? "work_mode_command",
  };
  params.actor.workContext = next;
  return next;
}

export function setActorTaskPhase(params: {
  actor: AiAgentActor;
  taskPhase: unknown;
  source?: string;
  occurredAt?: string;
  trigger?: string;
}): ActorWorkContextData {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const current = getActorWorkContext(params.actor);
  const taskPhase = normalizeTaskPhase(params.taskPhase);
  const next: ActorWorkContextData = {
    ...current,
    taskPhase,
    taskPhaseSource: params.source ?? "tool_call",
    taskPhaseUpdatedAt: taskPhase === current.taskPhase ? current.taskPhaseUpdatedAt : occurredAt,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    lastTrigger: params.trigger ?? "task_phase_tool",
  };
  params.actor.workContext = next;
  return next;
}

export function getActorContinuationBaseline(actor: AiAgentActor): ContinuationBaselineData {
  return actor.continuationBaseline ?? defaultContinuationBaseline();
}

export function getActorWorkContextFromVm(params: {
  vm: AiAgentVm;
  actorKey: string;
}): ActorWorkContextData | null {
  const actor = params.vm.actors[params.actorKey];
  return actor ? getActorWorkContext(actor) : null;
}

export function getActorContinuationBaselineFromVm(params: {
  vm: AiAgentVm;
  actorKey: string;
}): ContinuationBaselineData | null {
  const actor = params.vm.actors[params.actorKey];
  return actor ? getActorContinuationBaseline(actor) : null;
}

export function resolveTurnWorkContextForActor(params: {
  actor: AiAgentActor;
  messages: Array<{ role?: string; content?: unknown }>;
  sessionId?: string;
  occurredAt?: string;
  trigger?: string;
}): ActorWorkContextData {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const current = getActorWorkContext(params.actor);
  const taskInput = latestUserText(params.messages);
  const workMode = normalizeWorkMode(current.workMode);
  const taskPhase = taskInput ? TASK_PHASES.normal : normalizeTaskPhase(current.taskPhase);
  const next: ActorWorkContextData = {
    ...current,
    workMode,
    taskPhase,
    workModeSource: current.workModeSource || "retained",
    taskPhaseSource: taskInput && current.taskPhase !== TASK_PHASES.normal ? "turn_reset" : (current.taskPhaseSource || "retained"),
    workModeUpdatedAt: workMode === current.workMode ? current.workModeUpdatedAt : occurredAt,
    taskPhaseUpdatedAt: taskPhase === current.taskPhase ? current.taskPhaseUpdatedAt : occurredAt,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    sessionId: params.sessionId ?? current.sessionId,
    lastTrigger: params.trigger ?? "turn_start",
  };
  params.actor.workContext = next;
  return next;
}

export function advanceActorWorkContextAfterTool(params: {
  actor: AiAgentActor;
  toolName: string;
  args?: unknown;
  occurredAt?: string;
}): ActorWorkContextData {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const current = getActorWorkContext(params.actor);
  const toolName = String(params.toolName ?? "");
  let taskPhase: TaskPhase = normalizeTaskPhase(current.taskPhase);
  let taskPhaseSource = current.taskPhaseSource || "retained";
  if (taskPhase === TASK_PHASES.answer && toolName !== TASK_PHASE_CONTROL_TOOL_NAME) {
    taskPhase = TASK_PHASES.normal;
    taskPhaseSource = "tool_after_answer";
  }
  const next: ActorWorkContextData = {
    ...current,
    workMode: normalizeWorkMode(current.workMode),
    taskPhase,
    taskPhaseSource,
    taskPhaseUpdatedAt: taskPhase === current.taskPhase ? current.taskPhaseUpdatedAt : occurredAt,
    lastTrigger: "tool_round",
  };
  params.actor.workContext = next;
  return next;
}

export function buildPromptRoutingDecision(params: {
  actor: AiAgentActor;
  toolNames: string[];
}): PromptRoutingDecisionData {
  const workContext = getActorWorkContext(params.actor);
  const selectedCandidateIds = params.toolNames.map((toolName) => `tool:${toolName}`);
  return {
    source: "runtime_context_control_plane",
    selectedCandidateIds,
    rationale:
      workContext.taskPhase === TASK_PHASES.answer
        ? "Bias prompt assembly toward a concise final answer unless more information is strictly required."
        : workContext.workMode === WORK_MODES.plan
          ? "Bias prompt assembly toward read-only planning and verification."
          : "Bias prompt assembly toward concrete build execution with the currently loaded tool surface.",
    metadata: {
      workMode: workContext.workMode,
      taskPhase: workContext.taskPhase,
    },
  };
}

export function buildPromptPlanForActorExecution(params: {
  sessionId: string;
  actor: AiAgentActor;
  messages: ChatMessage[];
  tools: any[];
  selectedModel?: string | null;
}): PromptPlanData {
  const workContext = getActorWorkContext(params.actor);
  const systemPrompts = collectSystemPromptsForActorExecution(params.actor, params.messages);
  const toolNames = params.tools
    .map((tool) => String(tool?.function?.name ?? tool?.name ?? ""))
    .filter(Boolean);
  const routingDecision = buildPromptRoutingDecision({
    actor: params.actor,
    toolNames,
  });
  const cacheProfile = buildPromptPlanCacheProfile({
    actor: params.actor,
    systemPrompts,
    tools: params.tools,
  });
  return {
    version: PROMPT_PLAN_VERSION,
    sessionId: params.sessionId,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    workContext,
    systemPrompts,
    toolNames,
    routingDecision,
    cacheProfile,
    metadata: {
      selectedModel: params.selectedModel ?? params.actor.modelConfig.model ?? null,
      actorType: params.actor.type,
      systemPromptCount: systemPrompts.length,
      toolCount: toolNames.length,
      modelFamily: params.actor.modelConfig.capabilities?.family,
      cacheProfile,
      modelCapabilities: params.actor.modelConfig.capabilities,
    },
  };
}

export type WorkModeToolGuidance = {
  prefer: string[];
  avoidUntilNeeded: string[];
};

export function resolveWorkModeToolGuidance(workContext: ActorWorkContextData): WorkModeToolGuidance {
  const workMode = normalizeWorkMode(workContext.workMode);
  const taskPhase = normalizeTaskPhase(workContext.taskPhase);
  if (workMode === WORK_MODES.plan) {
    return {
      prefer: ["read", "grep", "glob", "ls", "bash"],
      avoidUntilNeeded: ["write", "edit", "multiedit", "apply_patch"],
    };
  }
  if (taskPhase === TASK_PHASES.answer) {
    return {
      prefer: ["read", "grep"],
      avoidUntilNeeded: ["write", "edit", "multiedit", "apply_patch"],
    };
  }
  return {
    prefer: [],
    avoidUntilNeeded: [],
  };
}

export function buildWorkContextOverlayText(workContext: ActorWorkContextData): string {
  const workMode = normalizeWorkMode(workContext.workMode);
  const taskPhase = normalizeTaskPhase(workContext.taskPhase);
  const lines = [
    "<runtime_work_context>",
    `work_mode: ${workMode}`,
    `task_phase: ${taskPhase}`,
  ];
  if (taskPhase === TASK_PHASES.answer) {
    lines.push("instruction: answer phase means provide the final answer unless more information is strictly required.");
  } else if (workMode === WORK_MODES.plan) {
    lines.push("instruction: plan mode is read-only; do not modify files or run destructive commands.");
  } else {
    lines.push("instruction: build mode means execute the requested change using the normal tool policy.");
  }
  const toolGuidance = resolveWorkModeToolGuidance({ ...workContext, workMode, taskPhase });
  if (toolGuidance.prefer.length || toolGuidance.avoidUntilNeeded.length) {
    lines.push("<tool_guidance>");
    if (toolGuidance.prefer.length) lines.push(`prefer: ${toolGuidance.prefer.join(", ")}`);
    if (toolGuidance.avoidUntilNeeded.length) lines.push(`avoid_until_needed: ${toolGuidance.avoidUntilNeeded.join(", ")}`);
    lines.push("</tool_guidance>");
  }
  lines.push("</runtime_work_context>");
  return lines.join("\n");
}

export function materializeExecutionMessagesWithWorkContext(params: {
  actor: AiAgentActor;
  messages: ChatMessage[];
  tools: any[];
  sessionId: string;
  selectedModel?: string | null;
}): {
  promptPlan: PromptPlanData;
  executionMessages: ChatMessage[];
  workContextOverlay: string;
} {
  const promptPlan = buildPromptPlanForActorExecution(params);
  const workContextOverlay = buildWorkContextOverlayText(promptPlan.workContext);
  const rootedMessages = materializeActorSystemPrompts(params.actor, params.messages);
  return {
    promptPlan,
    executionMessages: insertLateStatusOverlay(rootedMessages, workContextOverlay),
    workContextOverlay,
  };
}

/**
 * Estimation-only completion of a domain-materialized prompt (track
 * refactor-ai-semantic-conversation-spine, T4.3): builds that do not record a
 * prompt generation (compaction ratio gates) may run before the actor has any
 * active prompt generation, in which case the materialization carries no
 * Stage-1 system prompts and no work-context overlay yet. Complete the
 * estimate purely so the gate evaluates the provider-READY prompt: root the
 * plan's system prompts and insert the overlay unless already present. The
 * input is the domain materialization — never a raw message array.
 */
export function completeEstimationPromptMaterialization(params: {
  promptPlan: PromptPlanData;
  messages: ChatMessage[];
}): ChatMessage[] {
  let next = [...params.messages];
  const existingSystem = new Set(
    next
      .filter((message) => String(message?.role ?? "") === "system")
      .map((message) => normalizeSystemPromptText(message?.content))
      .filter(Boolean),
  );
  const missing = (params.promptPlan.systemPrompts ?? [])
    .map((prompt) => normalizeSystemPromptText(prompt))
    .filter((prompt) => prompt && !existingSystem.has(prompt));
  if (missing.length > 0) {
    next = [...missing.map((prompt) => ({ role: "system", content: prompt } as ChatMessage)), ...next];
  }
  const hasOverlay = next.some(
    (message) =>
      String(message?.role ?? "") === "system"
      && String(message?.content ?? "").includes("<runtime_work_context>"),
  );
  if (!hasOverlay) {
    next = insertLateStatusOverlay(next, buildWorkContextOverlayText(params.promptPlan.workContext));
  }
  return next;
}

export function recordPromptPlanForActorExecution(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  messages: ChatMessage[];
  tools: any[];
  selectedModel?: string | null;
  occurredAt?: string;
}): { promptGenerationId: string | null; promptPlan: PromptPlanData } {
  const runtime = getVmConversationDomainRuntime(params.vm);
  const sessionId = resolveSessionId(params.vm);
  const promptPlan = buildPromptPlanForActorExecution({
    actor: params.actor,
    messages: params.messages,
    tools: params.tools,
    sessionId,
    selectedModel: params.selectedModel,
  });
  if (!runtime) {
    return {
      promptGenerationId: null,
      promptPlan,
    };
  }
  const actorRawState = getConversationActorRawStateFromVm({
    vm: params.vm,
    actorKey: params.actor.key,
    sessionId,
  });
  const promptGenerationId = recordPromptRequestToConversationDomainRuntime({
    runtime,
    sessionId,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    reason: "request_build",
    basisHistoryGenerationIds:
      actorRawState?.historyHeadGenerationId ? [actorRawState.historyHeadGenerationId] : [],
    systemPrompts: promptPlan.systemPrompts,
    metadata: {
      workContext: promptPlan.workContext,
      promptPlan,
      routingDecision: promptPlan.routingDecision,
      selectedModel: params.selectedModel ?? params.actor.modelConfig.model ?? null,
      providerId: params.actor.modelConfig.provider ?? params.actor.modelConfig.adapter ?? null,
    },
    occurredAt: params.occurredAt,
  });
  applyPromptTransformToConversationDomainRuntime({
    runtime,
    sessionId,
    actorKey: params.actor.key,
    promptGenerationId,
    transformKind: "overlay",
    payload: {
      content: buildWorkContextOverlayText(promptPlan.workContext),
      overlayKind: "work_context",
      insertPlacement: "late_status",
      promptPlanVersion: promptPlan.version,
    },
    occurredAt: params.occurredAt,
  });
  return {
    promptGenerationId,
    promptPlan,
  };
}

export function buildCompactionPolicyContextForActor(params: {
  actor: AiAgentActor;
  messages: Array<{ role?: string; content?: unknown }>;
  trigger: string;
  mode: "auto" | "manual" | "micro";
  tokensBefore: number;
}): CompactionPolicyContextData {
  const workContext = getActorWorkContext(params.actor);
  const cachePolicy = params.actor.modelConfig.capabilities?.cachePolicy;
  const tokenThreshold = Number(cachePolicy?.compactionThresholdTokens ?? params.actor.modelConfig.inputLimit ?? 0);
  const recentText = readRecentText(params.messages);
  return {
    workMode: workContext.workMode,
    taskPhase: workContext.taskPhase,
    trigger: params.trigger,
    mode: params.mode,
    tokensBefore: params.tokensBefore,
    tokenThreshold,
    tokenPressure: tokenThreshold > 0 ? params.tokensBefore / tokenThreshold : 0,
    modelFamily: params.actor.modelConfig.capabilities?.family,
    cachePolicy,
    baselineEpoch: getActorContinuationBaseline(params.actor).baselineEpoch,
    messageCount: params.messages.length,
    recentToolEvidenceCount: countRecentToolEvidence(params.messages),
    hasRecentPatchRationale:
      /write|edit|patch|diff|modified|updated|changed file|变更|修改/.test(recentText),
    hasRecentVerificationTarget:
      /pytest|test |test_|verify|verification|assert|lint|typecheck|check|验证|测试/.test(recentText),
  };
}

export function decideCompactionPolicy(
  context: CompactionPolicyContextData,
): CompactionPolicyDecisionData {
  const workMode = normalizeWorkMode(context.workMode);
  const taskPhase = normalizeTaskPhase(context.taskPhase);
  if (workMode === WORK_MODES.plan) {
    return {
      policy: "work_context_gate",
      decision: context.tokenPressure >= 1 ? "rewrite" : "skip",
      reason: "plan",
      workMode,
      taskPhase,
      protectedCategories: ["discovery_evidence", "coordination_state"],
      rewrittenCategories: ["low_signal_chatter"],
      skipReason: context.tokenPressure >= 1 ? null : "protected_plan_mode",
    };
  }
  if (taskPhase === TASK_PHASES.answer) {
    return {
      policy: "work_context_gate",
      decision: "summarize",
      reason: "answer",
      workMode,
      taskPhase,
      protectedCategories: ["patch_rationale", "coordination_state"],
      rewrittenCategories: ["low_signal_chatter", "discovery_evidence"],
      skipReason: null,
    };
  }
  return {
    policy: "work_context_gate",
    decision: context.mode === "micro" ? "summarize" : "rewrite",
    reason: "normal",
    workMode,
    taskPhase,
    protectedCategories: context.hasRecentVerificationTarget
      ? ["patch_rationale", "verification_evidence", "coordination_state"]
      : ["patch_rationale", "coordination_state"],
    rewrittenCategories: ["low_signal_chatter", "discovery_evidence"],
    skipReason: null,
  };
}

export function resetActorContinuationBaseline(params: {
  actor: AiAgentActor;
  reason: string;
  occurredAt?: string;
}): ContinuationBaselineData {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const current = getActorContinuationBaseline(params.actor);
  const next: ContinuationBaselineData = {
    baselineEpoch: Number(current.baselineEpoch ?? 0) + 1,
    lastResetReason: params.reason,
    latestResponseId: null,
    updatedAt: occurredAt,
  };
  params.actor.continuationBaseline = next;
  return next;
}
