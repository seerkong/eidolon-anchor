import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeMemberStatusOuterComputed,
  makeMemberStatusInnerRuntime,
  makeMemberStatusInnerInput,
  makeMemberStatusInnerConfig,
  memberStatusCoreLogic,
  makeMemberStatusOuterOutput,
} from "./Logic"
import type { MemberStatusOuterConfig, MemberStatusOuterInput, MemberStatusOuterOutput } from "./OuterTypes"

export function buildMemberStatusToolDef(): ToolDef<MemberStatusOuterInput, MemberStatusOuterOutput, MemberStatusOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "MemberStatus",
        description: "Show member status.",
        parameters: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
      },
    },
    briefPromptXnl: readPromptFromDir("MemberStatus", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("MemberStatus", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeMemberStatusOuterComputed,
        makeMemberStatusInnerRuntime,
        makeMemberStatusInnerInput,
        makeMemberStatusInnerConfig,
        memberStatusCoreLogic,
        makeMemberStatusOuterOutput,
      )
    },
  }
}
