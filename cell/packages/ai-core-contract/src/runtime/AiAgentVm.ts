import type { ActorType, AiAgentActorContract, AiAgentMailboxSchema } from "./AiAgentActor";
import type { AiRuntimeOuterCtx } from "./AiRuntimeOuterCtx";
import type { McpManagerLike } from "./McpManagerLike";
import type { AiRuntimeRegistries } from "./RuntimeRegistries";
import type { ObservabilityRecord } from "./Observability";
import type { SemanticEvent } from "../stream/semantic";
import type { UsageData } from "../stream/common";

export type RuntimeCallbacks<TVm = unknown> = {
  resolveExtraBody?: (vm: TVm) => Record<string, unknown>;
  buildSystemMessages?: (prompts: string[]) => any[];
  onSlashPrompt?: (event: { prompt: string }) => void;
  onTuiControl?: (event: { cmd: "NewMessage" }) => void;
  onTuiMessage?: (text: string) => void;
  onAutoCompact?: (event: { phase: "start" | "done"; message: string }) => void;
  onToolStart?: (callId: string, toolName: string, code?: string) => void;
  onResult?: (result: { id: string; isError: boolean; output: string }) => void;
  onTodoUpdate?: (snapshot: { stats: { total: number; completed: number; inProgress: number; pending: number } }) => void;
  onDone?: () => void;
  onError?: (error: Error) => void;
};

export type RuntimeOptions = {
  maxIterations?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  autoCompactionThreshold?: number;
  reasoningSplit?: boolean;
  exitAfterToolResult?: boolean;
  stopAfterFirstTool?: boolean;
  stopAfterTools?: string[];
};

export type RuntimeEffects = {
  log?: (level: "info" | "warn" | "error" | "debug", message: string, context?: Record<string, unknown>) => void;
  messageHistory?: {
    appendMessage: (event: {
      stream: string;
      payload: string;
      agentKey: string;
      agentActorId: string;
      actorType?: ActorType;
      agentName?: string;
      memberName?: string;
    }) => void;
    backupHistory?: (params: {
      agentKey: string;
      agentActorId: string;
      actorType?: ActorType;
      agentName?: string;
      memberName?: string;
    }) => Promise<void>;
  };
  orchestrationHistory?: {
    appendEvent: (event: {
      stream: string;
      kind: string;
      payload: Record<string, unknown>;
    }) => void;
    backupHistory?: () => Promise<void>;
  };
};

export type VmRecoveryState = {
  restoredFromSnapshot: boolean;
  snapshotVersion?: number;
  restoredAt?: number;
  report?: VmRecoveryReport;
};

export type VmRecoveryReportActorTranscriptSource = {
  source: "conversation" | "transcript" | "empty";
  path?: string;
};

export type VmRecoveryReport = {
  sessionId?: string;
  restoredAt: number;
  corruptions: Array<{ path: string; reason: string }>;
  actorTranscriptSources: Record<string, VmRecoveryReportActorTranscriptSource>;
};

export type VmMemberRosterEntry = {
  memberId: string;
  name: string;
  role: string;
  agentType: string;
  lane: "member" | "autonomous_holon";
  fiberId: string;
  actorKey: string;
  actorId: string;
  createdAt: number;
  lastActiveAt: number;
  lifecycleState: "active" | "shutting_down" | "exited";
  shutdownRequestId?: string;
};

export type VmHolonRecord = {
  holonId: string;
  governance: "autonomous" | "leader_led";
  name: string;
  memberIds: string[];
  leaderMemberId?: string | null;
  watchState?: "watched" | "unwatched";
  createdAt: number;
  updatedAt: number;
};

export type VmAutonomousHolonRecord = VmHolonRecord & {
  governance: "autonomous";
  leaderMemberId?: null;
};

export type VmLeaderLedHolonRecord = VmHolonRecord & {
  governance: "leader_led";
  leaderMemberId: string | null;
};

export type VmDetachedActorRecord = {
  taskId: string;
  kind: "delegate" | "bash" | "tool_call";
  status: "pending" | "running" | "suspended" | "interrupted" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  toolCallId?: string;
  parentFiberId?: string;
  childFiberId?: string;
  childActorKey?: string;
  childActorId?: string;
  outputText?: string;
  error?: string;
};

export type VmSessionState = {
  memberRoster: Record<string, VmMemberRosterEntry>;
  holons: Record<string, VmHolonRecord>;
  detachedActors: Record<string, VmDetachedActorRecord>;
};

export type VmDeferredResume = {
  fiberId: string;
  at: number;
};

export type VmOrchestratorContext = {
  parentFiberId: string;
  spawnFiber: (params: any) => void;
};

