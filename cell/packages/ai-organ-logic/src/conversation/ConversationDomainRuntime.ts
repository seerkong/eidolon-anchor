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
  toCommittedConversationMessage,
  type ConversationPersistenceRepository,
} from "@cell/ai-support";
import { reduceTranscriptToMessages } from "@cell/ai-core-logic/runtime/ActorTranscript";
import type { TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";
import type { AiAgentVm } from "@cell/ai-core-logic";

export type ConversationHistoryDomainEvent = Extract<
  ConversationDomainEvent,
  { type: `actor_history_${string}` }
>;

export type ConversationPromptDomainEvent = Extract<
  ConversationDomainEvent,
  { type: `actor_prompt_${string}` }
>;

export type ConversationSessionDomainEvent = Extract<
  ConversationDomainEvent,
  { type: `local_conversation_${string}` }
>;

export type ConversationHistoryRuntimeState = {
  sessionId: string;
  actorKey: string;
  actorId: string;
  generations: ActorHistoryGenerationData[];
  activeGenerationId?: string | null;
  lastCompaction?: {
    sourceGenerationIds: string[];
    targetGenerationId: string;
    summaryText?: string | null;
    artifactId?: string | null;
    appliedAt: string;
  } | null;
  resetReason?: string | null;
  updatedAt: string;
};

export type ConversationPromptRuntimeState = {
  sessionId: string;
  actorKey: string;
  actorId: string;
  generations: ActorPromptGenerationData[];
  activePromptGenerationId?: string | null;
  resetReason?: string | null;
  updatedAt: string;
};

export type ConversationMessageAssemblyRuntimeState = {
  sessionId: string;
  actorKey: string;
  actorId: string;
  transcriptRecords: TranscriptRecord[];
  reducedMessages: ChatMessage[];
  emittedMessageCount: number;
  updatedAt: string;
};

type ValueSignal<T> = {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: (value: T) => void) => { unsubscribe: () => void };
};

type DomainListener<TEvent> = (event: TEvent) => void;

export type ConversationDomainEventStream<TEvent> = {
  subscribe: (listener: DomainListener<TEvent>) => { unsubscribe: () => void };
};

const MAX_CONVERSATION_DOMAIN_EVENTS_PER_STREAM = 500;
const MAX_MESSAGE_ASSEMBLY_TRANSCRIPT_RECORDS = 400;
const MAX_MESSAGE_ASSEMBLY_REDUCED_MESSAGES = 300;

export type ConversationDomainPersistHooks = {
  history?: (event: ConversationHistoryDomainEvent) => void;
  prompt?: (event: ConversationPromptDomainEvent) => void;
  session?: (event: ConversationSessionDomainEvent) => void;
};

export type ConversationDomainRuntime = {
  historyEvents: ConversationDomainEvent[];
  promptEvents: ConversationDomainEvent[];
  sessionEvents: ConversationDomainEvent[];
  actorRawStateSignal: ValueSignal<Record<string, ConversationActorRawState>>;
  historyStateSignal: ValueSignal<Record<string, ConversationHistoryRuntimeState>>;
  promptStateSignal: ValueSignal<Record<string, ConversationPromptRuntimeState>>;
  sessionStateSignal: ValueSignal<Record<string, ConversationSessionRawState>>;
  messageAssemblySignal: ValueSignal<Record<string, ConversationMessageAssemblyRuntimeState>>;
  historyListeners: Set<DomainListener<ConversationHistoryDomainEvent>>;
  promptListeners: Set<DomainListener<ConversationPromptDomainEvent>>;
  sessionListeners: Set<DomainListener<ConversationSessionDomainEvent>>;
  persistHooks: ConversationDomainPersistHooks;
};

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

function actorRuntimeKey(sessionId: string, actorKey: string): string {
  return `${sessionId}::${actorKey}`;
}

function retainTail<T>(items: T[], maxItems: number): T[] {
  if (items.length <= maxItems) return items;
  return items.slice(-maxItems);
}

