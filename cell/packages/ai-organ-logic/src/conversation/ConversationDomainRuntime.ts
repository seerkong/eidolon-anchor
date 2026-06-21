import type { ChatMessage } from "@shared/composer";

import type {
  ActorHistoryGenerationData,
  ActorPromptGenerationData,
  ConversationActorRawState,
  ConversationDomainEvent,
  ConversationSessionRawState,
} from "@cell/ai-organ-contract";
import type { TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";

/**
 * Compatibility facade for the conversation capsule. The implementation lives
 * in ../conversationCapsule (coreLogic + internals); this module owns the
 * exported types and re-exports the public value surface from coreLogic.
 */

export {
  appendConversationDomainEvent,
  appendLiveHistoryMessageToConversationDomainRuntime,
  bindActorConversationProjectionToVm,
  applyPromptTransformToConversationDomainRuntime,
  clearContextBlocksInConversationDomainRuntime,
  closeConversationSessionInConversationDomainRuntime,
  createConversationDomainRuntime,
  emitConversationDomainEvent,
  ensureVmConversationDomainRuntime,
  forkConversationSessionInConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  getConversationSessionRawStateFromVm,
  getConversationVisibleMessagesFromVm,
  getVmConversationDomainRuntime,
  injectConversationActorRawState,
  injectConversationSessionRawState,
  materializeConversationHistoryMessagesFromVm,
  materializeConversationRuntimeMessagesFromVm,
  recordConversationTranscriptEvidenceInRuntime,
  recordPromptOverlayToConversationDomainRuntime,
  recordPromptRequestToConversationDomainRuntime,
  registerContextBlockToConversationDomainRuntime,
  rewriteActiveHistoryGenerationMessagesInConversationDomainRuntime,
  setConversationDomainPersistHooks,
  subscribeConversationHistory,
  subscribeConversationPrompt,
  subscribeConversationSession,
  synchronizeConversationDomainActorFromPersistence,
  synchronizeConversationDomainSessionFromPersistence,
  teeConversationHistoryStream,
  teeConversationPromptStream,
  teeConversationSessionStream,
  updateConversationDomainFromTranscriptRecordBatch,
} from "../conversationCapsule/coreLogic";

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