export type VmRuntimeContext = {
  driver: unknown | null;
  currentOrchestrator: VmOrchestratorContext | null;
  deferredMemberResumes: VmDeferredResume[];
  interactiveTurnActive: boolean;
  conversationDomainRuntime: unknown | null;
  autonomousHolonTaskSignals: CompletionSignalRegistryLike<string, { status: string; resultText: string | null }>;
  leaderLedHolonRouteSignals: CompletionSignalRegistryLike<string, { resultText: string | null }>;
};

export type CompletionSignalRegistryLike<TKey extends string, TValue> = {
  create?: (key: TKey) => unknown;
  resolve?: (key: TKey, value: TValue) => void;
  reject?: (key: TKey, error: unknown) => void;
};

export type AiRuntimeVmFacet = {
  sessionState: VmSessionState;
  runtimeContext: VmRuntimeContext;
};

export type AiAgentVmRxSubscription = {
  unsubscribe: () => void;
};

export type AiAgentVmRxStream<TEvent> = {
  subscribe: (listener: (event: TEvent) => void) => AiAgentVmRxSubscription;
};

export type AiAgentVmWritableRxStream<TEvent> = AiAgentVmRxStream<TEvent> & {
  append: (event: TEvent) => void;
};

export type AiAgentVmReadonlyRxSignal<TValue> = {
  get: () => TValue;
  subscribe: (listener: (value: TValue) => void) => AiAgentVmRxSubscription;
};

export type AiAgentVmWritableRxSignal<TValue> = AiAgentVmReadonlyRxSignal<TValue> & {
  set: (value: TValue | ((prev: TValue) => TValue)) => void;
};

export type AiAgentVmDomainRxEvent = {
  type: string;
  payload?: unknown;
  occurredAt?: string | number;
};

export type AiAgentVmUsageData = UsageData;

export type AiAgentVmTraceSummaryData = {
  eventCount: number;
  lastEventAt: number | null;
};

export type AiAgentVmRxBinding = {
  dispose: () => void;
};

export type AiAgentVmPublicRxData = {
  semanticEvents: AiAgentVmRxStream<SemanticEvent>;
  historyDomainStream: AiAgentVmRxStream<AiAgentVmDomainRxEvent>;
  promptDomainStream: AiAgentVmRxStream<AiAgentVmDomainRxEvent>;
  sessionDomainStream: AiAgentVmRxStream<AiAgentVmDomainRxEvent>;
  observabilityRecords: AiAgentVmRxStream<ObservabilityRecord>;
  observabilityErrors: AiAgentVmRxStream<ObservabilityRecord>;
  usage: AiAgentVmReadonlyRxSignal<AiAgentVmUsageData>;
  traceSummary: AiAgentVmReadonlyRxSignal<AiAgentVmTraceSummaryData>;
};

export type AiAgentVmPrivateRxData = {
  semanticEvents: AiAgentVmWritableRxStream<SemanticEvent>;
  historyDomainStream: AiAgentVmWritableRxStream<AiAgentVmDomainRxEvent>;
  promptDomainStream: AiAgentVmWritableRxStream<AiAgentVmDomainRxEvent>;
  sessionDomainStream: AiAgentVmWritableRxStream<AiAgentVmDomainRxEvent>;
  observabilityRecords: AiAgentVmWritableRxStream<ObservabilityRecord>;
  observabilityErrors: AiAgentVmWritableRxStream<ObservabilityRecord>;
  usage: AiAgentVmWritableRxSignal<AiAgentVmUsageData>;
  traceSummary: AiAgentVmWritableRxSignal<AiAgentVmTraceSummaryData>;
};

export type AiHolonRuntime = {
  aiFacet: AiRuntimeVmFacet;
  sessionState: VmSessionState;
  runtimeContext: VmRuntimeContext;
};

export type AiRuntimeInnerCtx<TRegistries = AiRuntimeRegistries> = {
  registries: TRegistries;
  mcpManager?: McpManagerLike;
  recovery?: VmRecoveryState;
};

export type AiRuntimeImmutableSnapshot = {
  controlActorKey: string;
  actorKeys: string[];
  createdAt: number;
};

export type AiRuntimeMutableSnapshot = {
  updatedAt: number;
};

export type ActorRuntimeLike<TVm = unknown, TSchema = AiAgentMailboxSchema> = {
  ensureFacet: <TFacet>(key: string, factory: () => TFacet) => TFacet;
  setFacet: <TFacet>(key: string, value: TFacet) => void;
  has: (id: string) => boolean;
  register: (id: string, actor: unknown) => void;
};

export type AiAgentVmActorsRuntime<
  TActor = AiAgentActorContract,
  TActorRuntime = ActorRuntimeLike,
