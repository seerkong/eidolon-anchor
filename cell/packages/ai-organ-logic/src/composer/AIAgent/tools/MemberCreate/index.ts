import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeMemberCreateOuterComputed,
  makeMemberCreateInnerRuntime,
  makeMemberCreateInnerInput,
  makeMemberCreateInnerConfig,
  memberCreateCoreLogic,
  makeMemberCreateOuterOutput,
} from "./Logic"
import type { MemberCreateOuterConfig, MemberCreateOuterInput, MemberCreateOuterOutput } from "./OuterTypes"

export function buildMemberCreateToolDef(): ToolDef<MemberCreateOuterInput, MemberCreateOuterOutput, MemberCreateOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "MemberCreate",
        description: "Create a persistent member actor in the current session. Members are durable team/session actors looked up by member id or name; subagent is a delegate alias, not a member alias.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            agent_type: { type: "string" },
            prompt: { type: "string" },
          },
          required: ["name", "agent_type", "prompt"],
        },
      },
    },
    briefPromptXnl: readPromptFromDir("MemberCreate", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("MemberCreate", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeMemberCreateOuterComputed,
        makeMemberCreateInnerRuntime,
        makeMemberCreateInnerInput,
        makeMemberCreateInnerConfig,
        memberCreateCoreLogic,
        makeMemberCreateOuterOutput,
      )
    },
  }
}
