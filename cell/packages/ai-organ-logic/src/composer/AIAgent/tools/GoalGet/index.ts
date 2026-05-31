import type { ToolDef } from "@cell/ai-core-contract/types"
import { formatThreadGoalStatus, getThreadGoal } from "@cell/ai-organ-logic/goals/ThreadGoalManager"

export function buildGoalGetToolDef(): ToolDef<Record<string, never>, string> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "get_goal",
        description: "Get the current persisted thread goal, including status, budget, token usage, and elapsed-time usage.",
        parameters: { type: "object", properties: {} },
      },
    },
    briefPromptXnl: "Use get_goal to inspect the current thread goal before deciding whether it is complete or blocked.",
    detailPromptXnl: "Returns the current thread goal or null. Do not infer a goal from ordinary user requests; only use persisted goal state.",
    run: async (runtime) => formatThreadGoalStatus(getThreadGoal(runtime.vm)),
  }
}

