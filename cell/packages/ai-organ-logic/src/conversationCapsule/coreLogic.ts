import {
  assertConversationReducerDerivation,
  assertMaterializationDerivation,
  assertMessageAssemblyDerivation,
  type ConversationCapsuleConfig,
  type ConversationCapsuleInput,
  type ConversationCapsuleOutput,
  type ConversationCapsuleRuntime,
} from "@cell/ai-core-contract";

import { resolveConversationPersistenceAdapter } from "./adapterRegistry";
import { createInMemoryConversationPersistenceAdapter } from "./adapters/inMemory";
import {
  applyConversationDomainsCommand,
  initializeConversationDomainsState,
  materializeProviderContextFromDomains,
  projectConversationVisibleHistoryFromDomains,
  type ThreeDomainCommand,
  type ThreeDomainState,
} from "./internals/derivations";
import {
  initializeMessageAssemblyState,
  reduceMessageAssemblySemanticEvent,
} from "./internals/messageAssembly";

/**
 * Stable core logic surface of the conversation capsule. The vm-coupled
 * domain runtime lives in ./internals/domainRuntime; pure reduction and
 * projection cores live in ./internals/derivations. Everything consumers may
 * use is re-exported here so nothing outside the capsule reaches into
 * internals.
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
} from "./internals/domainRuntime";

export {
  actorRuntimeKey,
  appendBounded,
  appendCommittedMessageToGeneration,
  applyCommittedMessageAppendToDomains,
  applyConversationDomainsCommand,
  createEmptySessionState,
  currentSessionActiveActorKey,
  deriveConversationActorRawState,
  findSharedMessageSuffixPrefix,
  initializeConversationDomainsState,
  materializeProviderContextFromDomains,
  projectConversationVisibleHistoryFromDomains,
  retainTail,
  toHistoryRuntimeState,
  toPromptRuntimeState,
  upsertHistoryGeneration,
  upsertPromptGeneration,
} from "./internals/derivations";

export {
  initializeMessageAssemblyState,
  reduceMessageAssemblySemanticEvent,
} from "./internals/messageAssembly";

export { createInMemoryConversationPersistenceAdapter } from "./adapters/inMemory";

export {
  MAX_CONVERSATION_DOMAIN_EVENTS_PER_STREAM,
  MAX_MESSAGE_ASSEMBLY_REDUCED_MESSAGES,
  MAX_MESSAGE_ASSEMBLY_TRANSCRIPT_RECORDS,
} from "./internals/constants";

/**
 * Conversation reducer derivation: explicit-state processing definition for
 * the conversation cluster, asserted against the contract from
 * @cell/ai-core-contract.
 */
export const conversationReducerDerivation = assertConversationReducerDerivation({
  initializeConversationState: (input?: unknown): ThreeDomainState =>
    initializeConversationDomainsState(input),
  applyCommand: (state: ThreeDomainState, command: ThreeDomainCommand) =>
    applyConversationDomainsCommand(state, command),
  projectVisibleHistory: (state: ThreeDomainState) =>
    projectConversationVisibleHistoryFromDomains(state),
});

/**
 * Message assembly derivation: the MessageHistoryGraph merge semantics
 * formalized as a contract-asserted derivation. semantic -> committed is the
 * single commit boundary; the implementation reduces with the same pure core
 * as MessageHistoryGraph (see ./internals/messageAssembly).
 */
export const messageAssemblyDerivation = assertMessageAssemblyDerivation({
  initializeAssemblyState: () => initializeMessageAssemblyState(),
  reduceSemanticEvent: reduceMessageAssemblySemanticEvent,
});

/**
 * Materialization derivation: provider-context materialization over the
 * explicit three-domain state (three stages: Session selection -> History
 * active tail -> Context transforms/overlay).
 */
export const materializationDerivation = assertMaterializationDerivation({
  materializeProviderContext: (domains: ThreeDomainState) =>
    materializeProviderContextFromDomains(domains),
});

/**
 * Stable capsule entry. `runtime` carries injected adapter dependencies,
 * `input` identifies the session, `config` selects the persistence adapter by
 * enum id; the adapter is resolved through the capsule registry (unknown ids
 * throw) and exposed on the output. "in_memory" is registered by the capsule
 * itself; "local_file" is registered by the assembly layer (ai-support).
 */
export function runConversationCapsule(
  runtime: ConversationCapsuleRuntime,
  input: ConversationCapsuleInput,
  config: ConversationCapsuleConfig,
): ConversationCapsuleOutput {
  void runtime;
  const persistence = resolveConversationPersistenceAdapter(config.persistenceAdapter);
  return {
    state: initializeConversationDomainsState({ sessionId: input.sessionId }),
    persistence,
  };
}
