import type { TaskTree } from "../plan/TaskTree";
import type { ToolCallRecord } from "./ToolCallDomain";
import type {
  ActorCtrlOptions,
  ActorIdentity,
  ActorModelConfig,
  ActorRecoveryState,
  ActorToolPolicy,
  AiAgentActorContract,
  AiAgentMailboxSchema,
  DetachedTaskState,
  HolonActorState,
} from "./AiAgentActor";
import type {
  RuntimeOptions,
  VmDetachedActorRecord,
  VmHolonRecord,
  VmRecoveryState,
  VmThreadGoalRecord,
} from "./AiAgentVm";
import type {
  ActorWorkContextData,
  ContinuationBaselineData,
} from "./ContextControl";
import type { DurableControlSignalSnapshotStore } from "./DurableControlSignal";
import type { QuestionnaireRow } from "./Questionnaire";
import type { HeartbeatSchedule } from "./Heartbeat";

export const RUNTIME_SNAPSHOT_SCHEMA_VERSION = 3;

export type RuntimeSnapshotVersion = typeof RUNTIME_SNAPSHOT_SCHEMA_VERSION;

export type SnapshotRecoveryState = {
  restoredFromSnapshot: boolean;
  snapshotVersion?: number;
  restoredAt?: number;
};

export type RuntimeSnapshotManifestBase = {
  version: number;
  createdAt: string;
  updatedAt: string;
  actorKeys: string[];
  fiberIds: string[];
  indexFiles: string[];
  derivedIndexFiles?: string[];
  savedAt?: number;
  vmFile: string;
  actorFiles: Record<string, string>;
  fiberFiles: Record<string, string>;
};

export type RuntimeRootSnapshotBase = {
  version: number;
  controlActorKey: string;
  actorKeys: string[];
  updatedAt: string;
  recovery?: SnapshotRecoveryState;
};

export type ActorSnapshotBase<TActorType extends string = string> = {
  version: number;
  key: string;
  id: string;
  type: TActorType;
  parentKey?: string;
  updatedAt?: string;
  recovery?: SnapshotRecoveryState;
};

export type FiberSnapshotBase = {
  version: number;
  fiberId: string;
  actorKey?: string;
  actorId?: string;
  parentFiberId?: string;
  status?: string;
  lane?: string;
  workloadKind?: string;
  kind?: string;
  waitingReason?: string | null;
  createdAt?: number;
  lastRunAt?: number | null;
  lastYieldAt?: number | null;
  resumeMetadata?: Record<string, unknown> | null;
  updatedAt?: string;
  workload?: string;
  metadata?: Record<string, unknown>;
};

type RuntimeSnapshotMailboxQueues = {
  [K in keyof AiAgentMailboxSchema]: AiAgentMailboxSchema[K][];
};

export type RuntimeSnapshotManifest = RuntimeSnapshotManifestBase & {
  controlActorKey: string;
  sessionId?: string;
};

export type RuntimeSnapshotVm = RuntimeRootSnapshotBase & {
  registryIndexRefs?: {
    memberRoster?: string;
    detachedActors?: string;
    coordinationRecords?: string;
  };
  sessionState?: {
    holons?: VmHolonRecord[];
    detachedActors?: VmDetachedActorRecord[];
    controlSignals?: DurableControlSignalSnapshotStore;
    heartbeatSchedules?: HeartbeatSchedule[];
    threadGoal?: VmThreadGoalRecord | null;
  };
  runtimeMetadata: {
    sessionScope: "session";
    recoveryMode: "conservative";
    sideEffectPolicy: "noReplay";
  };
  options?: RuntimeOptions;
  recovery?: VmRecoveryState;
  /**
   * P4: persisted ToolCallDomain records (the tool-call lifecycle fact set).
   * Optional + backward-compatible — snapshots written before P4 omit it and
   * restore to an empty domain. Recovery rebuilds an interrupted tool's result
   * from these records (decision D3) with evidence payloads as fallback.
   */
  toolCallDomain?: ToolCallRecord[];
};

export type RuntimeSnapshotActor = ActorSnapshotBase<AiAgentActorContract["type"]> & {
  systemPrompts: string[];
  identity?: ActorIdentity;
  agentName?: string;
  planApproval?: AiAgentActorContract["planApproval"];
  shutdownCoordination?: AiAgentActorContract["shutdownCoordination"];
  toolPolicy: ActorToolPolicy;
  modelConfig: ActorModelConfig;
  ctrlOptions: ActorCtrlOptions;
  taskTree: TaskTree;
  mailboxes: RuntimeSnapshotMailboxQueues;
  toolCallStreamState: {
    toolCalls: unknown[];
  };
  workContext?: ActorWorkContextData;
  continuationBaseline?: ContinuationBaselineData;
  lastMemberResultNotifiedAt?: number | null;
  detachedTask?: DetachedTaskState;
  holonState?: HolonActorState;
  recovery?: ActorRecoveryState;
};

export type RuntimeSnapshotFiber = FiberSnapshotBase;

export type RuntimeSnapshotIndexName = "actors_by_key" | "actors_by_id" | "fibers_by_id";

export type RuntimeSnapshotActorKeyIndex = {
  schemaVersion: RuntimeSnapshotVersion;
  kind: "actors_by_key";
  entries: Record<string, string>;
};

export type RuntimeSnapshotActorIdIndex = {
  schemaVersion: RuntimeSnapshotVersion;
  kind: "actors_by_id";
  entries: Record<string, string>;
};

export type RuntimeSnapshotFiberIdIndex = {
  schemaVersion: RuntimeSnapshotVersion;
  kind: "fibers_by_id";
  entries: Record<string, string>;
};

export type RuntimeSnapshotIndex =
  | RuntimeSnapshotActorKeyIndex
  | RuntimeSnapshotActorIdIndex
  | RuntimeSnapshotFiberIdIndex;

export type RuntimeSnapshotIndexes = {
  actors_by_key: RuntimeSnapshotActorKeyIndex;
  actors_by_id: RuntimeSnapshotActorIdIndex;
  fibers_by_id: RuntimeSnapshotFiberIdIndex;
};

export type RuntimeSnapshotPersistedState = {
  vm: RuntimeSnapshotVm;
  actors: Record<string, RuntimeSnapshotActor>;
  questionnaires?: QuestionnaireRow[];
  fibers?: Record<string, RuntimeSnapshotFiber>;
  indexes?: Partial<RuntimeSnapshotIndexes>;
};

export type RuntimeSnapshotCorruption = {
  path: string;
  reason: string;
};

export type RuntimeSnapshotLoadResult = {
  manifest: RuntimeSnapshotManifest;
  vm: RuntimeSnapshotVm;
  actors: Record<string, RuntimeSnapshotActor>;
  questionnaires: QuestionnaireRow[];
  fibers: Record<string, RuntimeSnapshotFiber>;
  indexes: Partial<RuntimeSnapshotIndexes>;
  corruptions: RuntimeSnapshotCorruption[];
};
