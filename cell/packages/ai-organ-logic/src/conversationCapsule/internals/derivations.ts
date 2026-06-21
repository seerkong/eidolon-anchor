import type { ChatMessage } from "@shared/composer";

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorHistoryGenerationData,
  type ActorPromptGenerationData,
  type ConversationActorRawState,
  type ConversationCommittedMessageData,
  type ConversationDomainEvent,
  type ConversationSessionRawState,
} from "@cell/ai-organ-contract";
import {
  committedHistoryRefsToMessages,
  materializeConversationRuntimePrompt,
  toCommittedConversationMessage,
} from "@cell/ai-support";

import type {
  ConversationHistoryRuntimeState,
  ConversationPromptRuntimeState,
} from "../../conversation/ConversationDomainRuntime";

/**
 * Pure reduction/projection functions of the conversation capsule. Top-level
 * function declarations only, no IO and no imports from domainRuntime or
 * coreLogic: the vm-coupled runtime wrappers in ./domainRuntime call into the
 * pure cores defined here (same surgery as the orchestrator capsule's
 * applyResumeFiber).
 */

/** Explicit three-domain conversation state (history / llm-context / session). */
export type ThreeDomainState = {
  history: Record<string, ConversationHistoryRuntimeState>;
  prompt: Record<string, ConversationPromptRuntimeState>;
  session: Record<string, ConversationSessionRawState>;
};

/** Commands accepted by the conversation reducer derivation (extended in later tasks). */
export type ThreeDomainCommand = {
  kind: "append_committed_message";
  sessionId?: string;
  actorKey: string;
  actorId: string;
  message: ChatMessage;
  occurredAt?: string;
};

export function actorRuntimeKey(sessionId: string, actorKey: string): string {
  return `${sessionId}::${actorKey}`;
}

export function retainTail<T>(items: T[], maxItems: number): T[] {
  if (items.length <= maxItems) return items;
  return items.slice(-maxItems);
}

export function appendBounded<T>(items: T[], item: T, maxItems: number): T[] {
  if (items.length < maxItems) return [...items, item];
  return [...items.slice(items.length - maxItems + 1), item];
}

