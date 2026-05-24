import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeMemberAssignOuterComputed,
  makeMemberAssignInnerRuntime,
  makeMemberAssignInnerInput,
  makeMemberAssignInnerConfig,
  memberAssignCoreLogic,
  makeMemberAssignOuterOutput,
} from "./Logic"
import type { MemberAssignOuterConfig, MemberAssignOuterInput, MemberAssignOuterOutput } from "./OuterTypes"

export function buildMemberAssignToolDef(): ToolDef<MemberAssignOuterInput, MemberAssignOuterOutput, MemberAssignOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "MemberAssign",
        description: "Assign work to a member actor.",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string" },
            mode: { type: "string", enum: ["final", "none", "stream"] },
            content: { type: "string" },
          },
          required: ["target", "mode", "content"],
        },
      },
    },
    briefPromptXnl: readPromptFromDir("MemberAssign", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("MemberAssign", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeMemberAssignOuterComputed,
        makeMemberAssignInnerRuntime,
        makeMemberAssignInnerInput,
        makeMemberAssignInnerConfig,
        memberAssignCoreLogic,
        makeMemberAssignOuterOutput,
      )
    },
  }
}
