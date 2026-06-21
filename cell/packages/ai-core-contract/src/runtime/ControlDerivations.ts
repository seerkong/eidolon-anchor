import {
  assertDerivationContract,
  createDerivationContract,
  type DerivationContract,
} from "@cell/platform-contract";

/**
 * Derivation contracts for the driver and coordinator clusters. The processing
 * definitions are contract; implementations are pure functions over explicit
 * state, injected into vendor-primitive flow wiring.
 */

export type SchedulerDerivation<
  TState = unknown,
  TEvent = unknown,
  TEffect = unknown,
  TSignal = unknown,
> = {
  initializeSchedulerState: (input?: unknown) => TState;
  reduceFiberEvent: (state: TState, event: TEvent) => { state: TState; effects: TEffect[] };
  projectSchedulerSignal: (state: TState) => TSignal;
};

export const SCHEDULER_DERIVATION_CONTRACT: DerivationContract = createDerivationContract({
  contractId: "scheduler_derivation",
  requiredMethods: ["initializeSchedulerState", "reduceFiberEvent", "projectSchedulerSignal"],
});

export function assertSchedulerDerivation<TState, TEvent, TEffect, TSignal>(
  implementation: SchedulerDerivation<TState, TEvent, TEffect, TSignal>,
): SchedulerDerivation<TState, TEvent, TEffect, TSignal> {
  return assertDerivationContract(SCHEDULER_DERIVATION_CONTRACT, implementation);
}

export type CoordinatorDerivation<
  TCheckpointInput = unknown,
  TCheckpointDecision = unknown,
  TRecoveryInput = unknown,
  TRecoveryDecision = unknown,
> = {
  decideCheckpointAction: (input: TCheckpointInput) => TCheckpointDecision;
  decideRecovery: (input: TRecoveryInput) => TRecoveryDecision;
};

export const COORDINATOR_DERIVATION_CONTRACT: DerivationContract = createDerivationContract({
  contractId: "coordinator_derivation",
  requiredMethods: ["decideCheckpointAction", "decideRecovery"],
});

export function assertCoordinatorDerivation<TCi, TCd, TRi, TRd>(
  implementation: CoordinatorDerivation<TCi, TCd, TRi, TRd>,
): CoordinatorDerivation<TCi, TCd, TRi, TRd> {
  return assertDerivationContract(COORDINATOR_DERIVATION_CONTRACT, implementation);
}

export const COORDINATOR_WRITER_ADAPTER_IDS = ["file_store", "in_memory"] as const;

export type CoordinatorWriterAdapterId = (typeof COORDINATOR_WRITER_ADAPTER_IDS)[number];

export type CoordinatorCheckpointDecisionInput = {
  storageFilesEnabled: boolean;
  safepointSafe: boolean;
  pendingEffectIds: readonly string[];
};

export type CoordinatorCheckpointSkipReason =
  | "skipped_storage_disabled"
  | "skipped_non_safepoint"
  | "skipped_pending_effects";

export type CoordinatorCheckpointDecision =
  | { action: "save" }
  | { action: "skip"; reason: CoordinatorCheckpointSkipReason };

/** Explicit dependencies a writer adapter may need; adapters receive it verbatim. */
export type CoordinatorCapsuleRuntime = {
  writerDependencies?: unknown;
};

export type CoordinatorWriteRequest = {
  sessionDir: string;
  idempotencyKey: string;
  writeConcreteCheckpoint: () => Promise<{ manifestVersion?: number }>;
};

export type CoordinatorWriteResult = {
  status: string;
  pendingEffectIds?: string[];
};

export type CoordinatorWriterAdapter = (
  runtime: CoordinatorCapsuleRuntime,
  request: CoordinatorWriteRequest,
) => Promise<CoordinatorWriteResult>;

export type CoordinatorCapsuleConfig = {
  writerAdapter: CoordinatorWriterAdapterId;
};

export type CoordinatorCapsuleInput = {
  decision: CoordinatorCheckpointDecisionInput;
  writeRequest: CoordinatorWriteRequest;
};

export type CoordinatorCapsuleOutput = {
  decision: CoordinatorCheckpointDecision;
  result?: CoordinatorWriteResult;
};
