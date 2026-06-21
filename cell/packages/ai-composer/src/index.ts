import type { ToolSchema } from "@cell/ai-core-contract/types";
import type {
  RuntimeAssemblyContext as PlatformRuntimeAssemblyContext,
  RuntimeAssemblyResult as PlatformRuntimeAssemblyResult,
  RuntimeAssemblyState as PlatformRuntimeAssemblyState,
  RuntimeBindingDescriptor,
  RuntimeBootstrapOptions,
  RuntimeEntryType,
  RuntimeExtensionKind,
  RuntimeProfile as PlatformRuntimeProfile,
  RuntimeStorageCapabilityFlags,
} from "@cell/platform-contract/composer";
import type {
  RuntimeAssemblyContext,
  RuntimeAssemblyResult,
  RuntimeAssemblyState,
  RuntimeExtension,
  RuntimeProfile,
} from "./ai-contract";

export type {
  RuntimeBootstrapOptions,
  RuntimeAssemblyContext,
  RuntimeAssemblyResult,
  RuntimeAssemblyState,
  RuntimeExtension,
  RuntimePolicyMap,
  RuntimeProfile,
} from "./contract";
export type {
  RuntimeBindingDescriptor,
  RuntimeEntryType,
  RuntimeExtensionKind,
  RuntimeStorageCapabilityFlags,
} from "@cell/platform-contract/composer";

function buildSystemPrompt(sections: string[]): string {
  return sections.filter((section) => section.trim()).join("\n\n");
}

function reduceProfile<
  TState extends PlatformRuntimeAssemblyState,
  TContext extends PlatformRuntimeAssemblyContext,
>(
  profile: PlatformRuntimeProfile<TState, TContext>,
  context: TContext,
  initialState: TState,
): TState {
  return profile.extensions.reduce(
    (current, extension) => extension.apply(current, context),
    initialState,
  );
}

function reduceRuntimeProfile(
  profile: RuntimeProfile,
  context: RuntimeAssemblyContext,
  initialState: RuntimeAssemblyState,
): RuntimeAssemblyState {
  return profile.extensions.reduce((current, extension) => {
    const runtimeExtension = extension as RuntimeExtension;
    const next = extension.apply(current, context);
    if (!runtimeExtension.hooks?.length) return next;
    return {
      ...next,
      hookDefinitions: [...next.hookDefinitions, ...runtimeExtension.hooks],
    };
  }, initialState);
}

function createPlatformInitialState(): PlatformRuntimeAssemblyState {
  return {
    systemPromptSections: [],
    capabilityIds: [],
    policies: {},
  };
}

function finalizePlatformAssemblyResult(
  profileId: string,
  state: Pick<PlatformRuntimeAssemblyState, "systemPromptSections" | "capabilityIds" | "policies">,
): PlatformRuntimeAssemblyResult {
  return {
    profileId,
    systemPrompt: buildSystemPrompt(state.systemPromptSections),
    capabilityIds: state.capabilityIds,
    policies: state.policies,
  };
}

function createInitialState(context: RuntimeAssemblyContext): RuntimeAssemblyState {
  return {
    ...createPlatformInitialState(),
    agentConfigs: context.loadedAgents,
    tooling: null,
    bootstrap: null,
    runtimeCatalog: null,
    runtimeSupport: null,
    slashCommands: [],
    slashCommandSurfaces: [],
    slashRuntimeFactory: null,
    hookDefinitions: [],
  };
}

export function assemblePlatformProfile(
  profile: PlatformRuntimeProfile,
  context: PlatformRuntimeAssemblyContext,
): PlatformRuntimeAssemblyResult {
  const state = reduceProfile(profile, context, createPlatformInitialState());
  return finalizePlatformAssemblyResult(profile.id, state);
}

function finalizeAllTools(state: RuntimeAssemblyState, context: RuntimeAssemblyContext): ToolSchema[] {
  return state.tooling ? state.tooling.buildAllTools(state, context) : [];
}

function groupExtensionIdsByKind(profile: RuntimeProfile): Record<RuntimeExtensionKind, string[]> {
  const groups: Record<RuntimeExtensionKind, string[]> = {
    platform: [],
    domain_kernel: [],
    app_overlay: [],
  };
  for (const extension of profile.extensions) {
    groups[extension.kind ?? "platform"].push(extension.id);
  }
  return groups;
}

export function buildRuntimeBindingDescriptor(params: {
  profile: RuntimeProfile;
  context: RuntimeAssemblyContext;
  entryType: RuntimeEntryType;
  storage: RuntimeStorageCapabilityFlags;
  surfaceCapabilities?: readonly string[];
}): RuntimeBindingDescriptor {
  const state = reduceRuntimeProfile(params.profile, params.context, createInitialState(params.context));
  const modules = groupExtensionIdsByKind(params.profile);
  return {
    profileId: params.profile.id,
    entryType: params.entryType,
    enabledCapabilities: [...state.capabilityIds],
    storage: { ...params.storage },
    platformModules: modules.platform,
    domainKernelModules: modules.domain_kernel,
    appOverlays: modules.app_overlay,
    surfaceCapabilities: [...(params.surfaceCapabilities ?? [])],
  };
}

/**
 * Two descriptors are compatible when the profile-derived composition and the
 * storage flags match. Entry type and surface capabilities are allowed to
 * differ: the same runtime may be driven by CLI, TUI, or headless surfaces.
 */
export function areRuntimeBindingDescriptorsCompatible(
  left: RuntimeBindingDescriptor,
  right: RuntimeBindingDescriptor,
): boolean {
  const project = (descriptor: RuntimeBindingDescriptor) =>
    JSON.stringify({
      profileId: descriptor.profileId,
      enabledCapabilities: descriptor.enabledCapabilities,
      storage: descriptor.storage,
      platformModules: descriptor.platformModules,
      domainKernelModules: descriptor.domainKernelModules,
      appOverlays: descriptor.appOverlays,
    });
  return project(left) === project(right);
}

export function assembleRuntimeProfile(
  profile: RuntimeProfile,
  context: RuntimeAssemblyContext,
  options?: RuntimeBootstrapOptions,
): RuntimeAssemblyResult {
  const state = reduceRuntimeProfile(profile, context, createInitialState(context));
  const allTools = finalizeAllTools(state, context);
  const platformResult = finalizePlatformAssemblyResult(profile.id, state);

  return {
    ...platformResult,
    agentConfigs: state.agentConfigs,
    allTools,
    buildToolset: (vm) => (state.tooling ? state.tooling.buildToolset(state, vm, context) : allTools),
    createRegistries: (bootstrapOptions) => {
      if (!state.bootstrap) {
        throw new Error(`Runtime profile "${profile.id}" did not provide bootstrap registries.`);
      }
      return state.bootstrap.createRegistries(state, context, bootstrapOptions ?? options);
    },
    runtimeCatalog: state.runtimeCatalog,
    runtimeSupport: state.runtimeSupport,
    slashCommands: state.slashCommands,
    slashCommandSurfaces: state.slashCommandSurfaces,
    createSlashRuntime: (commands) =>
      state.slashRuntimeFactory ? state.slashRuntimeFactory(commands ?? state.slashCommands) : null,
    hookDefinitions: state.hookDefinitions,
  };
}