function appendBounded<T>(items: T[], item: T, maxItems: number): T[] {
  if (items.length < maxItems) return [...items, item];
  return [...items.slice(items.length - maxItems + 1), item];
}

function trimMutableTail<T>(items: T[], maxItems: number): void {
  const extra = items.length - maxItems;
  if (extra > 0) items.splice(0, extra);
}

function chatMessagesEqual(left: ChatMessage, right: ChatMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findSharedMessageSuffixPrefix(previous: ChatMessage[], next: ChatMessage[]): number {
  const maxShared = Math.min(previous.length, next.length);
  for (let length = maxShared; length > 0; length -= 1) {
    let matched = true;
    for (let index = 0; index < length; index += 1) {
      if (!chatMessagesEqual(previous[previous.length - length + index]!, next[index]!)) {
        matched = false;
        break;
      }
    }
    if (matched) return length;
  }
  return 0;
}

function currentSessionActiveActorKey(session?: ConversationSessionRawState | null): string | null {
  const activeActorKey = session?.activeActorKey?.trim();
  if (activeActorKey) return activeActorKey;
  const indexedActiveActorKey = session?.sessionIndex.session.activeActorKey?.trim();
  if (indexedActiveActorKey) return indexedActiveActorKey;
  const selectedActorKey = session?.sessionIndex.session.activeSelection?.activeActorKey?.trim();
  return selectedActorKey || null;
}

function toHistoryRuntimeState(rawState: ConversationActorRawState): ConversationHistoryRuntimeState {
  return {
    sessionId: rawState.session.sessionId,
    actorKey: rawState.actorKey,
    actorId: rawState.actorId,
    generations: rawState.visibleHistoryGenerations,
    activeGenerationId: rawState.historyHeadGenerationId ?? null,
    lastCompaction: null,
    resetReason: null,
    updatedAt:
      rawState.activeHistoryGeneration?.updatedAt
      ?? rawState.session.historyIndex.updatedAt
      ?? new Date(0).toISOString(),
  };
}

function toPromptRuntimeState(rawState: ConversationActorRawState): ConversationPromptRuntimeState {
  return {
    sessionId: rawState.session.sessionId,
    actorKey: rawState.actorKey,
    actorId: rawState.actorId,
    generations: rawState.promptGeneration ? [rawState.promptGeneration] : [],
    activePromptGenerationId: rawState.promptHeadGenerationId ?? null,
    resetReason: null,
    updatedAt:
      rawState.promptGeneration?.updatedAt
      ?? rawState.session.promptIndex.updatedAt
      ?? new Date(0).toISOString(),
  };
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
  if (current) return current;
  const created = createConversationDomainRuntime();
  vm.runtimeContext.conversationDomainRuntime = created;
  return created;
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

function upsertHistoryGeneration(
  generations: ActorHistoryGenerationData[],
  generation: ActorHistoryGenerationData,
): ActorHistoryGenerationData[] {
  return [
    ...generations.filter((item) => item.generationId !== generation.generationId),
    generation,
  ];
}

function upsertPromptGeneration(
  generations: ActorPromptGenerationData[],
  generation: ActorPromptGenerationData,
): ActorPromptGenerationData[] {
  return [
    ...generations.filter((item) => item.promptGenerationId !== generation.promptGenerationId),
    generation,
  ];
}

function createEmptySessionState(sessionId: string): ConversationSessionRawState {
  const zeroIso = new Date(0).toISOString();
  return {
    sessionId,
    activeActorKey: null,
    actorBindings: {},
    contextAssetRegistry: null,
    contextAssets: [],
    activeSelection: null,
    lineage: null,
    historyIndex: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      heads: {},
      lineages: {},
      generations: {},
      updatedAt: zeroIso,
    },
    promptIndex: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      heads: {},
      generations: {},
      updatedAt: zeroIso,
    },
    sessionIndex: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      session: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId,
        activeActorKey: null,
        actorBindings: {},
        contextAssetRegistry: null,
        contextAssets: [],
        activeSelection: null,
        createdAt: zeroIso,
        updatedAt: zeroIso,
      },
      lineage: null,
      updatedAt: zeroIso,
    },
  };
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

