import type { AgentEventGraph } from "../stream/AgentEventGraph";
import type { ToolFuncRegistry } from "./ToolFuncRegistry";
import {
  ActorRuntime,
  createCompletionSignalRegistry,
} from "depa-actor";
import type { AiAgentActor, AiAgentMailboxSchema } from "./actor";
import { AgentRegistry } from "./AgentRegistry";
import { SkillRegistry } from "./SkillRegistry";
import { McpRegistry } from "./McpRegistry";
import type {
  AiAgentVm as ContractAiAgentVm,
  AiAgentVmActorsRuntime as ContractAiAgentVmActorsRuntime,
  AiAgentVmLegacyCompat as ContractAiAgentVmLegacyCompat,
  AiAgentVmNonRxData as ContractAiAgentVmNonRxData,
  AiAgentVmPrivateRxData,
  AiAgentVmPublicRxData,
  AiAgentVmRuntimeKnobs as ContractAiAgentVmRuntimeKnobs,
  AiAgentVmRxBinding,
  AiAgentVmRxDataPlane as ContractAiAgentVmRxDataPlane,
  AiHolonRuntime,
  AiRuntimeImmutableSnapshot,
  AiRuntimeInnerCtx as ContractAiRuntimeInnerCtx,
  AiRuntimeMutableSnapshot,
  AiRuntimeVmFacet,
  PlatformRuntimeVm as ContractPlatformRuntimeVm,
  RuntimeCallbacks as ContractRuntimeCallbacks,
  RuntimeEffects,
  RuntimeOptions,
  VmAutonomousHolonRecord,
  VmDeferredResume,
  VmDetachedActorRecord,
  VmHolonRecord,
  VmLeaderLedHolonRecord,
  VmMemberRosterEntry,
  VmOrchestratorContext,
  VmRecoveryReport,
  VmRecoveryReportActorTranscriptSource,
  VmRecoveryState,
  VmRuntimeContext,
  VmSessionState,
} from "@cell/ai-core-contract/runtime/AiAgentVm";
import type { ActorSurfaceRuntimeStateData } from "@cell/ai-core-contract/runtime/ActorSurface";
import type { AiRuntimeRegistries as ContractRuntimeRegistries } from "@cell/ai-core-contract/runtime/RuntimeRegistries";
import type { AiRuntimeOuterCtx } from "@cell/ai-core-contract/runtime/AiRuntimeOuterCtx";
import type { McpManagerLike } from "@cell/ai-core-contract/runtime/McpManagerLike";
import { cloneDurableControlSignalStore, createEmptyDurableControlSignalStore } from "./DurableControlSignals";

export { AI_AGENT_VM_FACET_OWNERSHIP } from "@cell/ai-core-contract/runtime/AiAgentVm";
export { bindVmDomainRxStreams, ensureVmRxData } from "./rxData";
export type {
  AiAgentVmPrivateRxData,
  AiAgentVmPublicRxData,
  AiAgentVmRxBinding,
  AiHolonRuntime,
  AiRuntimeImmutableSnapshot,
  AiRuntimeMutableSnapshot,
  AiRuntimeVmFacet,
  RuntimeEffects,
  RuntimeOptions,
  VmAutonomousHolonRecord,
  VmDeferredResume,
  VmDetachedActorRecord,
  VmHolonRecord,
  VmLeaderLedHolonRecord,
  VmMemberRosterEntry,
  VmOrchestratorContext,
  VmRecoveryReport,
  VmRecoveryReportActorTranscriptSource,
  VmRecoveryState,
  VmRuntimeContext,
  VmSessionState,
};

export type RuntimeRegistries = ContractRuntimeRegistries<ToolFuncRegistry | null, SkillRegistry, AgentRegistry, McpRegistry>;
export type RuntimeCallbacks = ContractRuntimeCallbacks<AiAgentVm>;
export type AiRuntimeInnerCtx = ContractAiRuntimeInnerCtx<RuntimeRegistries>;
export type AiAgentVmActorsRuntime = ContractAiAgentVmActorsRuntime<AiAgentActor, ActorRuntime<AiAgentVm, AiAgentMailboxSchema>>;
export type AiAgentVmRuntimeKnobs = ContractAiAgentVmRuntimeKnobs<AiAgentVm>;
export type AiAgentVmNonRxData = ContractAiAgentVmNonRxData<RuntimeRegistries>;
export type AiAgentVmRxDataPlane = ContractAiAgentVmRxDataPlane<AgentEventGraph>;
export type AiAgentVmLegacyCompat = ContractAiAgentVmLegacyCompat<RuntimeRegistries>;
export type PlatformRuntimeVm = ContractPlatformRuntimeVm<AiAgentActor, ActorRuntime<AiAgentVm, AiAgentMailboxSchema>, RuntimeRegistries, AgentEventGraph>;
export type AiAgentVm = ContractAiAgentVm<AiAgentActor, ActorRuntime<AiAgentVm, AiAgentMailboxSchema>, RuntimeRegistries, AgentEventGraph>;

