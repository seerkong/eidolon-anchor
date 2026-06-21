import type { RuntimeBootstrapDescriptor } from "@cell/ai-core-contract";
import { AgentRegistry, SkillRegistry } from "@cell/ai-core-logic";
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent";
import { loadSkillEntriesFromDir } from "@cell/ai-support";
import { createPlatformRuntimeRegistries } from "@cell/platform-support";

export function createKernelBootstrapDescriptor(
  baseBootstrap: RuntimeBootstrapDescriptor | null,
): RuntimeBootstrapDescriptor {
  return {
    createRegistries: (state, context, options) => {
      const baseRegistries =
        baseBootstrap?.createRegistries(state, context, options) ??
        createPlatformRuntimeRegistries();
      const skillRegistry = baseRegistries.skillRegistry ?? new SkillRegistry();
      SkillRegistry.configureLoader(skillRegistry, loadSkillEntriesFromDir);
      return {
        toolRegistry: composeToolRegistry({ includeInternalOnly: options?.includeInternalOnly ?? false }),
        agentRegistry: new AgentRegistry(state.agentConfigs),
        skillRegistry,
      };
    },
  };
}
