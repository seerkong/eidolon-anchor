import type {
  RuntimeAssemblyContext,
  RuntimeAssemblyState,
} from "@cell/platform-contract/composer";
import { createPlatformRuntimeRegistries } from "@cell/platform-support";

type PlatformKernelBootstrapDescriptor = {
  createRegistries: (..._args: unknown[]) => ReturnType<typeof createPlatformRuntimeRegistries>;
};

type PlatformKernelAssemblyState = RuntimeAssemblyState & {
  bootstrap: PlatformKernelBootstrapDescriptor | null;
};

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function createPlatformKernelBootstrapDescriptor(): PlatformKernelBootstrapDescriptor {
  return {
    createRegistries: () => createPlatformRuntimeRegistries(),
  };
}

export function applyModPlatformKernel<TState extends PlatformKernelAssemblyState>(
  state: TState,
  _context: RuntimeAssemblyContext,
): TState {
  return {
    ...state,
    bootstrap: state.bootstrap ?? createPlatformKernelBootstrapDescriptor(),
    capabilityIds: uniqueValues([...state.capabilityIds, "mod-platform-kernel"]),
    policies: {
      ...state.policies,
      runtimeBootstrapOwner: state.policies.runtimeBootstrapOwner ?? "mod-platform-kernel",
      platformSupportOwner: "@cell/platform-support",
    },
  } as TState;
}
