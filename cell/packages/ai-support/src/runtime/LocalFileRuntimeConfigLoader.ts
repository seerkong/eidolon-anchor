import type {
  AgentPresetConfig,
  LLMProviderConfig,
} from "@cell/ai-organ-contract/llm/ProviderConfig";
import type { CoreRuntimeConfigLoader } from "@cell/ai-core-contract/runtime/ConfigLoader";
import type { RuntimeLogFn } from "@cell/ai-core-contract/runtime/Logging";
import type { ActorModelConfig } from "@cell/ai-core-logic/runtime/actor";
import fs from "fs";
import path from "path";
import {
  loadPresentConfig,
  loadProviderCatalog,
  resolveActorModelConfig,
} from "@cell/ai-organ-logic/llm/ModelConfigOps";

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || require("os").homedir();
}

function firstExistingConfigPath(rootDir: string, filenames: string[]): string | undefined {
  for (const filename of filenames) {
    const candidate = path.join(rootDir, ".eidolon", filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function firstExistingProjectOrHomeConfigPath(workDir: string, filenames: string[]): string | undefined {
  return firstExistingConfigPath(workDir, filenames) ?? firstExistingConfigPath(homeDir(), filenames);
}

export const LocalFileRuntimeConfigLoader: CoreRuntimeConfigLoader = {
  loadLLMProviderConfig(workDir: string, logger?: RuntimeLogFn): LLMProviderConfig | null {
    try {
      return loadProviderCatalog(firstExistingProjectOrHomeConfigPath(workDir, ["llm-provider.json"]));
    } catch (error) {
      logger?.("error", "Failed to load LLM provider catalog", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },

  loadAgentPresetConfig(workDir: string, logger?: RuntimeLogFn): AgentPresetConfig | null {
    try {
      const presentConfigPath = firstExistingProjectOrHomeConfigPath(workDir, ["agent-preset.json"]);
      const presentConfig = loadPresentConfig({ configPath: presentConfigPath, workdir: workDir });
      return {
        preset: presentConfig.defaultPreset,
        presets: Object.fromEntries(
          Object.entries(presentConfig.presets).map(([presetName, preset]) => [
            presetName,
            {
              default: { model: preset.primary.model },
              main: { model: preset.primary.model },
            },
          ]),
        ),
      };
    } catch (error) {
      logger?.("error", "Failed to load LLM present config", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },
};

export function loadLLMProviderConfig(workDir: string, logger?: RuntimeLogFn): LLMProviderConfig | null {
  return LocalFileRuntimeConfigLoader.loadLLMProviderConfig(workDir, logger);
}

export function loadAgentPresetConfig(workDir: string, logger?: RuntimeLogFn): AgentPresetConfig | null {
  return LocalFileRuntimeConfigLoader.loadAgentPresetConfig(workDir, logger);
}

export function resolveActorModelConfigFromLocalFiles(params: {
  workDir: string;
  agentKey: string;
  fallbackModelConfig: ActorModelConfig;
  fallbackOverrideKeys?: (keyof ActorModelConfig)[];
  logger?: RuntimeLogFn;
}): ActorModelConfig {
  const { workDir, logger } = params;
  return resolveActorModelConfig({
    ...params,
    providerConfig: loadLLMProviderConfig(workDir, logger),
    presetConfig: loadAgentPresetConfig(workDir, logger),
  });
}
