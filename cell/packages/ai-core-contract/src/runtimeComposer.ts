import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig";
import type { AgentPresetConfig, LLMProviderConfig } from "@cell/ai-organ-contract/llm/ProviderConfig";
import type {
  OrchestrationHistoryEffects,
  RuntimeHistorySupportParams,
} from "@cell/ai-core-contract/runtime/HistoryEffects";
import type { RuntimeLogFn } from "@cell/ai-core-contract/runtime/Logging";
import type { RuntimeSnapshotRepositoryFactory } from "@cell/ai-core-contract/runtime/RuntimeSnapshotStore";
import type { ToolSchema } from "@cell/ai-core-contract/types";
import type {
  RuntimeSnapshotLoadResult,
  RuntimeSnapshotManifest,
  RuntimeSnapshotPersistedState,
} from "@cell/ai-core-contract/runtime/RuntimeSnapshotTypes";
import type { ActorModelConfig } from "@cell/ai-core-contract/runtime/AiAgentActor";
import type {
  AiAgentVm as CoreAiAgentVm,
} from "@cell/ai-core-contract/runtime/AiAgentVm";
import type {
  AgentRegistryData,
  SkillRegistryData,
  ToolFuncRegistryData,
} from "@cell/ai-core-contract/runtime/RuntimeRegistries";
import type { LocalPermissionConfigStore } from "@cell/ai-organ-contract/permissions/LocalPermissionConfig";
import type { ConversationPersistenceRepositoryFactory } from "@cell/ai-organ-contract/persistence/conversation/ConversationPersistence";
import type { RuntimeDerivedIndexesStore } from "@cell/ai-organ-contract/persistence/RuntimeDerivedIndexes";

export type DomainRuntimeVm = CoreAiAgentVm<any, any, any, any>;

export type RuntimeToolsetVm = Pick<DomainRuntimeVm, "mcpManager" | "outerCtx" | "registries">;

export type DomainRuntimeAssemblyContext = {
  skillsDescription: string;
  delegateAgentDescriptions: string;
  loadedAgents: Readonly<Record<string, AgentConfig>>;
};

export type RuntimeSlashCommandNamespace = "actor" | "member" | "holon" | "goal";

export type RuntimeSlashCommandActionParse =
  | { kind: "assign" }
  | { kind: "literal"; form: string }
  | { kind: "target"; form: string; argName?: string }
  | { kind: "name"; form: string; argName?: string }
  | { kind: "pair"; form: string; argNames: readonly [string, string] }
  | { kind: "create_member"; form: string; defaultAgentType?: string }
  | { kind: "create_holon"; form: string }
  | { kind: "rest"; form?: string; argName?: string };

export type RuntimeSlashCommandActionDescriptor = {
  toolName: string;
  parse: RuntimeSlashCommandActionParse;
  help: string;
  promptForms?: readonly string[];
};

export type RuntimeSlashCommandDescriptor = {
  namespace: RuntimeSlashCommandNamespace;
  actions: Readonly<Record<string, RuntimeSlashCommandActionDescriptor>>;
};

export type RuntimePromptSlashCommand = {
  kind: "prompt_expand";
  command: string;
  prompt: string;
};

export type RuntimeDirectSlashCommand = {
  kind: "direct_execute";
  command: string;
  namespace: RuntimeSlashCommandNamespace;
  action: string;
  args: Record<string, unknown>;
};

export type RuntimeResolvedSlashCommand = RuntimePromptSlashCommand | RuntimeDirectSlashCommand;

export type RuntimeSlashRuntime = {
  resolveCommand: (input: string) => RuntimeResolvedSlashCommand | null;
  expandPrompt: (input: string) => RuntimePromptSlashCommand | null;
  getNamespaceHelp: (namespace: RuntimeSlashCommandNamespace) => string;
};

export type RuntimeSlashRuntimeFactory = (
  commands: RuntimeSlashCommandDescriptor[],
) => RuntimeSlashRuntime;

export type RuntimeRegistries = {
  toolRegistry: ToolFuncRegistryData;
  agentRegistry: AgentRegistryData;
  skillRegistry: SkillRegistryData;
};

export type RuntimeHookMode = "observe" | "transform" | "decision" | "around";

export type RuntimeHookAction = "continue" | "replace" | "deny" | "ask" | "retry" | "stop";

export type RuntimeHookStepStatus =
  | "matched"
  | "skipped"
  | "failed"
  | "timed_out"
  | "reentrant_skipped"
  | "budget_exhausted";

export type RuntimeHookMatcher = {
  actorIds?: readonly string[];
  actorNames?: readonly string[];
  actorKinds?: readonly string[];
  toolNames?: readonly string[];
  providerIds?: readonly string[];
  shellTypes?: readonly string[];
  commandNames?: readonly string[];
  extensionIds?: readonly string[];
  subjectPaths?: readonly string[];
  pathGlobs?: readonly string[];
  riskLevels?: readonly string[];
  tags?: readonly string[];
};

export type RuntimeHookInvocationContext = {
  point: string;
  sessionId?: string;
  actorId?: string;
  actorName?: string;
  actorKind?: string;
  toolName?: string;
  providerId?: string;
  shellType?: string;
  commandName?: string;
  extensionId?: string;
  subjectPath?: string;
  riskLevel?: string;
  traceId?: string;
  tags?: readonly string[];
  payload?: unknown;
};

export type RuntimeHookMailboxEnqueueEffect = {
  type: "mailbox_enqueue";
  fiberId?: string;
  actorId?: string;
  actorName?: string;
  mailbox: string;
  payload: unknown;
};

export type RuntimeHookResumeFiberEffect = {
  type: "resume_fiber";
  fiberId?: string;
  actorId?: string;
  actorName?: string;
  reason?: string;
};

