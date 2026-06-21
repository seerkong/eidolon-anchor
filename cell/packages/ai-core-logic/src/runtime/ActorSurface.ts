import type {
  ActorConversationLaneData,
  ActorRuntimeLaneData,
  ActorSurfaceCancelRequestData,
  ActorSurfaceSetModelConfigRequestData,
  ActorSurfaceBackendIdentityData,
  ActorSurfaceLaneStatus,
  ActorSurfaceProjectionData,
  ActorSurfaceTargetSelectorData,
  QuestionnaireSurfaceSubmitResultData,
  QuestionnaireSurfaceItemData,
} from "@cell/ai-core-contract/runtime/ActorSurface";
import type { ActorIdentity, AiAgentMailboxSchema } from "@cell/ai-core-contract/runtime/AiAgentActor";
import type { QuestionnaireRow } from "@cell/ai-core-contract/runtime/Questionnaire";
import { createActor, type AiAgentActor } from "./actor";
import type { AiAgentVm, VmHolonRecord, VmMemberRosterEntry } from "./runtime";
import { ensureVmSessionState, getControlActor } from "./runtime";
import { answerQuestionnaireRow, questionnaireRowFromPendingActorRequest } from "./QuestionnaireRows";

export type BuildActorSurfaceProjectionOptions = {
  selectedLaneId?: string;
  selectedActorId?: string;
};

export type ActorSurfaceFacade = {
  getActorSurface: (options?: BuildActorSurfaceProjectionOptions) => ActorSurfaceProjectionData;
  selectActorSurfaceTarget: (target: ActorSurfaceTargetSelectorData) => ActorSurfaceProjectionData;
  sendActorHumanMessage: (target: ActorSurfaceTargetSelectorData, text: string) => ActorSurfaceProjectionData;
  cancelActorTurn: (request: ActorSurfaceCancelRequestData) => ActorSurfaceProjectionData;
  setActorModelConfig: (request: ActorSurfaceSetModelConfigRequestData) => ActorSurfaceProjectionData;
  submitQuestionnaireResponse: (
    questionnaireId: string,
    responseText: string,
  ) => QuestionnaireSurfaceSubmitResultData;
};

export type ActorSurfaceFacadeOptions = {
  emitFiberSignal?: (input: {
    actor: AiAgentActor;
    fiberId: string;
    signalKind: "mailbox_enqueue" | "interrupt_requested";
    mailbox: { kind: keyof AiAgentMailboxSchema; payload: unknown };
    toolCallId?: string;
    idempotencyKey: string;
    createdAt: number;
  }) => void;
  now?: () => number;
};

function emitActorSurfaceMailbox(
  options: ActorSurfaceFacadeOptions,
  input: {
    actor: AiAgentActor;
    signalKind: "mailbox_enqueue" | "interrupt_requested";
    mailbox: { kind: keyof AiAgentMailboxSchema; payload: unknown };
    toolCallId?: string;
    idempotencyKey: string;
    createdAt: number;
  },
): void {
  const fiberId = actorFiberId(input.actor);
  if (options.emitFiberSignal) {
    options.emitFiberSignal({
      actor: input.actor,
      fiberId,
      signalKind: input.signalKind,
      mailbox: input.mailbox,
      toolCallId: input.toolCallId,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.createdAt,
    });
    return;
  }

  input.actor.send(input.mailbox.kind as any, input.mailbox.payload as any);
}

function actorHasPendingQuestionnaire(actor: AiAgentActor): boolean {
  return Object.keys(actor.pendingQuestionnaires ?? {}).length > 0
    || actor.peekMailbox("control").some((entry) => entry.kind === "questionnaire_pending");
}

function actorHasCancelRequested(actor: AiAgentActor): boolean {
  return actor.peekMailbox("control").some((entry) => entry.kind === "cancel_requested");
}

function actorRuntimeStatus(actor: AiAgentActor): ActorSurfaceLaneStatus {
  if (actorHasCancelRequested(actor)) return "cancel_requested";
  if (actorHasPendingQuestionnaire(actor)) return "waiting_for_human";
  if (actor.detachedTask?.status === "suspended") return "suspended";
  if (actor.detachedTask?.status === "completed") return "completed";
  if (actor.detachedTask?.status === "failed") return "failed";
  if (actor.detachedTask?.status === "cancelled") return "cancel_requested";
  if (actor.llmAbortController || actor.stream) return "running";
  return "idle";
}