export type CreateVmAiRuntimeFacetParams = {
  sessionState?: Partial<VmSessionState>;
  runtimeContext?: Partial<VmRuntimeContext>;
};

const VM_AI_FACET = "cell.vm.aiFacet";
const VM_RUNTIME_CONTEXT_FACET = "cell.vm.runtimeContext";

export function createEmptyVmSessionState(): VmSessionState {
  return {
    memberRoster: {},
    holons: {},
    detachedActors: {},
    actorSurface: createEmptyActorSurfaceRuntimeState(),
    controlSignals: createEmptyDurableControlSignalStore(),
    threadGoal: null,
  };
}

function createEmptyActorSurfaceRuntimeState(): ActorSurfaceRuntimeStateData {
  return {
    laneActorBindings: {},
    pendingQuestionnaires: {},
    answeredQuestionnaires: {},
  };
}

export function createEmptyVmRuntimeContext(): VmRuntimeContext {
  return {
    driver: null,
    currentOrchestrator: null,
    deferredMemberResumes: [],
    interactiveTurnActive: false,
    conversationDomainRuntime: null,
    heartbeatScheduler: null,
    threadGoalRuntime: {
      continuationTurns: 0,
      continuationInFlight: false,
    },
    autonomousHolonTaskSignals: createCompletionSignalRegistry<string, { status: string; resultText: string | null }>(),
    leaderLedHolonRouteSignals: createCompletionSignalRegistry<string, { resultText: string | null }>(),
  };
}

function materializeVmSessionState(sessionState?: Partial<VmSessionState>): VmSessionState {
  return {
    ...createEmptyVmSessionState(),
    ...(sessionState ?? {}),
    memberRoster: { ...(sessionState?.memberRoster ?? {}) },
    holons: { ...(sessionState?.holons ?? {}) },
    detachedActors: { ...(sessionState?.detachedActors ?? {}) },
    actorSurface: {
      ...createEmptyActorSurfaceRuntimeState(),
      ...(sessionState?.actorSurface ?? {}),
      laneActorBindings: { ...(sessionState?.actorSurface?.laneActorBindings ?? {}) },
      pendingQuestionnaires: { ...(sessionState?.actorSurface?.pendingQuestionnaires ?? {}) },
      answeredQuestionnaires: { ...(sessionState?.actorSurface?.answeredQuestionnaires ?? {}) },
    },
    controlSignals: cloneDurableControlSignalStore(sessionState?.controlSignals),
    threadGoal: sessionState?.threadGoal ? { ...sessionState.threadGoal } : null,
  };
}

function materializeVmRuntimeContext(runtimeContext?: Partial<VmRuntimeContext>): VmRuntimeContext {
  return {
    ...createEmptyVmRuntimeContext(),
    ...(runtimeContext ?? {}),
    deferredMemberResumes: [...(runtimeContext?.deferredMemberResumes ?? [])],
    interactiveTurnActive: runtimeContext?.interactiveTurnActive === true,
    driver: runtimeContext?.driver ?? null,
    currentOrchestrator: runtimeContext?.currentOrchestrator ?? null,
    conversationDomainRuntime: runtimeContext?.conversationDomainRuntime ?? null,
    heartbeatScheduler: runtimeContext?.heartbeatScheduler ?? null,
    threadGoalRuntime: {
      continuationTurns: 0,
      continuationInFlight: false,
      ...(runtimeContext?.threadGoalRuntime ?? {}),
    },
    autonomousHolonTaskSignals:
      runtimeContext?.autonomousHolonTaskSignals ??
      createCompletionSignalRegistry<string, { status: string; resultText: string | null }>(),
    leaderLedHolonRouteSignals:
      runtimeContext?.leaderLedHolonRouteSignals ??
      createCompletionSignalRegistry<string, { resultText: string | null }>(),
  };
}

