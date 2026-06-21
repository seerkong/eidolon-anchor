import type { RuntimeHookDefinition } from "@cell/ai-core-contract";

export function createKernelHookDefinitions(): RuntimeHookDefinition[] {
  return [
    {
      name: "goal-continuation",
      description: "Continue the active thread goal when the owning actor becomes idle.",
      extensionId: "mod-ai-kernel",
      point: "actor.idle.before",
      mode: "decision",
      priority: 100,
      timeoutMs: 1000,
      failOpen: true,
      matcher: {
        actorKinds: ["main"],
        tags: ["goal"],
      },
      execution: {
        style: "component",
        componentId: "mod-ai-kernel.goal-continuation",
      },
    },
  ];
}
