import type { ToolDef } from "@cell/ai-core-contract/types"
import { getThreadGoal, setThreadGoal } from "@cell/ai-organ-logic/goals/ThreadGoalManager"

type GoalCreateInput = {
  objective?: string
  token_budget?: number
}

export function buildGoalCreateToolDef(): ToolDef<GoalCreateInput, string> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "create_goal",
        description: "Create a persisted thread goal only when the user or higher-priority instruction explicitly asks for goal tracking.",
        parameters: {
          type: "object",
          properties: {
            objective: { type: "string", description: "The user-provided objective to persist as the active thread goal." },
            token_budget: { type: "number", description: "Optional token budget for this goal." },
          },
          required: ["objective"],
        },
      },
    },
    briefPromptXnl: "Use create_goal only when the user explicitly asks to set or track a goal.",
    detailPromptXnl: "Never create a goal merely because a normal task is multi-step. If a goal already exists, this tool rejects instead of replacing it.",
    run: async (runtime, input) => {
      const existing = getThreadGoal(runtime.vm)
      if (existing && existing.status !== "complete") {
        return JSON.stringify({ ok: false, error: "goal_already_exists", goal: existing })
      }
      const result = setThreadGoal({ vm: runtime.vm, objective: input?.objective, tokenBudget: input?.token_budget })
      return JSON.stringify(result)
    },
  }
}

