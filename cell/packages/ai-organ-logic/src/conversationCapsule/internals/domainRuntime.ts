import path from "node:path";

import type { ChatMessage } from "@shared/composer";

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorHistoryGenerationData,
  type ActorPromptBasisRefData,
  type ActorPromptGenerationData,
  type ActorPromptHeadData,
  type ActorPromptTransformData,
  type ConversationActorRawState,
  type ConversationCommittedMessageData,
  type ConversationDomainEvent,
  type ConversationSessionRawState,
  type LocalConversationContextAssetData,
} from "@cell/ai-organ-contract";
import {
  committedHistoryRefsToMessages,
  loadConversationActorRawState,
  loadConversationSessionRawState,
  materializeConversationRuntimePrompt,
  materializeConversationVisibleHistory,
  materializeConversationVisibleMessages,
  toCommittedConversationMessage,
  type ConversationPersistenceRepository,
} from "@cell/ai-support";
import { reduceTranscriptToMessages } from "@cell/ai-core-logic/runtime/TranscriptRecords";
import type { TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";
import type { AiAgentVm } from "@cell/ai-core-logic";

import type {
  ConversationDomainEventStream,
  ConversationDomainPersistHooks,
  ConversationDomainRuntime,
  ConversationHistoryDomainEvent,
  ConversationHistoryRuntimeState,
  ConversationMessageAssemblyRuntimeState,
  ConversationPromptDomainEvent,
  ConversationPromptRuntimeState,
  ConversationSessionDomainEvent,
} from "../../conversation/ConversationDomainRuntime";
import {
  MAX_CONVERSATION_DOMAIN_EVENTS_PER_STREAM,
  MAX_MESSAGE_ASSEMBLY_REDUCED_MESSAGES,
  MAX_MESSAGE_ASSEMBLY_TRANSCRIPT_RECORDS,
} from "./constants";
import {
  actorRuntimeKey,
  appendBounded,
  appendCommittedMessageToGeneration,
  applyCommittedMessageAppendToDomains,
  createEmptySessionState,
  deriveConversationActorRawState,
  findSharedMessageSuffixPrefix,
  retainTail,
  toHistoryRuntimeState,
  toPromptRuntimeState,
  upsertHistoryGeneration,
  upsertPromptGeneration,
} from "./derivations";

/**
 * Vm-coupled implementation of the conversation domain runtime. The exported
 * types live on the compatibility facade at
 * src/conversation/ConversationDomainRuntime.ts (type-only back-imports stay
 * acyclic); pure reduction/projection cores live in ./derivations.
 */

type ValueSignal<T> = {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: (value: T) => void) => { unsubscribe: () => void };
};

type DomainListener<TEvent> = (event: TEvent) => void;

function createValueSignal<T>(initial: T): ValueSignal<T> {
  let current = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => current,
    set: (next) => {
      current = next;
      for (const listener of [...listeners]) listener(current);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return {
        unsubscribe: () => listeners.delete(listener),
      };
    },
  };
}

function trimMutableTail<T>(items: T[], maxItems: number): void {
  const extra = items.length - maxItems;
  if (extra > 0) items.splice(0, extra);
}

export function createConversationDomainRuntime(): ConversationDomainRuntime {
  return {
    historyEvents: [],
    promptEvents: [],
    sessionEvents: [],
    actorRawStateSignal: createValueSignal<Record<string, ConversationActorRawState>>({}),
    historyStateSignal: createValueSignal<Record<string, ConversationHistoryRuntimeState>>({}),
    promptStateSignal: createValueSignal<Record<string, ConversationPromptRuntimeState>>({}),
    sessionStateSignal: createValueSignal<Record<string, ConversationSessionRawState>>({}),
    messageAssemblySignal: createValueSignal<Record<string, ConversationMessageAssemblyRuntimeState>>({}),
    historyListeners: new Set(),
    promptListeners: new Set(),
    sessionListeners: new Set(),
    persistHooks: {},
  };
}

export function ensureVmConversationDomainRuntime(vm: AiAgentVm): ConversationDomainRuntime {
  const current = vm.runtimeContext.conversationDomainRuntime as ConversationDomainRuntime | null;
  if (current) {
    bindVmActorsConversationProjection(vm);
    return current;
  }
  const created = createConversationDomainRuntime();
  vm.runtimeContext.conversationDomainRuntime = created;
  bindVmActorsConversationProjection(vm);
  return created;
}

/**
 * Bind every vm actor's read-only `messages` view to the History-domain
 * projection (P7 mirror elimination). Idempotent and cheap; swept on every
 * ensure call so late-spawned actors (delegates, members) get bound as soon
 * as any conversation-domain code path runs.
 */
export function bindActorConversationProjectionToVm(
  vm: AiAgentVm,
  actor: { key: string; bindConversationProjection?: (provider: () => readonly ChatMessage[]) => void },
): void {
  actor.bindConversationProjection?.(() =>
    getConversationVisibleMessagesFromVm({ vm, actorKey: actor.key }),
  );
}

function bindVmActorsConversationProjection(vm: AiAgentVm): void {
  for (const actor of Object.values(vm.actors ?? {})) {
    bindActorConversationProjectionToVm(vm, actor as { key: string; bindConversationProjection?: (provider: () => readonly ChatMessage[]) => void });
  }
}

export function getVmConversationDomainRuntime(vm: AiAgentVm): ConversationDomainRuntime | null {
  return (vm.runtimeContext.conversationDomainRuntime as ConversationDomainRuntime | null) ?? null;
}

export function getConversationSessionRawStateFromVm(params: {
  vm: AiAgentVm;
  sessionId?: string;
}): ConversationSessionRawState | null {
  const runtime = getVmConversationDomainRuntime(params.vm);
  if (!runtime) return null;
  const sessionId = params.sessionId ?? resolveSessionIdFromVm(params.vm);
  return runtime.sessionStateSignal.get()[sessionId] ?? null;
}

export function getConversationActorRawStateFromVm(params: {
  vm: AiAgentVm;
  actorKey: string;
  sessionId?: string;
}): ConversationActorRawState | null {
  const runtime = getVmConversationDomainRuntime(params.vm);
  if (!runtime) return null;
  const sessionId = params.sessionId ?? resolveSessionIdFromVm(params.vm);
  return runtime.actorRawStateSignal.get()[actorRuntimeKey(sessionId, params.actorKey)] ?? null;
}