function actorDisplayName(actor: AiAgentActor): string {
  return actor.agentName
    ?? actor.identity?.name
    ?? actor.detachedTask?.taskId
    ?? actor.key;
}

function actorWorkSessionId(actor: AiAgentActor): string | undefined {
  return actor.workContext?.sessionId;
}

function actorFiberId(actor: AiAgentActor): string {
  return `${actor.key}:${actor.id}`;
}

function backendIdentityForActor(actor: AiAgentActor): ActorSurfaceBackendIdentityData {
  if (actor.type === "primary") {
    return {
      kind: "primary",
      name: actorDisplayName(actor),
      agentName: actor.agentName,
    };
  }

  if (actor.identity?.kind === "member") {
    return {
      kind: "member",
      memberId: actor.identity.memberId,
      name: actor.identity.name,
      role: actor.identity.role,
      agentType: actor.identity.agentType,
      metadata: actor.identity.lane ? { schedulerLane: actor.identity.lane } : undefined,
    };
  }

  if (actor.identity?.kind === "holon") {
    return {
      kind: "holon",
      holonId: actor.identity.holonId,
      name: actor.identity.name,
      governance: actor.identity.governance,
      leaderMemberId: actor.identity.leaderId,
    };
  }

  return {
    kind: "agent",
    name: actorDisplayName(actor),
    agentName: actor.agentName,
  };
}

function backendIdentityForMember(member: VmMemberRosterEntry): ActorSurfaceBackendIdentityData {
  return {
    kind: "member",
    memberId: member.memberId,
    name: member.name,
    role: member.role,
    agentType: member.agentType,
    metadata: {
      schedulerLane: member.lane,
      fiberId: member.fiberId,
    },
  };
}

function backendIdentityForHolon(holon: VmHolonRecord): ActorSurfaceBackendIdentityData {
  return {
    kind: "holon",
    holonId: holon.holonId,
    name: holon.name,
    governance: holon.governance,
    leaderMemberId: holon.leaderMemberId,
    metadata: {
      memberIds: [...holon.memberIds],
      watchState: holon.watchState,
    },
  };
}

function findActorByIdentity(
  actors: AiAgentActor[],
  predicate: (identity: ActorIdentity) => boolean,
): AiAgentActor | undefined {
  return actors.find((actor) => actor.identity && predicate(actor.identity));
}

function buildPrimaryLane(
  actor: AiAgentActor | undefined,
  backendIdentity?: ActorSurfaceBackendIdentityData,
): ActorConversationLaneData {
  return {
    laneId: "lane:primary",
    kind: "primary",
    displayName: actor ? actorDisplayName(actor) : "Primary",
    backendIdentity: backendIdentity ?? (actor
      ? backendIdentityForActor(actor)
      : { kind: "primary", name: "Primary" }),
    actorId: actor?.id,
    actorKey: actor?.key,
    initialized: Boolean(actor),
    status: actor ? actorRuntimeStatus(actor) : "unknown",
    metadata: actor?.workContext ? { workContext: actor.workContext } : undefined,
  };
}

function buildMemberLane(member: VmMemberRosterEntry, actor?: AiAgentActor): ActorConversationLaneData {
  return {
    laneId: `lane:member:${member.memberId}`,
    kind: "member",
    displayName: member.name,
    backendIdentity: backendIdentityForMember(member),
    actorId: actor?.id,
    actorKey: actor?.key,
    initialized: Boolean(actor),
    status: actor ? actorRuntimeStatus(actor) : "idle",
    metadata: {
      lifecycleState: member.lifecycleState,
      createdAt: member.createdAt,
      lastActiveAt: member.lastActiveAt,
      workContext: actor?.workContext,
    },
  };
}

function buildHolonLane(holon: VmHolonRecord, actor?: AiAgentActor): ActorConversationLaneData {
  return {
    laneId: `lane:holon:${holon.holonId}`,
    kind: "holon",
    displayName: holon.name,
    backendIdentity: backendIdentityForHolon(holon),
    actorId: actor?.id,
    actorKey: actor?.key,
    initialized: Boolean(actor),
    status: actor ? actorRuntimeStatus(actor) : "idle",
    metadata: {
      governance: holon.governance,
      watchState: holon.watchState,
      createdAt: holon.createdAt,
      updatedAt: holon.updatedAt,
      workContext: actor?.workContext,
    },
  };
}