export type RuntimeHookEmitDiagnosticEffect = {
  type: "emit_diagnostic";
  eventType?: string;
  payload: unknown;
};

export type RuntimeHookRequestSnapshotEffect = {
  type: "request_snapshot";
  reason?: string;
};

export type RuntimeHookEffect =
  | RuntimeHookMailboxEnqueueEffect
  | RuntimeHookResumeFiberEffect
  | RuntimeHookEmitDiagnosticEffect
  | RuntimeHookRequestSnapshotEffect;

export type RuntimeHookResult = {
  action: RuntimeHookAction;
  payload?: unknown;
  output?: unknown;
  message?: string;
  metadata?: Record<string, unknown>;
  effects?: readonly RuntimeHookEffect[];
};

export type RuntimeHookComponentExecution = {
  style: "component";
  componentId: string;
  config?: unknown;
};

export type RuntimeHookExecution = RuntimeHookComponentExecution;

export type RuntimeHookDefinition = {
  name: string;
  description?: string;
  point: string;
  mode: RuntimeHookMode;
  extensionId: string;
  enabled?: boolean;
  priority?: number;
  timeoutMs?: number;
  failOpen?: boolean;
  matcher?: RuntimeHookMatcher;
  execution: RuntimeHookExecution;
};

export type RuntimeHookDispatchStepReport = {
  hookName: string;
  extensionId: string;
  point: string;
  mode: RuntimeHookMode;
  status: RuntimeHookStepStatus;
  action?: RuntimeHookAction;
  elapsedMs?: number;
  message?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type RuntimeHookDispatchReport = {
  eventType: "hook_dispatch_report";
  point: string;
  sessionId?: string;
  actorId?: string;
  actorName?: string;
  traceId?: string;
  finalAction: RuntimeHookAction;
  elapsedMs: number;
  steps: readonly RuntimeHookDispatchStepReport[];
  payload?: unknown;
  output?: unknown;
  effects?: readonly RuntimeHookEffect[];
};

export type RuntimeToolingDescriptor = {
  buildAllTools: (state: DomainRuntimeAssemblyState, context: DomainRuntimeAssemblyContext) => ToolSchema[];
  buildToolset: (
    state: DomainRuntimeAssemblyState,
    vm: RuntimeToolsetVm,
    context: DomainRuntimeAssemblyContext,
  ) => ToolSchema[];
};

export type RuntimeBootstrapDescriptor = {
  createRegistries: (
    state: DomainRuntimeAssemblyState,
    context: DomainRuntimeAssemblyContext,
    options?: { includeInternalOnly?: boolean },
  ) => RuntimeRegistries;
};

export type RuntimeCatalogConfigBundle = {
  providerConfig: LLMProviderConfig | null;
  presetConfig: AgentPresetConfig | null;
};

export type RuntimeCatalogDescriptor = {
  loadConfigBundle: (workDir: string) => RuntimeCatalogConfigBundle;
};

export type RuntimeAgentLoader = {
  getAgents: () => Readonly<Record<string, AgentConfig>>;
  getDescriptions: () => string;
};

export type RuntimeModelConfigResolverParams = {
  workDir: string;
  agentKey: string;
  modelRef?: string;
  fallbackModelConfig: ActorModelConfig;
  fallbackOverrideKeys?: (keyof ActorModelConfig)[];
  strictModelRef?: boolean;
  logger?: RuntimeLogFn;
};

export type RuntimePersistenceDescriptor = {
  snapshotRepositoryFactory: RuntimeSnapshotRepositoryFactory<
    RuntimeSnapshotPersistedState,
    RuntimeSnapshotManifest,
    RuntimeSnapshotLoadResult
  >;
  derivedIndexesStore: RuntimeDerivedIndexesStore;
  conversationPersistenceRepositoryFactory?: ConversationPersistenceRepositoryFactory;
};

export type RuntimeSupportDescriptor = {
  createAgentLoader: (agentsDir: string) => RuntimeAgentLoader;
  resolveActorModelConfig: (params: RuntimeModelConfigResolverParams) => ActorModelConfig;
  createOrchestrationHistoryEffects: (
    params: RuntimeHistorySupportParams,
  ) => OrchestrationHistoryEffects;
  permissionConfigStore: LocalPermissionConfigStore;
  persistence: RuntimePersistenceDescriptor;
};

export type DomainRuntimeAssemblyState = {
  agentConfigs: Readonly<Record<string, AgentConfig>>;
  tooling: RuntimeToolingDescriptor | null;
  bootstrap: RuntimeBootstrapDescriptor | null;
  runtimeCatalog: RuntimeCatalogDescriptor | null;
  runtimeSupport: RuntimeSupportDescriptor | null;
  slashCommands: RuntimeSlashCommandDescriptor[];
  slashCommandSurfaces: string[];
  slashRuntimeFactory: RuntimeSlashRuntimeFactory | null;
  hookDefinitions: RuntimeHookDefinition[];
};

export type DomainRuntimeAssemblyResult = {
  agentConfigs: Readonly<Record<string, AgentConfig>>;
  allTools: ToolSchema[];
  buildToolset: (vm: RuntimeToolsetVm) => ToolSchema[];
  createRegistries: (options?: { includeInternalOnly?: boolean }) => RuntimeRegistries;
  runtimeCatalog: RuntimeCatalogDescriptor | null;
  runtimeSupport: RuntimeSupportDescriptor | null;
  slashCommands: RuntimeSlashCommandDescriptor[];
  slashCommandSurfaces: string[];
  createSlashRuntime: (commands?: RuntimeSlashCommandDescriptor[]) => RuntimeSlashRuntime | null;
  hookDefinitions: RuntimeHookDefinition[];
};
