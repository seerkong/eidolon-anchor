import type { RuntimeToolingDescriptor } from "@cell/ai-core-contract";
import {
  buildAllTools,
  buildToolset as buildRuntimeToolset,
} from "@cell/ai-organ-logic/composer/AIAgent";

export function createKernelToolingDescriptor(): RuntimeToolingDescriptor {
  return {
    buildAllTools: (state, context) => buildAllTools(context.skillsDescription, state.agentConfigs),
    buildToolset: (state, vm, context) =>
      buildRuntimeToolset(buildAllTools(context.skillsDescription, state.agentConfigs), vm),
  };
}
