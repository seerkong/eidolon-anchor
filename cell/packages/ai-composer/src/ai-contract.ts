import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig";
import type {
  DomainRuntimeAssemblyContext,
  DomainRuntimeAssemblyResult,
  DomainRuntimeAssemblyState,
  RuntimeHookDefinition,
} from "@cell/ai-core-contract";
import type {
  RuntimeAssemblyContext as PlatformRuntimeAssemblyContext,
  RuntimeAssemblyResult as PlatformRuntimeAssemblyResult,
  RuntimeAssemblyState as PlatformRuntimeAssemblyState,
  RuntimeBootstrapOptions,
  RuntimeExtension as PlatformRuntimeExtension,
  RuntimeProfile as PlatformRuntimeProfile,
} from "@cell/platform-contract/composer";

export type RuntimeAssemblyContext = PlatformRuntimeAssemblyContext & DomainRuntimeAssemblyContext;

export type RuntimeAssemblyState = PlatformRuntimeAssemblyState & DomainRuntimeAssemblyState & {
  agentConfigs: Readonly<Record<string, AgentConfig>>;
};

export type RuntimeExtension = PlatformRuntimeExtension<RuntimeAssemblyState, RuntimeAssemblyContext> & {
  hooks?: readonly RuntimeHookDefinition[];
};

export type RuntimeProfile = PlatformRuntimeProfile<RuntimeAssemblyState, RuntimeAssemblyContext>;

export type RuntimeAssemblyResult = PlatformRuntimeAssemblyResult & DomainRuntimeAssemblyResult;

export type { RuntimeBootstrapOptions } from "@cell/platform-contract/composer";
export type {
  DomainRuntimeAssemblyContext,
  DomainRuntimeAssemblyResult,
  DomainRuntimeAssemblyState,
  RuntimeAgentLoader,
  RuntimeBootstrapDescriptor,
  RuntimeCatalogConfigBundle,
  RuntimeCatalogDescriptor,
  RuntimeDirectSlashCommand,
  RuntimeHookAction,
  RuntimeHookDefinition,
  RuntimeHookDispatchReport,
  RuntimeHookDispatchStepReport,
  RuntimeHookEffect,
  RuntimeHookExecution,
  RuntimeHookInvocationContext,
  RuntimeHookMatcher,
  RuntimeHookMode,
  RuntimeHookResult,
  RuntimeHookStepStatus,
  RuntimeModelConfigResolverParams,
  RuntimePersistenceDescriptor,
  RuntimePromptSlashCommand,
  RuntimeRegistries,
  RuntimeResolvedSlashCommand,
  RuntimeSlashCommandActionDescriptor,
  RuntimeSlashCommandActionParse,
  RuntimeSlashCommandDescriptor,
  RuntimeSlashCommandNamespace,
  RuntimeSlashRuntime,
  RuntimeSlashRuntimeFactory,
  RuntimeSupportDescriptor,
  RuntimeToolingDescriptor,
  RuntimeToolsetVm,
} from "@cell/ai-core-contract";
