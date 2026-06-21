import {
  createControlLogicBoundaryRegistry,
  type ControlLogicBoundaryDeclaration,
  type ControlLogicBoundaryRegistry,
} from "@cell/platform-contract";

/**
 * Boundary declarations for the three control-plane logic clusters.
 *
 * Core logic entries reference real source symbols; conformance tests assert
 * that those symbols stay free of direct IO and that cross-actor unblock
 * entries stay on the mailbox path. Full outer/inner restructuring of the
 * clusters is owned by a follow-up track; these declarations are the contract
 * it will be held to.
 */

export const AI_RUNTIME_CONTROL_BOUNDARY_IDS = [
  "orchestrator_driver",
  "runtime_control_engine",
  "snapshot_coordinator",
] as const;

export type AiRuntimeControlBoundaryId = (typeof AI_RUNTIME_CONTROL_BOUNDARY_IDS)[number];

/** Source patterns the declared core logic must never contain. */
const CONTROL_CORE_FORBIDDEN_IO = [
  "node:fs",
  "node:child_process",
  "fetch(",
  "process.env",
] as const;

const ORCHESTRATOR_DRIVER_BOUNDARY: ControlLogicBoundaryDeclaration = {
  id: "orchestrator_driver",
  layer: "platform",
  /** Scheduling decision helpers inside ai-organ-logic/src/orchestratorCapsule/internals/decisions.ts. */
  coreLogicEntries: [
    "applyResumeFiber",
    "isTerminalFiberRecordStatus",
    "isTerminalDetachedActorStatus",
    "resetCooperativeExecStateAfterInterrupt",
    "drainControlKinds",
  ],
  injectedEffectContracts: ["actor_runtime", "durable_control_signal_store", "scheduler_signal_sink"],
  outerAdapterSurface: [
    "createAiAgentOrchestratorDriver",
    "createAiAgentOrchestratorDriverWithCooperative",
    "createOrchestratorCapsule",
    "tickUntilBlocked",
    "tickUntilForegroundSettled",
    "tickUntilBackgroundSettled",
  ],
  entries: [
    { entryId: "spawnFiber", kind: "sync_command" },
    { entryId: "tick", kind: "sync_command" },
    { entryId: "suspendFiber", kind: "sync_command" },
    {
      entryId: "resumeFiber",
      kind: "async_message",
      description: "Unblock signals reach the scheduler via mailbox-backed durable control signals.",
    },
    { entryId: "reviveFiber", kind: "async_message" },
    { entryId: "settleInterruptedFiber", kind: "async_message" },
    { entryId: "emitFiberSignal", kind: "async_message" },
    { entryId: "waitForSignal", kind: "async_message" },
  ],
  forbiddenDirectIo: [...CONTROL_CORE_FORBIDDEN_IO],
};

const RUNTIME_CONTROL_ENGINE_BOUNDARY: ControlLogicBoundaryDeclaration = {
  id: "runtime_control_engine",
  layer: "platform_domain_bridge",
  /** Pure reducers and classifiers in cell/packages/ai-runtime-control-logic/src. */
  coreLogicEntries: [
    "createAiRuntimeControlState",
    "enqueueAiRuntimeControlCommand",
    "selectNextAiRuntimeControlCommand",
    "classifyAiRuntimeControlRecovery",
    "evaluateAiAgentRuntimeSnapshotSafepoint",
    "classifyAiSnapshotBlockingMailboxes",
    "evaluateAiTurnSnapshotBarrier",
    "classifyRealSessionRecovery",
    "rebuildEffectsFromLifecycleEvidence",
  ],
  injectedEffectContracts: ["effect_handler_registry", "durable_head_store", "effect_evidence_recorder"],
  outerAdapterSurface: [
    "runOneAiRuntimeControlStep",
    "runAiRuntimeControlUntilIdle",
    "runEngineCapsule",
    "createAiRuntimeControlEngine",
  ],
  entries: [
    { entryId: "enqueueAiRuntimeControlCommand", kind: "sync_command" },
    { entryId: "recovery_scan_request", kind: "sync_command" },
    {
      entryId: "effect_result_delivery",
      kind: "async_message",
      description: "Effect completions re-enter through the prioritized effectResult queue.",
    },
  ],
  forbiddenDirectIo: [...CONTROL_CORE_FORBIDDEN_IO],
};

const SNAPSHOT_COORDINATOR_BOUNDARY: ControlLogicBoundaryDeclaration = {
  id: "snapshot_coordinator",
  layer: "platform_domain_bridge",
  /** Boundary decision logic in ai-runtime-control-composer; the writer only persists. */
  coreLogicEntries: [
    "decideAiRuntimePendingEffectsRecovery",
    "buildAiRuntimeInterruptedInflightFailedEvidence",
  ],
  injectedEffectContracts: ["runtime_persistence_support", "file_store", "durable_head_store"],
  outerAdapterSurface: [
    "saveAiAgentRuntimeSnapshot",
    "recoverAiAgentRuntime",
    "hasRuntimeSnapshot",
    "runFileStoreAiRuntimeConcreteCheckpoint",
    "runCoordinatorCapsule",
  ],
  entries: [
    {
      entryId: "snapshot_save_request",
      kind: "sync_command",
      description: "Explicit capability call at a safe boundary; returns saved or a structured skip.",
    },
    { entryId: "recovery_bootstrap", kind: "sync_command" },
    {
      entryId: "interrupted_inflight_evidence_replay",
      kind: "async_message",
      description: "Recovered inflight evidence re-enters live state only through actor mailboxes.",
    },
  ],
  forbiddenDirectIo: [...CONTROL_CORE_FORBIDDEN_IO],
};

export const AI_RUNTIME_CONTROL_BOUNDARY_DECLARATIONS: readonly ControlLogicBoundaryDeclaration[] = [
  ORCHESTRATOR_DRIVER_BOUNDARY,
  RUNTIME_CONTROL_ENGINE_BOUNDARY,
  SNAPSHOT_COORDINATOR_BOUNDARY,
];

export function createAiRuntimeControlBoundaryRegistry(): ControlLogicBoundaryRegistry {
  return createControlLogicBoundaryRegistry([...AI_RUNTIME_CONTROL_BOUNDARY_DECLARATIONS]);
}