function chatMessagesEqual(left: ChatMessage, right: ChatMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function findSharedMessageSuffixPrefix(previous: ChatMessage[], next: ChatMessage[]): number {
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

export function currentSessionActiveActorKey(session?: ConversationSessionRawState | null): string | null {
  const activeActorKey = session?.activeActorKey?.trim();
  if (activeActorKey) return activeActorKey;
  const indexedActiveActorKey = session?.sessionIndex.session.activeActorKey?.trim();
  if (indexedActiveActorKey) return indexedActiveActorKey;
  const selectedActorKey = session?.sessionIndex.session.activeSelection?.activeActorKey?.trim();
  return selectedActorKey || null;
}

export function toHistoryRuntimeState(rawState: ConversationActorRawState): ConversationHistoryRuntimeState {
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

export function toPromptRuntimeState(rawState: ConversationActorRawState): ConversationPromptRuntimeState {
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

export function upsertHistoryGeneration(
  generations: ActorHistoryGenerationData[],
  generation: ActorHistoryGenerationData,
): ActorHistoryGenerationData[] {
  return [
    ...generations.filter((item) => item.generationId !== generation.generationId),
    generation,
  ];
}

export function upsertPromptGeneration(
  generations: ActorPromptGenerationData[],
  generation: ActorPromptGenerationData,
): ActorPromptGenerationData[] {
  return [
    ...generations.filter((item) => item.promptGenerationId !== generation.promptGenerationId),
    generation,
  ];
}

export function createEmptySessionState(sessionId: string): ConversationSessionRawState {
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

export function appendCommittedMessageToGeneration(params: {
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

/**
 * Pure core of the actor raw-state projection: recomputes the
 * ConversationActorRawState view from the explicit per-domain states. The
 * runtime wrapper (refreshConversationActorRawStateFromDomainState) feeds the
 * vm signals into this function and publishes the result.
 */
export function deriveConversationActorRawState(params: {
  sessionId: string;
  actorKey: string;
  actorId?: string;
  currentActorRaw?: ConversationActorRawState | null;
  historyState?: ConversationHistoryRuntimeState | null;
  promptState?: ConversationPromptRuntimeState | null;
  sessionState?: ConversationSessionRawState | null;
}): ConversationActorRawState {
  const currentActorRaw = params.currentActorRaw ?? null;
  const historyState = params.historyState ?? null;
  const promptState = params.promptState ?? null;
  const sessionState = params.sessionState
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

  return {
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
  };
}

/**
 * Pure core of committed-message append: computes the next History-domain and
 * Session-domain states (plus the appended generation) for one committed
 * message. The vm wrapper appendLiveHistoryMessageToConversationDomainRuntime
 * publishes these to the signals and emits the domain event.
 */
export function applyCommittedMessageAppendToDomains(params: {
  historyStates: Record<string, ConversationHistoryRuntimeState>;
  sessionStates: Record<string, ConversationSessionRawState>;
  sessionId: string;
  actorKey: string;
  actorId: string;
  message: ChatMessage;
  occurredAt: string;
}): {
  key: string;
  nextHistoryState: ConversationHistoryRuntimeState;
  nextSession: ConversationSessionRawState;
  nextGeneration: ActorHistoryGenerationData;
} {
  const sessionId = params.sessionId;
  const key = actorRuntimeKey(sessionId, params.actorKey);
  const current = params.historyStates[key] ?? {
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
    occurredAt: params.occurredAt,
  });
  const nextHistoryState: ConversationHistoryRuntimeState = {
    ...current,
    actorId: params.actorId,
    generations: upsertHistoryGeneration(current.generations, nextGeneration),
    activeGenerationId: nextGeneration.generationId,
    updatedAt: nextGeneration.updatedAt,
  };

  const currentActiveActorKey =
    currentSessionActiveActorKey(params.sessionStates[sessionId])
    ?? params.actorKey;
  const actorIsActive = currentActiveActorKey === params.actorKey;
  const currentSession = params.sessionStates[sessionId] ?? {
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

  return { key, nextHistoryState, nextSession, nextGeneration };
}

/** Reducer derivation: initialize an empty explicit three-domain state. */
export function initializeConversationDomainsState(input?: unknown): ThreeDomainState {
  const sessionId =
    input && typeof input === "object" && typeof (input as { sessionId?: unknown }).sessionId === "string"
      ? (input as { sessionId: string }).sessionId
      : null;
  return {
    history: {},
    prompt: {},
    session: sessionId ? { [sessionId]: createEmptySessionState(sessionId) } : {},
  };
}

/** Reducer derivation: apply a command to the explicit three-domain state. */
export function applyConversationDomainsCommand(
  state: ThreeDomainState,
  command: ThreeDomainCommand,
): { state: ThreeDomainState; events: ConversationDomainEvent[] } {
  if (!command || command.kind !== "append_committed_message") {
    return { state, events: [] };
  }
  const sessionId = command.sessionId ?? Object.keys(state.session)[0] ?? "__unsessioned__";
  const occurredAt = command.occurredAt ?? new Date().toISOString();
  const { key, nextHistoryState, nextSession, nextGeneration } = applyCommittedMessageAppendToDomains({
    historyStates: state.history,
    sessionStates: state.session,
    sessionId,
    actorKey: command.actorKey,
    actorId: command.actorId,
    message: command.message,
    occurredAt,
  });
  const event: ConversationDomainEvent = {
    type: "actor_history_appended",
    sessionId,
    actorKey: command.actorKey,
    generationId: nextGeneration.generationId,
    messageRecordId: `${nextGeneration.generationId}::${nextGeneration.messages.length - 1}`,
    message: toCommittedConversationMessage(command.message),
    generation: nextGeneration,
    head: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      actorKey: command.actorKey,
      actorId: command.actorId,
      activeGenerationId: nextGeneration.generationId,
      visibleGenerationIds: nextHistoryState.generations.map((generation) => generation.generationId),
      updatedAt: nextGeneration.updatedAt,
    },
    occurredAt: nextGeneration.updatedAt,
  };
  return {
    state: {
      history: { ...state.history, [key]: nextHistoryState },
      prompt: state.prompt,
      session: { ...state.session, [sessionId]: nextSession },
    },
    events: [event],
  };
}

/** Reducer derivation: project committed visible history per actor. */
export function projectConversationVisibleHistoryFromDomains(
  state: ThreeDomainState,
): Record<string, ChatMessage[]> {
  const view: Record<string, ChatMessage[]> = {};
  for (const [key, historyState] of Object.entries(state.history)) {
    view[key] = historyState.generations.flatMap((generation) =>
      committedHistoryRefsToMessages(generation.messages),
    );
  }
  return view;
}

/**
 * Materialization derivation: provider-context materialization over the
 * explicit three-domain state (pure part of
 * materializeConversationRuntimePrompt, fed by the derived actor raw state).
 */
export function materializeProviderContextFromDomains(state: ThreeDomainState): ChatMessage[] {
  for (const sessionState of Object.values(state.session)) {
    const actorKey = currentSessionActiveActorKey(sessionState);
    if (!actorKey) continue;
    const key = actorRuntimeKey(sessionState.sessionId, actorKey);
    const rawState = deriveConversationActorRawState({
      sessionId: sessionState.sessionId,
      actorKey,
      historyState: state.history[key] ?? null,
      promptState: state.prompt[key] ?? null,
      sessionState,
    });
    return materializeConversationRuntimePrompt(rawState);
  }
  const firstHistory = Object.values(state.history)[0];
  if (!firstHistory) return [];
  const firstKey = actorRuntimeKey(firstHistory.sessionId, firstHistory.actorKey);
  const rawState = deriveConversationActorRawState({
    sessionId: firstHistory.sessionId,
    actorKey: firstHistory.actorKey,
    actorId: firstHistory.actorId,
    historyState: firstHistory,
    promptState: state.prompt[firstKey] ?? null,
    sessionState: state.session[firstHistory.sessionId] ?? null,
  });
  return materializeConversationRuntimePrompt(rawState);
}