function createVmAiRuntimeFacet(params?: CreateVmAiRuntimeFacetParams): AiRuntimeVmFacet {
  return {
    sessionState: materializeVmSessionState(params?.sessionState),
    runtimeContext: materializeVmRuntimeContext(params?.runtimeContext),
  };
}

function normalizeVmAiRuntimeFacet(facet?: Partial<AiRuntimeVmFacet>): AiRuntimeVmFacet {
  return createVmAiRuntimeFacet({
    sessionState: facet?.sessionState,
    runtimeContext: facet?.runtimeContext,
  });
}

export type CreateVMParams = {
  controlActorKey?: string;
  actors: Record<string, AiAgentActor>;
  eventBus?: AgentEventGraph | null;
  registries?: Partial<RuntimeRegistries>;
  callbacks?: RuntimeCallbacks;
  options?: RuntimeOptions;
  effects?: RuntimeEffects;
  outerCtx?: AiRuntimeOuterCtx;
  mcpManager?: McpManagerLike;
  recovery?: VmRecoveryState;
  aiFacet?: CreateVmAiRuntimeFacetParams;
  sessionState?: Partial<VmSessionState>;
  runtimeContext?: Partial<VmRuntimeContext>;
};

export function getPlatformRuntimeVm(vm: AiAgentVm): PlatformRuntimeVm {
  return vm;
}

export function ensureAiRuntimeFacet(vm: AiAgentVm): AiRuntimeVmFacet {
  const facetBacked = vm.actorRuntime.ensureFacet<AiRuntimeVmFacet>(
    VM_AI_FACET,
    () => normalizeVmAiRuntimeFacet(vm.aiFacet),
  );
  const normalized = normalizeVmAiRuntimeFacet({
    sessionState: facetBacked.sessionState ?? vm.aiFacet?.sessionState ?? vm.sessionState,
    runtimeContext: facetBacked.runtimeContext ?? vm.aiFacet?.runtimeContext ?? vm.runtimeContext,
  });

  facetBacked.sessionState = normalized.sessionState;
  facetBacked.runtimeContext = normalized.runtimeContext;
  vm.aiFacet = facetBacked;
  syncHolonRuntime(vm.holonRuntime, vm.aiFacet);
  vm.actorRuntime.setFacet(VM_RUNTIME_CONTEXT_FACET, facetBacked.runtimeContext);
  return vm.aiFacet;
}

export function getAiRuntimeFacet(vm: AiAgentVm): AiRuntimeVmFacet {
  return ensureAiRuntimeFacet(vm);
}

export function ensureVmSessionState(vm: AiAgentVm): VmSessionState {
  const aiFacet = ensureAiRuntimeFacet(vm);
  aiFacet.sessionState = materializeVmSessionState(aiFacet.sessionState);
  syncHolonRuntime(vm.holonRuntime, aiFacet);
  vm.actorRuntime.setFacet(VM_AI_FACET, aiFacet);
  return aiFacet.sessionState;
}

export function ensureVmRuntimeContext(vm: AiAgentVm): VmRuntimeContext {
  const aiFacet = ensureAiRuntimeFacet(vm);
  const facetBacked = vm.actorRuntime.ensureFacet<VmRuntimeContext>(
    VM_RUNTIME_CONTEXT_FACET,
    () => aiFacet.runtimeContext,
  );
  aiFacet.runtimeContext = materializeVmRuntimeContext(facetBacked);
  syncHolonRuntime(vm.holonRuntime, aiFacet);
  vm.actorRuntime.setFacet(VM_AI_FACET, aiFacet);
  vm.actorRuntime.setFacet(VM_RUNTIME_CONTEXT_FACET, aiFacet.runtimeContext);
  return aiFacet.runtimeContext;
}

function syncHolonRuntime(runtime: AiHolonRuntime, aiFacet: AiRuntimeVmFacet): void {
  runtime.aiFacet = aiFacet;
  runtime.sessionState = aiFacet.sessionState;
  runtime.runtimeContext = aiFacet.runtimeContext;
}

export function getControlActor(vm: AiAgentVm): AiAgentActor | undefined {
  return vm.actors?.[vm.controlActorKey];
}

