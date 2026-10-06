import type { QuestionnaireRow, QuestionnaireRequestPayload, QuestionnaireResultPayload } from "@cell/ai-core-contract/runtime/Questionnaire";
import type { AiAgentActor } from "./actor";
import type { AiAgentVm } from "./runtime";
import { ensureVmSessionState } from "./runtime";

function actorFiberId(actor: AiAgentActor): string {
  return `${actor.key}:${actor.id}`;
}

function actorWorkSessionId(actor: AiAgentActor): string | undefined {
  return actor.workContext?.sessionId;
}

function normalizeQuestionnaireId(request: QuestionnaireRequestPayload, fallbackId: string): string {
  return request.questionnaireId || fallbackId;
}

export function questionnaireRowFromPendingActorRequest(params: {
  actor: AiAgentActor;
  request: QuestionnaireRequestPayload;
  fallbackId?: string;
  now?: number;
  existing?: QuestionnaireRow;
}): QuestionnaireRow {
  const questionnaireId = normalizeQuestionnaireId(params.request, params.fallbackId ?? params.request.questionnaireId);
  return {
    ...params.existing,
    questionnaireId,
    sessionId: params.existing?.sessionId ?? actorWorkSessionId(params.actor),
    ownerActorId: params.actor.id,
    ownerActorKey: params.actor.key,
    ownerFiberId: actorFiberId(params.actor),
    toolCallId: params.request.toolCallId,
    request: params.request,
    suspendPolicy: params.request.suspendPolicy,
    status: "pending",
    createdAt: params.existing?.createdAt ?? params.now,
    updatedAt: params.now ?? params.existing?.updatedAt,
  };
}

export function upsertPendingQuestionnaireRow(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  request: QuestionnaireRequestPayload;
  fallbackId?: string;
  now?: number;
}): QuestionnaireRow {
  const sessionState = ensureVmSessionState(params.vm);
  const questionnaireId = normalizeQuestionnaireId(params.request, params.fallbackId ?? params.request.questionnaireId);
  const row = questionnaireRowFromPendingActorRequest({
    actor: params.actor,
    request: params.request,
    fallbackId: questionnaireId,
    now: params.now ?? Date.now(),
    existing: sessionState.questionnaires[questionnaireId],
  });
  sessionState.questionnaires[questionnaireId] = row;
  return row;
}

/** Publish through the canonical questionnaire owner after optional synchronous host admission. */
export function publishPendingQuestionnaireRow(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  request: QuestionnaireRequestPayload;
  replaceQuestionnaireId?: string;
}): QuestionnaireRow {
  const { vm, actor } = params;
  const request: QuestionnaireRequestPayload = vm.effects?.questionnaires
    ? { ...params.request, suspendPolicy: "continue_others" }
    : params.request;
  const questionnaireId = request.questionnaireId;
  const lease = vm.effects?.questionnaires?.admit({ actor: { id: actor.id, key: actor.key }, request });
  try {
    actor.pendingQuestionnaires[questionnaireId] = request;
    const row = upsertPendingQuestionnaireRow({ vm, actor, request });
    actor.send("control", {
      kind: "questionnaire_pending", toolCallId: request.toolCallId,
      questionnaireId, suspendPolicy: request.suspendPolicy,
    });
    vm.eventBus?.emitQuestionnaireRequest({ key: actor.key, id: actor.id }, request);
    lease?.publish(row);
    if (params.replaceQuestionnaireId && params.replaceQuestionnaireId !== questionnaireId) {
      delete actor.pendingQuestionnaires[params.replaceQuestionnaireId];
      actor.mailboxes.control = actor.mailboxes.control.filter(entry => entry.kind !== "questionnaire_pending" || entry.questionnaireId !== params.replaceQuestionnaireId);
    }
    return row;
  } catch (error) {
    if (lease) {
      try { lease.release(); }
      finally {
        delete actor.pendingQuestionnaires[questionnaireId];
        actor.mailboxes.control = actor.mailboxes.control.filter(entry => entry.kind !== "questionnaire_pending" || entry.questionnaireId !== questionnaireId);
        const state = ensureVmSessionState(vm);
        if (state.questionnaires[questionnaireId]?.request === request) delete state.questionnaires[questionnaireId];
      }
    }
    throw error;
  }
}

