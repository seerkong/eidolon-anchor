import type { ToolDef } from "@cell/ai-core-contract/types"
import {
  clearThreadGoal,
  formatThreadGoalStatus,
  getThreadGoal,
  setThreadGoal,
  updateThreadGoalStatus,
} from "@cell/ai-organ-logic/goals/ThreadGoalManager"

type GoalCommandInput = {
  command?: "status" | "set" | "edit" | "pause" | "resume" | "clear"
  objective?: string
  token_budget?: number
}

export function buildGoalCommandToolDef(): ToolDef<GoalCommandInput, string> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "GoalCommand",
        description: "User slash-command handler for thread goals.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", enum: ["status", "set", "edit", "pause", "resume", "clear"] },
            objective: { type: "string" },
            token_budget: { type: "number" },
          },
          required: ["command"],
        },
      },
    },
    briefPromptXnl: "Internal slash handler for /goal.",
    detailPromptXnl: "User-controlled goal management surface.",
    run: async (runtime, input) => {
      const command = input?.command ?? "status"
      if (command === "status") return formatThreadGoalStatus(getThreadGoal(runtime.vm))
      if (command === "set") {
        const existing = getThreadGoal(runtime.vm)
        if (existing && existing.status !== "complete") {
          return JSON.stringify({
            ok: false,
            error: "goal_already_exists",
            message: "A current thread goal already exists. Use /goal edit <objective> to explicitly replace it, or /goal clear first.",
            goal: existing,
          })
        }
        return JSON.stringify(setThreadGoal({ vm: runtime.vm, objective: input?.objective, tokenBudget: input?.token_budget }))
      }
      if (command === "edit") {
        return JSON.stringify(setThreadGoal({ vm: runtime.vm, objective: input?.objective, tokenBudget: input?.token_budget }))
      }
      if (command === "pause") return JSON.stringify(updateThreadGoalStatus({ vm: runtime.vm, status: "paused" }))
      if (command === "resume") return JSON.stringify(updateThreadGoalStatus({ vm: runtime.vm, status: "active" }))
      if (command === "clear") return JSON.stringify(clearThreadGoal(runtime.vm))
      return JSON.stringify({ ok: false, error: "unknown_goal_command" })
    },
  }
}