function buildActorLane(actor: AiAgentActor): ActorRuntimeLaneData {
  const runtimeStatus = actorRuntimeStatus(actor);
  const hasActiveTurn = Boolean(actor.llmAbortController || actor.stream);
  return {
    actorId: actor.id,
    actorKey: actor.key,
    actorType: actor.type,
    displayName: actorDisplayName(actor),
    identity: actor.identity,
    transcriptKey: {
      sessionId: actorWorkSessionId(actor),
      actorId: actor.id,
      actorKey: actor.key,
    },
    runtimeStatus,
    activeTurnId: hasActiveTurn ? actorFiberId(actor) : undefined,
    cancellable: hasActiveTurn,
    metadata: {
      parentKey: actor.parentKey,
      detachedTask: actor.detachedTask,
      watchState: actor.watchState,
      workContext: actor.workContext,
    },
  };
}

type PendingQuestionnaireControlEntry = Extract<
  AiAgentMailboxSchema["control"],
  { kind: "questionnaire_pending" }
>;

function isPendingQuestionnaireControlEntry(
  entry: AiAgentMailboxSchema["control"],
): entry is PendingQuestionnaireControlEntry {
  return entry.kind === "questionnaire_pending";
}

function controlEntryForQuestionnaire(
  actor: AiAgentActor,
  questionnaireId: string,
): PendingQuestionnaireControlEntry | undefined {
  return actor.peekMailbox("control")
    .filter(isPendingQuestionnaireControlEntry)
    .find((entry) => entry.questionnaireId === questionnaireId);
}

function buildTransientQuestionnaireRowsForActor(
  actor: AiAgentActor,
  durableRows: Record<string, QuestionnaireRow>,
  answeredQuestionnaires: Record<string, QuestionnaireSurfaceItemData>,
): QuestionnaireRow[] {
  return Object.entries(actor.pendingQuestionnaires ?? {})
    .filter(([fallbackId, request]) => {
      const questionnaireId = request.questionnaireId || fallbackId;
      return !durableRows[questionnaireId] && !answeredQuestionnaires[questionnaireId];
    })
    .map(([fallbackId, request]) => {
      const questionnaireId = request.questionnaireId || fallbackId;
      const controlEntry = controlEntryForQuestionnaire(actor, questionnaireId);
      return questionnaireRowFromPendingActorRequest({
        actor,
        request: {
          ...request,
          toolCallId: request.toolCallId ?? controlEntry?.toolCallId ?? "",
          suspendPolicy: request.suspendPolicy ?? controlEntry?.suspendPolicy ?? "pause_all",
        },
        fallbackId,
        existing: durableRows[request.questionnaireId || fallbackId],
      });
    });
}

function questionnaireRowToSurfaceItem(row: QuestionnaireRow): QuestionnaireSurfaceItemData {
  return {
    questionnaireId: row.questionnaireId,
    sessionId: row.sessionId,
    ownerActorId: row.ownerActorId,
    ownerActorKey: row.ownerActorKey,
    ownerFiberId: row.ownerFiberId,
    toolCallId: row.toolCallId,
    request: row.request,
    result: row.result,
    suspendPolicy: row.suspendPolicy,
    lifecycleState: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata,
  };
}

function refreshRuntimeGlobalQuestionnaireIndex(vm: AiAgentVm): QuestionnaireSurfaceItemData[] {
  const sessionState = ensureVmSessionState(vm);
  const durableRows = { ...(sessionState.questionnaires ?? {}) };
  const projectionRows: Record<string, QuestionnaireRow> = { ...durableRows };
  for (const actor of Object.values(vm.actors ?? {})) {
    for (const row of buildTransientQuestionnaireRowsForActor(actor, durableRows, sessionState.actorSurface.answeredQuestionnaires)) {
      projectionRows[row.questionnaireId] = row;
    }
  }
  const pending = Object.fromEntries(
    Object.values(projectionRows)
      .filter((row) => row.status === "pending")
      .map((row) => [row.questionnaireId, questionnaireRowToSurfaceItem(row)]),
  );
  const answered = Object.fromEntries(
    Object.values(projectionRows)
      .filter((row) => row.status === "answered")
      .map((row) => [row.questionnaireId, questionnaireRowToSurfaceItem(row)]),
  );
  sessionState.actorSurface.pendingQuestionnaires = pending;
  sessionState.actorSurface.answeredQuestionnaires = answered;
  return Object.values(pending);
}