export function createVM(params: CreateVMParams): AiAgentVm {
  const controlActorKey = params.controlActorKey
  if (!controlActorKey) {
    throw new Error("createVM: controlActorKey is required")
  }
  const registries: RuntimeRegistries = {
    toolRegistry: params.registries?.toolRegistry ?? null,
    skillRegistry: params.registries?.skillRegistry ?? new SkillRegistry(),
    agentRegistry: params.registries?.agentRegistry ?? new AgentRegistry(),
    mcpRegistry: params.registries?.mcpRegistry ?? new McpRegistry(),
  };
  const aiFacet = createVmAiRuntimeFacet({
    sessionState: {
      ...(params.sessionState ?? {}),
      ...(params.aiFacet?.sessionState ?? {}),
    },
    runtimeContext: {
      ...(params.runtimeContext ?? {}),
      ...(params.aiFacet?.runtimeContext ?? {}),
    },
  });

  let vm!: AiAgentVm;
  const actorRuntime = new ActorRuntime<AiAgentVm, AiAgentMailboxSchema>(() => vm);
  const holonRuntime: AiHolonRuntime = {
    aiFacet,
    sessionState: aiFacet.sessionState,
    runtimeContext: aiFacet.runtimeContext,
  };
  const innerCtx: AiRuntimeInnerCtx = {
    registries,
    mcpManager: params.mcpManager,
    recovery: params.recovery,
  };
  const createdAt = Date.now();

  vm = {
    controlActorKey,
    actors: { ...params.actors },
    eventBus: params.eventBus ?? null,
    get registries(): RuntimeRegistries {
      return innerCtx.registries;
    },
    set registries(nextRegistries: RuntimeRegistries) {
      innerCtx.registries = nextRegistries;
    },
    callbacks: params.callbacks ?? {},
    options: params.options ?? {},
    effects: params.effects ?? {},
    outerCtx: params.outerCtx ?? {},
    innerCtx,
    get mcpManager(): McpManagerLike | undefined {
      return innerCtx.mcpManager;
    },
    set mcpManager(nextManager: McpManagerLike | undefined) {
      innerCtx.mcpManager = nextManager;
    },
    get recovery(): VmRecoveryState | undefined {
      return innerCtx.recovery;
    },
    set recovery(nextRecovery: VmRecoveryState | undefined) {
      innerCtx.recovery = nextRecovery;
    },
    immutableSnapshot: {
      controlActorKey,
      actorKeys: Object.keys(params.actors),
      createdAt,
    },
    mutableSnapshot: {
      updatedAt: createdAt,
    },
    publicRxData: null,
    privateRxData: null,
    publicRxBinding: null,
    privateRxBinding: null,
    holonRuntime,
    get aiFacet(): AiRuntimeVmFacet {
      return aiFacet;
    },
    set aiFacet(nextFacet: AiRuntimeVmFacet) {
      aiFacet.sessionState = materializeVmSessionState(nextFacet?.sessionState);
      aiFacet.runtimeContext = materializeVmRuntimeContext(nextFacet?.runtimeContext);
      syncHolonRuntime(holonRuntime, aiFacet);
      actorRuntime.setFacet(VM_AI_FACET, aiFacet);
      actorRuntime.setFacet(VM_RUNTIME_CONTEXT_FACET, aiFacet.runtimeContext);
    },
    get sessionState(): VmSessionState {
      return aiFacet.sessionState;
    },
    set sessionState(nextState: VmSessionState) {
      aiFacet.sessionState = materializeVmSessionState(nextState);
      syncHolonRuntime(holonRuntime, aiFacet);
      actorRuntime.setFacet(VM_AI_FACET, aiFacet);
    },
    get runtimeContext(): VmRuntimeContext {
      return aiFacet.runtimeContext;
    },
    set runtimeContext(nextContext: VmRuntimeContext) {
      aiFacet.runtimeContext = materializeVmRuntimeContext(nextContext);
      syncHolonRuntime(holonRuntime, aiFacet);
      actorRuntime.setFacet(VM_AI_FACET, aiFacet);
      actorRuntime.setFacet(VM_RUNTIME_CONTEXT_FACET, aiFacet.runtimeContext);
    },
    actorRuntime,
  };

  actorRuntime.setFacet(VM_AI_FACET, aiFacet);
  actorRuntime.setFacet(VM_RUNTIME_CONTEXT_FACET, aiFacet.runtimeContext);

  for (const [id, actor] of Object.entries(vm.actors)) {
    if (!actorRuntime.has(id)) {
      actorRuntime.register(id, actor);
    }
  }

  return vm;
}
