import type { LlmAdapter } from "@cell/ai-core-contract/LlmTypes";
import {
  applyConversationCompaction,
} from "@cell/ai-support";
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
} from "@cell/ai-core-logic";
import { MessageHistoryGraph } from "@cell/ai-core-logic/stream/MessageHistoryGraph";
import type { QuestionnaireRequestPayload } from "@cell/ai-core-contract/runtime/Questionnaire";
import type {
  CompactionPolicyContextData,
  CompactionPolicyDecisionData,
  PromptPlanData,
} from "@cell/ai-core-contract/runtime/ContextControl";
import type { AgentLoopResult } from "@cell/ai-core-contract/types";
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import { ensureVmRuntimeContext, ensureVmSessionState, getControlActor, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import {
  createDispatchHandler,
  createPipelineHandler,
  type ActorEnvelope,
  type ActorSelf,
  type MailboxSchema,
} from "@cell/symbiont-contract/runtime/ActorFramework";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import type { ToolFuncRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";
import { compressHistory } from "@cell/ai-organ-logic/compression/ContextCompressor";
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
  recordConversationTranscriptEvidenceInRuntime,
  synchronizeConversationDomainActorFromPersistence,
} from "../conversation/ConversationDomainRuntime";
import {
  advanceActorWorkContextAfterTool,
  buildCompactionPolicyContextForActor,
  decideCompactionPolicy,
  getActorContinuationBaseline,
  getActorWorkContext,
  materializeExecutionMessagesWithWorkContext,
  recordPromptPlanForActorExecution,
  resetActorContinuationBaseline,
  resolveTurnWorkContextForActor,
} from "../runtime/ContextControlPlane";
import { getCoordinationEngine } from "../coordination/CoordinationEngine";
import { getMemberManager } from "../organization/MemberManager";
import { getOrganizationManager } from "../organization/OrganizationManager";
import { normalizeOpenAIChatMessages } from "../llm/OpenAIChatHelpers";

const isDebugEnabled = (): boolean => (globalThis as any)?.process?.env?.AI_LOOP_DEBUG === "1";

type ProcessStreamFn = (vm: AiAgentVm, stream: any) => Promise<any>;

type CompressionDeps = {
  estimateUsageRatio: typeof estimateUsageRatio;
  compressHistory: typeof compressHistory;
};

let compressionDeps: CompressionDeps = {
  estimateUsageRatio,
  compressHistory,
};

function isAutonomousHolonActor(actor: AiAgentActor | undefined | null): actor is AiAgentActor {
  return actor?.identity?.kind === "holon" && actor.identity.governance === "autonomous";
}

function isLeaderLedHolonActor(actor: AiAgentActor | undefined | null): actor is AiAgentActor {
  return actor?.identity?.kind === "holon" && actor.identity.governance === "leader_led";
}

function getAutonomousHolonState(actor: AiAgentActor | undefined | null) {
  return isAutonomousHolonActor(actor) && actor.holonState?.governance === "autonomous"
    ? actor.holonState
    : null;
}

function getLeaderLedHolonState(actor: AiAgentActor | undefined | null) {
  return isLeaderLedHolonActor(actor) && actor.holonState?.governance === "leader_led"
    ? actor.holonState
    : null;
}

function isThinContext(messages: any[]): boolean {
  const nonSystem = messages.filter((m) => m && m.role !== "system");
  return nonSystem.length <= 6;
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

function withIdentityReinjection(messages: any[], actor: AiAgentActor): any[] {
  const identityMsg = buildIdentityBlockSystemMessage(actor);
  if (!identityMsg) return messages;
  if (!isThinContext(messages)) return messages;

  // Avoid duplicating identity blocks if already present.
  const recent = messages.slice(-12);
  const already = recent.some((m) => m?.role === "system" && String(m?.content ?? "").includes("<identity_block>"));
  if (already) return messages;

  // Insert after any existing system messages to keep ordering stable.
  const idx = messages.findIndex((m) => !m || m.role !== "system");
  const insertAt = idx === -1 ? messages.length : idx;
  return [...messages.slice(0, insertAt), identityMsg, ...messages.slice(insertAt)];
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

function getMemberId(actor: AiAgentActor): string | undefined {
  if (actor.identity?.kind === "member") return actor.identity.memberId
  return undefined
}

function isPlanApprovalSatisfied(status: unknown): boolean {
  return status === AI_AGENT_COORDINATION_STATUSES.approved || status === AI_AGENT_COORDINATION_STATUSES.completed;
}

function isToolAllowedByPlanApprovalGate(
  vm: AiAgentVm,
  actor: AiAgentActor,
  toolName: string,
): { ok: true } | { ok: false; error: string } {
  if (!isMemberActor(actor)) return { ok: true };
  if (!isGatedToolByPlanApproval(toolName)) return { ok: true };

  const requestId = actor.planApproval?.requestId;
  if (!requestId) return { ok: true };

  const rec = getCoordinationEngine().get(vm, requestId);
  const status = rec?.status ?? actor.planApproval?.status;
  if (isPlanApprovalSatisfied(status)) {
    return { ok: true };
  }

  return {
    ok: false,
    error: `Error: policy violation: plan approval required for tool '${toolName}' (request_id=${requestId})`,
  };
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

function isToolAllowedByGate(vm: AiAgentVm, toolName: string): { ok: true } | { ok: false; error: string } {
  if (!isWebTool(toolName)) {
    return { ok: true };
  }
  const access = resolveNetworkAccess(vm);
  if (access === "disabled") {
    return { ok: false, error: `Error: policy violation: network access is disabled for tool '${toolName}'` };
  }
  // Default allow when network access is not explicitly disabled.
  return { ok: true };
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
  const processStreamFn: ProcessStreamFn = (localVm, stream) => actor.callbacks.processStream(localVm, actor, stream);

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

  holonActor.send("memberInbox", {
    from: actor.identity.name || actor.key,
    text: buildLeaderLedHolonEnvelope({
      kind: "result",
      routeId: request.routeId,
      holonId: request.holonId,
      leaderMemberId: actor.identity.memberId,
      text,
    }),
    ts: Date.now(),
  } as any);

  drainLeaderLedHolonActorInbox(vm, holonActor);
  const driver = ensureVmRuntimeContext(vm).driver as any;
  driver?.resumeFiber?.(`${holonActor.key}:${holonActor.id}`, Date.now());
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

  holonActor.send("memberInbox", {
    from: actor.identity.name || actor.key,
    text: buildLeaderLedHolonEnvelope({
      kind: "event",
      routeId: parsed.payload.routeId,
      holonId: parsed.payload.holonId,
      leaderMemberId: actor.identity.memberId,
      eventType: "leader_received",
      text: `${actor.identity.name} received holon route ${parsed.payload.routeId}`,
    }),
    ts: Date.now(),
  } as any);

  const driver = ensureVmRuntimeContext(vm).driver as any;
  driver?.resumeFiber?.(`${holonActor.key}:${holonActor.id}`, Date.now());
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

  holonActor.send("memberInbox", {
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
    ts: Date.now(),
  } as any);

  drainAutonomousHolonActorInbox(vm, holonActor);
  const driver = ensureVmRuntimeContext(vm).driver as any;
  driver?.resumeFiber?.(`${holonActor.key}:${holonActor.id}`, Date.now());
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
  target.send("memberInbox", {
    from: params.from,
    text: params.text,
    ts: Date.now(),
  } as any);
  driver.resumeFiber?.(`${params.actorKey}:${params.actorId}`, Date.now());
}

function resolveAutonomousHolonTaskWaiters(
  vm: AiAgentVm,
  taskId: string,
  result: { status: string; resultText: string | null },
): void {
  const runtimeContext = ensureVmRuntimeContext(vm);
  runtimeContext.autonomousHolonTaskSignals.resolve(taskId, result);
}

function resolveLeaderLedHolonRouteWaiters(
  vm: AiAgentVm,
  routeId: string,
  result: { resultText: string | null },
): void {
  const runtimeContext = ensureVmRuntimeContext(vm);
  runtimeContext.leaderLedHolonRouteSignals.resolve(routeId, result);
}

function drainLeaderLedHolonActorInbox(vm: AiAgentVm, actor: AiAgentActor): void {
  const holonState = getLeaderLedHolonState(actor);
  if (!holonState) {
    return;
  }

  const members = getMemberManager();
  const now = Date.now();
  for (const payload of actor.drainMailbox("memberInbox" as any)) {
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
  for (const payload of actor.drainMailbox("memberInbox" as any)) {
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
  messages: any[],
): Promise<{ stopReason: AgentLoopResult["stopReason"] | null }> {
  const eventBus = vm.eventBus;
  const eventActor = toEventActorRef(actor);

  drainChildDoneIntoMessages(actor, messages);
  drainMemberInboxIntoMessages(vm, actor, messages);
  drainCoordinationIntoMessages(vm, actor, messages);
  drainHumanInputIntoMessages(vm, actor, messages);

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
      if (eventBus && !shouldSuppressToolResultMessage(workspaceAccessGrantContext.toolName, outputText)) {
        const resultPayload =
          typeof resolvedOutput === "string"
            ? resolvedOutput
            : resolvedOutput === undefined
              ? ""
              : JSON.stringify(resolvedOutput);
        eventBus.emitToolCallResult(eventActor, workspaceAccessGrantContext.toolName, toolCallId, resultPayload, outputText.startsWith("Error:"));
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: resolvedOutput,
      });
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
      if (eventBus && !shouldSuppressToolResultMessage(localPermissionContext.toolName, outputText)) {
        const resultPayload =
          typeof resolvedOutput === "string"
            ? resolvedOutput
            : resolvedOutput === undefined
              ? ""
              : JSON.stringify(resolvedOutput);
        eventBus.emitToolCallResult(eventActor, localPermissionContext.toolName, toolCallId, resultPayload, outputText.startsWith("Error:"));
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: resolvedOutput,
      });
      continue;
    }
    messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: JSON.stringify({
        questionnaireId,
        rawText,
        status: parsed.status,
        answers: parsed.answers,
        errors: parsed.errors ?? [],
      }),
    });
  }

  return { stopReason: null };
}

