import {
  assertDerivationContract,
  createDerivationContract,
  type DataSubgraphContract,
  type DerivationContract,
} from "@cell/platform-contract";

/**
 * Stage components of the streaming pipeline (ingress -> lexical/syntactic ->
 * semantic). Stage logic stays unchanged; these contracts pin ownership. The
 * semantic event stream is the canonical timeline and the single extension
 * point: ALL conversation inputs (provider stream output, user input, tool
 * results, childDone) enter as semantic events, and the conversation domains'
 * only writer is the reducer/assembly consuming this stream.
 */

export const INGRESS_STAGE_CONTRACT: DataSubgraphContract = {
  id: "ingress_stage",
  layer: "domain",
  ownedFactNodes: [{ nodeId: "stage.ingress_timeline", grade: "authoritative_fact" }],
  derivedNodes: [],
  writeCommands: ["stage.append_ingress"],
  readViews: ["stage.ingress_replay_view"],
  factStreams: ["stage.ingress_events"],
  projectionSinks: ["journal.ingress"],
  notOwnedHere: ["stage.semantic_events", "history.committed_messages"],
  allowedRecoveryReads: [],
  forbiddenLiveReads: ["journal.ingress"],
};

export const LEXICAL_SYNTACTIC_STAGE_CONTRACT: DataSubgraphContract = {
  id: "lexical_syntactic_stage",
  layer: "domain",
  ownedFactNodes: [
    { nodeId: "stage.lexical_events", grade: "domain_canonical_event" },
    { nodeId: "stage.syntactic_events", grade: "domain_canonical_event" },
    { nodeId: "stage.parser_state", grade: "derived_projection_cache" },
  ],
  derivedNodes: [],
  writeCommands: ["stage.advance_parser"],
  readViews: ["stage.syntactic_view"],
  factStreams: ["stage.syntactic_events_stream"],
  projectionSinks: ["journal.diagnostics"],
  notOwnedHere: ["stage.semantic_events", "stage.ingress_timeline"],
  allowedRecoveryReads: [],
  forbiddenLiveReads: ["stage.ingress_timeline"],
};

export const SEMANTIC_EVENT_CONTRACT: DataSubgraphContract = {
  id: "semantic_event",
  layer: "domain",
  ownedFactNodes: [{ nodeId: "stage.semantic_events", grade: "domain_canonical_event" }],
  derivedNodes: [],
  writeCommands: ["stage.emit_semantic_event"],
  readViews: ["stage.semantic_stream_view"],
  factStreams: ["stage.semantic_events_stream"],
  projectionSinks: ["surface.tui_view", "journal.diagnostics"],
  notOwnedHere: ["history.committed_messages", "llm_context.materialized_provider_context"],
  allowedRecoveryReads: [],
  forbiddenLiveReads: ["stage.parser_state"],
};

export const AI_STAGE_COMPONENT_CONTRACTS: readonly DataSubgraphContract[] = [
  INGRESS_STAGE_CONTRACT,
  LEXICAL_SYNTACTIC_STAGE_CONTRACT,
  SEMANTIC_EVENT_CONTRACT,
];

/** Conversation derivations: contract-hosted processing definitions. */

export type ConversationReducerDerivation<TState = unknown, TCommand = unknown, TEvent = unknown, TView = unknown> = {
  initializeConversationState: (input?: unknown) => TState;
  applyCommand: (state: TState, command: TCommand) => { state: TState; events: TEvent[] };
  projectVisibleHistory: (state: TState) => TView;
};

export const CONVERSATION_REDUCER_DERIVATION_CONTRACT: DerivationContract = createDerivationContract({
  contractId: "conversation_reducer_derivation",
  requiredMethods: ["initializeConversationState", "applyCommand", "projectVisibleHistory"],
});

export function assertConversationReducerDerivation<TState, TCommand, TEvent, TView>(
  implementation: ConversationReducerDerivation<TState, TCommand, TEvent, TView>,
): ConversationReducerDerivation<TState, TCommand, TEvent, TView> {
  return assertDerivationContract(CONVERSATION_REDUCER_DERIVATION_CONTRACT, implementation);
}

export type MessageAssemblyDerivation<TState = unknown, TSemanticEvent = unknown, TCommitted = unknown> = {
  initializeAssemblyState: (input?: unknown) => TState;
  reduceSemanticEvent: (state: TState, event: TSemanticEvent) => { state: TState; committed?: TCommitted };
};

export const MESSAGE_ASSEMBLY_DERIVATION_CONTRACT: DerivationContract = createDerivationContract({
  contractId: "message_assembly_derivation",
  requiredMethods: ["initializeAssemblyState", "reduceSemanticEvent"],
});

export function assertMessageAssemblyDerivation<TState, TSemanticEvent, TCommitted>(
  implementation: MessageAssemblyDerivation<TState, TSemanticEvent, TCommitted>,
): MessageAssemblyDerivation<TState, TSemanticEvent, TCommitted> {
  return assertDerivationContract(MESSAGE_ASSEMBLY_DERIVATION_CONTRACT, implementation);
}

export type MaterializationDerivation<TDomains = unknown, TProviderMessages = unknown> = {
  /** Three stages: Session selection -> History active tail -> Context transforms/overlay. */
  materializeProviderContext: (domains: TDomains) => TProviderMessages;
};

export const MATERIALIZATION_DERIVATION_CONTRACT: DerivationContract = createDerivationContract({
  contractId: "materialization_derivation",
  requiredMethods: ["materializeProviderContext"],
});

export function assertMaterializationDerivation<TDomains, TProviderMessages>(
  implementation: MaterializationDerivation<TDomains, TProviderMessages>,
): MaterializationDerivation<TDomains, TProviderMessages> {
  return assertDerivationContract(MATERIALIZATION_DERIVATION_CONTRACT, implementation);
}

/** Conversation capsule: stable entry shapes and persistence adapter wiring. */

export const CONVERSATION_PERSISTENCE_ADAPTER_IDS = ["local_file", "in_memory"] as const;

export type ConversationPersistenceAdapterId = (typeof CONVERSATION_PERSISTENCE_ADAPTER_IDS)[number];

/**
 * Persistence adapter surface of the conversation capsule. The shape mirrors
 * the consumed factory surface (`createRepository(sessionDir)` on the
 * conversation persistence repository factory); the repository payload stays
 * `unknown` so the contract package does not depend back on support-layer
 * repository types.
 */
export type ConversationPersistenceAdapter = {
  createRepository: (sessionDir: string) => unknown;
};

export type ConversationCapsuleRuntime = {
  persistenceDependencies?: unknown;
};

export type ConversationCapsuleInput = {
  sessionId: string;
};

export type ConversationCapsuleConfig = {
  persistenceAdapter: ConversationPersistenceAdapterId;
};

export type ConversationCapsuleOutput = {
  state: unknown;
  /** Adapter resolved from `config.persistenceAdapter` via the capsule registry. */
  persistence: ConversationPersistenceAdapter;
};