export function buildActorSurfaceProjection(
  vm: AiAgentVm,
  options: BuildActorSurfaceProjectionOptions = {},
): ActorSurfaceProjectionData {
  const actors = Object.values(vm.actors ?? {});
  const sessionState = ensureVmSessionState(vm);
  const selectedLaneId = options.selectedLaneId ?? sessionState.actorSurface.selectedLaneId ?? "lane:primary";
  const selectedActorId = options.selectedActorId
    ?? sessionState.actorSurface.selectedActorId
    ?? findActorForLane(vm, selectedLaneId)?.id;
  const controlActor = getControlActor(vm);

  const conversationLanes: ActorConversationLaneData[] = [
    buildPrimaryLane(controlActor, sessionState.actorSurface.primaryBackendIdentity),
  ];

  for (const member of Object.values(sessionState.memberRoster)
    .sort((left, right) => left.memberId.localeCompare(right.memberId))) {
    const actor = findActorByIdentity(actors, (identity) => (
      identity.kind === "member" && identity.memberId === member.memberId
    ));
    conversationLanes.push(buildMemberLane(member, actor));
  }

  for (const holon of Object.values(sessionState.holons)
    .sort((left, right) => left.holonId.localeCompare(right.holonId))) {
    const actor = findActorByIdentity(actors, (identity) => (
      identity.kind === "holon" && identity.holonId === holon.holonId
    ));
    conversationLanes.push(buildHolonLane(holon, actor));
  }

  const actorLanes = actors.map(buildActorLane);
  const questionnaireSurface = refreshRuntimeGlobalQuestionnaireIndex(vm);

  return {
    conversationLanes,
    actorLanes,
    selectedLaneId,
    selectedActorId,
    selectedTarget: {
      laneId: selectedLaneId,
      actorId: selectedActorId,
    },
    questionnaireSurface,
  };
}

export function createActorSurfaceFacade(vm: AiAgentVm, options: ActorSurfaceFacadeOptions = {}): ActorSurfaceFacade {
  function persistSelectedTarget(target: ActorSurfaceTargetSelectorData): void {
    const resolved = resolveActorSurfaceTarget(vm, target);
    const sessionState = ensureVmSessionState(vm);
    sessionState.actorSurface.selectedLaneId = resolved.laneId;
    sessionState.actorSurface.selectedActorId = resolved.actor?.id ?? target.actorId;
  }

  return {
    getActorSurface: (options) => buildActorSurfaceProjection(vm, options),
    selectActorSurfaceTarget: (target) => {
      persistSelectedTarget(target);
      return buildActorSurfaceProjection(vm);
    },
    sendActorHumanMessage: (target, text) => {
      const actor = ensureActorForSurfaceTarget(vm, target);
      const now = options.now?.() ?? Date.now();
      emitActorSurfaceMailbox(options, {
        actor,
        signalKind: "mailbox_enqueue",
        mailbox: { kind: "humanInput", payload: text },
        idempotencyKey: `${actorFiberId(actor)}:humanInput:${now}`,
        createdAt: now,
      });
      persistSelectedTarget({ actorId: actor.id, laneId: resolveLaneIdForActor(vm, actor) });
      return buildActorSurfaceProjection(vm);
    },
    cancelActorTurn: (request) => {
      const actor = findActorById(vm, request.actorId);
      if (actor) {
        const now = options.now?.() ?? Date.now();
        actor.llmAbortController?.abort();
        actor.llmAbortController = null;
        emitActorSurfaceMailbox(options, {
          actor,
          signalKind: "interrupt_requested",
          mailbox: { kind: "control", payload: { kind: "cancel_requested" } },
          idempotencyKey: `${actorFiberId(actor)}:cancel:${now}`,
          createdAt: now,
        });
      }
      return buildActorSurfaceProjection(vm);
    },
    setActorModelConfig: (request) => {
      const actor = ensureActorForSurfaceTarget(vm, request);
      const now = options.now?.() ?? Date.now();
      emitActorSurfaceMailbox(options, {
        actor,
        signalKind: "mailbox_enqueue",
        mailbox: {
          kind: "control",
          payload: {
            kind: "set_active_model_config",
            modelConfig: request.modelConfig,
            modelRef: request.modelRef,
            source: request.source,
            requestedBy: request.requestedBy,
            requestedAt: now,
          },
        },
        idempotencyKey: `${actorFiberId(actor)}:set_active_model_config:${request.modelRef ?? request.modelConfig.provider ?? ""}/${request.modelConfig.model ?? ""}:${now}`,
        createdAt: now,
      });
      persistSelectedTarget({ actorId: actor.id, laneId: resolveLaneIdForActor(vm, actor) });
      return buildActorSurfaceProjection(vm);
    },
    submitQuestionnaireResponse: (questionnaireId, responseText) => {
      return submitQuestionnaireResponseById(vm, questionnaireId, responseText, options);
    },
  };
}

