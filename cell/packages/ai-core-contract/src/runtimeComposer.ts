import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig";
import type { AgentPresetConfig, LLMProviderConfig } from "@cell/ai-organ-contract/llm/ProviderConfig";
import type { ActorTranscriptStore } from "@cell/ai-core-contract/runtime/ActorTranscript";
import type {
  MessageHistoryEffects,
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

export type RuntimeSlashCommandNamespace = "actor" | "member" | "holon";

export type RuntimeSlashCommandActionParse =
  | { kind: "assign" }
  | { kind: "literal"; form: string }
  | { kind: "target"; form: string; argName?: string }
  | { kind: "name"; form: string; argName?: string }
  | { kind: "pair"; form: string; argNames: readonly [string, string] }
  | { kind: "create_member"; form: string; defaultAgentType?: string }
  | { kind: "create_holon"; form: string };

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
  fallbackModelConfig: ActorModelConfig;
  fallbackOverrideKeys?: (keyof ActorModelConfig)[];
  logger?: RuntimeLogFn;
};

export type RuntimePersistenceDescriptor = {
  actorTranscriptStore: ActorTranscriptStore;
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
  createMessageHistoryEffects: (params: RuntimeHistorySupportParams) => MessageHistoryEffects;
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
};
