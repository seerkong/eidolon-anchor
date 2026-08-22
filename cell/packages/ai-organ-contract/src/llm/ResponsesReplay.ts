import type { ResponsesContinuationMode } from "./ProviderRuntime";

/**
 * One JSON-compatible Responses input/output item kept exactly in provider shape.
 * It is deliberately not a ChatMessage or a Conversation History fact.
 */
export type ResponsesNativeItem = Readonly<Record<string, unknown>>;

export type ResponsesNativeOutputEvidenceItem = Readonly<{
  outputIndex?: number;
  item: ResponsesNativeItem;
}>;

export type ResponsesFunctionCallArgumentDeltaEvidence = Readonly<{
  itemId: string;
  delta: string;
}>;

/** Raw provider event evidence. A transport may collect it, but cannot decide it. */
export type ResponsesNativeOutputEvidence = Readonly<{
  schemaVersion: 1;
  kind: "responses_native_output_evidence";
  responseId: string;
  completedOutput: Readonly<{
    observed: boolean;
    items: readonly ResponsesNativeItem[];
  }>;
  addedItems: readonly ResponsesNativeOutputEvidenceItem[];
  doneItems: readonly ResponsesNativeOutputEvidenceItem[];
  functionCallArgumentDeltas: readonly ResponsesFunctionCallArgumentDeltaEvidence[];
}>;

export type ResponsesNativeOutputCompletenessProof = Readonly<{
  schemaVersion: 1;
  kind: "responses_native_output_completeness_proof";
  status: "complete";
  source: "completed_output" | "indexed_done_items" | "reconstructed_event_items";
  evidenceDigest: string;
}>;

export type ResponsesCallLineageProof = Readonly<{
  schemaVersion: 1;
  kind: "responses_call_lineage_proof";
  status: "valid";
  itemCount: number;
  lineageDigest: string;
}>;

export type ResponsesCallLineageInvalidReason =
  | "empty_call_id"
  | "duplicate_function_call"
  | "duplicate_function_call_output"
  | "out_of_order_function_call_output"
  | "orphan_function_call_output"
  | "unresolved_function_call";

export type ResponsesCallLineageDecision =
  | ResponsesCallLineageProof
  | Readonly<{
      schemaVersion: 1;
      kind: "responses_call_lineage_decision";
      status: "invalid";
      reason: ResponsesCallLineageInvalidReason;
      itemIndex: number;
      callId?: string;
    }>;

export type ResponsesMessageFingerprint = Readonly<{
  schemaVersion: 1;
  algorithm: "sha256";
  digest: string;
}>;

export type ResponsesMessageFrontier = Readonly<{
  schemaVersion: 1;
  algorithm: "sha256";
  messageCount: number;
  digest: string;
}>;

export type ResponsesProviderOutputSnapshot = Readonly<{
  schemaVersion: 2;
  kind: "responses_provider_output_snapshot";
  responseId?: string;
  items: readonly ResponsesNativeItem[];
  completenessProof: ResponsesNativeOutputCompletenessProof;
}>;

export type ResponsesNativeOutputCompletenessDecision =
  | Readonly<{
      schemaVersion: 1;
      kind: "responses_native_output_completeness_decision";
      status: "complete";
      output: ResponsesProviderOutputSnapshot;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "responses_native_output_completeness_decision";
      status: "incomplete";
      reason:
        | "invalid_evidence"
        | "missing_final_output"
        | "terminal_output_conflict"
        | "indexed_output_conflict";
    }>;

export type ResponsesNativeWindowFingerprint = Readonly<{
  schemaVersion: 1;
  algorithm: "sha256";
  itemCount: number;
  digest: string;
}>;

export type ResponsesCheckpointRequestKind =
  | "stateful_incremental"
  | "stateless_replay";

/**
 * Replaceable provider optimization state. `recoveryRole: "none"` is an
 * intentional contract guard: Conversation/History remains canonical recovery
 * truth even when this checkpoint is absent, stale, or unreadable.
 */