function submitQuestionnaireResponseById(
  vm: AiAgentVm,
  questionnaireId: string,
  responseText: string,
  options: ActorSurfaceFacadeOptions = {},
): QuestionnaireSurfaceSubmitResultData {
  const normalizedId = questionnaireId.trim();
  if (!normalizedId) {
    return { status: "not_pending", projection: buildActorSurfaceProjection(vm) };
  }

  refreshRuntimeGlobalQuestionnaireIndex(vm);
  const sessionState = ensureVmSessionState(vm);
  const pending = sessionState.actorSurface.pendingQuestionnaires[normalizedId];
  if (!pending) {
    return { status: "not_pending", projection: buildActorSurfaceProjection(vm) };
  }

  const owner = findActorById(vm, pending.ownerActorId) ?? findActorByKey(vm, pending.ownerActorKey);
  if (!owner) {
    return { status: "owner_missing", projection: buildActorSurfaceProjection(vm) };
  }

  const now = options.now?.() ?? Date.now();
  emitActorSurfaceMailbox(options, {
    actor: owner,
    signalKind: "mailbox_enqueue",
    mailbox: {
      kind: "toolResult",
      payload: {
        toolCallId: pending.toolCallId,
        questionnaireId: normalizedId,
        content: responseText,
      },
    },
    toolCallId: pending.toolCallId,
    idempotencyKey: `${actorFiberId(owner)}:toolResult:${pending.toolCallId}:${now}`,
    createdAt: now,
  });
  owner.mailboxes.control = owner.mailboxes.control.filter((entry) => (
    entry.kind !== "questionnaire_pending" || entry.questionnaireId !== normalizedId
  ));

  delete sessionState.actorSurface.pendingQuestionnaires[normalizedId];
  const answered = {
    ...pending,
    result: {
      questionnaireId: normalizedId,
      toolCallId: pending.toolCallId,
      rawText: responseText,
      status: "ok",
      answers: { raw: responseText },
    },
    lifecycleState: "answered",
    updatedAt: now,
  };
  sessionState.actorSurface.answeredQuestionnaires[normalizedId] = answered;
  const answeredRow = answerQuestionnaireRow({
    vm,
    questionnaireId: normalizedId,
    result: answered.result,
    now,
  });
  if (!answeredRow) {
    ensureVmSessionState(vm).questionnaires[normalizedId] = {
      questionnaireId: answered.questionnaireId,
      sessionId: answered.sessionId,
      ownerActorId: answered.ownerActorId,
      ownerActorKey: answered.ownerActorKey,
      ownerFiberId: answered.ownerFiberId,
      toolCallId: answered.toolCallId,
      request: answered.request,
      result: answered.result,
      suspendPolicy: answered.suspendPolicy,
      status: "answered",
      createdAt: answered.createdAt ?? now,
      updatedAt: now,
      metadata: answered.metadata,
    };
  }

  return { status: "submitted", projection: buildActorSurfaceProjection(vm) };
}

function findActorById(vm: AiAgentVm, actorId: string | undefined): AiAgentActor | undefined {
  if (!actorId) return undefined;
  return Object.values(vm.actors ?? {}).find((actor) => actor.id === actorId);
}

function findActorByKey(vm: AiAgentVm, actorKey: string | undefined): AiAgentActor | undefined {
  if (!actorKey) return undefined;
  return vm.actors?.[actorKey];
}

