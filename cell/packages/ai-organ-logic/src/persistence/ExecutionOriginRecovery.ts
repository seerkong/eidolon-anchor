import { decodeExecutionOrigin } from "@cell/ai-core-contract/runtime/ExecutionOrigin";
import type { RuntimeSnapshotActor, RuntimeSnapshotFiber, RuntimeSnapshotVm } from "@cell/ai-core-contract/runtime/RuntimeSnapshotTypes";
import type { QuestionnaireRow } from "@cell/ai-core-contract/runtime/Questionnaire";

type RecoveryMaterial = {
  vm: RuntimeSnapshotVm;
  actors: Record<string, RuntimeSnapshotActor>;
  fibers: Record<string, RuntimeSnapshotFiber>;
  questionnaires?: QuestionnaireRow[];
};

// This transition runs on recovered material before actor registration or
// effect continuation. Its retained envelope is diagnostic, never runnable.
export function quarantineWebExecutionOnRecovery(material: RecoveryMaterial, evidence: readonly {
  executionOrigin?: Readonly<Record<string, unknown>>; originSchemaVersion?: number; payload?: unknown;
}[] = []): Set<string> {
  const quarantined = new Set<string>();
  const requiredIds = new Set(material.vm.executionOrigins?.webActorIds ?? []);
  const newerWebOrigins = new Map<string, NonNullable<ReturnType<typeof decodeExecutionOrigin>>>();
  for (const event of evidence) {
    const origin = decodeExecutionOrigin(event.executionOrigin);
    if (origin?.source === "web") newerWebOrigins.set(origin.actorId, origin);
    else if (origin) newerWebOrigins.delete(origin.actorId);
    else if (event.originSchemaVersion !== undefined && !origin) {
      const key = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>).actorKey : undefined;
      if (typeof key === "string") quarantined.add(key);
    }
  }
  for (const actor of Object.values(material.actors)) {
    const execution = actor.execution;
    const origin = decodeExecutionOrigin(execution?.origin);
    if (newerWebOrigins.has(actor.id) || (origin?.source === "web" && execution?.status !== "settled")
      || (!origin && (requiredIds.has(actor.id) || execution?.webOwned))
      || (execution !== undefined && (!origin || execution.originSchemaVersion !== 1))) quarantined.add(actor.key);
    for (const [mailbox, value] of Object.entries(actor.mailboxExecutionOrigins ?? {})) {
      if (!actor.mailboxes[mailbox as keyof typeof actor.mailboxes]?.length) continue;
      const mailboxOrigin = decodeExecutionOrigin(value);
      if (!mailboxOrigin || mailboxOrigin.source === "web") quarantined.add(actor.key);
    }
  }
  for (const signal of material.vm.sessionState?.controlSignals?.events ?? []) {
    if (material.vm.sessionState?.controlSignals?.consumedEventIds[signal.eventId]) continue;
    const origin = decodeExecutionOrigin(signal.executionOrigin);
    if (origin?.source === "web" || (signal.originSchemaVersion !== undefined && (signal.originSchemaVersion !== 1 || !origin))) quarantined.add(signal.actorKey);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const fiber of Object.values(material.fibers)) {
      const parentKey = fiber.parentFiberId ? material.fibers[fiber.parentFiberId]?.actorKey : undefined;
      const origin = decodeExecutionOrigin(fiber.executionOrigin);
      const actor = fiber.actorKey ? material.actors[fiber.actorKey] : undefined;
      const execState = fiber.metadata?.cooperativeExecState;
      const hasInflight = execState && typeof execState === "object" && "inflight" in execState && Boolean(execState.inflight);
      const unfinished = actor?.execution?.status !== "settled" || fiber.status === "ready" || fiber.status === "running"
        || hasInflight;
      if (fiber.actorKey && !quarantined.has(fiber.actorKey)
        && ((origin?.source === "web" && unfinished) || (fiber.originSchemaVersion !== undefined && (fiber.originSchemaVersion !== 1 || !origin)) || (parentKey && quarantined.has(parentKey)))) {
        quarantined.add(fiber.actorKey);
        changed = true;
      }
    }
    for (const actor of Object.values(material.actors)) {
      if (actor.parentKey && quarantined.has(actor.parentKey) && !quarantined.has(actor.key)) {
        quarantined.add(actor.key);
        changed = true;
      }
    }
  }
  for (const actor of Object.values(material.actors)) {
    if (!quarantined.has(actor.key)) continue;
    const origin = newerWebOrigins.get(actor.id) ?? decodeExecutionOrigin(actor.execution?.origin);
    actor.execution = {
      originSchemaVersion: 1, ...(origin ? { origin } : {}), status: "interrupted", webOwned: true,
      quarantine: actor.execution?.quarantine ?? {
        reason: origin ? "web_execution_recovery_interrupted" : "execution_origin_unknown",
        originalOrigin: actor.execution?.origin,
        mailboxes: structuredClone(actor.mailboxes),
        execState: Object.values(material.fibers).find((fiber) => fiber.actorKey === actor.key)?.metadata?.cooperativeExecState,
      },
    };
    for (const queue of Object.values(actor.mailboxes)) queue.length = 0;
    actor.toolCallStreamState = { toolCalls: [] };
  }
  for (const fiber of Object.values(material.fibers)) {
    if (!fiber.actorKey || !quarantined.has(fiber.actorKey)) continue;
    fiber.status = "suspended";
    fiber.waitingReason = "idle_external";
    fiber.metadata = { ...fiber.metadata, cooperativeExecState: null, waitingReason: "idle_external",
      suspendPolicy: "continue_others", completionBinding: null, lastError: "web_execution_recovery_interrupted",
      timeoutAt: null, retryAt: null };
  }
  for (const question of material.questionnaires ?? []) {
    if (question.status === "pending" && ((question.ownerActorKey && quarantined.has(question.ownerActorKey))
      || Object.values(material.actors).some((actor) => quarantined.has(actor.key) && actor.id === question.ownerActorId))) {
      question.status = "invalidated";
      question.metadata = { ...question.metadata, invalidationReason: "web_execution_recovery_interrupted" };
    }
  }
  const schedules = material.vm.sessionState?.heartbeatSchedules;
  if (schedules) material.vm.sessionState!.heartbeatSchedules = schedules.filter((schedule) => !quarantined.has(schedule.targetActorKey));
  return quarantined;
}
