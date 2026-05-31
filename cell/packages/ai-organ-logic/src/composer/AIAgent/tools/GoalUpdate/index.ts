import type { ToolDef } from "@cell/ai-core-contract/types"
import { updateThreadGoalStatus } from "@cell/ai-organ-logic/goals/ThreadGoalManager"

type GoalUpdateInput = {
  status?: "complete" | "blocked"
  reason?: string
}

export function buildGoalUpdateToolDef(): ToolDef<GoalUpdateInput, string> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "update_goal",
        description: "Mark the current thread goal complete or blocked after strict evidence-based audit.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["complete", "blocked"] },
            reason: { type: "string", description: "Required. For complete, provide the evidence-based audit. For blocked, describe the repeated external blocker." },
          },
          required: ["status", "reason"],
        },
      },
    },
    briefPromptXnl: "Use update_goal only to mark the persisted goal complete or blocked.",
    detailPromptXnl: [
      "Only call update_goal status=complete when every requirement in the original objective is satisfied by current evidence; include that audit in reason.",
      "Only call status=blocked after the same blocker has recurred for three consecutive goal turns and no meaningful progress is possible.",
      "Do not use update_goal for pause, resume, usage_limited, or budget_limited; those states are controlled by user/system runtime.",
    ].join("\n"),
    run: async (runtime, input) => {
      const result = updateThreadGoalStatus({
        vm: runtime.vm,
        status: input?.status,
        reason: input?.reason,
        modelUpdate: true,
      })
      return JSON.stringify(result)
    },
  }
}