export function subscribeConversationHistory(
  runtime: ConversationDomainRuntime,
  listener: DomainListener<ConversationHistoryDomainEvent>,
): { unsubscribe: () => void } {
  runtime.historyListeners.add(listener);
  return {
    unsubscribe: () => runtime.historyListeners.delete(listener),
  };
}

export function subscribeConversationPrompt(
  runtime: ConversationDomainRuntime,
  listener: DomainListener<ConversationPromptDomainEvent>,
): { unsubscribe: () => void } {
  runtime.promptListeners.add(listener);
  return {
    unsubscribe: () => runtime.promptListeners.delete(listener),
  };
}

export function subscribeConversationSession(
  runtime: ConversationDomainRuntime,
  listener: DomainListener<ConversationSessionDomainEvent>,
): { unsubscribe: () => void } {
  runtime.sessionListeners.add(listener);
  return {
    unsubscribe: () => runtime.sessionListeners.delete(listener),
  };
}

export function teeConversationHistoryStream(
  runtime: ConversationDomainRuntime,
): ConversationDomainEventStream<ConversationHistoryDomainEvent> {
  return createDomainEventStream(runtime.historyListeners);
}

export function teeConversationPromptStream(
  runtime: ConversationDomainRuntime,
): ConversationDomainEventStream<ConversationPromptDomainEvent> {
  return createDomainEventStream(runtime.promptListeners);
}

export function teeConversationSessionStream(
  runtime: ConversationDomainRuntime,
): ConversationDomainEventStream<ConversationSessionDomainEvent> {
  return createDomainEventStream(runtime.sessionListeners);
}

export function setConversationDomainPersistHooks(
  runtime: ConversationDomainRuntime,
  hooks: ConversationDomainPersistHooks,
): void {
  runtime.persistHooks = { ...hooks };
}

export function injectConversationSessionRawState(
  runtime: ConversationDomainRuntime,
  rawState: ConversationSessionRawState,
): void {
  runtime.sessionStateSignal.set({
    ...runtime.sessionStateSignal.get(),
    [rawState.sessionId]: rawState,
  });
}

export function injectConversationActorRawState(
  runtime: ConversationDomainRuntime,
  rawState: ConversationActorRawState,
): void {
  const key = actorRuntimeKey(rawState.session.sessionId, rawState.actorKey);
  runtime.actorRawStateSignal.set({
    ...runtime.actorRawStateSignal.get(),
    [key]: rawState,
  });
  runtime.historyStateSignal.set({
    ...runtime.historyStateSignal.get(),
    [key]: toHistoryRuntimeState(rawState),
  });
  runtime.promptStateSignal.set({
    ...runtime.promptStateSignal.get(),
    [key]: toPromptRuntimeState(rawState),
  });
  injectConversationSessionRawState(runtime, rawState.session);
}

export async function synchronizeConversationDomainActorFromPersistence(params: {
  runtime: ConversationDomainRuntime;
  sessionDir: string;
  actorKey: string;
  repository: ConversationPersistenceRepository;
}): Promise<void> {
  const sessionRawState = await loadConversationSessionRawState({
    sessionDir: params.sessionDir,
    repository: params.repository,
  });
  injectConversationSessionRawState(params.runtime, sessionRawState);

  const actorRawState = await loadConversationActorRawState({
    sessionDir: params.sessionDir,
    actorKey: params.actorKey,
    repository: params.repository,
  });
  if (actorRawState) {
    injectConversationActorRawState(params.runtime, actorRawState);
  }
}

export async function synchronizeConversationDomainSessionFromPersistence(params: {
  runtime: ConversationDomainRuntime;
  sessionDir: string;
  actorKey?: string;
  repository: ConversationPersistenceRepository;
}): Promise<void> {
  const sessionRawState = await loadConversationSessionRawState({
    sessionDir: params.sessionDir,
    repository: params.repository,
  });
  injectConversationSessionRawState(params.runtime, sessionRawState);
  const actorKey =
    params.actorKey
    ?? sessionRawState.activeActorKey
    ?? Object.keys(sessionRawState.actorBindings)[0]
    ?? null;
  if (!actorKey) return;
  await synchronizeConversationDomainActorFromPersistence({
    runtime: params.runtime,
    sessionDir: params.sessionDir,
    actorKey,
    repository: params.repository,
  });
}

function resolveSessionIdFromVm(vm: AiAgentVm): string {
  const metadata = (vm.outerCtx?.metadata ?? {}) as Record<string, unknown>;
  const explicit = typeof metadata.sessionId === "string" ? metadata.sessionId.trim() : "";
  if (explicit) return explicit;
  const sessionDir = typeof metadata.sessionDir === "string" ? metadata.sessionDir.trim() : "";
  if (sessionDir) return path.basename(sessionDir);
  return "__unsessioned__";
}

function createDomainEventStream<TEvent>(
  listeners: Set<DomainListener<TEvent>>,
): ConversationDomainEventStream<TEvent> {
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return {
        unsubscribe: () => listeners.delete(listener),
      };
    },
  };
}

function notifyListeners<TEvent>(
  listeners: Set<DomainListener<TEvent>>,
  event: TEvent,
): void {
  for (const listener of [...listeners]) {
    listener(event);
  }
}

