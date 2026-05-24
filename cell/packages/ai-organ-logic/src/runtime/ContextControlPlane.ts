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

const DEFAULT_WORK_MODE: WorkMode = WORK_MODES.general_execution;
const DEFAULT_TASK_PHASE: TaskPhase = TASK_PHASES.implementation;
const PROMPT_PLAN_VERSION = 1;

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildPromptPlanCacheProfile(params: {
  actor: AiAgentActor;
  systemPrompts: string[];
  toolNames: string[];
}): PromptPlanData["cacheProfile"] | undefined {
  const capabilities = params.actor.modelConfig.capabilities;
  const cachePolicy = capabilities?.cachePolicy;
  if (!cachePolicy?.stablePrefix) return undefined;
  return {
    providerFamily: capabilities.family,
    stablePrefixEnabled: true,
    providerManagedPrefixCache: cachePolicy.providerManagedPrefixCache,
    preferLateCompaction: cachePolicy.preferLateCompaction,
    stablePrefixSections: ["system", "work_context", "tools"],
    stablePrefixHash: stableHash({
      family: capabilities.family,
      systemPrompts: params.systemPrompts,
      toolNames: [...params.toolNames].sort(),
    }),
    compactionThresholdTokens: cachePolicy.compactionThresholdTokens,
  };
}

const LONG_RUNNING_HINTS = [
  "roadmap",
  "migration",
  "repo-wide",
  "repository-wide",
  "multi-step",
  "multi phase",
  "multi-phase",
  "milestone",
  "workflow",
  "delegate",
  "delegation",
  "parallel",
  "teammate",
  "coordination",
  "迁移",
  "全仓",
  "多步骤",
  "多阶段",
  "里程碑",
  "工作流",
  "委派",
  "并行",
  "协作",
];

const CODING_LOCAL_HINTS = [
  "fix",
  "bug",
  "patch",
  "failing test",
  "assertion",
  "stack trace",
  "single-file",
  "single file",
  "localized",
  "small edit",
  "targeted",
  "lint",
  "typecheck",
  "error",
  "regression",
  "修复",
  "补丁",
  "报错",
  "失败测试",
  "断言",
  "单文件",
  "局部",
  "定向",
  "回归",
  "类型检查",
];

const CODING_HINTS = [
  "code",
  "coding",
  "bug",
  "fix",
  "patch",
  "refactor",
  "test",
  "tests",
  "debug",
  "implement",
  "implementation",
  "script",
  "readme",
  "release",
  "migration",
  "deploy",
  "deployment",
  "rollback",
  "sdk",
  "api",
  "cli",
  "repo",
  "parser",
  "代码",
  "编程",
  "修复",
  "补丁",
  "重构",
  "测试",
  "脚本",
  "发布",
  "迁移",
  "部署",
  "回滚",
];

const EXTERNAL_RESEARCH_HINTS = [
  "research",
  "survey",
  "latest",
  "current facts",
  "verify sources",
  "primary source",
  "multi-source",
  "internet",
  "web",
  "news",
  "调研",
  "最新",
  "当前事实",
  "核实来源",
  "一手来源",
  "多来源",
  "互联网",
  "网页",
  "新闻",
];

const WORKSPACE_BOUNDED_HINTS = [
  "repo",
  "repository",
  "workspace",
  "workdir",
  "codebase",
  "code",
  "frontend",
  "backend",
  "docs/",
  "commit",
  "diff",
  "local file",
  "仓库",
  "工作区",
  "代码库",
  "代码",
  "前端",
  "后端",
  "提交",
  "本地文件",
];

const LOOKUP_HINTS = [
  "what",
  "why",
  "how",
  "which",
  "look up",
  "find",
  "查一下",
  "看看",
  "解释",
  "说明",
  "是什么",
  "为什么",
  "如何",
];

const DOCS_THEN_CODE_DISCOVERY_HINTS = [
  "read docs",
  "read the docs",
  "read documentation",
  "review docs",
  "understand the project",
  "understand the codebase",
  "understand the architecture",
  "docs/",
  "documentation",
  "先读 docs",
  "先看 docs",
  "阅读 docs",
  "阅读文档",
  "先了解",
  "了解项目",
  "了解代码",
  "了解结构",
  "项目结构",
  "代码结构",
];

const DOCS_THEN_CODE_ACTION_HINTS = [
  "then refactor",
  "before refactor",
  "then rewrite",
  "refactor after reading",
  "align with the architecture",
  "fit the current architecture",
  "align with coding conventions",
  "rewrite to match",
  "refactor",
  "rewrite existing implementation",
  "重构",
  "改造",
  "按设计风格",
  "统一规范",
  "符合架构",
  "对齐架构",
  "按现有架构",
  "按规范改造",
];

const INSPECTION_ONLY_HINTS = [
  "inspection only",
  "analysis only",
  "read-only analysis",
  "audit only",
  "review only",
  "只做分析",
  "只做阅读",
  "只读分析",
  "仅分析",
  "仅审查",
];

