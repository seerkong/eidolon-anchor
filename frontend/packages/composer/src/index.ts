import type { FrontendConfig, FrontendRuntime } from "./types";
import { allFrontendModuleManifests } from "./modules";
import { FrontendModuleRegistry } from "./registry";

export const createFrontendRuntime = (config: FrontendConfig): FrontendRuntime => {
  const registry = new FrontendModuleRegistry();
  registry.registerAll(allFrontendModuleManifests);
  return registry.build(config);
};

export * from "./container";
export * from "./modules";
export * from "./registry";
export * from "./types";