function makeRuntimeScopedId(prefix: string): string {
  return `${prefix}__${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Work-context ("late status") overlays are per-build status banners: the
 * control plane re-materializes exactly one against the CURRENT work context
 * on every prompt build. Inheriting them across prompt generations is what
 * produced the D2 overlay accumulation (and stale plan-mode overlays), so a
 * new generation inherits only structural transforms (compaction summaries,
 * context assets, prelude overlays) and never late-status ones.
 */
function isLateStatusOverlayTransform(transform: ActorPromptTransformData): boolean {
  if (transform.kind !== "overlay") return false;
  const payload = (transform.payload ?? {}) as Record<string, unknown>;
  return payload.insertPlacement === "late_status" || payload.overlayKind === "work_context";
}

function inheritStructuralPromptTransforms(
  transforms: ActorPromptTransformData[] | undefined,
): ActorPromptTransformData[] {
  return (transforms ?? []).filter((transform) => !isLateStatusOverlayTransform(transform));
}

function refreshConversationActorRawStateFromDomainState(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId?: string;
}): void {
  const key = actorRuntimeKey(params.sessionId, params.actorKey);
  const next = deriveConversationActorRawState({
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    currentActorRaw: params.runtime.actorRawStateSignal.get()[key] ?? null,
    historyState: params.runtime.historyStateSignal.get()[key] ?? null,
    promptState: params.runtime.promptStateSignal.get()[key] ?? null,
    sessionState: params.runtime.sessionStateSignal.get()[params.sessionId] ?? null,
  });
  params.runtime.actorRawStateSignal.set({
    ...params.runtime.actorRawStateSignal.get(),
    [key]: next,
  });
}

export function appendConversationDomainEvent(
  runtime: ConversationDomainRuntime,
  event: ConversationDomainEvent,
): void {
  const keyActor =
    "actorKey" in event && typeof event.actorKey === "string"
      ? actorRuntimeKey(event.sessionId, event.actorKey)
      : null;

  if (event.type.startsWith("actor_history_")) {
    runtime.historyEvents.push(event);
    trimMutableTail(runtime.historyEvents, MAX_CONVERSATION_DOMAIN_EVENTS_PER_STREAM);
    if (!keyActor) return;
    const current = runtime.historyStateSignal.get()[keyActor];
    if (event.type === "actor_history_generation_created") {
      const nextGeneration: ActorHistoryGenerationData = event.generation ?? {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        generationId: event.generationId,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: current?.actorId ?? "",
        parentGenerationId: null,
        predecessorGenerationIds: [],
        createdReason: "append",
        sealed: false,
        messageCount: 0,
        messages: [],
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      };
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          sessionId: event.sessionId,
          actorKey: event.actorKey,
          actorId: current?.actorId ?? "",
          generations: upsertHistoryGeneration(current?.generations ?? [], nextGeneration),
          activeGenerationId: current?.activeGenerationId ?? event.generationId,
          lastCompaction: current?.lastCompaction ?? null,
          resetReason: current?.resetReason ?? null,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: nextGeneration.actorId,
      });
      return;
    }
    if (event.type === "actor_history_generation_sealed" && current) {
      const sealedGeneration = event.generation
        ? {
            ...event.generation,
            sealed: true,
            updatedAt: event.occurredAt,
          }
        : null;
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: sealedGeneration
            ? upsertHistoryGeneration(current.generations, sealedGeneration)
            : current.generations.map((generation) =>
                generation.generationId === event.generationId
                  ? {
                      ...generation,
                      sealed: true,
                      updatedAt: event.occurredAt,
                    }
                  : generation,
              ),
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
      });
      return;
    }
    if (event.type === "actor_history_head_moved") {
      const activeGenerationId = event.head?.activeGenerationId ?? event.activeGenerationId;
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          sessionId: event.sessionId,
          actorKey: event.actorKey,
          actorId: event.head?.actorId ?? current?.actorId ?? "",
          generations: current?.generations ?? [],
          activeGenerationId,
          lastCompaction: current?.lastCompaction ?? null,
          resetReason: current?.resetReason ?? null,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.head?.actorId,
      });
      return;
    }
    if (event.type === "actor_history_reset") {
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          sessionId: event.sessionId,
          actorKey: event.actorKey,
          actorId: event.actorId ?? current?.actorId ?? "",
          generations: [],
          activeGenerationId: null,
          lastCompaction: null,
          resetReason: event.reason,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.actorId,
      });
      return;
    }
    if (event.type === "actor_history_compaction_applied" && current) {
      const nextActiveGenerationId =
        event.head?.activeGenerationId
        ?? event.generation?.generationId
        ?? current.activeGenerationId
        ?? event.targetGenerationId;
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: event.generation
            ? upsertHistoryGeneration(current.generations, event.generation)
            : current.generations,
          activeGenerationId: nextActiveGenerationId,
          lastCompaction: {
            sourceGenerationIds: [...event.sourceGenerationIds],
            targetGenerationId: event.targetGenerationId,
            summaryText: event.summaryText ?? null,
            artifactId: event.artifactId ?? null,
            appliedAt: event.occurredAt,
          },
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.actorId,
      });
      return;
    }
    if (event.type === "actor_history_appended" && current?.activeGenerationId && event.message) {
      const activeGenerationId =
        event.head?.activeGenerationId
        ?? event.generation?.generationId
        ?? current.activeGenerationId;
      const generation =
        event.generation
        ?? current.generations.find((item) => item.generationId === activeGenerationId)
        ?? {
          version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
          generationId: activeGenerationId,
          sessionId: current.sessionId,
          actorKey: current.actorKey,
          actorId: current.actorId,
          parentGenerationId: null,
          predecessorGenerationIds: [],
          createdReason: "append",
          sealed: false,
          messageCount: 0,
          messages: [],
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        };
      if (generation.messages.some((message) => message.recordId === event.messageRecordId)) {
        return;
      }
      const nextGeneration = appendCommittedMessageToGeneration({
        generation,
        message: event.message as ConversationCommittedMessageData,
        actorKey: current.actorKey,
        actorId: current.actorId,
      });
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: upsertHistoryGeneration(current.generations, nextGeneration),
          activeGenerationId,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
      });
    }
    return;
  }

  if (event.type.startsWith("actor_prompt_")) {
    runtime.promptEvents.push(event);
    trimMutableTail(runtime.promptEvents, MAX_CONVERSATION_DOMAIN_EVENTS_PER_STREAM);
    if (!keyActor) return;
    const current = runtime.promptStateSignal.get()[keyActor] ?? {
      sessionId: event.sessionId,
      actorKey: event.actorKey,
      actorId: "",
      generations: [],
      activePromptGenerationId: null,
      resetReason: null,
      updatedAt: event.occurredAt,
    };
    if (event.type === "actor_prompt_generation_created") {
      const nextGeneration: ActorPromptGenerationData = event.generation ?? {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        promptGenerationId: event.promptGenerationId,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: current.actorId,
        basedOnPromptGenerationId: current.activePromptGenerationId ?? null,
        basis: {
          version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
          basisHistoryGenerationIds: [],
          basisMessageRecordIds: [],
          basisRefs: [],
        },
        transforms: [],
        createdReason: "unknown",
        materializedContext: null,
        sealed: false,
        createdAt: event.occurredAt,
        sealedAt: null,
        updatedAt: event.occurredAt,
        metadata: {},
      };
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: upsertPromptGeneration(current.generations, nextGeneration),
          activePromptGenerationId: current.activePromptGenerationId ?? event.promptGenerationId,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: nextGeneration.actorId,
      });
      return;
    }
    if (event.type === "actor_prompt_basis_selected") {
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: current.generations.map((generation) =>
            generation.promptGenerationId === event.promptGenerationId
              ? {
                  ...generation,
                  basis: {
                    ...generation.basis,
                    basisHistoryGenerationIds: [...event.basisHistoryGenerationIds],
                    basisMessageRecordIds: [...(event.basisMessageRecordIds ?? [])],
                    basisRefs: [...(event.basisRefs ?? [])],
                  },
                  updatedAt: event.occurredAt,
                }
              : generation,
          ),
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
      });
      return;
    }
    if (event.type === "actor_prompt_transform_applied") {
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: current.generations.map((generation) =>
            generation.promptGenerationId === event.promptGenerationId
                ? {
                  ...generation,
                  transforms: [
                    ...generation.transforms.filter((transform) => transform.transformId !== event.transformId),
                    (
                      event.transform
                      ?? {
                          transformId: event.transformId,
                          kind: event.transformKind,
                          payload: event.payload ?? {},
                          appliedAt: event.occurredAt,
                        }
                    ) as ActorPromptTransformData,
                  ],
                  updatedAt: event.occurredAt,
                }
              : generation,
          ),
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
      });
      return;
    }
    if (event.type === "actor_prompt_generation_sealed") {
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: current.generations.map((generation) =>
            generation.promptGenerationId === event.promptGenerationId
              ? {
                  ...generation,
                  sealed: true,
                  sealedAt: event.occurredAt,
                  updatedAt: event.occurredAt,
                }
              : generation,
          ),
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
      });
      return;
    }
    if (event.type === "actor_prompt_head_moved") {
      const activePromptGenerationId = event.head?.activePromptGenerationId ?? event.activePromptGenerationId;
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          ...current,
          actorId: event.head?.actorId ?? current.actorId,
          activePromptGenerationId,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.head?.actorId,
      });
      return;
    }
    if (event.type === "actor_prompt_reset") {
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          sessionId: event.sessionId,
          actorKey: event.actorKey,
          actorId: event.actorId ?? current.actorId,
          generations: [],
          activePromptGenerationId: null,
          resetReason: event.reason,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.actorId,
      });
      return;
    }
    return;
  }

  runtime.sessionEvents.push(event);
  trimMutableTail(runtime.sessionEvents, MAX_CONVERSATION_DOMAIN_EVENTS_PER_STREAM);
  const currentSession = runtime.sessionStateSignal.get()[event.sessionId] ?? createEmptySessionState(event.sessionId);
  if (event.type === "local_conversation_session_created") {
    const nextSession = event.session
      ? {
          ...currentSession,
          activeActorKey: event.session.activeActorKey ?? null,
          actorBindings: event.session.actorBindings,
          contextAssetRegistry: event.session.contextAssetRegistry ?? null,
          contextAssets: event.session.contextAssets ?? [],
          activeSelection: event.session.activeSelection ?? null,
          sessionIndex: {
            ...currentSession.sessionIndex,
            updatedAt: event.occurredAt,
            session: { ...event.session },
          },
        }
      : {
          ...currentSession,
          sessionIndex: {
            ...currentSession.sessionIndex,
            updatedAt: event.occurredAt,
            session: {
              ...currentSession.sessionIndex.session,
              createdAt: event.occurredAt,
              updatedAt: event.occurredAt,
            },
          },
        };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: nextSession,
    });
    return;
  }
  if (event.type === "local_conversation_session_forked") {
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        lineage: event.lineage ?? currentSession.lineage,
        sessionIndex: {
          ...currentSession.sessionIndex,
          lineage: event.lineage ?? currentSession.sessionIndex.lineage,
          updatedAt: event.occurredAt,
        },
      },
    });
    return;
  }
  if (event.type === "local_conversation_session_closed") {
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        activeActorKey: event.session?.activeActorKey ?? currentSession.activeActorKey,
        actorBindings: event.session?.actorBindings ?? currentSession.actorBindings,
        contextAssetRegistry: event.session?.contextAssetRegistry ?? currentSession.contextAssetRegistry,
        contextAssets: event.session?.contextAssets ?? currentSession.contextAssets,
        activeSelection: event.session?.activeSelection ?? currentSession.activeSelection,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...(event.session ?? currentSession.sessionIndex.session),
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    return;
  }
  if (event.type === "local_conversation_session_head_selected") {
    const nextSelection = event.selection ?? {
      sessionId: event.sessionId,
      activeActorKey: event.activeActorKey,
      historyHeadGenerationId: currentSession.activeSelection?.historyHeadGenerationId ?? null,
      promptHeadGenerationId: currentSession.activeSelection?.promptHeadGenerationId ?? null,
      selectedAt: event.occurredAt,
      metadata: currentSession.activeSelection?.metadata,
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        activeActorKey: event.session?.activeActorKey ?? event.activeActorKey,
        actorBindings: event.session?.actorBindings ?? currentSession.actorBindings,
        contextAssetRegistry: event.session?.contextAssetRegistry ?? currentSession.contextAssetRegistry,
        contextAssets: event.session?.contextAssets ?? currentSession.contextAssets,
        activeSelection: nextSelection,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...(event.session ?? currentSession.sessionIndex.session),
            activeActorKey: event.session?.activeActorKey ?? event.activeActorKey,
            activeSelection: nextSelection,
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    refreshConversationActorRawStateFromDomainState({
      runtime,
      sessionId: event.sessionId,
      actorKey: event.activeActorKey,
    });
    return;
  }
  if (event.type === "local_conversation_session_actor_bound") {
    const nextBinding = event.binding ?? {
      actorKey: event.actorKey,
      actorId: event.actorId,
      actorName: event.actorName ?? null,
      actorKind: event.actorKind ?? null,
      boundAt: event.occurredAt,
      historyHeadGenerationId: event.historyHeadGenerationId ?? null,
      promptHeadGenerationId: event.promptHeadGenerationId ?? null,
      metadata: currentSession.actorBindings[event.actorKey]?.metadata,
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        actorBindings: {
          ...currentSession.actorBindings,
          [event.actorKey]: nextBinding,
        },
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...currentSession.sessionIndex.session,
            actorBindings: {
              ...currentSession.sessionIndex.session.actorBindings,
              [event.actorKey]: nextBinding,
            },
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    refreshConversationActorRawStateFromDomainState({
      runtime,
      sessionId: event.sessionId,
      actorKey: event.actorKey,
      actorId: nextBinding.actorId,
    });
    return;
  }
  if (event.type === "local_conversation_session_lineage_updated") {
    const nextLineage = event.lineage ?? {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: event.sessionId,
      parentSessionId: event.parentSessionId ?? null,
      forkedFromGenerationId: event.forkedFromGenerationId ?? null,
      rolledBackFromSessionId: event.rolledBackFromSessionId ?? null,
      predecessorSessionIds: currentSession.lineage?.predecessorSessionIds ?? [],
      forkSessionIds: currentSession.lineage?.forkSessionIds ?? [],
      updatedAt: event.occurredAt,
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        lineage: nextLineage,
        sessionIndex: {
          ...currentSession.sessionIndex,
          lineage: nextLineage,
          updatedAt: event.occurredAt,
        },
      },
    });
    return;
  }
  if (event.type === "local_conversation_session_active_selection_updated") {
    const nextSelection = event.selection ?? {
      sessionId: event.sessionId,
      activeActorKey: event.activeActorKey,
      historyHeadGenerationId: event.historyHeadGenerationId ?? null,
      promptHeadGenerationId: event.promptHeadGenerationId ?? null,
      selectedAt: event.occurredAt,
      metadata: currentSession.activeSelection?.metadata,
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        activeActorKey: event.activeActorKey,
        activeSelection: nextSelection,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...currentSession.sessionIndex.session,
            activeActorKey: event.activeActorKey,
            activeSelection: nextSelection,
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    refreshConversationActorRawStateFromDomainState({
      runtime,
      sessionId: event.sessionId,
      actorKey: event.activeActorKey,
    });
    return;
  }
  if (event.type === "local_conversation_context_asset_registered") {
    const nextAssets = [
      ...(currentSession.contextAssets ?? []).filter((asset) => asset.assetId !== event.assetId),
      ...(event.asset ? [event.asset] : []),
    ];
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        contextAssetRegistry: {
          version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
          assetIds: [...new Set([...(currentSession.contextAssetRegistry?.assetIds ?? []), event.assetId])],
          updatedAt: event.occurredAt,
        },
        contextAssets: nextAssets,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...currentSession.sessionIndex.session,
            contextAssetRegistry: {
              version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
              assetIds: [...new Set([...(currentSession.contextAssetRegistry?.assetIds ?? []), event.assetId])],
              updatedAt: event.occurredAt,
            },
            contextAssets: nextAssets,
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    const actorKeys = Object.keys(currentSession.actorBindings);
    for (const actorKey of actorKeys) {
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey,
      });
    }
    return;
  }
  if (event.type === "local_conversation_context_asset_removed") {
    const nextAssetIds = (currentSession.contextAssetRegistry?.assetIds ?? []).filter((assetId) => assetId !== event.assetId);
    const nextAssets = (currentSession.contextAssets ?? []).filter((asset) => asset.assetId !== event.assetId);
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        activeActorKey: event.session?.activeActorKey ?? currentSession.activeActorKey,
        actorBindings: event.session?.actorBindings ?? currentSession.actorBindings,
        contextAssetRegistry: event.session?.contextAssetRegistry ?? (currentSession.contextAssetRegistry
          ? {
              ...currentSession.contextAssetRegistry,
              assetIds: nextAssetIds,
              updatedAt: event.occurredAt,
            }
          : null),
        contextAssets: event.session?.contextAssets ?? nextAssets,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...(event.session ?? currentSession.sessionIndex.session),
            contextAssetRegistry: event.session?.contextAssetRegistry ?? (currentSession.contextAssetRegistry
              ? {
                  ...currentSession.contextAssetRegistry,
                  assetIds: nextAssetIds,
                  updatedAt: event.occurredAt,
                }
              : null),
            contextAssets: event.session?.contextAssets ?? nextAssets,
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    const actorKeys = Object.keys(currentSession.actorBindings);
    for (const actorKey of actorKeys) {
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey,
      });
    }
  }
}

export function emitConversationDomainEvent(
  runtime: ConversationDomainRuntime,
  event: ConversationDomainEvent,
): void {
  appendConversationDomainEvent(runtime, event);
  if (event.type.startsWith("actor_history_")) {
    const historyEvent = event as ConversationHistoryDomainEvent;
    runtime.persistHooks.history?.(historyEvent);
    notifyListeners(runtime.historyListeners, historyEvent);
    return;
  }
  if (event.type.startsWith("actor_prompt_")) {
    const promptEvent = event as ConversationPromptDomainEvent;
    runtime.persistHooks.prompt?.(promptEvent);
    notifyListeners(runtime.promptListeners, promptEvent);
    return;
  }
  const sessionEvent = event as ConversationSessionDomainEvent;
  runtime.persistHooks.session?.(sessionEvent);
  notifyListeners(runtime.sessionListeners, sessionEvent);
}

export function appendLiveHistoryMessageToConversationDomainRuntime(params: {
  vm: AiAgentVm;
  actorKey: string;
  actorId: string;
  message: ChatMessage;
  occurredAt?: string;
}): void {
  const runtime = ensureVmConversationDomainRuntime(params.vm);
  const sessionId = resolveSessionIdFromVm(params.vm);
  const key = actorRuntimeKey(sessionId, params.actorKey);
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const messageAssemblyStates = runtime.messageAssemblySignal.get();
  const currentAssembly = messageAssemblyStates[key] ?? {
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    transcriptRecords: [],
    reducedMessages: [],
    emittedMessageCount: 0,
    updatedAt: new Date(0).toISOString(),
  };
  const nextReducedMessages = appendBounded(
    currentAssembly.reducedMessages,
    params.message,
    MAX_MESSAGE_ASSEMBLY_REDUCED_MESSAGES,
  );
  runtime.messageAssemblySignal.set({
    ...messageAssemblyStates,
    [key]: {
      ...currentAssembly,
      actorId: params.actorId,
      reducedMessages: nextReducedMessages,
      emittedMessageCount: currentAssembly.emittedMessageCount + 1,
      updatedAt: occurredAt,
    },
  });
  const { nextHistoryState, nextSession, nextGeneration } = applyCommittedMessageAppendToDomains({
    historyStates: runtime.historyStateSignal.get(),
    sessionStates: runtime.sessionStateSignal.get(),
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    message: params.message,
    occurredAt,
  });
  runtime.historyStateSignal.set({
    ...runtime.historyStateSignal.get(),
    [key]: nextHistoryState,
  });
  runtime.sessionStateSignal.set({
    ...runtime.sessionStateSignal.get(),
    [sessionId]: nextSession,
  });

  const actorRawStates = runtime.actorRawStateSignal.get();
  const currentActorRaw = actorRawStates[key];
  const nextVisibleGenerations = upsertHistoryGeneration(
    currentActorRaw?.visibleHistoryGenerations ?? [],
    nextGeneration,
  );
  runtime.actorRawStateSignal.set({
    ...actorRawStates,
    [key]: {
      session: nextSession,
      actorKey: params.actorKey,
      actorId: params.actorId,
      historyHeadGenerationId: nextGeneration.generationId,
      promptHeadGenerationId:
        currentActorRaw?.promptHeadGenerationId
        ?? nextSession.actorBindings[params.actorKey]?.promptHeadGenerationId
        ?? null,
      visibleGenerationIds: nextVisibleGenerations.map((generation) => generation.generationId),
      visibleHistoryGenerations: nextVisibleGenerations,
      activeHistoryGeneration: nextGeneration,
      promptGeneration: currentActorRaw?.promptGeneration ?? null,
      contextAssetIds:
        currentActorRaw?.contextAssetIds
        ?? nextSession.contextAssetRegistry?.assetIds
        ?? [],
    },
  });

  emitConversationDomainEvent(runtime, {
    type: "actor_history_appended",
    sessionId,
    actorKey: params.actorKey,
    generationId: nextGeneration.generationId,
    messageRecordId: `${nextGeneration.generationId}::${nextGeneration.messages.length - 1}`,
    message: toCommittedConversationMessage(params.message),
    generation: nextGeneration,
    head: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      actorKey: params.actorKey,
      actorId: params.actorId,
      activeGenerationId: nextGeneration.generationId,
      visibleGenerationIds: nextVisibleGenerations.map((generation) => generation.generationId),
      updatedAt: nextGeneration.updatedAt,
    },
    occurredAt: nextGeneration.updatedAt,
  });
}

/**
 * In-place domain transform over the ACTIVE history generation (track
 * refactor-ai-semantic-conversation-spine, task T4.3): apply a pure,
 * positional (1:1) message rewrite — e.g. cheap tool-result compaction — to
 * the committed messages of the active generation and publish the rewritten
 * generation through an `actor_history_compaction_applied` domain event
 * (upsert semantics, head unchanged). The History domain stays the single
 * provider-context truth: the materialization picks the rewrite up on the
 * next build without any raw-array involvement.
 */
export function rewriteActiveHistoryGenerationMessagesInConversationDomainRuntime(params: {
  vm: AiAgentVm;
  actorKey: string;
  actorId?: string;
  /** Diagnostic tag recorded in the thrown error on a non-positional rewrite. */
  reason: string;
  /** Pure rewrite; return null to signal "no change". Must keep message count. */
  rewrite: (messages: ChatMessage[]) => ChatMessage[] | null;
  occurredAt?: string;
}): { changed: boolean } {
  const runtime = getVmConversationDomainRuntime(params.vm);
  if (!runtime) return { changed: false };
  const sessionId = resolveSessionIdFromVm(params.vm);
  const key = actorRuntimeKey(sessionId, params.actorKey);
  const historyState = runtime.historyStateSignal.get()[key];
  const activeGenerationId = historyState?.activeGenerationId;
  if (!historyState || !activeGenerationId) return { changed: false };
  const generation = historyState.generations.find((item) => item.generationId === activeGenerationId);
  if (!generation || generation.messages.length === 0) return { changed: false };

  const currentMessages = committedHistoryRefsToMessages(generation.messages);
  const rewrittenMessages = params.rewrite(currentMessages);
  if (!rewrittenMessages) return { changed: false };
  if (rewrittenMessages.length !== generation.messages.length) {
    throw new Error(
      `active history generation rewrite must be positional (1:1): produced ${rewrittenMessages.length} `
        + `messages for ${generation.messages.length} committed records (${params.reason})`,
    );
  }

  let changed = false;
  const nextRefs = generation.messages.map((ref, index) => {
    const nextMessage = rewrittenMessages[index]!;
    if (JSON.stringify(nextMessage) === JSON.stringify(currentMessages[index])) {
      return ref;
    }
    changed = true;
    return { ...ref, message: toCommittedConversationMessage(nextMessage) };
  });
  if (!changed) return { changed: false };

  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const nextGeneration: ActorHistoryGenerationData = {
    ...generation,
    messages: nextRefs,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(runtime, {
    type: "actor_history_compaction_applied",
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    sourceGenerationIds: [generation.generationId],
    targetGenerationId: generation.generationId,
    summaryText: null,
    artifactId: null,
    generation: nextGeneration,
    occurredAt,
  });
  return { changed: true };
}

export function recordConversationTranscriptEvidenceInRuntime(params: {
  vm: AiAgentVm;
  actorKey: string;
  actorId: string;
  transcriptRecord: TranscriptRecord;
}): void {
  const runtime = ensureVmConversationDomainRuntime(params.vm);
  const sessionId = resolveSessionIdFromVm(params.vm);
  const key = actorRuntimeKey(sessionId, params.actorKey);
  const current = runtime.messageAssemblySignal.get()[key] ?? {
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    transcriptRecords: [],
    reducedMessages: [],
    emittedMessageCount: 0,
    updatedAt: new Date(0).toISOString(),
  };
  runtime.messageAssemblySignal.set({
    ...runtime.messageAssemblySignal.get(),
    [key]: {
      ...current,
      actorId: params.actorId,
      transcriptRecords: appendBounded(
        current.transcriptRecords,
        params.transcriptRecord,
        MAX_MESSAGE_ASSEMBLY_TRANSCRIPT_RECORDS,
      ),
      updatedAt: new Date().toISOString(),
    },
  });
}

export function recordPromptRequestToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId: string;
  reason?: ActorPromptGenerationData["createdReason"];
  materializedContext?: string | null;
  basisHistoryGenerationIds?: string[];
  basisMessageRecordIds?: string[];
  basisRefs?: ActorPromptBasisRefData[];
  /**
   * Stage-1 system prompt snapshot for the provider-context materialization.
   * When omitted, the snapshot of the previous prompt generation is carried
   * forward (structural inheritance, like compaction/asset transforms).
   */
  systemPrompts?: string[];
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}): string {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const promptGenerationId = makeRuntimeScopedId(`${params.actorKey}__prompt`);
  const currentPromptState =
    params.runtime.promptStateSignal.get()[actorRuntimeKey(params.sessionId, params.actorKey)];
  const currentPromptGeneration = currentPromptState?.activePromptGenerationId
    ? (
        currentPromptState.generations.find(
          (generation) => generation.promptGenerationId === currentPromptState.activePromptGenerationId,
        ) ?? null
      )
    : null;
  const inheritedSystemPrompts = (() => {
    const currentMetadata = (currentPromptGeneration?.metadata ?? {}) as Record<string, unknown>;
    const direct = currentMetadata.systemPrompts;
    if (Array.isArray(direct)) return direct.filter((value): value is string => typeof value === "string");
    const fromPlan = (currentMetadata.promptPlan as Record<string, unknown> | undefined)?.systemPrompts;
    if (Array.isArray(fromPlan)) return fromPlan.filter((value): value is string => typeof value === "string");
    return [];
  })();
  const systemPrompts = params.systemPrompts ?? inheritedSystemPrompts;
  const generation: ActorPromptGenerationData = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    promptGenerationId,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    basedOnPromptGenerationId: currentPromptState?.activePromptGenerationId ?? null,
    basis: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      basisHistoryGenerationIds: [
        ...(currentPromptGeneration?.basis.basisHistoryGenerationIds ?? []),
        ...(params.basisHistoryGenerationIds ?? []),
      ],
      basisMessageRecordIds: [
        ...(currentPromptGeneration?.basis.basisMessageRecordIds ?? []),
        ...(params.basisMessageRecordIds ?? []),
      ],
      basisRefs: [
        ...(currentPromptGeneration?.basis.basisRefs ?? []),
        ...(params.basisRefs ?? []),
      ],
    },
    transforms: inheritStructuralPromptTransforms(currentPromptGeneration?.transforms),
    createdReason: params.reason ?? "request_build",
    materializedContext: params.materializedContext ?? currentPromptGeneration?.materializedContext ?? null,
    sealed: false,
    createdAt: occurredAt,
    sealedAt: null,
    updatedAt: occurredAt,
    metadata: {
      ...(params.metadata ?? {}),
      ...(systemPrompts.length ? { systemPrompts } : {}),
    },
  };
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_generation_created",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    generation,
    occurredAt,
  });
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_basis_selected",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    basisHistoryGenerationIds: generation.basis.basisHistoryGenerationIds,
    basisMessageRecordIds: generation.basis.basisMessageRecordIds,
    basisRefs: generation.basis.basisRefs,
    occurredAt,
  });
  const head: ActorPromptHeadData = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    activePromptGenerationId: promptGenerationId,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_head_moved",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    activePromptGenerationId: promptGenerationId,
    head,
    occurredAt,
  });
  return promptGenerationId;
}

export function recordPromptOverlayToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId: string;
  content: string;
  overlayKind?: string;
  occurredAt?: string;
}): string {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const promptGenerationId = recordPromptRequestToConversationDomainRuntime({
    runtime: params.runtime,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    reason: "overlay",
    occurredAt,
  });
  const transformId = `${promptGenerationId}::overlay`;
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_transform_applied",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    transformId,
    transformKind: "overlay",
    payload: {
      content: params.content,
      overlayKind: params.overlayKind ?? "system",
    },
    transform: {
      transformId,
      kind: "overlay",
      payload: {
        content: params.content,
        overlayKind: params.overlayKind ?? "system",
      },
      appliedAt: occurredAt,
    },
    occurredAt,
  });
  return promptGenerationId;
}

export function applyPromptTransformToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  promptGenerationId?: string | null;
  transformKind: ActorPromptTransformData["kind"];
  payload: Record<string, unknown>;
  occurredAt?: string;
}): string | null {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const promptState =
    params.runtime.promptStateSignal.get()[actorRuntimeKey(params.sessionId, params.actorKey)];
  const promptGenerationId =
    params.promptGenerationId
    ?? promptState?.activePromptGenerationId
    ?? null;
  if (!promptGenerationId) {
    return null;
  }
  const transformId = makeRuntimeScopedId(`${params.actorKey}__${params.transformKind}`);
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_transform_applied",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    transformId,
    transformKind: params.transformKind,
    payload: params.payload,
    transform: {
      transformId,
      kind: params.transformKind,
      payload: params.payload,
      appliedAt: occurredAt,
    },
    occurredAt,
  });
  return transformId;
}

export function registerContextBlockToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId: string;
  title: string;
  content: string;
  source?: LocalConversationContextAssetData["source"];
  occurredAt?: string;
}): string {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const assetId = makeRuntimeScopedId(`${params.actorKey}__asset`);
  const asset: LocalConversationContextAssetData = {
    assetId,
    kind: params.source?.kind === "mcp_resource"
      ? "mcp_resource"
      : params.source?.kind === "upload"
        ? "upload"
        : params.source?.kind === "generated_summary"
          ? "generated_summary"
          : params.source?.kind === "note"
            ? "note"
            : "workspace_file",
    label: params.title,
    source: params.source ?? { kind: "workspace_file", path: params.title || assetId },
    metadata: {},
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_context_asset_registered",
    sessionId: params.sessionId,
    assetId,
    asset,
    occurredAt,
  });
  const promptGenerationId = recordPromptRequestToConversationDomainRuntime({
    runtime: params.runtime,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    reason: "asset_attach",
    basisRefs: [{ refKind: "session_asset", refId: assetId }],
    occurredAt,
  });
  const transformId = `${promptGenerationId}::asset_attach`;
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_transform_applied",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    transformId,
    transformKind: "context_asset_attach",
    payload: {
      assetId,
      title: params.title,
      content: params.content,
    },
    transform: {
      transformId,
      kind: "context_asset_attach",
      payload: {
        assetId,
        title: params.title,
        content: params.content,
      },
      appliedAt: occurredAt,
    },
    occurredAt,
  });
  return assetId;
}

export function clearContextBlocksInConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId: string;
  occurredAt?: string;
}): string {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const promptGenerationId = recordPromptRequestToConversationDomainRuntime({
    runtime: params.runtime,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    reason: "manual",
    occurredAt,
  });
  const transformId = `${promptGenerationId}::detach_all`;
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_transform_applied",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    transformId,
    transformKind: "context_asset_detach_all",
    payload: {},
    transform: {
      transformId,
      kind: "context_asset_detach_all",
      payload: {},
      appliedAt: occurredAt,
    },
    occurredAt,
  });
  return transformId;
}

export function forkConversationSessionInConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  parentSessionId?: string | null;
  forkedFromGenerationId?: string | null;
  occurredAt?: string;
}): void {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_session_forked",
    sessionId: params.sessionId,
    lineage: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: params.sessionId,
      parentSessionId: params.parentSessionId ?? null,
      forkedFromGenerationId: params.forkedFromGenerationId ?? null,
      rolledBackFromSessionId: null,
      predecessorSessionIds: params.parentSessionId ? [params.parentSessionId] : [],
      forkSessionIds: [],
      updatedAt: occurredAt,
    },
    occurredAt,
  });
}

export function closeConversationSessionInConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  reason?: string | null;
  occurredAt?: string;
}): void {
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_session_closed",
    sessionId: params.sessionId,
    reason: params.reason ?? null,
    occurredAt: params.occurredAt ?? new Date().toISOString(),
  });
}

export function materializeConversationRuntimeMessagesFromVm(params: {
  vm: AiAgentVm;
  actorKey: string;
}): ChatMessage[] {
  const actorRawState = getConversationActorRawStateFromVm({
    vm: params.vm,
    actorKey: params.actorKey,
  });
  return actorRawState ? materializeConversationRuntimePrompt(actorRawState) : [];
}

export function materializeConversationHistoryMessagesFromVm(params: {
  vm: AiAgentVm;
  actorKey: string;
}): ChatMessage[] {
  const actorRawState = getConversationActorRawStateFromVm({
    vm: params.vm,
    actorKey: params.actorKey,
  });
  return actorRawState ? materializeConversationVisibleHistory(actorRawState) : [];
}

const EMPTY_VISIBLE_MESSAGES: readonly ChatMessage[] = Object.freeze([]);

/**
 * Cache keyed by raw-state object identity: every domain write derives a NEW
 * ConversationActorRawState (refreshConversationActorRawStateFromDomainState),
 * so the projection invalidates naturally on writes and keeps a stable array
 * reference between writes (consumers holding the reference do not churn).
 */
const visibleMessagesProjectionCache = new WeakMap<object, readonly ChatMessage[]>();

/**
 * Read-only conversation view of an actor (spec case
 * single-in-memory-truth/mirror-eliminated): prompt-transform prelude plus
 * History-domain active tail, frozen. This is the single projection behind
 * the `actor.messages` facade getter; it is NOT a provider assembly input —
 * provider context comes from materializeConversationRuntimeMessagesFromVm.
 */
export function getConversationVisibleMessagesFromVm(params: {
  vm: AiAgentVm;
  actorKey: string;
}): readonly ChatMessage[] {
  const actorRawState = getConversationActorRawStateFromVm({
    vm: params.vm,
    actorKey: params.actorKey,
  });
  if (!actorRawState) return EMPTY_VISIBLE_MESSAGES;
  const cached = visibleMessagesProjectionCache.get(actorRawState);
  if (cached) return cached;
  const projected = Object.freeze(materializeConversationVisibleMessages(actorRawState));
  visibleMessagesProjectionCache.set(actorRawState, projected);
  return projected;
}

export function updateConversationDomainFromTranscriptRecordBatch(params: {
  vm: AiAgentVm;
  actorKey: string;
  actorId: string;
  transcriptRecord: TranscriptRecord;
}): void {
  // Compatibility/bootstrap helper only. Live ingress should append committed
  // messages via appendLiveHistoryMessageToConversationDomainRuntime(...).
  recordConversationTranscriptEvidenceInRuntime(params);
  const runtime = ensureVmConversationDomainRuntime(params.vm);
  const sessionId = resolveSessionIdFromVm(params.vm);
  const key = actorRuntimeKey(sessionId, params.actorKey);
  const current = runtime.messageAssemblySignal.get()[key];
  if (!current) return;
  const reducedMessages = reduceTranscriptToMessages(current.transcriptRecords);
  const previousReducedMessages = current.reducedMessages;
  const sharedCount = findSharedMessageSuffixPrefix(previousReducedMessages, reducedMessages);
  const newMessages = reducedMessages.slice(sharedCount);
  const nextReducedMessages = retainTail([...previousReducedMessages, ...newMessages], MAX_MESSAGE_ASSEMBLY_REDUCED_MESSAGES);
  runtime.messageAssemblySignal.set({
    ...runtime.messageAssemblySignal.get(),
    [key]: {
      ...current,
      reducedMessages: nextReducedMessages,
      emittedMessageCount: current.emittedMessageCount + newMessages.length,
      updatedAt: new Date().toISOString(),
    },
  });
  for (const message of newMessages) {
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm: params.vm,
      actorKey: params.actorKey,
      actorId: params.actorId,
      message,
    });
  }
}