const WEAK_CONTINUE_INPUTS = new Set([
  "continue",
  "please continue",
  "go on",
  "carry on",
  "继续",
  "请继续",
  "继续处理",
  "继续吧",
  "接着来",
  "继续一下",
]);

const PROGRESS_TOOL_NAMES = new Set(["write", "edit"]);

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

function containsAny(text: string, hints: string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

function isWeakContinueInput(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return WEAK_CONTINUE_INPUTS.has(normalized);
}

function isExplicitExternalResearchRequest(text: string): boolean {
  return containsAny(text, EXTERNAL_RESEARCH_HINTS) && !containsAny(text, WORKSPACE_BOUNDED_HINTS);
}

function isDocsThenCodeRequest(text: string): boolean {
  return containsAny(text, DOCS_THEN_CODE_DISCOVERY_HINTS) && containsAny(text, DOCS_THEN_CODE_ACTION_HINTS);
}

function deriveWorkMode(taskInput: string): WorkMode {
  const combined = taskInput.trim().toLowerCase();
  if (!combined) return DEFAULT_WORK_MODE;
  if (containsAny(combined, LONG_RUNNING_HINTS)) return WORK_MODES.long_running_coordination;
  if (isDocsThenCodeRequest(combined)) return WORK_MODES.docs_then_code;
  if (containsAny(combined, CODING_LOCAL_HINTS)) return WORK_MODES.localized_repair;
  if (containsAny(combined, CODING_HINTS) && combined.length < 800) return WORK_MODES.small_edit;
  if (isExplicitExternalResearchRequest(combined)) return WORK_MODES.external_research;
  if (containsAny(combined, LOOKUP_HINTS) || combined.length < 220) return WORK_MODES.direct_lookup;
  if (combined.length < 800) return WORK_MODES.focused_assignment;
  return DEFAULT_WORK_MODE;
}

function inferTaskPhase(taskInput: string, workMode: WorkMode, defaultPhase: TaskPhase): TaskPhase {
  const normalized = taskInput.trim().toLowerCase();
  if (!normalized) {
    return workMode === WORK_MODES.docs_then_code ? TASK_PHASES.context_build : defaultPhase;
  }
  if (containsAny(normalized, INSPECTION_ONLY_HINTS)) return TASK_PHASES.inspection_only;
  if (workMode === WORK_MODES.docs_then_code || isDocsThenCodeRequest(normalized)) {
    return TASK_PHASES.context_build_then_code;
  }
  return defaultPhase || DEFAULT_TASK_PHASE;
}

function classifyBashCommand(command: string): "progress" | "verification" | "neutral" {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return "neutral";
  if (
    /(^|\s)(pytest|bun test|vitest|pnpm test|npm test|cargo test|go test|ruff|mypy|tsc|lint|typecheck|check|verify)(\s|$)/.test(normalized)
  ) {
    return "verification";
  }
  if (
    /(>|>>|\btee\b|\bmv\b|\bcp\b|\brm\b|\bmkdir\b|\bgit apply\b|\bsed -i\b|\bperl -pi\b|\btouch\b)/.test(normalized)
  ) {
    return "progress";
  }
  return "neutral";
}

function classifyToolProgression(toolName: string, args: unknown): "progress" | "verification" | "neutral" {
  if (PROGRESS_TOOL_NAMES.has(toolName)) return "progress";
  if (toolName === "bash" || toolName === "DetachedBash") {
    const command = typeof (args as { command?: unknown } | null)?.command === "string"
      ? String((args as { command?: string }).command)
      : "";
    return classifyBashCommand(command);
  }
  return "neutral";
}

function readRecentText(messages: Array<{ role?: string; content?: unknown }>): string {
  return messages.slice(-8).map((message) => String(message?.content ?? "")).join("\n").toLowerCase();
}

function countRecentToolEvidence(messages: Array<{ role?: string }>): number {
  return messages.slice(-8).filter((message) => String(message?.role ?? "") === "tool").length;
}

function resolveSessionId(vm: AiAgentVm): string {
  const sessionId = (vm.outerCtx?.metadata as Record<string, unknown> | undefined)?.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : "default";
}

function insertSystemOverlay(messages: ChatMessage[], overlay: string | null): ChatMessage[] {
  if (!overlay) return [...messages];
  const next = [...messages];
  const insertAt = next.findIndex((message) => String(message.role ?? "") !== "system");
  const overlayMessage = { role: "system", content: overlay } as ChatMessage;
  if (insertAt === -1) {
    next.push(overlayMessage);
    return next;
  }
  next.splice(insertAt, 0, overlayMessage);
  return next;
}

export function getActorWorkContext(actor: AiAgentActor): ActorWorkContextData {
  return actor.workContext ?? defaultWorkContext(actor);
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

  let workMode: WorkMode = current.workMode || DEFAULT_WORK_MODE;
  let workModeSource = current.workModeSource || "retained";
  if (taskInput) {
    if (isWeakContinueInput(taskInput) && current.workMode) {
      workMode = current.workMode;
      workModeSource = "inherited";
    } else {
      const derived = deriveWorkMode(taskInput);
      workMode = derived;
      workModeSource = derived === current.workMode ? (current.workModeSource || "retained") : "derived";
    }
  }

  let phaseDefault: TaskPhase = current.taskPhase || DEFAULT_TASK_PHASE;
  if (workMode !== current.workMode) {
    phaseDefault = DEFAULT_TASK_PHASE;
  }
  let taskPhase = inferTaskPhase(taskInput, workMode, phaseDefault);
  if (
    current.taskPhase
    && workMode === current.workMode
    && taskPhase === DEFAULT_TASK_PHASE
  ) {
    taskPhase = current.taskPhase;
  }
  const next: ActorWorkContextData = {
    ...current,
    workMode,
    taskPhase,
    workModeSource,
    taskPhaseSource: taskInput ? "input_inferred" : "retained",
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
  const progression = classifyToolProgression(params.toolName, params.args);
  let taskPhase: TaskPhase = current.taskPhase || DEFAULT_TASK_PHASE;
  let taskPhaseSource = current.taskPhaseSource || "retained";
  if (progression === "progress") {
    taskPhase = TASK_PHASES.implementation;
    taskPhaseSource = "tool_progression";
  } else if (progression === "verification") {
    taskPhase = TASK_PHASES.verification;
    taskPhaseSource = "tool_verification";
  }
  const next: ActorWorkContextData = {
    ...current,
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
      workContext.workMode === WORK_MODES.docs_then_code
        ? "Bound prompt assembly to docs-then-code context while keeping execution path explicit."
        : workContext.taskPhase === TASK_PHASES.verification
          ? "Bias prompt assembly toward verification continuity and targeted checks."
          : "Bias prompt assembly toward direct execution with the currently loaded tool surface.",
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
  const systemPrompts = params.messages
    .filter((message) => String(message.role ?? "") === "system")
    .map((message) => String(message.content ?? ""))
    .filter(Boolean);
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
    toolNames,
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

export function buildWorkContextOverlayText(workContext: ActorWorkContextData): string {
  const lines = [
    "<runtime_work_context>",
    `work_mode: ${String(workContext.workMode || DEFAULT_WORK_MODE)}`,
    `task_phase: ${String(workContext.taskPhase || DEFAULT_TASK_PHASE)}`,
  ];
  if (workContext.taskPhase === TASK_PHASES.context_build || workContext.taskPhase === TASK_PHASES.context_build_then_code) {
    lines.push("instruction: keep context build bounded and move into concrete execution once the target seam is clear.");
  } else if (workContext.taskPhase === TASK_PHASES.verification) {
    lines.push("instruction: keep verification target, failure reason, and command/result continuity explicit.");
  } else {
    lines.push("instruction: prefer the shortest concrete execution path over broad scouting.");
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
  return {
    promptPlan,
    executionMessages: insertSystemOverlay(params.messages, workContextOverlay),
    workContextOverlay,
  };
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
  const workMode = context.workMode || DEFAULT_WORK_MODE;
  const taskPhase = context.taskPhase || DEFAULT_TASK_PHASE;
  if (taskPhase === TASK_PHASES.context_build || taskPhase === TASK_PHASES.context_build_then_code) {
    return {
      policy: "work_context_gate",
      decision: context.tokenPressure >= 1.1 ? "rewrite" : "skip",
      reason: "bounded_context_build",
      workMode,
      taskPhase,
      protectedCategories: ["discovery_evidence", "coordination_state"],
      rewrittenCategories: ["low_signal_chatter"],
      skipReason: context.tokenPressure >= 1.1 ? null : "protected_context_build",
    };
  }
  if (taskPhase === TASK_PHASES.verification) {
    return {
      policy: "work_context_gate",
      decision: context.mode === "micro" ? "summarize" : "rewrite",
      reason: "verification",
      workMode,
      taskPhase,
      protectedCategories: ["verification_evidence", "patch_rationale", "coordination_state"],
      rewrittenCategories: ["low_signal_chatter", "discovery_evidence"],
      skipReason: null,
    };
  }
  if (taskPhase === TASK_PHASES.inspection_only) {
    return {
      policy: "work_context_gate",
      decision: context.mode === "micro" ? "summarize" : "rewrite",
      reason: "inspection_only",
      workMode,
      taskPhase,
      protectedCategories: ["discovery_evidence", "coordination_state"],
      rewrittenCategories: ["low_signal_chatter"],
      skipReason: null,
    };
  }
  return {
    policy: "work_context_gate",
    decision: context.mode === "micro" ? "summarize" : "rewrite",
    reason: "implementation",
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
