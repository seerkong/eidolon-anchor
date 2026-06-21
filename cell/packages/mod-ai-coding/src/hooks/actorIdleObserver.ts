import type { RuntimeHookDefinition } from "@cell/ai-composer/ai-contract";

export function createCodingHookDefinitions(): RuntimeHookDefinition[] {
  return [
    {
      name: "actor-idle-observer",
      description: "Coding overlay idle observation hook descriptor.",
      extensionId: "mod-ai-coding",
      point: "actor.idle.before",
      mode: "observe",
      priority: 0,
      timeoutMs: 500,
      failOpen: true,
      matcher: {
        actorKinds: ["main"],
        tags: ["coding"],
      },
      execution: {
        style: "component",
        componentId: "mod-ai-coding.actor-idle-observer",
      },
    },
  ];
}