export function answerQuestionnaireRow(params: {
  vm: AiAgentVm;
  questionnaireId: string;
  result: QuestionnaireResultPayload;
  now?: number;
}): QuestionnaireRow | null {
  const sessionState = ensureVmSessionState(params.vm);
  const existing = sessionState.questionnaires[params.questionnaireId];
  if (!existing) return null;
  const now = params.now ?? Date.now();
  const row: QuestionnaireRow = {
    ...existing,
    result: params.result,
    status: "answered",
    updatedAt: now,
  };
  sessionState.questionnaires[params.questionnaireId] = row;
  params.vm.effects?.questionnaires?.transitioned?.(row);
  return row;
}

/** The existing row owner performs cancellation; the optional host only observes its result. */
export function cancelQuestionnaireRow(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  questionnaireId: string;
  now?: number;
}): QuestionnaireRow | null {
  const state = ensureVmSessionState(params.vm);
  const existing = state.questionnaires[params.questionnaireId];
  if (!existing || existing.status !== "pending" || existing.ownerActorId !== params.actor.id || existing.ownerActorKey !== params.actor.key) return null;
  const row: QuestionnaireRow = { ...existing, status: "cancelled", updatedAt: params.now ?? Date.now() };
  state.questionnaires[params.questionnaireId] = row;
  delete params.actor.pendingQuestionnaires[params.questionnaireId];
  params.actor.mailboxes.control = params.actor.mailboxes.control.filter(entry => entry.kind !== "questionnaire_pending" || entry.questionnaireId !== params.questionnaireId);
  delete state.actorSurface.pendingQuestionnaires[params.questionnaireId];
  params.vm.effects?.questionnaires?.transitioned?.(row);
  return row;
}

export function collectQuestionnaireRowsForSnapshot(vm: AiAgentVm): QuestionnaireRow[] {
  const sessionState = ensureVmSessionState(vm);
  const rows: Record<string, QuestionnaireRow> = { ...(sessionState.questionnaires ?? {}) };
  const now = Date.now();
  for (const actor of Object.values(vm.actors ?? {})) {
    for (const [fallbackId, request] of Object.entries(actor.pendingQuestionnaires ?? {})) {
      const questionnaireId = normalizeQuestionnaireId(request, fallbackId);
      if (rows[questionnaireId]?.status === "answered") continue;
      rows[questionnaireId] = questionnaireRowFromPendingActorRequest({
        actor,
        request,
        fallbackId,
        now,
        existing: rows[questionnaireId],
      });
    }
  }
  sessionState.questionnaires = rows;
  return Object.values(rows).sort((left, right) => {
    const leftTime = left.createdAt ?? 0;
    const rightTime = right.createdAt ?? 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.questionnaireId.localeCompare(right.questionnaireId);
  });
}

export function hydrateQuestionnaireRowsIntoRuntime(vm: AiAgentVm, rows: QuestionnaireRow[]): void {
  const sessionState = ensureVmSessionState(vm);
  sessionState.questionnaires = Object.fromEntries(rows.map((row) => [row.questionnaireId, { ...row }]));
  for (const actor of Object.values(vm.actors ?? {})) {
    actor.pendingQuestionnaires = {};
  }
  for (const row of rows) {
    if (row.status !== "pending") continue;
    const actor = row.ownerActorKey ? vm.actors[row.ownerActorKey] : undefined;
    if (!actor) continue;
    actor.pendingQuestionnaires[row.questionnaireId] = row.request;
  }
}