function drainChildDoneIntoMessages(actor: AiAgentActor, messages: any[]): void {
  for (const payload of actor.drainMailbox("childDone")) {
    const outputText = String((payload as any)?.outputText ?? "");
    const toolCallId = typeof (payload as any)?.toolCallId === "string" ? (payload as any).toolCallId : "";
    const mode = normalizeDelegateRunMode((payload as any)?.mode);
    const childActorKey = String((payload as any)?.childActorKey ?? "");

    if (mode === "sync_wait" && toolCallId) {
      messages.push({ role: "tool", tool_call_id: toolCallId, content: outputText });
      continue;
    }

    messages.push({
      role: "assistant",
      content: childActorKey ? `Delegate actor ${childActorKey} done:\n${outputText}` : `Delegate actor done:\n${outputText}`,
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

function drainMemberInboxIntoMessages(vm: AiAgentVm, actor: AiAgentActor, messages: any[]): void {
  const members = getMemberManager();
  const coordinationEngine = getCoordinationEngine();

  for (const payload of actor.drainMailbox("memberInbox" as any)) {
    const from = String((payload as any)?.from ?? "");
    const text = String((payload as any)?.text ?? "");
    const ts = typeof (payload as any)?.ts === "number" ? (payload as any).ts : Date.now();
    if (!text) continue;

    if (coordinationEngine.parseEnvelopeText(text)) {
      actor.send("coordination", { from, text, ts } as any);
      continue;
    }

    relayLeaderLedHolonStageEventFromLeaderInbox(vm, actor, text);

    const memberId = getMemberId(actor);
    if (memberId) {
      members.markMemberActive({ vm, memberId });
    }
    messages.push({ role: "user", content: from ? `Message from ${from}:\n${text}` : text });
  }
}

function drainCoordinationIntoMessages(vm: AiAgentVm, actor: AiAgentActor, messages: any[]): void {
  const coordinationEngine = getCoordinationEngine();
  const members = getMemberManager();

  while (actor.hasPending("coordination")) {
    for (const payload of actor.drainMailbox("coordination" as any)) {
      const from = String((payload as any)?.from ?? "");
      const text = String((payload as any)?.text ?? "");
      const ts = typeof (payload as any)?.ts === "number" ? (payload as any).ts : Date.now();
      if (!text) continue;

      const coordination = coordinationEngine.ingestMemberInbox(vm, { from, text, ts }, { cache: false });
      if (!coordination.handled) {
        continue;
      }

      const inject = typeof coordination.injectText === "string" && coordination.injectText ? coordination.injectText : text;
      messages.push({ role: "user", content: inject });

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
        actor.send("coordination", { from: responder, text: response.text, ts: Date.now() } as any);

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

function drainHumanInputIntoMessages(vm: AiAgentVm, actor: AiAgentActor, messages: any[]): void {
  const eventBus = vm.eventBus;
  const eventActor = toEventActorRef(actor);
  for (const payload of actor.drainMailbox("humanInput")) {
    const text = String(payload ?? "");
    if (!text) continue;
    messages.push({ role: "user", content: text });
    eventBus?.emitUserInput(eventActor, text);
  }
}

function emitVisibleAssistantError(vm: AiAgentVm, actor: AiAgentActor, message: string): void {
  const text = String(message ?? "").trim();
  if (!text) return;
  const eventBus = vm.eventBus;
  if (!eventBus) return;
  const eventActor = toEventActorRef(actor);
  eventBus.emitToolCallError(eventActor, [text], "content");
}

function attachMessageHistory(vm: AiAgentVm): () => void {
  const eventBus = vm.eventBus;
  const appendMessage = vm.effects.messageHistory?.appendMessage;
  if (!eventBus || !appendMessage) {
    return () => {};
  }

  const resolveHistoryMeta = (actor: AiAgentActor | undefined) => {
    if (!actor) return {};
    if (actor.identity?.kind === "member") {
      return {
        actorType: actor.type,
        memberName: actor.identity.name,
      };
    }
    if (isDelegateActor(actor)) {
      return {
        actorType: actor.type,
        agentName: actor.agentName ?? actor.key,
      };
    }
    return { actorType: actor.type };
  };

  const msgHistoryGraph = new MessageHistoryGraph();
  const historySub = msgHistoryGraph.onHistoryEvent((event) => {
    const actor = vm.actors[event.agentKey];
    appendMessage({
      ...event,
      ...resolveHistoryMeta(actor),
    });
    if (actor) {
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
    }
  });
  const committedSub = msgHistoryGraph.onCommittedMessage((event) => {
    const actor = vm.actors[event.agentKey];
    if (!actor) return;
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
  });
  const busSub = eventBus.addConsumer((event) => {
    msgHistoryGraph.consumeSemanticEvent(event);
  });

  return () => {
    busSub.unsubscribe();
    historySub.unsubscribe();
    committedSub.unsubscribe();
    msgHistoryGraph.dispose();
  };
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

async function persistConversationCompaction(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  compressedMessages: any[];
  policyContext: CompactionPolicyContextData;
  policyDecision: CompactionPolicyDecisionData;
  promptPlan?: PromptPlanData | null;
}): Promise<void> {
  const sessionDir = typeof (params.vm.outerCtx?.metadata as any)?.sessionDir === "string"
    ? String((params.vm.outerCtx?.metadata as any).sessionDir)
    : "";
  if (!sessionDir) {
    return;
  }

  const summary = extractCompactionSummary(params.compressedMessages);
  if (!summary) {
    return;
  }

  const factory = (params.vm.outerCtx?.metadata as any)?.conversationPersistenceRepositoryFactory as
    | ConversationPersistenceRepositoryFactory
    | undefined;
  const repository = factory?.createRepository(sessionDir) ?? null;
  if (!repository) {
    return;
  }

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
  const sessionId = sessionIndex.session.sessionId;
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

type ExecutorStageSchema = {
  stage: {
    key: "drain" | "compress" | "llm";
  };
};

type ExecutorStageState = {
  turn: number;
  tools: any[];
  toolCalls: any[];
  stopReason: AgentLoopResult["stopReason"] | null;
};

type LlmTurnPipelineSchema = {
  llmTurn: {
    tools: any[];
  };
};

type LlmTurnPipelineState = {
  msg: any | null;
  toolCalls: any[];
};

type ToolCallPipelineSchema = {
  toolCall: {
    tc: any;
  };
};

type ToolCallPipelineResult = {
  funcName: string;
  toolCallId: string;
  args: any;
  output: unknown;
  outputText: string;
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

type ToolCallPipelineState = {
  result: ToolCallPipelineResult | null;
};

type ToolOutputDispatchSchema = {
  toolOutput: {
    result: ToolCallPipelineResult;
  };
};

type ToolOutputDispatchState = {
  stopReason: AgentLoopResult["stopReason"] | null;
};

let executorEnvelopeSeq = 0;
const loopActorId = "aiAgentLoopStreaming";

function createExecutorEnvelope<TSchema extends MailboxSchema, TTag extends keyof TSchema & string>(
  tag: TTag,
  payload: TSchema[TTag],
): ActorEnvelope<TSchema> {
  return {
    id: ++executorEnvelopeSeq,
    ts: Date.now(),
    from: loopActorId,
    to: loopActorId,
    tag,
    payload,
  };
}

function createExecutorSelf<TSchema extends MailboxSchema, TState>(
  vm: AiAgentVm,
  state: TState,
): ActorSelf<AiAgentVm, TSchema, TState> {
  return {
    id: loopActorId,
    ref: {
      id: loopActorId,
      send: () => {},
    },
    runtime: vm,
    state,
    send: () => {},
    broadcast: () => {},
    hasPending: () => false,
    drainMailbox: () => [] as never,
  };
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
  messages: any[];
  llmAdapter: LlmAdapter;
  model: string;
  processStreamFn: ProcessStreamFn;
  promptPlan?: PromptPlanData | null;
}): Promise<void> {
  const { vm, actor, messages, llmAdapter, model, processStreamFn } = params;
  resolveTurnWorkContextForActor({
    actor,
    messages,
    sessionId: typeof (vm.outerCtx?.metadata as any)?.sessionId === "string"
      ? String((vm.outerCtx?.metadata as any).sessionId)
      : undefined,
    trigger: "compress_gate",
  });
  if (!shouldCompressActorHistory(actor)) {
    return;
  }
  const inputLimit = actor.modelConfig.inputLimit ?? 0;
  if (inputLimit <= 0) {
    return;
  }

  const ratio = compressionDeps.estimateUsageRatio(messages, inputLimit);
  if (ratio < 0.85) {
    return;
  }
  const tokensBefore = estimateTokens(messages);
  const policyContext = buildCompactionPolicyContextForActor({
    actor,
    messages,
    trigger: "auto_threshold",
    mode: "auto",
    tokensBefore,
  });
  const policyDecision = decideCompactionPolicy(policyContext);
  if (policyDecision.decision === "skip") {
    return;
  }

  try {
    await vm.effects.messageHistory?.backupHistory?.({
      agentKey: actor.key,
      agentActorId: actor.id,
      actorType: actor.type,
    });
  } catch (error) {
    vm.effects.log?.("warn", "history backup failed", { error });
  }

  let compressedMessages: any[] | null = null;
  try {
    compressedMessages = await compressionDeps.compressHistory({
      messages,
      llmAdapter,
      model,
      inputLimit,
      logger: {
        warn: (message: string, error?: unknown) =>
          vm.effects.log?.("warn", message, error === undefined ? undefined : { error }),
      },
      processStream: (stream) => processStreamFn(vm, stream),
    });
  } catch (error) {
    vm.effects.log?.("warn", "history compression failed", { error });
    compressedMessages = null;
  }

  if (!compressedMessages) {
    return;
  }

  messages.length = 0;
  messages.push(...compressedMessages);
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

function consumeControlSignals(actor: AiAgentActor): { cancelRequested: boolean; shutdownRequested: boolean } {
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

function resetCooperativeStateAfterCancel(state: AiAgentCooperativeExecState): void {
  state.phase = "drain";
  state.tools = [];
  state.toolCalls = [];
  state.toolIndex = 0;
  state.pendingToolResults = [];
  state.pendingAiGenerated = [];
  state.inflight = undefined;
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
  messages: any[];
}): Promise<AgentLoopResult> {
  const { llmAdapter, model, buildToolsetFn, processStreamFn, toolRegistry, extraBody } = resolveLoopDeps(vm, actor);
  let tools = buildToolsetFn().filter((tool: any) => isToolAllowed(actor, getToolName(tool)));
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

  const detachMessageHistory = isHistoryTrackedActor(actor) ? attachMessageHistory(vm) : () => {};

  const llmTurnPipeline = createPipelineHandler<
    AiAgentVm,
    LlmTurnPipelineSchema,
    LlmTurnPipelineState,
    { tools: any[] },
    { vm: AiAgentVm; llmAdapter: LlmAdapter; model: string; processStreamFn: ProcessStreamFn; extraBody?: Record<string, unknown> },
    { messages: any[]; tools: any[] },
    Record<string, never>,
    any
  >({
    computeDerived: (_self, payload) => ({ tools: payload.tools }),
    innerRuntime: () => ({ vm, llmAdapter, model, processStreamFn, extraBody }),
    innerInput: (_self, _payload, _state, derived) => ({ messages, tools: derived.tools }),
    innerConfig: () => ({}),
    coreLogic: async (runtime, input) => {
      const sessionId = typeof (vm.outerCtx?.metadata as any)?.sessionId === "string"
        ? String((vm.outerCtx?.metadata as any).sessionId)
        : undefined;
      resolveTurnWorkContextForActor({
        actor,
        messages: input.messages,
        sessionId,
        trigger: "turn_start",
      });
      const baseMessages = withIdentityReinjection(input.messages, actor);
      const { promptPlan, executionMessages } = materializeExecutionMessagesWithWorkContext({
        actor,
        messages: baseMessages,
        tools: input.tools,
        sessionId: sessionId ?? "default",
        selectedModel: runtime.model,
      });
      recordPromptPlanForActorExecution({
        vm: runtime.vm,
        actor,
        messages: baseMessages,
        tools: input.tools,
        selectedModel: runtime.model,
      });
      const abortController = new AbortController();
      actor.llmAbortController = abortController;
      try {
      const providerMessages = prepareMessagesForLlmAdapter(runtime.llmAdapter, executionMessages);
      const { stream } = await runtime.llmAdapter.createStream({
        model: runtime.model,
        messages: providerMessages,
        tools: input.tools,
        extraBody: {
          ...(runtime.extraBody ?? {}),
          prompt_plan: promptPlan,
          work_context: getActorWorkContext(actor),
        },
        signal: abortController.signal,
      });
      return await runtime.processStreamFn(runtime.vm, stream);
      } finally {
        if (actor.llmAbortController === abortController) actor.llmAbortController = null;
      }
    },
    output: (_self, _payload, state, _derived, msg) => {
      if (llmAdapter.type === "anthropic" || llmAdapter.type === "claude") {
        if (!Array.isArray(msg.content_parts)) msg.content_parts = [];
        if (msg.reasoning_content && !msg.content_parts.find((p: any) => p?.type === "reasoning")) {
          msg.content_parts.push({ type: "reasoning", text: String(msg.reasoning_content) });
        }
        if (msg.content && !msg.content_parts.find((p: any) => p?.type === "text")) {
          msg.content_parts.push({ type: "text", text: String(msg.content) });
        }
      }
      messages.push(msg);
      state.msg = msg;
      state.toolCalls = msg.tool_calls || msg.toolCalls || [];
    },
  });

  const toolCallPipeline = createPipelineHandler<
    AiAgentVm,
    ToolCallPipelineSchema,
    ToolCallPipelineState,
    { tc: any },
    { vm: AiAgentVm; actor: AiAgentActor; toolRegistry: ToolFuncRegistryData },
    { tc: any },
    Record<string, never>,
    ToolCallPipelineResult
  >({
    computeDerived: (_self, payload) => ({ tc: payload.tc }),
    innerRuntime: () => ({ vm, actor, toolRegistry }),
    innerInput: (_self, _payload, _state, derived) => ({ tc: derived.tc }),
    innerConfig: () => ({}),
    coreLogic: async (runtime, input) => {
      const tc = input.tc;
      const funcName = tc.function?.name || "";
      let args: any = {};
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        args = {};
      }
      const prettyArgs = JSON.stringify(args, null, 2);
      const toolCallId = tc.id || "";

      if (eventBus) {
        eventBus.emitToolCallStart(eventActor, funcName, toolCallId, prettyArgs);
      }

      const output = isToolAllowed(runtime.actor, funcName)
        ? (() => {
            const planGate = isToolAllowedByPlanApprovalGate(runtime.vm, runtime.actor, funcName);
            if (!planGate.ok) {
              return planGate.error as unknown;
            }
            const gate = isToolAllowedByGate(runtime.vm, funcName);
            if (!gate.ok) {
              return gate.error as unknown;
            }
            return null as unknown;
          })()
        : `Error: policy violation: tool '${funcName}' is disabled`;

      const resolvedOutput =
        output === null
          ? await ToolFuncRegistry.call(runtime.toolRegistry, funcName, runtime.vm, runtime.actor, args, { toolCallId })
          : output;
      const outputText =
        typeof resolvedOutput === "string" ? resolvedOutput : resolvedOutput === undefined ? "" : JSON.stringify(resolvedOutput);

      return {
        funcName,
        toolCallId,
        args,
        output: resolvedOutput,
        outputText,
      };
    },
    output: (_self, _payload, state, _derived, result) => {
      const { funcName, toolCallId, output, outputText } = result;
      const suppress = shouldSuppressToolResultMessage(String(funcName ?? ""), String(outputText ?? ""));
      if (eventBus && !suppress) {
        const resultPayload = typeof output === "string" ? output : output === undefined ? "" : JSON.stringify(output);
        eventBus.emitToolCallResult(eventActor, funcName, toolCallId, resultPayload, outputText.startsWith("Error:"));
      }

      if (!suppress && (llmAdapter.type === "anthropic" || llmAdapter.type === "claude")) {
        const toolName = funcName || "";
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          tool_name: toolName,
          content: output,
          content_parts: [
            {
              type: "tool-result",
              toolCallId,
              toolName,
              output: { type: "text", value: output },
            },
          ],
        });
      } else if (!suppress) {
        messages.push({ role: "tool", tool_call_id: toolCallId, content: output });
      }

      advanceActorWorkContextAfterTool({
        actor,
        toolName: String(funcName ?? ""),
        args: result.args,
      });

      state.result = result;
    },
  });

   const toolOutputDispatch = createDispatchHandler<AiAgentVm, ToolOutputDispatchSchema, ToolOutputDispatchState>([
     {
       tags: ["toolOutput"],
       resolveKey: (envelope) =>
         classifyToolOutput({
           actor,
           funcName: envelope.payload.result.funcName,
           toolCallId: envelope.payload.result.toolCallId,
           outputText: envelope.payload.result.outputText,
         }),
       routes: {
         questionnaire_wait: async (self, envelope) => {
           const result = envelope.payload.result;
           const pending = findQuestionnairePendingControl(actor, result.toolCallId);
           const pendingId = pending?.questionnaireId;
           const stored = pendingId ? (actor.pendingQuestionnaires as any)?.[pendingId] : undefined;
           const req = stored ?? normalizeQuestionnaireRequestArgs(result.args, result.toolCallId);

           // Backstop: if a custom Questionnaire tool didn't mark pending, do it here.
           if (!pendingId) {
             actor.pendingQuestionnaires[req.questionnaireId] = req;
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
           eventBus?.emitAgentTurnEnd(eventActor, "questionnaire_wait");
           self.state.stopReason = "questionnaire_wait";
         },
        child_wait: async (self, _envelope) => {
          if (eventBus) {
            eventBus.emitAgentTurnEnd(eventActor, "child_wait");
          }
          self.state.stopReason = "child_wait";
        },
        stop_agent: async (self) => {
          if (eventBus) {
            eventBus.emitAgentTurnEnd(eventActor, "stop_agent");
          }
          self.state.stopReason = "stop_agent";
        },
        continue: async () => {},
      },
    },
  ]);

  const stageDispatch = createDispatchHandler<AiAgentVm, ExecutorStageSchema, ExecutorStageState>([
    {
      tags: ["stage"],
      resolveKey: (envelope) => envelope.payload.key,
      routes: {
        drain: async (self) => {
          const drained = await drainActorMailboxes(vm, actor, messages);
          if (drained.stopReason) {
            self.state.stopReason = drained.stopReason;
          }
        },
        compress: async () => {
          await maybeCompressMessages({
            vm,
            actor,
            messages,
            llmAdapter,
            model,
            processStreamFn,
          });
        },
        llm: async (self) => {
          const llmState: LlmTurnPipelineState = {
            msg: null,
            toolCalls: [],
          };
          const llmSelf = createExecutorSelf<LlmTurnPipelineSchema, LlmTurnPipelineState>(vm, llmState);
          await runHookedStage("pipeline:llm", self.state.turn, vm, actor, messages, async () => {
            await llmTurnPipeline(llmSelf, createExecutorEnvelope<LlmTurnPipelineSchema, "llmTurn">("llmTurn", { tools: self.state.tools }));
          });
          self.state.toolCalls = llmState.toolCalls;
        },
      },
    },
  ]);

  const stopWith = (reason: AgentLoopResult["stopReason"]): AgentLoopResult => {
    if (isDebugEnabled()) {
      console.log(`[ai-loop] stop_reason=${reason}`);
    }
    if (reason !== "questionnaire_wait" && reason !== "child_wait" && reason !== "stop_agent" && eventBus) {
      eventBus.emitAgentTurnEnd(eventActor, reason);
    }
    return { messages, stopReason: reason };
  };

  try {
    while (true) {
      turn += 1;
      const stageState: ExecutorStageState = {
        turn,
        tools,
        toolCalls: [],
        stopReason: null,
      };
      const stageSelf = createExecutorSelf<ExecutorStageSchema, ExecutorStageState>(vm, stageState);

      await runHookedStage("dispatch:drain", turn, vm, actor, messages, async () => {
        await stageDispatch(stageSelf, createExecutorEnvelope<ExecutorStageSchema, "stage">("stage", { key: "drain" }));
      });

      if (stageState.stopReason) {
        return stopWith(stageState.stopReason);
      }

      await runHookedStage("dispatch:compress", turn, vm, actor, messages, async () => {
        await stageDispatch(stageSelf, createExecutorEnvelope<ExecutorStageSchema, "stage">("stage", { key: "compress" }));
      });

      if (eventBus) {
        eventBus.emitAgentTurnStart(eventActor, turn);
      }

      await runHookedStage("dispatch:llm", turn, vm, actor, messages, async () => {
        await stageDispatch(stageSelf, createExecutorEnvelope<ExecutorStageSchema, "stage">("stage", { key: "llm" }));
      });

      const toolCalls = stageState.toolCalls;
      if (!toolCalls || !toolCalls.length) {
        emitMemberResultToControl(vm, actor, messages);
        return stopWith("no_tool_calls");
      }

      for (const tc of toolCalls) {
        const toolState: ToolCallPipelineState = {
          result: null,
        };
        const toolSelf = createExecutorSelf<ToolCallPipelineSchema, ToolCallPipelineState>(vm, toolState);
        await runHookedStage("pipeline:tool", turn, vm, actor, messages, async () => {
          await toolCallPipeline(toolSelf, createExecutorEnvelope<ToolCallPipelineSchema, "toolCall">("toolCall", { tc }));
        });

        const result = toolState.result;
        if (!result) {
          continue;
        }

        const outputState: ToolOutputDispatchState = {
          stopReason: null,
        };
        const outputSelf = createExecutorSelf<ToolOutputDispatchSchema, ToolOutputDispatchState>(vm, outputState);
        await runHookedStage("dispatch:tool-output", turn, vm, actor, messages, async () => {
          await toolOutputDispatch(
            outputSelf,
            createExecutorEnvelope<ToolOutputDispatchSchema, "toolOutput">("toolOutput", { result }),
          );
        });

        if (outputState.stopReason) {
          return stopWith(outputState.stopReason);
        }

        if (stopAfterFirstTool) {
          return stopWith("stop_after_tool");
        }

        if (stopAfterTools.length && stopAfterTools.includes(result.funcName)) {
          return stopWith("stop_after_tool");
        }
      }

      if (exitAfterToolResult) {
        return stopWith("exit_after_tool_result");
      }

      if (maxIterations !== undefined && turn >= maxIterations) {
        return stopWith("max_iterations");
      }

      if (isDebugEnabled()) {
        console.log("[ai-loop] continue");
      }

      tools = buildToolsetFn().filter((tool: any) => isToolAllowed(actor, getToolName(tool)));
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
  inflight?:
    | { kind: "compress"; opId: string }
    | { kind: "llm"; opId: string; turn: number; tools: any[] }
    | { kind: "tool"; opId: string; funcName: string; toolCallId: string; args: any }
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
        | "human_clarification"
        | "human_approval"
        | "human_answer";
      suspendPolicy?: "continue_others" | "pause_all";
    }
  | { kind: "complete" }
  | { kind: "cancel"; reason: string; propagateToChildren?: boolean }
  | { kind: "fail"; error: string };

function ensureCooperativeState(state: AiAgentCooperativeExecState | undefined, vm: AiAgentVm, actor: AiAgentActor): AiAgentCooperativeExecState {
  if (state) {
    return state;
  }

  const detach = isHistoryTrackedActor(actor) ? attachMessageHistory(vm) : () => {};
  return {
    phase: "drain",
    turn: 0,
    tools: [],
    toolCalls: [],
    toolIndex: 0,
    nextOpSeq: 1,
    pendingToolResults: [],
    pendingAiGenerated: [],
    inflight: undefined,
    messageHistoryAttached: isHistoryTrackedActor(actor),
    messageHistoryDetach: detach,
  };
}

function detachCooperativeHistory(state: AiAgentCooperativeExecState): void {
  if (!state.messageHistoryAttached) {
    return;
  }
  try {
    state.messageHistoryDetach?.();
  } catch {
    // ignore
  }
  state.messageHistoryAttached = false;
  state.messageHistoryDetach = undefined;
}

function pumpAiGeneratedMailbox(actor: AiAgentActor, state: AiAgentCooperativeExecState): void {
  const drained = actor.drainMailbox("aiGenerated") as any[];
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

function mapQuestionnaireKindToWait(kind: unknown): "human_clarification" | "human_approval" | "human_answer" {
  if (kind === "clarification") return "human_clarification";
  if (kind === "approval") return "human_approval";
  return "human_answer";
}

function normalizeSuspendPolicy(value: unknown): "continue_others" | "pause_all" {
  return value === "continue_others" ? "continue_others" : "pause_all";
}

export async function aiAgentCooperativeStep(params: {
  fiberId: string;
  vm: AiAgentVm;
  actor: AiAgentActor;
  messages: any[];
  state?: AiAgentCooperativeExecState;
  setState: (state: AiAgentCooperativeExecState) => void;
  resumeFiber: (fiberId: string) => void;
}): Promise<AiAgentFiberStepOutcome> {
  const { fiberId, vm, actor, messages } = params;
  const eventBus = vm.eventBus;
  const eventActor = toEventActorRef(actor);

  const state = ensureCooperativeState(params.state, vm, actor);
  pumpAiGeneratedMailbox(actor, state);

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
    return { kind: "suspend", reason: "external" };
  }

  if (isAutonomousHolonActor(actor)) {
    drainAutonomousHolonActorInbox(vm, actor);
    params.setState(state);
    return { kind: "suspend", reason: "external" };
  }

  if (isLeaderLedHolonActor(actor)) {
    drainLeaderLedHolonActorInbox(vm, actor);
    params.setState(state);
    return { kind: "suspend", reason: "external" };
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
        actor.hasPending("coordination") ||
        actor.hasPending("memberInbox") ||
        actor.hasPending("humanInput") ||
        actor.hasPending("toolResult");

  drainChildDoneIntoMessages(actor, messages);
  drainMemberInboxIntoMessages(vm, actor, messages);
  drainCoordinationIntoMessages(vm, actor, messages);
  drainHumanInputIntoMessages(vm, actor, messages);

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
        messages.some((message: any) => {
          const role = String(message?.role ?? "")
          return role !== "" && role !== "system"
        })

      if (!hadMailboxWork && state.pendingToolResults.length === 0 && !hasSeedMessages) {
        params.setState(state);
        return { kind: "suspend", reason: "external" };
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
            actor.send("aiGenerated", {
              kind: "questionnaire_parsed",
              opId,
              questionnaireId,
              toolCallId,
              rawText,
              parsed,
            } satisfies CooperativeAiGeneratedEvent as any);
          } catch (error) {
            actor.send("aiGenerated", {
              kind: "questionnaire_parsed",
              opId,
              questionnaireId,
              toolCallId,
              rawText,
              parsed: { status: "invalid", answers: {}, errors: [error instanceof Error ? error.message : String(error)] },
            } satisfies CooperativeAiGeneratedEvent as any);
          } finally {
            params.resumeFiber(fiberId);
          }
        })();

        return { kind: "suspend", reason: "external" };
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
        return { kind: "suspend", reason: "external" };
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
        if (eventBus && !shouldSuppressToolResultMessage(workspaceAccessGrantContext.toolName, outputText)) {
          const resultPayload =
            typeof resolvedOutput === "string"
              ? resolvedOutput
              : resolvedOutput === undefined
                ? ""
                : JSON.stringify(resolvedOutput);
          eventBus.emitToolCallResult(eventActor, workspaceAccessGrantContext.toolName, toolCallId, resultPayload, outputText.startsWith("Error:"));
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: resolvedOutput,
        });

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
        if (eventBus && !shouldSuppressToolResultMessage(localPermissionContext.toolName, outputText)) {
          const resultPayload =
            typeof resolvedOutput === "string"
              ? resolvedOutput
              : resolvedOutput === undefined
                ? ""
                : JSON.stringify(resolvedOutput);
          eventBus.emitToolCallResult(eventActor, localPermissionContext.toolName, toolCallId, resultPayload, outputText.startsWith("Error:"));
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: resolvedOutput,
        });

        state.phase = "compress";
        params.setState(state);
        return { kind: "yield" };
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify({
          questionnaireId,
          rawText,
          status: parsed.status,
          answers: parsed.answers,
          errors: parsed.errors ?? [],
        }),
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
          return { kind: "suspend", reason: "external" };
        }

        state.inflight = undefined;
        const compressedMessages = (ev as any).compressedMessages as any[] | null;
        if (Array.isArray(compressedMessages) && compressedMessages.length) {
          messages.length = 0;
          messages.push(...compressedMessages);
          try {
            await persistConversationCompaction({
              vm,
              actor,
              compressedMessages,
              policyContext:
                ((ev as any).policyContext as CompactionPolicyContextData | undefined)
                ?? buildCompactionPolicyContextForActor({
                  actor,
                  messages,
                  trigger: "auto_threshold",
                  mode: "auto",
                  tokensBefore: estimateTokens(messages),
                }),
              policyDecision:
                ((ev as any).policyDecision as CompactionPolicyDecisionData | undefined)
                ?? decideCompactionPolicy(
                  buildCompactionPolicyContextForActor({
                    actor,
                    messages,
                    trigger: "auto_threshold",
                    mode: "auto",
                    tokensBefore: estimateTokens(messages),
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

      if (!shouldCompressActorHistory(actor)) {
        state.phase = "start_llm";
        params.setState(state);
        return { kind: "yield" };
      }

      const inputLimit = actor.modelConfig.inputLimit ?? 0;
      if (inputLimit <= 0) {
        state.phase = "start_llm";
        params.setState(state);
        return { kind: "yield" };
      }

      const ratio = compressionDeps.estimateUsageRatio(messages, inputLimit);
      if (ratio < 0.85) {
        state.phase = "start_llm";
        params.setState(state);
        return { kind: "yield" };
      }
      resolveTurnWorkContextForActor({
        actor,
        messages,
        sessionId: typeof (vm.outerCtx?.metadata as any)?.sessionId === "string"
          ? String((vm.outerCtx?.metadata as any).sessionId)
          : undefined,
        trigger: "compress_gate",
      });
      const tokensBefore = estimateTokens(messages);
      const policyContext = buildCompactionPolicyContextForActor({
        actor,
        messages,
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

      const { llmAdapter, model, processStreamFn } = resolveLoopDeps(vm, actor);
      const opId = `compress:${fiberId}:${state.nextOpSeq++}`;
      state.inflight = { kind: "compress", opId };
      params.setState(state);

      void (async () => {
        let compressedMessages: any[] | null = null;
        try {
          try {
            await vm.effects.messageHistory?.backupHistory?.({
              agentKey: actor.key,
              agentActorId: actor.id,
              actorType: actor.type,
            });
          } catch (error) {
            vm.effects.log?.("warn", "history backup failed", { error });
          }

          compressedMessages = await compressionDeps.compressHistory({
            messages,
            llmAdapter,
            model,
            inputLimit,
            logger: {
              warn: (message: string, error?: unknown) =>
                vm.effects.log?.("warn", message, error === undefined ? undefined : { error }),
            },
            processStream: (stream) => processStreamFn(vm, stream),
          });
        } catch (error) {
          vm.effects.log?.("warn", "history compression failed", { error });
          compressedMessages = null;
        } finally {
          actor.send("aiGenerated", {
            kind: "compress_done",
            opId,
            compressedMessages,
            policyContext,
            policyDecision,
          } satisfies CooperativeAiGeneratedEvent as any);
          params.resumeFiber(fiberId);
        }
      })();

      return { kind: "suspend", reason: "external" };
    }

    if (state.phase === "start_llm") {
      const { llmAdapter, model, buildToolsetFn, processStreamFn, extraBody } = resolveLoopDeps(vm, actor);
      const tools = buildToolsetFn().filter((tool: any) => isToolAllowed(actor, getToolName(tool)));
      const sessionId = typeof (vm.outerCtx?.metadata as any)?.sessionId === "string"
        ? String((vm.outerCtx?.metadata as any).sessionId)
        : "default";
      resolveTurnWorkContextForActor({
        actor,
        messages,
        sessionId,
        trigger: "turn_start",
      });
      const baseMessages = withIdentityReinjection(messages, actor);
      const { promptPlan, executionMessages } = materializeExecutionMessagesWithWorkContext({
        actor,
        messages: baseMessages,
        tools,
        sessionId,
        selectedModel: model,
      });
      recordPromptPlanForActorExecution({
        vm,
        actor,
        messages: baseMessages,
        tools,
        selectedModel: model,
      });

      state.turn += 1;
      const turn = state.turn;
      eventBus?.emitAgentTurnStart(eventActor, turn);

      const opId = `llm:${fiberId}:${state.nextOpSeq++}`;
      state.inflight = { kind: "llm", opId, turn, tools };
      state.tools = tools;
      state.toolCalls = [];
      state.toolIndex = 0;
      state.phase = "wait_llm";
      params.setState(state);

      void (async () => {
        const abortController = new AbortController();
        actor.llmAbortController = abortController;
        try {
          const providerMessages = prepareMessagesForLlmAdapter(llmAdapter, executionMessages);
          const { stream } = await llmAdapter.createStream({
          model,
          messages: providerMessages,
          tools,
          extraBody: {
            ...(extraBody ?? {}),
            prompt_plan: promptPlan,
            work_context: getActorWorkContext(actor),
          },
          signal: abortController.signal,
        });
          const msg = await processStreamFn(vm, stream);
          if (abortController.signal.aborted) {
            return;
          }
          if (llmAdapter.type === "anthropic" || llmAdapter.type === "claude") {
            if (!Array.isArray(msg.content_parts)) msg.content_parts = [];
            if (msg.reasoning_content && !msg.content_parts.find((p: any) => p?.type === "reasoning")) {
              msg.content_parts.push({ type: "reasoning", text: String(msg.reasoning_content) });
            }
            if (msg.content && !msg.content_parts.find((p: any) => p?.type === "text")) {
              msg.content_parts.push({ type: "text", text: String(msg.content) });
            }
          }
          actor.send("aiGenerated", { kind: "llm_done", opId, msg } satisfies CooperativeAiGeneratedEvent as any);
        } catch (error) {
          if (abortController.signal.aborted) {
            return;
          }
          const message = `Error: ${error instanceof Error ? error.message : String(error)}`;
          emitVisibleAssistantError(vm, actor, message);
          actor.send("aiGenerated", {
            kind: "llm_done",
            opId,
            msg: { role: "assistant", content: message },
          } satisfies CooperativeAiGeneratedEvent as any);
        } finally {
          if (actor.llmAbortController === abortController) actor.llmAbortController = null;
          if (!abortController.signal.aborted) {
            params.resumeFiber(fiberId);
          }
        }
      })();

      return { kind: "suspend", reason: "external" };
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
        return { kind: "suspend", reason: "external" };
      }

      state.inflight = undefined;
      const msg = (ev as any).msg;
      messages.push(msg);
      const toolCalls = msg?.tool_calls || msg?.toolCalls || [];
      state.toolCalls = Array.isArray(toolCalls) ? toolCalls : [];
      state.toolIndex = 0;

      if (!state.toolCalls.length) {
        emitMemberResultToControl(vm, actor, messages);
        if (eventBus) {
          eventBus.emitAgentTurnEnd(eventActor, "no_tool_calls");
        }
        state.phase = "drain";
        params.setState(state);
        if (isDelegateActor(actor)) {
          detachCooperativeHistory(state);
          return { kind: "complete" };
        }
        return { kind: "suspend", reason: "external" };
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
          return { kind: "suspend", reason: "external" };
        }
        if (maxIterations !== undefined && state.turn >= maxIterations) {
          eventBus?.emitAgentTurnEnd(eventActor, "max_iterations");
          state.phase = "drain";
          params.setState(state);
          return { kind: "suspend", reason: "external" };
        }

        // next turn
        state.phase = "start_llm";
        params.setState(state);
        return { kind: "yield" };
      }

      const { toolRegistry } = resolveLoopDeps(vm, actor);
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

      const opId = `tool:${fiberId}:${state.nextOpSeq++}`;
      state.inflight = { kind: "tool", opId, funcName, toolCallId, args };
      state.phase = "wait_tool";
      params.setState(state);

      void (async () => {
        try {
          const output = isToolAllowed(actor, funcName)
            ? (() => {
                const planGate = isToolAllowedByPlanApprovalGate(vm, actor, funcName);
                if (!planGate.ok) {
                  return planGate.error as unknown;
                }
                const gate = isToolAllowedByGate(vm, funcName);
                if (!gate.ok) {
                  return gate.error as unknown;
                }
                return null as unknown;
              })()
            : `Error: policy violation: tool '${funcName}' is disabled`;

          const resolvedOutput =
            output === null ? await ToolFuncRegistry.call(toolRegistry, funcName, vm, actor, args, { toolCallId }) : output;
          const outputText =
            typeof resolvedOutput === "string" ? resolvedOutput : resolvedOutput === undefined ? "" : JSON.stringify(resolvedOutput);
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
          actor.send("aiGenerated", {
            kind: "tool_done",
            opId,
            funcName,
            toolCallId,
            args,
            output: resolvedOutput,
            outputText,
          } satisfies CooperativeAiGeneratedEvent as any);
        } catch (error) {
          const outputText = `Error: ${error instanceof Error ? error.message : String(error)}`;
          if (eventBus) {
            eventBus.emitToolCallResult(eventActor, funcName, toolCallId, outputText, true);
          }
          actor.send("aiGenerated", {
            kind: "tool_done",
            opId,
            funcName,
            toolCallId,
            args,
            output: outputText,
            outputText,
          } satisfies CooperativeAiGeneratedEvent as any);
        } finally {
          params.resumeFiber(fiberId);
        }
      })();

      return { kind: "suspend", reason: "tool_result" };
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
        return { kind: "suspend", reason: "tool_result" };
      }

      state.inflight = undefined;
      const { llmAdapter } = resolveLoopDeps(vm, actor);
      const outputText = String((ev as any).outputText ?? "");
      const funcName = String((ev as any).funcName ?? "");
      const suppress = shouldSuppressToolResultMessage(funcName, outputText);

      if (!suppress && (llmAdapter.type === "anthropic" || llmAdapter.type === "claude")) {
        const toolName = String((ev as any).funcName ?? "");
        messages.push({
          role: "tool",
          tool_call_id: String((ev as any).toolCallId ?? ""),
          tool_name: toolName,
          content: (ev as any).output,
          content_parts: [
            {
              type: "tool-result",
              toolCallId: String((ev as any).toolCallId ?? ""),
              toolName,
              output: { type: "text", value: (ev as any).output },
            },
          ],
        });
      } else if (!suppress) {
        messages.push({ role: "tool", tool_call_id: String((ev as any).toolCallId ?? ""), content: (ev as any).output });
      }
      advanceActorWorkContextAfterTool({
        actor,
        toolName: funcName,
        args: (ev as any).args,
      });

      const toolCallId = String((ev as any).toolCallId ?? "");
      const pending = findQuestionnairePendingControl(actor, toolCallId);
      if (pending) {
        const stored = (actor.pendingQuestionnaires as any)?.[pending.questionnaireId];
        const req = stored ?? normalizeQuestionnaireRequestArgs((ev as any).args, toolCallId);

        // Backstop: if a custom Questionnaire tool didn't mark pending, do it here.
        if (!stored) {
          actor.pendingQuestionnaires[req.questionnaireId] = req;
          actor.send("control", {
            kind: "questionnaire_pending",
            toolCallId: req.toolCallId,
            questionnaireId: req.questionnaireId,
            suspendPolicy: req.suspendPolicy,
          });
          eventBus?.emitQuestionnaireRequest(eventActor, req);
        }

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
        return { kind: "suspend", reason: "external" };
      }

      if (stopAfterTools.length && stopAfterTools.includes(String((ev as any).funcName ?? ""))) {
        eventBus?.emitAgentTurnEnd(eventActor, "stop_after_tool");
        state.phase = "drain";
        params.setState(state);
        if (isDelegateActor(actor)) {
          detachCooperativeHistory(state);
          return { kind: "complete" };
        }
        return { kind: "suspend", reason: "external" };
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