function resolveLaneIdForActor(vm: AiAgentVm, actor: AiAgentActor): string | undefined {
  if (actor.key === vm.controlActorKey) return "lane:primary";
  if (actor.identity?.kind === "member") return `lane:member:${actor.identity.memberId}`;
  if (actor.identity?.kind === "holon") return `lane:holon:${actor.identity.holonId}`;
  return undefined;
}

function resolveActorSurfaceTarget(
  vm: AiAgentVm,
  target: ActorSurfaceTargetSelectorData,
): { actor?: AiAgentActor; laneId?: string } {
  if (target.actorId) {
    const actor = findActorById(vm, target.actorId);
    return {
      actor,
      laneId: target.laneId ?? (actor ? resolveLaneIdForActor(vm, actor) : undefined),
    };
  }

  if (target.laneId) {
    return {
      actor: findActorForLane(vm, target.laneId),
      laneId: target.laneId,
    };
  }

  return {
    actor: getControlActor(vm),
    laneId: "lane:primary",
  };
}

function findActorForLane(vm: AiAgentVm, laneId: string): AiAgentActor | undefined {
  if (laneId === "lane:primary") return getControlActor(vm);
  const sessionState = ensureVmSessionState(vm);
  const binding = sessionState.actorSurface.laneActorBindings[laneId];
  if (binding) return findActorById(vm, binding.actorId) ?? findActorByKey(vm, binding.actorKey);

  if (laneId.startsWith("lane:member:")) {
    const memberId = laneId.slice("lane:member:".length);
    return Object.values(vm.actors ?? {}).find((actor) => (
      actor.identity?.kind === "member" && actor.identity.memberId === memberId
    ));
  }

  if (laneId.startsWith("lane:holon:")) {
    const holonId = laneId.slice("lane:holon:".length);
    return Object.values(vm.actors ?? {}).find((actor) => (
      actor.identity?.kind === "holon" && actor.identity.holonId === holonId
    ));
  }

  return undefined;
}

function ensureActorForSurfaceTarget(vm: AiAgentVm, target: ActorSurfaceTargetSelectorData): AiAgentActor {
  const resolved = resolveActorSurfaceTarget(vm, target);
  if (resolved.actor) return resolved.actor;
  if (resolved.laneId) return materializeActorForLane(vm, resolved.laneId);
  const controlActor = getControlActor(vm);
  if (!controlActor) throw new Error("No actor surface target is available");
  return controlActor;
}

function materializeActorForLane(vm: AiAgentVm, laneId: string): AiAgentActor {
  const sessionState = ensureVmSessionState(vm);

  if (laneId.startsWith("lane:member:")) {
    const memberId = laneId.slice("lane:member:".length);
    const member = sessionState.memberRoster[memberId];
    if (!member) throw new Error(`Unknown member lane: ${laneId}`);
    const actor = createActor({
      key: member.actorKey,
      id: member.actorId,
      type: "delegate",
      agentName: member.name,
      identity: {
        kind: "member",
        memberId: member.memberId,
        name: member.name,
        role: member.role,
        lane: member.lane,
        agentType: member.agentType,
      },
    });
    registerSurfaceActor(vm, laneId, actor);
    return actor;
  }

  if (laneId.startsWith("lane:holon:")) {
    const holonId = laneId.slice("lane:holon:".length);
    const holon = sessionState.holons[holonId];
    if (!holon) throw new Error(`Unknown holon lane: ${laneId}`);
    const actor = createActor({
      key: `holon:${holon.holonId}`,
      id: `actor:${holon.holonId}`,
      type: "delegate",
      agentName: holon.name,
      identity: {
        kind: "holon",
        holonId: holon.holonId,
        governance: holon.governance,
        name: holon.name,
        leaderId: holon.leaderMemberId ?? undefined,
      },
    });
    registerSurfaceActor(vm, laneId, actor);
    return actor;
  }

  throw new Error(`Unsupported actor surface lane: ${laneId}`);
}

function registerSurfaceActor(vm: AiAgentVm, laneId: string, actor: AiAgentActor): void {
  const sessionState = ensureVmSessionState(vm);
  vm.actors[actor.key] = actor;
  if (!vm.actorRuntime.has(actor.key)) {
    vm.actorRuntime.register(actor.key, actor);
  }
  sessionState.actorSurface.laneActorBindings[laneId] = {
    laneId,
    actorId: actor.id,
    actorKey: actor.key,
    initializedAt: Date.now(),
  };
}
