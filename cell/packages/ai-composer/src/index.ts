import type { ToolSchema } from "@cell/ai-core-contract/types";
import type {
  RuntimeAssemblyContext as PlatformRuntimeAssemblyContext,
  RuntimeAssemblyResult as PlatformRuntimeAssemblyResult,
  RuntimeAssemblyState as PlatformRuntimeAssemblyState,
  RuntimeBootstrapOptions,
  RuntimeProfile as PlatformRuntimeProfile,
} from "@cell/platform-contract/composer";
import type {
  RuntimeAssemblyContext,
  RuntimeAssemblyResult,
  RuntimeAssemblyState,
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

export function assembleRuntimeProfile(
  profile: RuntimeProfile,
  context: RuntimeAssemblyContext,
  options?: RuntimeBootstrapOptions,
): RuntimeAssemblyResult {
  const state = reduceProfile(profile, context, createInitialState(context));
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
  };
}
