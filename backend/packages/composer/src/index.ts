import type { BackendConfig, BackendRuntime } from "./infra/types";
import { BackendModuleRegistry } from "./registry";
import { allModuleManifests } from "./modules";

export const createBackendRuntime = (config: BackendConfig): BackendRuntime => {
  const registry = new BackendModuleRegistry();
  registry.registerAll(allModuleManifests);
  return registry.build(config);
};

export const createBackendRuntimeWithLifecycle = (config: BackendConfig) => {
  const registry = new BackendModuleRegistry();
  registry.registerAll(allModuleManifests);
  const runtime = registry.build(config);
  return {
    runtime,
    initAll: () => registry.initAll(),
    destroyAll: () => registry.destroyAll(),
  };
};

export * from "./infra/http";
export * from "./infra/types";
export * from "./registry";
export * from "./modules";
