import { AgentRegistry, SkillRegistry } from "@cell/ai-core-logic";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import type { AgentRegistryData, SkillRegistryData, ToolFuncRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";

export type PlatformRuntimeRegistries = {
  toolRegistry: ToolFuncRegistryData;
  agentRegistry: AgentRegistryData;
  skillRegistry: SkillRegistryData;
};

export function createPlatformRuntimeRegistries(): PlatformRuntimeRegistries {
  return {
    toolRegistry: new ToolFuncRegistry(),
    agentRegistry: new AgentRegistry(),
    skillRegistry: new SkillRegistry(),
  };
}