> = {
  controlActorKey: string;
  actors: Record<string, TActor>;
  actorRuntime: TActorRuntime;
};

export type AiAgentVmRuntimeKnobs<TVm = unknown> = {
  options: RuntimeOptions;
  effects: RuntimeEffects;
  callbacks: RuntimeCallbacks<any>;
};

export type AiAgentVmNonRxData<TRegistries = AiRuntimeRegistries> = {
  outerCtx: AiRuntimeOuterCtx;
  innerCtx: AiRuntimeInnerCtx<TRegistries>;
  immutableSnapshot: AiRuntimeImmutableSnapshot;
  mutableSnapshot: AiRuntimeMutableSnapshot;
};

export type AiAgentVmRxDataPlane<TEventBus = unknown> = {
  eventBus: TEventBus | null;
  publicRxData: AiAgentVmPublicRxData | null;
  privateRxData: AiAgentVmPrivateRxData | null;
  publicRxBinding: AiAgentVmRxBinding | null;
  privateRxBinding: AiAgentVmRxBinding | null;
};

export type AiAgentVmLegacyCompat<TRegistries = AiRuntimeRegistries> = {
  registries: TRegistries;
  mcpManager?: McpManagerLike;
  recovery?: VmRecoveryState;
  aiFacet: AiRuntimeVmFacet;
  sessionState: VmSessionState;
  runtimeContext: VmRuntimeContext;
};

export type AiAgentVm<
  TActor = any,
  TActorRuntime = any,
  TRegistries = AiRuntimeRegistries,
  TEventBus = any,
> =
  AiAgentVmActorsRuntime<TActor, TActorRuntime> & {
    holonRuntime: AiHolonRuntime;
  } &
  AiAgentVmRuntimeKnobs &
  AiAgentVmNonRxData<TRegistries> &
  AiAgentVmRxDataPlane<TEventBus> &
  AiAgentVmLegacyCompat<TRegistries>;

export type PlatformRuntimeVm<
  TActor = AiAgentActorContract,
  TActorRuntime = ActorRuntimeLike,
  TRegistries = AiRuntimeRegistries,
  TEventBus = unknown,
> = AiAgentVm<TActor, TActorRuntime, TRegistries, TEventBus>;

export type CreateVMParams<
  TActor = AiAgentActorContract,
  TRegistries = AiRuntimeRegistries,
  TEventBus = unknown,
> = {
  controlActorKey?: string;
  actors: Record<string, TActor>;
  eventBus?: TEventBus | null;
  registries?: Partial<TRegistries>;
  callbacks?: RuntimeCallbacks;
  options?: RuntimeOptions;
  effects?: RuntimeEffects;
  outerCtx?: AiRuntimeOuterCtx;
  mcpManager?: McpManagerLike;
  recovery?: VmRecoveryState;
  aiFacet?: {
    sessionState?: Partial<VmSessionState>;
    runtimeContext?: Partial<VmRuntimeContext>;
  };
  sessionState?: Partial<VmSessionState>;
  runtimeContext?: Partial<VmRuntimeContext>;
};

export const AI_AGENT_VM_FACET_OWNERSHIP = {
  actors: [
    "controlActorKey",
    "actors",
    "actorRuntime",
  ],
  holonRuntime: [
    "holonRuntime",
  ],
  runtimeKnobs: [
    "options",
    "effects",
    "callbacks",
  ],
  nonRxData: [
    "outerCtx",
    "innerCtx",
    "immutableSnapshot",
    "mutableSnapshot",
  ],
  rxData: [
    "eventBus",
    "publicRxData",
    "privateRxData",
    "publicRxBinding",
    "privateRxBinding",
  ],
  platform: [
    "controlActorKey",
    "actors",
    "actorRuntime",
    "eventBus",
    "publicRxData",
    "privateRxData",
    "publicRxBinding",
    "privateRxBinding",
    "registries",
    "callbacks",
    "options",
    "effects",
    "outerCtx",
    "innerCtx",
    "mcpManager",
    "recovery",
    "immutableSnapshot",
    "mutableSnapshot",
    "holonRuntime",
  ],
  ai: [
    "aiFacet",
    "sessionState",
    "runtimeContext",
  ],
} as const satisfies {
  actors: readonly (keyof PlatformRuntimeVm)[];
  holonRuntime: readonly (keyof PlatformRuntimeVm)[];
  runtimeKnobs: readonly (keyof PlatformRuntimeVm)[];
  nonRxData: readonly (keyof PlatformRuntimeVm)[];
  rxData: readonly (keyof PlatformRuntimeVm)[];
  platform: readonly (keyof PlatformRuntimeVm)[];
  ai: readonly ("aiFacet" | keyof AiRuntimeVmFacet)[];
};
