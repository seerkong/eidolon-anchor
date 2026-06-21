import { createAiSlashRuntime } from "./slash";
import {
  createKernelBootstrapDescriptor,
} from "./bootstrap";
import {
  buildModAiKernelPromptSection,
} from "./prompt";
import {
  createKernelRuntimeCatalogDescriptor,
} from "./catalog";
import {
  createKernelRuntimeSupportDescriptor,
} from "./support";
import {
  createKernelSlashCommandDescriptors,
  DEFAULT_KERNEL_SLASH_COMMAND_SURFACES,
  mergeSlashCommandDescriptors,
} from "./slash/commands";
import {
  createKernelToolingDescriptor,
} from "./tooling";
import type { RuntimeAssemblyContext, RuntimeAssemblyState } from "./types";
import { uniqueValues } from "./utils";

export function applyModAiKernel(
  state: RuntimeAssemblyState,
  context: RuntimeAssemblyContext,
): RuntimeAssemblyState {
  const slashCommands = mergeSlashCommandDescriptors([
    ...state.slashCommands,
    ...createKernelSlashCommandDescriptors(),
  ]);

  return {
    ...state,
    tooling: state.tooling ?? createKernelToolingDescriptor(),
    bootstrap: createKernelBootstrapDescriptor(state.bootstrap),
    runtimeCatalog: state.runtimeCatalog ?? createKernelRuntimeCatalogDescriptor(),
    runtimeSupport: state.runtimeSupport ?? createKernelRuntimeSupportDescriptor(),
    systemPromptSections: [...state.systemPromptSections, buildModAiKernelPromptSection(context)],
    slashCommands,
    slashRuntimeFactory: state.slashRuntimeFactory ?? createAiSlashRuntime,
    slashCommandSurfaces: uniqueValues([
      ...state.slashCommandSurfaces,
      ...slashCommands.map((command) => `/${command.namespace}`),
      ...DEFAULT_KERNEL_SLASH_COMMAND_SURFACES,
    ]),
    capabilityIds: uniqueValues([...state.capabilityIds, "mod-ai-kernel"]),
    policies: {
      ...state.policies,
      runtimeBootstrapOwner: "mod-ai-kernel",
      slashRouteOwner: "mod-ai-kernel",
      slashSurfaceOwner: "mod-ai-kernel",
      toolingOwner: "mod-ai-kernel",
    },
  };
}

export const applyModSysKernel = applyModAiKernel;
export const buildModSysKernelPromptSection = buildModAiKernelPromptSection;
export * from "./slash";
export * from "./types";
export * from "./tooling";
export * from "./bootstrap";
export * from "./catalog";
export * from "./support";
export * from "./hooks/goalContinuation";
export * from "./prompt";
