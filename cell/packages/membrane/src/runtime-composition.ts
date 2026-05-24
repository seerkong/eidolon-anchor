import {
  assembleRuntimeProfile,
  type RuntimeProfile,
} from "@cell/ai-composer";
import type {
  RuntimeAssemblyContext,
  RuntimeAssemblyResult,
  RuntimeCatalogConfigBundle,
  RuntimeBootstrapOptions,
  RuntimeSlashCommandDescriptor,
  RuntimeSlashRuntime,
} from "@cell/ai-composer/ai-contract";

export type RuntimeCompositionContext = RuntimeAssemblyContext;
export type RuntimeCompositionResult = RuntimeAssemblyResult;
export type RuntimeCompositionOptions = RuntimeBootstrapOptions;
export type RuntimeCompositionFactory = (
  context: RuntimeCompositionContext,
  options?: RuntimeCompositionOptions,
) => RuntimeCompositionResult;
export type RuntimeCompositionSlashCommand = RuntimeSlashCommandDescriptor;
export type RuntimeCompositionSlashRuntime = RuntimeSlashRuntime;
export type RuntimeCompositionCatalogBundle = RuntimeCatalogConfigBundle;

export type RuntimeCompositionFacade = {
  assembleProfile: (
    profile: RuntimeProfile,
    context: RuntimeCompositionContext,
    options?: RuntimeCompositionOptions,
  ) => RuntimeCompositionResult;
  createAssemblyFactory: (
    profile: RuntimeProfile,
    options?: RuntimeCompositionOptions,
  ) => RuntimeCompositionFactory;
};

export function assembleRuntimeCompositionProfile(
  profile: RuntimeProfile,
  context: RuntimeCompositionContext,
  options?: RuntimeCompositionOptions,
): RuntimeCompositionResult {
  return assembleRuntimeProfile(profile, context, options);
}

export function createRuntimeCompositionFacade(): RuntimeCompositionFacade {
  return {
    assembleProfile: assembleRuntimeCompositionProfile,
    createAssemblyFactory(profile, options) {
      return (context, localOptions) =>
        assembleRuntimeCompositionProfile(profile, context, localOptions ?? options);
    },
  };
}
