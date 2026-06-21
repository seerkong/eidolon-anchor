import type { RuntimeCatalogDescriptor } from "@cell/ai-core-contract";
import {
  loadAgentPresetConfig,
  loadLLMProviderConfig,
} from "@cell/ai-support";

export function createKernelRuntimeCatalogDescriptor(): RuntimeCatalogDescriptor {
  return {
    loadConfigBundle: (workDir) => ({
      providerConfig: loadLLMProviderConfig(workDir),
      presetConfig: loadAgentPresetConfig(workDir),
    }),
  };
}