function refreshConversationActorRawStateFromDomainState(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId?: string;
}): void {
  const key = actorRuntimeKey(params.sessionId, params.actorKey);
  const currentActorRaw = params.runtime.actorRawStateSignal.get()[key];
  const historyState = params.runtime.historyStateSignal.get()[key];
  const promptState = params.runtime.promptStateSignal.get()[key];
  const sessionState = params.runtime.sessionStateSignal.get()[params.sessionId]
    ?? currentActorRaw?.session
    ?? createEmptySessionState(params.sessionId);
  const actorId =
    params.actorId
    ?? currentActorRaw?.actorId
    ?? historyState?.actorId
    ?? promptState?.actorId
    ?? sessionState.actorBindings[params.actorKey]?.actorId
    ?? "";
  const visibleHistoryGenerations = historyState?.generations ?? currentActorRaw?.visibleHistoryGenerations ?? [];
  const historyHeadGenerationId =
    historyState?.activeGenerationId
    ?? sessionState.actorBindings[params.actorKey]?.historyHeadGenerationId
    ?? currentActorRaw?.historyHeadGenerationId
    ?? null;
  const promptHeadGenerationId =
    promptState?.activePromptGenerationId
    ?? sessionState.actorBindings[params.actorKey]?.promptHeadGenerationId
    ?? currentActorRaw?.promptHeadGenerationId
    ?? null;
  const activeHistoryGeneration = historyHeadGenerationId
    ? (
        visibleHistoryGenerations.find((generation) => generation.generationId === historyHeadGenerationId)
        ?? currentActorRaw?.activeHistoryGeneration
        ?? null
      )
    : null;
  const promptGeneration = promptHeadGenerationId
    ? (
        promptState?.generations.find((generation) => generation.promptGenerationId === promptHeadGenerationId)
        ?? currentActorRaw?.promptGeneration
        ?? null
      )
    : null;

  params.runtime.actorRawStateSignal.set({
    ...params.runtime.actorRawStateSignal.get(),
    [key]: {
      session: sessionState,
      actorKey: params.actorKey,
      actorId,
      historyHeadGenerationId,
      promptHeadGenerationId,
      visibleGenerationIds: visibleHistoryGenerations.map((generation) => generation.generationId),
      visibleHistoryGenerations,
      activeHistoryGeneration,
      promptGeneration,
      contextAssetIds: sessionState.contextAssetRegistry?.assetIds ?? currentActorRaw?.contextAssetIds ?? [],
    },
  });
}

