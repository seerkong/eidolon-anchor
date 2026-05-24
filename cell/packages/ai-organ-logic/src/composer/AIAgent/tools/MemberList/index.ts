import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeMemberListOuterComputed,
  makeMemberListInnerRuntime,
  makeMemberListInnerInput,
  makeMemberListInnerConfig,
  memberListCoreLogic,
  makeMemberListOuterOutput,
} from "./Logic"
import type { MemberListOuterConfig, MemberListOuterInput, MemberListOuterOutput } from "./OuterTypes"

export function buildMemberListToolDef(): ToolDef<MemberListOuterInput, MemberListOuterOutput, MemberListOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "MemberList",
        description: "List member actors in the current session.",
        parameters: { type: "object", properties: {} },
      },
    },
    briefPromptXnl: readPromptFromDir("MemberList", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("MemberList", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeMemberListOuterComputed,
        makeMemberListInnerRuntime,
        makeMemberListInnerInput,
        makeMemberListInnerConfig,
        memberListCoreLogic,
        makeMemberListOuterOutput,
      )
    },
  }
}