export type ResponsesReplayCheckpoint = Readonly<{
  schemaVersion: 2;
  kind: "provider_replay_checkpoint";
  factClass: "checkpoint_snapshot";
  authority: "non_authoritative";
  recoveryRole: "none";
  actorId: string;
  providerId: string;
  model: string;
  baselineEpoch: number;
  contextDigest: string;
  messageFrontier: ResponsesMessageFrontier;
  requestKind: ResponsesCheckpointRequestKind;
  requestInput: readonly ResponsesNativeItem[];
  output: ResponsesProviderOutputSnapshot;
  /** Complete provider-native lineage through `output`, never only the latest turn. */
  nativeWindow: readonly ResponsesNativeItem[];
  nativeWindowFingerprint: ResponsesNativeWindowFingerprint;
  lineageProof: ResponsesCallLineageProof;
}>; 

export type ResponsesContinuationBaseline = Readonly<{
  previousResponseId: string;
  baselineEpoch: number;
  contextDigest: string;
}>;

export type ResponsesStablePrefix = Readonly<{
  providerId: string;
  model: string;
  /** Stable instruction sections only; mutable overlays belong to the context digest. */
  stableInstructions?: unknown;
  tools?: readonly unknown[];
}>;

export type ResponsesStatefulIncrementalPlan = Readonly<{
  kind: "stateful_incremental";
  previousResponseId: string;
  input: readonly ResponsesNativeItem[];
  contextDigest: string;
  messageFrontier: ResponsesMessageFrontier;
  lineageProof: ResponsesCallLineageProof;
}>;

export type ResponsesStatelessReplayPlan = Readonly<{
  kind: "stateless_replay";
  source: "native_window" | "canonical_rebuild";
  input: readonly ResponsesNativeItem[];
  contextDigest: string;
  messageFrontier: ResponsesMessageFrontier;
  promptCacheKey: string;
  lineageProof: ResponsesCallLineageProof;
}>;

export type ResponsesRequestPlan =
  | ResponsesStatefulIncrementalPlan
  | ResponsesStatelessReplayPlan;

/**
 * Per-call transport input. The stateless fallback is explicit because a
 * stateful WebSocket body cannot be safely expanded back into full history.
 */
export type ResponsesTransportRequestContext = Readonly<{
  schemaVersion: 1;
  kind: "responses_transport_request_context";
  /** The single assembled value used for digest/cache planning and the wire. */
  instructions?: string;
  primary: ResponsesRequestPlan;
  statelessFallback?: ResponsesStatelessReplayPlan;
}>;

export type ResponsesActualTransport = "websocket" | "http_sse";

/**
 * Provider-native success fact for the request that actually reached the wire.
 * It is finalized only after the corresponding stream has been fully consumed.
 * In particular, a WebSocket intent that falls back to HTTP reports the
 * stateless fallback plan and HTTP transport, never the abandoned primary plan.
 */
export type ResponsesTransportResult = Readonly<{
  schemaVersion: 1;
  kind: "responses_transport_result";
  plan: ResponsesRequestPlan;
  transport: ResponsesActualTransport;
  responseStored: boolean;
  outputDecision: ResponsesNativeOutputCompletenessDecision;
}>;

export type ResponsesRequestPlanInput = Readonly<{
  actorId: string;
  providerId: string;
  model: string;
  mode: ResponsesContinuationMode;
  transportSupportsContinuation: boolean;
  baseline?: ResponsesContinuationBaseline;
  /** Persisted optimization state is untrusted until runtime validation succeeds. */
  checkpoint?: unknown;
  currentEpoch: number;
  currentContextDigest: string;
  currentMessages: readonly unknown[];
  fullCanonicalInput: readonly ResponsesNativeItem[];
  incrementalInput: readonly ResponsesNativeItem[];
  stablePrefix: ResponsesStablePrefix;
}>;