function appendCommittedMessageToGeneration(params: {
  generation: ActorHistoryGenerationData;
  message: ConversationCommittedMessageData;
  actorKey: string;
  actorId: string;
  occurredAt?: string;
}): ActorHistoryGenerationData {
  const nextIndex = params.generation.messages.length;
  const updatedAt = params.occurredAt ?? new Date().toISOString();
  return {
    ...params.generation,
    messages: [
      ...params.generation.messages,
      {
        recordId: `${params.generation.generationId}::${nextIndex}`,
        actorKey: params.actorKey,
        actorId: params.actorId,
        committedAt: nextIndex,
        message: params.message,
      },
    ],
    messageCount: params.generation.messages.length + 1,
    updatedAt,
  };
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
  const historyStates = runtime.historyStateSignal.get();
  const current = historyStates[key] ?? {
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    generations: [],
    activeGenerationId: `${params.actorKey}__active`,
    lastCompaction: null,
    resetReason: null,
    updatedAt: new Date(0).toISOString(),
  };
  const generation =
    current.generations.find((item) => item.generationId === current.activeGenerationId)
    ?? {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      generationId: current.activeGenerationId ?? `${params.actorKey}__active`,
      sessionId,
      actorKey: params.actorKey,
      actorId: params.actorId,
      parentGenerationId: null,
      predecessorGenerationIds: [],
      createdReason: "append",
      sealed: false,
      messageCount: 0,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  const nextGeneration = appendCommittedMessageToGeneration({
    generation,
    message: toCommittedConversationMessage(params.message),
    actorKey: params.actorKey,
    actorId: params.actorId,
    occurredAt,
  });
  const nextHistoryState: ConversationHistoryRuntimeState = {
    ...current,
    actorId: params.actorId,
    generations: upsertHistoryGeneration(current.generations, nextGeneration),
    activeGenerationId: nextGeneration.generationId,
    updatedAt: nextGeneration.updatedAt,
  };
  runtime.historyStateSignal.set({
    ...historyStates,
    [key]: nextHistoryState,
  });

  const sessionStates = runtime.sessionStateSignal.get();
  const currentActiveActorKey =
    currentSessionActiveActorKey(sessionStates[sessionId])
    ?? params.actorKey;
  const actorIsActive = currentActiveActorKey === params.actorKey;
  const currentSession = sessionStates[sessionId] ?? {
    sessionId,
    activeActorKey: params.actorKey,
    actorBindings: {},
    contextAssetRegistry: null,
    contextAssets: [],
    activeSelection: null,
    lineage: null,
    historyIndex: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      heads: {},
      lineages: {},
      generations: {},
      updatedAt: nextGeneration.updatedAt,
    },
    promptIndex: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      heads: {},
      generations: {},
      updatedAt: nextGeneration.updatedAt,
    },
    sessionIndex: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      session: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId,
        activeActorKey: params.actorKey,
        actorBindings: {},
        contextAssetRegistry: null,
        contextAssets: [],
        activeSelection: null,
        createdAt: nextGeneration.createdAt,
        updatedAt: nextGeneration.updatedAt,
      },
      lineage: null,
      updatedAt: nextGeneration.updatedAt,
    },
  };
  const nextSession: ConversationSessionRawState = {
    ...currentSession,
    activeActorKey: currentActiveActorKey,
    actorBindings: {
      ...currentSession.actorBindings,
      [params.actorKey]: {
        actorKey: params.actorKey,
        actorId: params.actorId,
        boundAt: nextGeneration.updatedAt,
        historyHeadGenerationId: nextGeneration.generationId,
        promptHeadGenerationId:
          currentSession.actorBindings[params.actorKey]?.promptHeadGenerationId ?? null,
      },
    },
    sessionIndex: {
      ...currentSession.sessionIndex,
      updatedAt: nextGeneration.updatedAt,
      session: {
        ...currentSession.sessionIndex.session,
        activeActorKey: currentActiveActorKey,
        actorBindings: {
          ...currentSession.sessionIndex.session.actorBindings,
          [params.actorKey]: {
            actorKey: params.actorKey,
            actorId: params.actorId,
            boundAt: nextGeneration.updatedAt,
            historyHeadGenerationId: nextGeneration.generationId,
            promptHeadGenerationId:
              currentSession.sessionIndex.session.actorBindings[params.actorKey]?.promptHeadGenerationId ?? null,
          },
        },
        activeSelection: actorIsActive
          ? {
              sessionId,
              activeActorKey: params.actorKey,
              historyHeadGenerationId: nextGeneration.generationId,
              promptHeadGenerationId:
                currentSession.sessionIndex.session.actorBindings[params.actorKey]?.promptHeadGenerationId ?? null,
              selectedAt: nextGeneration.updatedAt,
            }
          : currentSession.sessionIndex.session.activeSelection,
        updatedAt: nextGeneration.updatedAt,
      },
    },
  };
  runtime.sessionStateSignal.set({
    ...sessionStates,
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
    transforms: [...(currentPromptGeneration?.transforms ?? [])],
    createdReason: params.reason ?? "request_build",
    materializedContext: params.materializedContext ?? currentPromptGeneration?.materializedContext ?? null,
    sealed: false,
    createdAt: occurredAt,
    sealedAt: null,
    updatedAt: occurredAt,
    metadata: params.metadata ?? {},
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
